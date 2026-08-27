/**
 * Award flight search: per-provider cache → live providers → cross-reference.
 *
 * Differences from the cash tiers, driven by how award inventory works:
 *
 *  - Providers are NOT a fallback chain. Roame and ATF see different inventory,
 *    so both run by default (configurable via ENABLE_ROAME / ENABLE_ATF); one
 *    returning results never suppresses the other.
 *
 *  - Each provider is cached INDEPENDENTLY. A fresh Roame payload is served
 *    from cache even when ATF's has expired and must be re-fetched.
 *
 *  - Deduplication preserves programs. The same physical flight priced by four
 *    loyalty programs is four redemption options, not four duplicates. Only
 *    identical (itinerary × program) entries collapse, keeping the cheapest.
 *
 *  - Cross-verification requires INDEPENDENT evidence: the same program +
 *    cabin + date reported by two different providers. One provider repeating
 *    itself is not verification.
 */

import { getDb, currentPeriod, type DB } from "../../db/index.js"
import {
  readCache, writeCache, recordCacheHit, recordAwardObservations,
  recordCallAttempt, recordCallOutcome, recordReportedQuota, recordHealth,
} from "../../db/repositories.js"
import { awardCacheKey } from "../../cache/key.js"
import { cachePolicy, ttlToExpiry } from "../../cache/policy.js"
import { RoameAwardProvider } from "./roame.js"
import { ATFAwardProvider } from "./atf.js"
import type {
  AwardFlightProvider, AwardFlightQuery, AwardSearchOptions, AwardSearchResult,
  NormalizedAwardFlight, ProviderHealth,
} from "./types.js"

export * from "./types.js"
export { awardCacheKey } from "../../cache/key.js"

// ─── Registry ────────────────────────────────────────────────────────────────

let registry: AwardFlightProvider[] | null = null

export function getAwardProviders(): AwardFlightProvider[] {
  if (!registry) registry = [new RoameAwardProvider(), new ATFAwardProvider()]
  return registry
}

export function getAwardProvider(name: string): AwardFlightProvider | undefined {
  return getAwardProviders().find(p => p.name === name)
}

/** Test seam: swap the registry for mocks. Pass null to restore the real set. */
export function setAwardProviders(providers: AwardFlightProvider[] | null): void {
  registry = providers
}

export async function awardProviderHealth(db: DB = getDb()): Promise<ProviderHealth[]> {
  const results = await Promise.all(getAwardProviders().map(async p => {
    try {
      return await p.health()
    } catch (err) {
      return {
        provider: p.name, status: "error" as const, detail: (err as Error).message,
        latencyMs: null, checkedAt: new Date().toISOString(), quota: p.quota(),
      }
    }
  }))
  for (const h of results) {
    try { recordHealth(db, h.provider, h.status, h.detail, h.latencyMs) } catch { /* best effort */ }
  }
  return results
}

// ─── Deduplication (program-preserving) ──────────────────────────────────────

/**
 * Collapse only true duplicates: the same physical itinerary priced by the
 * SAME loyalty program. Within a duplicate set the cheapest points win (tie:
 * lower taxes, then higher verification). Entries for the same itinerary under
 * DIFFERENT programs always survive — that spread is the radar's raw material.
 */
export function dedupeAwards(flights: NormalizedAwardFlight[]): NormalizedAwardFlight[] {
  const rank = { "cross-verified": 3, discovered: 2, cached: 1 } as const
  const best = new Map<string, NormalizedAwardFlight>()

  for (const f of flights) {
    const key = `${f.itineraryHash}:${f.loyaltyProgram}`
    const existing = best.get(key)
    if (!existing) { best.set(key, f); continue }

    let better: boolean
    if (f.points !== existing.points) {
      better = f.points < existing.points
    } else if ((f.taxes?.amount ?? Infinity) !== (existing.taxes?.amount ?? Infinity)) {
      better = (f.taxes?.amount ?? Infinity) < (existing.taxes?.amount ?? Infinity)
    } else {
      better = rank[f.verificationLevel] > rank[existing.verificationLevel]
    }
    if (better) best.set(key, f)
  }
  return [...best.values()]
}

// ─── Cross-verification ──────────────────────────────────────────────────────

/**
 * Mark redemptions cross-verified when two DIFFERENT providers independently
 * reported availability for the same program + cabin + departure date. Cached
 * payloads count as evidence (they were independent observations), but a
 * provider corroborating itself never does.
 */
export function crossVerify(flights: NormalizedAwardFlight[]): number {
  const providersByKey = new Map<string, Set<string>>()
  for (const f of flights) {
    const key = `${f.loyaltyProgram}:${f.cabin}:${f.departureDate}`
    if (!providersByKey.has(key)) providersByKey.set(key, new Set())
    providersByKey.get(key)!.add(f.provider)
  }

  let marked = 0
  for (const f of flights) {
    const key = `${f.loyaltyProgram}:${f.cabin}:${f.departureDate}`
    if ((providersByKey.get(key)?.size ?? 0) >= 2) {
      f.verificationLevel = "cross-verified"
      marked++
    }
  }
  return marked
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface AwardProviderOutcome {
  provider: string
  ok: boolean
  fromCache: boolean
  cacheAgeMinutes: number | null
  flightCount: number
  callsSpent: number
  latencyMs: number
  completionPct: number | null
  error: string | null
}

export interface AwardSearchOutcome {
  flights: NormalizedAwardFlight[]
  perProvider: AwardProviderOutcome[]
  callsSpent: number
  crossVerifiedCount: number
  warnings: string[]
}

export interface AwardOrchestratorOptions extends AwardSearchOptions {
  /** Restrict to these provider names (the CLI's --sources filter). */
  providers?: string[]
  /** The unified search this belongs to; award observations reference it. */
  searchRequestId?: number | null
  db?: DB
}

function label(q: AwardFlightQuery): string {
  return `${q.origin}-${q.destination} ${q.searchClass}`
}

/**
 * Identical concurrent provider searches share one in-flight promise, keyed by
 * cache key — four simultaneous PRG→BKK searches trigger one Roame job and one
 * ATF sweep, not four of each.
 */
const inFlight = new Map<string, Promise<AwardSearchResult>>()

/**
 * Run one award search across the enabled providers. Never throws: a provider
 * failing (or being unconfigured) degrades the result and lands in warnings.
 */
export async function searchAwardFlights(
  query: AwardFlightQuery,
  options: AwardOrchestratorOptions = {},
): Promise<AwardSearchOutcome> {
  const db = options.db ?? getDb()
  const policy = cachePolicy()
  const warnings: string[] = []
  const perProvider: AwardProviderOutcome[] = []
  const collected: NormalizedAwardFlight[] = []
  let callsSpent = 0

  let providers = getAwardProviders()
  if (options.providers?.length) {
    providers = providers.filter(p => options.providers!.includes(p.name))
  }

  for (const provider of providers) {
    if (!provider.isEnabled()) {
      warnings.push(`${provider.name}: disabled via configuration`)
      continue
    }
    if (!provider.isConfigured()) {
      warnings.push(`${provider.name}: not configured`)
      perProvider.push({
        provider: provider.name, ok: false, fromCache: false, cacheAgeMinutes: null,
        flightCount: 0, callsSpent: 0, latencyMs: 0, completionPct: null,
        error: "not configured",
      })
      continue
    }

    const key = awardCacheKey(query, provider.name)

    // ── Tier 0: this provider's own cache ─────────────────────────────────
    if (!options.forceRefresh) {
      const entry = readCache<NormalizedAwardFlight>(db, key)
      if (entry && !entry.isExpired && entry.flights.length > 0) {
        recordCacheHit(db, key)
        console.log(`AWARD CACHE HIT ${label(query)} ${provider.name.toUpperCase()} (${entry.ageMinutes}m old)`)
        const flights = entry.flights
          .map(f => ({ ...f, verificationLevel: "cached" as const }))
        collected.push(...flights)
        perProvider.push({
          provider: provider.name, ok: true, fromCache: true, cacheAgeMinutes: entry.ageMinutes,
          flightCount: flights.length, callsSpent: 0, latencyMs: 0, completionPct: 100, error: null,
        })
        continue
      }
      console.log(`AWARD CACHE MISS ${label(query)} ${provider.name.toUpperCase()}`)
    }

    // ── Live search, collapsing identical concurrent requests ─────────────
    let result: AwardSearchResult
    const running = inFlight.get(key)
    if (running) {
      console.log(`AWARD JOIN ${label(query)} ${provider.name.toUpperCase()} (identical search already in flight)`)
      result = await running
      // The originating caller pays the quota accounting; joiners spend nothing.
      perProvider.push({
        provider: provider.name, ok: result.ok, fromCache: false, cacheAgeMinutes: null,
        flightCount: result.flights.length, callsSpent: 0, latencyMs: result.latencyMs,
        completionPct: result.completionPct, error: result.error ?? null,
      })
      if (result.ok) collected.push(...result.flights)
      else if (result.error) warnings.push(`${provider.name}: ${result.error}`)
      continue
    }

    // Attempts are recorded BEFORE the request — a crash mid-flight must still
    // leave a trace, and a failed call is never reclaimed as free.
    recordCallAttempt(db, provider.name, currentPeriod(), provider.callsPerSearch)

    const work = (async () => {
      try {
        return await provider.search(query, options)
      } catch (err) {
        // Contract says providers don't throw; survive one that does anyway.
        return {
          provider: provider.name, ok: false, flights: [], callsSpent: 0,
          latencyMs: 0, completionPct: null,
          reason: "provider-error" as const, error: (err as Error).message,
        }
      }
    })()
    inFlight.set(key, work)
    try {
      result = await work
    } finally {
      inFlight.delete(key)
    }

    // True up the estimate when the search cost more than callsPerSearch
    // (Roame searching ECON and PREM runs two jobs).
    if (result.callsSpent > provider.callsPerSearch) {
      recordCallAttempt(db, provider.name, currentPeriod(), result.callsSpent - provider.callsPerSearch)
    }
    recordCallOutcome(db, provider.name, { ok: result.ok, error: result.error })
    if (result.reportedQuota) {
      recordReportedQuota(db, provider.name, {
        remaining: result.reportedQuota.remaining, limit: result.reportedQuota.limit,
      })
    }

    callsSpent += result.callsSpent
    perProvider.push({
      provider: provider.name, ok: result.ok, fromCache: false, cacheAgeMinutes: null,
      flightCount: result.flights.length, callsSpent: result.callsSpent,
      latencyMs: result.latencyMs, completionPct: result.completionPct,
      error: result.error ?? null,
    })

    if (result.ok) {
      console.log(`${provider.name.toUpperCase()} ${result.flights.length} results (${result.latencyMs}ms)`)
      collected.push(...result.flights)
      try {
        writeCache(db, key, provider.name, {
          origin: query.origin, destination: query.destination,
          departureDate: query.departureDate, returnDate: query.returnDate ?? null,
          cabin: query.searchClass, adults: query.adults,
        }, result.flights, ttlToExpiry(policy.awardTtlHours))
        recordAwardObservations(db, result.flights, {
          rawRef: key, searchRequestId: options.searchRequestId ?? null,
        })
      } catch (err) {
        warnings.push(`could not persist ${provider.name} results: ${(err as Error).message}`)
      }
    } else {
      warnings.push(`${provider.name}: ${result.error || result.reason}`)
      console.warn(`${provider.name.toUpperCase()} failed — ${result.reason}: ${result.error}`)
    }
  }

  // Cross-verify across providers, then collapse true duplicates.
  const crossVerifiedCount = crossVerify(collected)
  const flights = dedupeAwards(collected)

  return { flights, perProvider, callsSpent, crossVerifiedCount, warnings }
}
