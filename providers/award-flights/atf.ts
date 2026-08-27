/**
 * Award Travel Finder — REST availability for a fixed set of Avios-adjacent
 * programs: BA Avios, Qatar Privilege Club, Cathay Asia Miles, Virgin Points,
 * Iberia Plus.
 *
 * Wraps the existing atf-scraper.ts. Two properties shape everything here:
 *
 *   - One search costs FIVE quota calls (one per airline) out of 150/month,
 *     so ~30 searches a month. Cache hits must therefore cost zero, and every
 *     attempt is recorded in provider_usage.
 *
 *   - ATF reports program-level availability, not itineraries: no times, no
 *     flight numbers, no stops. Its itinerary hash therefore degrades to
 *     route+date+cabin+airline, which is exactly the granularity of the data —
 *     never faked into looking like a specific flight.
 *
 * Confidence is "medium": availability is real but coarse, and cannot be tied
 * to one physical flight.
 */

import fs from "fs"
import path from "path"
import os from "os"
import {
  searchATF, buildATFBookingUrl, ATF_AIRLINE_META, ATF_AIRLINES,
  type ATFResult,
} from "../../atf-scraper.js"
import { itineraryHash } from "../../cache/key.js"
import { findTransferPaths, effectiveRatio } from "../../transfer-partners.js"
import { getDb, currentPeriod } from "../../db/index.js"
import { readUsage } from "../../db/repositories.js"
import type {
  AwardFlightProvider, AwardFlightQuery, AwardSearchResult, CabinClass,
  NormalizedAwardFlight, ProviderHealth, ProviderQuota, TransferOption,
} from "./types.js"

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

const CREDENTIALS_PATH = path.join(homeDir(), ".openclaw", "credentials", "awardtravelfinder.json")
const MONTHLY_LIMIT = 150

const VALID_CABINS: CabinClass[] = ["economy", "premium_economy", "business", "first"]

function transferOptionsFor(programKey: string): TransferOption[] {
  return findTransferPaths(programKey).map(tp => ({
    from: tp.from,
    fromName: tp.fromName,
    ratio: effectiveRatio(tp),
    transferTime: tp.transferTime,
    ...(tp.bonus ? { bonus: tp.bonus } : {}),
  }))
}

export class ATFAwardProvider implements AwardFlightProvider {
  readonly name = "atf"
  readonly confidence = "medium" as const
  readonly callsPerSearch = ATF_AIRLINES.length   // 5

  isEnabled(): boolean {
    return (process.env.ENABLE_ATF ?? "true") !== "false"
  }

  /** ATF ignores search class and flex days (one request per airline per
   *  route+date, all cabins in the response), so those must not fragment the
   *  cache key into duplicate 5-call spends. */
  normalizeCacheQuery(query: AwardFlightQuery): AwardFlightQuery {
    return { ...query, searchClass: "both", flexDays: 0 }
  }

  isConfigured(): boolean {
    return this.isEnabled() && Boolean(process.env.ATF_API_KEY || fs.existsSync(CREDENTIALS_PATH))
  }

  quota(): ProviderQuota {
    const usage = readUsage(getDb(), this.name, currentPeriod())
    return {
      estimatedUsed: usage.attempted,
      budget: MONTHLY_LIMIT,
      reserve: 0,
      automationRemaining: Math.max(0, MONTHLY_LIMIT - usage.attempted),
      reportedRemaining: usage.reportedRemaining,
      reportedLimit: usage.reportedLimit,
      reportedAt: usage.reportedAt,
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    if (!this.isEnabled()) {
      return { provider: this.name, status: "unconfigured", detail: "disabled via ENABLE_ATF=false", latencyMs: null, checkedAt, quota: null }
    }
    if (!this.isConfigured()) {
      return {
        provider: this.name, status: "unconfigured", latencyMs: null, checkedAt, quota: this.quota(),
        detail: `no API key (ATF_API_KEY or ${CREDENTIALS_PATH})`,
      }
    }
    const quota = this.quota()
    const remaining = quota.reportedRemaining ?? quota.automationRemaining
    // Deliberately no network call — a health probe must never spend one of
    // the 150 monthly requests.
    return {
      provider: this.name, status: "ok", latencyMs: null, checkedAt, quota,
      detail: `configured; ~${remaining} of ${quota.reportedLimit ?? MONTHLY_LIMIT} calls remaining ` +
              `(each search costs ${this.callsPerSearch}); covers ${ATF_AIRLINES.length} programs`,
    }
  }

  async search(query: AwardFlightQuery, options: { quotaPreRecorded?: number } = {}): Promise<AwardSearchResult> {
    const started = Date.now()
    if (!this.isEnabled()) {
      return { provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs: 0, completionPct: null, reason: "unconfigured", error: "disabled via ENABLE_ATF=false" }
    }
    if (!this.isConfigured()) {
      return { provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs: 0, completionPct: null, reason: "unconfigured", error: "ATF API key not configured" }
    }

    // Budget guard (mirrors SerpAPI's): a search costs 5 of ~150 monthly calls,
    // so refuse before spending when the allowance is exhausted. The reported
    // limit from ATF wins over the documented default when known.
    const quota = this.quota()
    const limit = quota.reportedLimit ?? MONTHLY_LIMIT
    // estimatedUsed may already include THIS search (the orchestrator
    // pre-records attempts); subtract that before projecting.
    const usedBefore = quota.estimatedUsed - (options.quotaPreRecorded ?? 0)
    if (usedBefore + ATF_AIRLINES.length > limit) {
      const message = `ATF monthly allowance exhausted (${usedBefore}/${limit}, next search needs ${ATF_AIRLINES.length})`
      console.warn(`ATF SKIPPED quota guard — ${message}`)
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs: 0,
        completionPct: null, reason: "budget-exhausted", error: message,
      }
    }

    try {
      const results = await searchATF(query.origin, query.destination, query.departureDate)
      const latencyMs = Date.now() - started
      const flights = this.normalise(results, query)

      // Surface the quota ATF itself reports so accounting can store it.
      const reported = this.extractReportedQuota(results)

      if (flights.length === 0) {
        const failed = results.filter(r => r.error || !r.response?.success)
        const allFailed = failed.length === results.length
        return {
          provider: this.name, ok: false, flights: [], callsSpent: ATF_AIRLINES.length, latencyMs,
          completionPct: null,
          reason: allFailed ? "provider-error" : "no-results",
          error: allFailed
            ? results.map(r => `${r.airline}: ${r.error || "success=false"}`).join("; ").slice(0, 300)
            : "no available award cabins on this route/date",
          ...(reported ? { reportedQuota: reported } : {}),
          // Some airlines answered "nothing available" but others failed
          // outright - an empty result that must NOT be cached as confirmed
          // emptiness, or the failed airlines' absence freezes for the TTL.
          ...(!allFailed && failed.length > 0 ? { partial: true } : {}),
        }
      }
      // Airlines whose check failed outright (transport error or API-reported
      // failure) — different from success=true with no available cabins, which
      // is a legitimate "no seats" answer.
      const failedAirlines = results
        .filter(r => r.error || !r.response?.success)
        .map(r => r.airline)
      const partial = failedAirlines.length > 0

      return {
        provider: this.name, ok: true, flights, callsSpent: ATF_AIRLINES.length, latencyMs,
        completionPct: Math.round(((ATF_AIRLINES.length - failedAirlines.length) / ATF_AIRLINES.length) * 100),
        ...(reported ? { reportedQuota: reported } : {}),
        ...(partial ? { partial: true, error: `airline check(s) failed: ${failedAirlines.join(", ")}` } : {}),
      }
    } catch (err) {
      return {
        provider: this.name, ok: false, flights: [], callsSpent: ATF_AIRLINES.length,
        latencyMs: Date.now() - started, completionPct: null,
        reason: "provider-error", error: (err as Error).message,
      }
    }
  }

  /** Last usage block ATF returned, if any. */
  private extractReportedQuota(results: ATFResult[]): { remaining: number; limit: number } | null {
    for (let i = results.length - 1; i >= 0; i--) {
      const usage = results[i]?.response?.usage
      if (usage && typeof usage.remaining_calls === "number") {
        return { remaining: usage.remaining_calls, limit: usage.monthly_limit ?? MONTHLY_LIMIT }
      }
    }
    return null
  }

  private normalise(results: ATFResult[], query: AwardFlightQuery): NormalizedAwardFlight[] {
    const out: NormalizedAwardFlight[] = []

    for (const result of results) {
      if (result.error || !result.response?.success || !result.response.data) continue
      const meta = ATF_AIRLINE_META[result.airline]
      const cabins = result.response.data.availability?.cabins || {}

      for (const [cabinKey, cabin] of Object.entries(cabins)) {
        if (!cabin?.available || !cabin.points) continue
        if (!VALID_CABINS.includes(cabinKey as CabinClass)) continue

        // GBP taxes converted at an approximate fixed rate — same behaviour as
        // the Phase 2 pipeline; kept until a real FX layer exists.
        let taxesAmount = cabin.taxes ?? null
        let taxesCurrency = cabin.taxes_currency || "USD"
        if (taxesAmount !== null && taxesCurrency === "GBP") {
          taxesAmount = Math.round(taxesAmount * 1.27)
          taxesCurrency = "USD"
        }

        out.push({
          // ATF has no times or flight numbers, so this identity is
          // route+date+cabin+airline — the honest granularity of the data.
          itineraryHash: itineraryHash({
            origin: query.origin,
            destination: query.destination,
            departureDate: query.departureDate,
            returnDate: query.returnDate ?? null,
            cabin: cabinKey,
            airlines: [meta.name],
          }),
          origin: query.origin.toUpperCase(),
          destination: query.destination.toUpperCase(),
          departureDate: query.departureDate,
          departureTime: null,
          arrivalTime: null,
          returnDate: query.returnDate ?? null,
          airline: meta.name,
          operatingAirlines: [meta.name],
          flightNumbers: [],
          stops: null,               // not exposed by ATF — null, not 0
          durationMinutes: null,
          airports: [query.origin.toUpperCase(), query.destination.toUpperCase()],
          cabin: cabinKey as CabinClass,
          equipment: [],
          loyaltyProgram: meta.programKey,
          loyaltyProgramName: meta.programName,
          points: cabin.points,
          taxes: taxesAmount !== null ? { amount: taxesAmount, currency: taxesCurrency } : null,
          availableSeats: cabin.seats ?? null,
          transferOptions: transferOptionsFor(meta.programKey),
          bookingUrl: buildATFBookingUrl(result.airline, query.origin, query.destination, query.departureDate, cabinKey),
          provider: this.name,
          fetchedAt: new Date().toISOString(),
          verificationLevel: "discovered",
          providerConfidence: this.confidence,
          providerScore: null,
          raw: { atfAirline: result.airline, responseType: result.response.data.response_type },
        })
      }
    }
    return out
  }
}
