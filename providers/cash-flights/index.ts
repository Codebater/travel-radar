/**
 * Cash flight search: cache → free provider → metered verification.
 *
 * The tiering that makes the whole thing affordable:
 *
 *   Tier 0  cached      replay what we already fetched, spend nothing
 *   Tier 1  discovered  free provider (fast_flights) — the default for every search
 *   Tier 2  verified    SerpAPI, only when asked for or when the free tier failed
 *
 * SerpAPI is never called just because a search happened. It is called when the
 * caller explicitly asks to verify, when the user hits "refresh live price", or
 * as a genuine fallback when the free provider produced nothing.
 */

import { getDb, type DB } from "../../db/index.js"
import {
  readCache, writeCache, recordCacheHit, recordPriceObservations,
  recordSearchRequest, recordHealth,
} from "../../db/repositories.js"
import { cacheKey } from "../../cache/key.js"
import { cachePolicy, ttlToExpiry } from "../../cache/policy.js"
import { FastFlightsProvider } from "./fast-flights.js"
import { SerpApiProvider } from "./serpapi.js"
import type {
  CashFlightProvider, CashFlightQuery, CashFlightSearchResult,
  NormalizedCashFlight, ProviderHealth, SearchOptions,
} from "./types.js"

export * from "./types.js"
export { cacheKey } from "../../cache/key.js"

// ─── Registry ────────────────────────────────────────────────────────────────

let registry: CashFlightProvider[] | null = null

/**
 * Providers in priority order: free first, metered last. Adding a provider is a
 * matter of implementing CashFlightProvider and inserting it here — nothing
 * else in the application names a specific vendor.
 */
export function getProviders(): CashFlightProvider[] {
  if (!registry) registry = [new FastFlightsProvider(), new SerpApiProvider()]
  return registry
}

export function getProvider(name: string): CashFlightProvider | undefined {
  return getProviders().find(p => p.name === name)
}

/** Test seam: swap the registry for mocks. Pass null to restore the real set. */
export function setProviders(providers: CashFlightProvider[] | null): void {
  registry = providers
}

export async function providerHealth(db: DB = getDb()): Promise<ProviderHealth[]> {
  const results = await Promise.all(getProviders().map(async p => {
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
    try { recordHealth(db, h.provider, h.status, h.detail, h.latencyMs) } catch { /* health is best effort */ }
  }
  return results
}

// ─── Deduplication ───────────────────────────────────────────────────────────

/**
 * Collapse itineraries that different providers describe identically.
 *
 * The best *validated* price wins the visible slot: a verified price beats a
 * discovered one even when the discovered one is cheaper, because a cheap price
 * we cannot confirm is not a price. Every observation is still written to
 * history separately, so the disagreement is never lost.
 */
export function deduplicate(flights: NormalizedCashFlight[]): NormalizedCashFlight[] {
  const rank = { verified: 3, discovered: 2, cached: 1 } as const
  const best = new Map<string, NormalizedCashFlight>()

  for (const f of flights) {
    const existing = best.get(f.itineraryHash)
    if (!existing) { best.set(f.itineraryHash, f); continue }

    const better =
      rank[f.verificationLevel] !== rank[existing.verificationLevel]
        ? rank[f.verificationLevel] > rank[existing.verificationLevel]
        : f.price.currency === existing.price.currency
          ? f.price.amount < existing.price.amount
          : false     // never compare across currencies

    if (better) best.set(f.itineraryHash, f)
  }
  return [...best.values()]
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface CashSearchOutcome {
  flights: NormalizedCashFlight[]
  /** Highest tier reached across the providers that contributed. */
  verificationLevel: "cached" | "discovered" | "verified"
  /** Age of the cached payload in minutes, when served from cache. */
  cacheAgeMinutes: number | null
  fromCache: boolean
  /** Billable calls this search actually spent. */
  callsSpent: number
  attempts: CashFlightSearchResult[]
  warnings: string[]
}

export interface CashSearchOptions extends SearchOptions {
  /** Ask the metered provider to confirm, budget permitting. */
  verify?: boolean
  /** Where the request came from — recorded against search_requests. */
  source?: "api" | "cli" | "test" | "observer" | "discovery"
  /**
   * Join an existing unified search instead of recording a new one. One user
   * search = one search_requests row; cash, award and hidden-city observations
   * all reference it.
   */
  searchRequestId?: number
  db?: DB
}

function label(q: CashFlightQuery): string {
  return `${q.origin}-${q.destination} ${q.cabin}`
}

/**
 * Run one cash search through the tiers.
 *
 * Never throws: a provider blowing up degrades the result, it does not fail the
 * search. The worst case is an empty flight list plus a warning explaining why.
 */
export async function searchCashFlights(
  query: CashFlightQuery,
  options: CashSearchOptions = {},
): Promise<CashSearchOutcome> {
  const db = options.db ?? getDb()
  const policy = cachePolicy()
  const warnings: string[] = []
  const attempts: CashFlightSearchResult[] = []
  let callsSpent = 0

  let searchRequestId: number | null = options.searchRequestId ?? null
  if (searchRequestId === null) {
    try {
      searchRequestId = recordSearchRequest(db, query, options.source ?? "api")
    } catch (err) {
      warnings.push(`could not record search request: ${(err as Error).message}`)
    }
  }

  const providers = getProviders()
  const free = providers.filter(p => p.kind === "free")
  const metered = providers.filter(p => p.kind === "metered")

  // ── Tier 0: cache ────────────────────────────────────────────────────────
  if (!options.forceRefresh) {
    for (const provider of providers) {
      const key = cacheKey(query, provider.name)
      const entry = readCache(db, key)
      if (!entry || entry.isExpired || entry.flights.length === 0) continue

      recordCacheHit(db, key)
      console.log(`CACHE HIT ${label(query)} (${provider.name}, ${entry.ageMinutes}m old)`)

      // Replaying a stored payload spends nothing and is not a fresh observation,
      // so it is labelled `cached` and is NOT appended to price history again.
      const flights = entry.flights.map(f => ({ ...f, verificationLevel: "cached" as const }))
      return {
        flights: deduplicate(flights),
        verificationLevel: "cached",
        cacheAgeMinutes: entry.ageMinutes,
        fromCache: true,
        callsSpent: 0,
        attempts,
        warnings,
      }
    }
    console.log(`CACHE MISS ${label(query)}`)
  } else {
    console.log(`CACHE BYPASS ${label(query)} (forceRefresh)`)
  }

  // ── Tier 1: free providers ───────────────────────────────────────────────
  const collected: NormalizedCashFlight[] = []
  let reached: "cached" | "discovered" | "verified" = "cached"

  for (const provider of free) {
    const result = await runProvider(provider, query, options)
    attempts.push(result)
    callsSpent += result.callsSpent

    if (result.ok) {
      collected.push(...result.flights)
      reached = "discovered"
      const cheapest = cheapestOf(result.flights)
      console.log(
        `${provider.name.toUpperCase()} discovery ${cheapest ? formatMoney(cheapest) : "n/a"} ` +
        `(${result.flights.length} itineraries, ${result.latencyMs}ms)`
      )
      persist(db, provider.name, query, result.flights, policy.cashTtlHours, searchRequestId, warnings)
    } else {
      warnings.push(`${provider.name}: ${result.error || result.reason}`)
      console.warn(`${provider.name.toUpperCase()} failed — ${result.reason}: ${result.error}`)
    }
  }

  // ── Tier 2: metered verification ─────────────────────────────────────────
  // Only when explicitly requested, or when the free tier produced nothing.
  const freeTierEmpty = collected.length === 0
  const wantVerification =
    options.allowMeteredFallback === false
      ? false   // scheduled observation: cache + free discovery only, never metered
      : options.verify === true || options.forceRefresh === true || freeTierEmpty

  if (wantVerification) {
    for (const provider of metered) {
      if (!provider.isConfigured()) {
        warnings.push(`${provider.name}: not configured`)
        continue
      }
      const result = await runProvider(provider, query, options)
      attempts.push(result)
      callsSpent += result.callsSpent

      if (result.ok) {
        collected.push(...result.flights)
        reached = "verified"
        const cheapest = cheapestOf(result.flights)
        console.log(
          `${provider.name.toUpperCase()} verification ${cheapest ? formatMoney(cheapest) : "n/a"} ` +
          `(${result.flights.length} itineraries, ${result.latencyMs}ms)`
        )
        persist(db, provider.name, query, result.flights, policy.cashTtlHours, searchRequestId, warnings)
      } else {
        warnings.push(`${provider.name}: ${result.error || result.reason}`)
      }
    }
  }

  return {
    flights: deduplicate(collected),
    verificationLevel: reached,
    cacheAgeMinutes: null,
    fromCache: false,
    callsSpent,
    attempts,
    warnings,
  }
}

async function runProvider(
  provider: CashFlightProvider,
  query: CashFlightQuery,
  options: CashSearchOptions,
): Promise<CashFlightSearchResult> {
  try {
    return await provider.search(query, options)
  } catch (err) {
    // A provider is contractually not supposed to throw, but one misbehaving
    // must still not take the search down with it.
    return {
      provider: provider.name, ok: false, flights: [], callsSpent: 0, latencyMs: 0,
      reason: "provider-error", error: (err as Error).message,
    }
  }
}

/** Write the cache payload and append the observations to history. */
function persist(
  db: DB,
  providerName: string,
  query: CashFlightQuery,
  flights: NormalizedCashFlight[],
  ttlHours: number,
  searchRequestId: number | null,
  warnings: string[],
): void {
  const key = cacheKey(query, providerName)
  try {
    writeCache(db, key, providerName, query, flights, ttlToExpiry(ttlHours))
    recordPriceObservations(db, flights, {
      adults: query.adults,
      rawRef: key,
      searchRequestId,
    })
  } catch (err) {
    warnings.push(`could not persist ${providerName} results: ${(err as Error).message}`)
  }
}

function cheapestOf(flights: NormalizedCashFlight[]): NormalizedCashFlight | null {
  const priced = flights.filter(f => f.price.amount > 0)
  if (priced.length === 0) return null
  return priced.reduce((a, b) => (b.price.amount < a.price.amount ? b : a))
}

function formatMoney(f: NormalizedCashFlight): string {
  const symbol = { EUR: "€", USD: "$", GBP: "£" }[f.price.currency] || `${f.price.currency} `
  return `${symbol}${f.price.amount}`
}
