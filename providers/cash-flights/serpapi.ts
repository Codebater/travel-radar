/**
 * SerpAPI (Google Flights) — metered verification provider.
 *
 * Phase 2 demotes this from "the default cash source" to "the source that
 * confirms an interesting price". It is the only cash provider with a
 * contractual relationship behind it, so a SerpAPI price is what we call
 * `verified`; it is also the only one with a hard monthly ceiling.
 *
 * Budget rules:
 *   - SERPAPI_MONTHLY_BUDGET is the total the month may spend.
 *   - SERPAPI_RESERVE_CALLS is held back for explicit user-initiated checks.
 *   - Automated code may spend up to (budget - reserve) and no further.
 *   - Attempts, not successes, count against the budget: a 401 still consumed
 *     a request slot as far as we can safely assume.
 */

import { itineraryHash } from "../../cache/key.js"
import { serpApiBudget } from "../../cache/policy.js"
import { getDb, currentPeriod } from "../../db/index.js"
import {
  readUsage, recordCallAttempt, recordCallOutcome, recordReportedQuota,
} from "../../db/repositories.js"
import type {
  CashFlightProvider, CashFlightQuery, CashFlightSearchResult, NormalizedCashFlight,
  NormalizedSegment, ProviderHealth, ProviderQuota, SearchOptions,
} from "./types.js"

const ENDPOINT = "https://serpapi.com/search"

/** SerpAPI travel_class codes. */
const CABIN_CODE: Record<string, number> = {
  economy: 1, premium_economy: 2, business: 3, first: 4,
}
const CODE_TO_CABIN: Record<number, CashFlightQuery["cabin"]> = {
  1: "economy", 2: "premium_economy", 3: "business", 4: "first",
}

export class SerpApiProvider implements CashFlightProvider {
  readonly name = "serpapi"
  readonly kind = "metered" as const
  readonly confidence = "high" as const
  readonly verificationLevel = "verified" as const

  isConfigured(): boolean {
    return Boolean(process.env.SERP_API_KEY)
  }

  quota(): ProviderQuota {
    const budget = serpApiBudget()
    const usage = readUsage(getDb(), this.name, currentPeriod())
    return {
      estimatedUsed: usage.attempted,
      budget: budget.monthlyBudget,
      reserve: budget.reserveCalls,
      automationRemaining: Math.max(0, budget.automationCeiling - usage.attempted),
      reportedRemaining: usage.reportedRemaining,
      reportedLimit: usage.reportedLimit,
      reportedAt: usage.reportedAt,
    }
  }

  /**
   * Whether a call may proceed. Automated callers stop at the automation
   * ceiling; only an explicit user action may dip into the reserve.
   */
  private budgetCheck(userInitiated: boolean): { allowed: boolean; message: string } {
    const budget = serpApiBudget()
    const used = this.quota().estimatedUsed

    if (used >= budget.monthlyBudget) {
      return {
        allowed: false,
        message: `SerpAPI monthly budget exhausted (${used}/${budget.monthlyBudget}); cached/free-provider results shown`,
      }
    }
    if (!userInitiated && used >= budget.automationCeiling) {
      return {
        allowed: false,
        message:
          `SerpAPI automation budget exhausted (${used}/${budget.automationCeiling}, ` +
          `${budget.reserveCalls} calls reserved for manual verification); cached/free-provider results shown`,
      }
    }
    return { allowed: true, message: "" }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    const quota = this.quota()

    if (!this.isConfigured()) {
      return {
        provider: this.name, status: "unconfigured", latencyMs: null, checkedAt,
        detail: "SERP_API_KEY not set", quota,
      }
    }

    const guard = this.budgetCheck(false)
    if (!guard.allowed) {
      return {
        provider: this.name, status: "degraded", latencyMs: null, checkedAt,
        detail: guard.message, quota,
      }
    }

    // Deliberately does not call SerpAPI: a health check must never be billable.
    const remaining = quota.automationRemaining ?? 0
    return {
      provider: this.name, status: "ok", latencyMs: null, checkedAt,
      detail: `configured; ${remaining}/${serpApiBudget().automationCeiling} automation calls remaining`,
      quota,
    }
  }

  async search(query: CashFlightQuery, options: SearchOptions = {}): Promise<CashFlightSearchResult> {
    const started = Date.now()
    const db = getDb()

    if (!this.isConfigured()) {
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 0,
        latencyMs: Date.now() - started, reason: "unconfigured",
        error: "SERP_API_KEY not set",
      }
    }

    const guard = this.budgetCheck(Boolean(options.userInitiated))
    if (!guard.allowed) {
      console.warn(`SERPAPI SKIPPED budget${options.userInitiated ? "" : " reserve"} — ${guard.message}`)
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 0,
        latencyMs: Date.now() - started, reason: "budget-exhausted", error: guard.message,
      }
    }

    const travelClass = CABIN_CODE[query.cabin] ?? 1
    const params = new URLSearchParams({
      engine: "google_flights",
      departure_id: query.origin,
      arrival_id: query.destination,
      outbound_date: query.departureDate,
      type: query.returnDate ? "1" : "2",
      travel_class: String(travelClass),
      adults: String(Math.max(1, query.adults)),
      currency: query.currency,
      hl: "en",
      api_key: process.env.SERP_API_KEY!,
    })
    if (query.returnDate) params.set("return_date", query.returnDate)

    // Counted before the request so a crash mid-flight still leaves a trace.
    recordCallAttempt(db, this.name)

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      let resp: Response
      try {
        resp = await fetch(`${ENDPOINT}?${params}`, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "")
        const error = `HTTP ${resp.status}: ${body.slice(0, 160)}`
        recordCallOutcome(db, this.name, { ok: false, error })
        return {
          provider: this.name, ok: false, flights: [], callsSpent: 1,
          latencyMs: Date.now() - started, reason: "provider-error", error,
        }
      }

      const data = await resp.json() as any

      // SerpAPI reports its own account totals; store them apart from our estimate.
      const info = data.search_metadata || data.account
      if (info && typeof info.total_searches_left === "number") {
        recordReportedQuota(db, this.name, {
          remaining: info.total_searches_left,
          limit: typeof info.searches_per_month === "number" ? info.searches_per_month : null,
        })
      }

      const flights = this.normalise(data, query, travelClass)
      recordCallOutcome(db, this.name, { ok: true })

      if (flights.length === 0) {
        return {
          provider: this.name, ok: false, flights: [], callsSpent: 1,
          latencyMs: Date.now() - started, reason: "no-results",
          error: "SerpAPI returned no priced itineraries",
        }
      }
      return {
        provider: this.name, ok: true, flights, callsSpent: 1,
        latencyMs: Date.now() - started,
      }
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      const error = aborted ? "request timed out after 30s" : (err as Error).message
      recordCallOutcome(db, this.name, { ok: false, error })
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 1,
        latencyMs: Date.now() - started,
        reason: aborted ? "timeout" : "provider-error", error,
      }
    }
  }

  private normalise(data: any, query: CashFlightQuery, travelClass: number): NormalizedCashFlight[] {
    const cabin = CODE_TO_CABIN[travelClass] || query.cabin
    const fetchedAt = new Date().toISOString()
    const out: NormalizedCashFlight[] = []

    for (const category of ["best_flights", "other_flights"]) {
      for (const itinerary of data[category] || []) {
        const legs: any[] = itinerary.flights || []
        if (legs.length === 0) continue
        if (typeof itinerary.price !== "number" || itinerary.price <= 0) continue

        const first = legs[0]
        const last = legs[legs.length - 1]
        const airlines = [...new Set(legs.map(l => l.airline).filter(Boolean))] as string[]
        const flightNumbers = legs.map(l => l.flight_number).filter(Boolean) as string[]

        const segments: NormalizedSegment[] = legs.map(l => ({
          origin: l.departure_airport?.id || query.origin,
          destination: l.arrival_airport?.id || query.destination,
          departureTime: normaliseTime(l.departure_airport?.time),
          arrivalTime: normaliseTime(l.arrival_airport?.time),
          airline: l.airline || null,
          flightNumber: l.flight_number || null,
          durationMinutes: typeof l.duration === "number" ? l.duration : null,
          aircraft: l.airplane || null,
          cabin: typeof l.travel_class === "string" && l.travel_class ? l.travel_class : null,
        }))

        const departureTime = normaliseTime(first.departure_airport?.time)
        const departureDate = departureTime?.slice(0, 10) || query.departureDate

        out.push({
          itineraryHash: itineraryHash({
            origin: query.origin,
            destination: query.destination,
            departureDate,
            departureTime,
            arrivalTime: normaliseTime(last.arrival_airport?.time),
            returnDate: query.returnDate ?? null,
            cabin,
            airlines,
            stops: (itinerary.layovers || []).length,
            durationMinutes: typeof itinerary.total_duration === "number" ? itinerary.total_duration : null,
          }),
          origin: (first.departure_airport?.id || query.origin).toUpperCase(),
          destination: (last.arrival_airport?.id || query.destination).toUpperCase(),
          departureDate,
          departureTime,
          arrivalTime: normaliseTime(last.arrival_airport?.time),
          returnDate: query.returnDate ?? null,
          airline: airlines[0] ?? null,
          airlines,
          flightNumbers,
          stops: (itinerary.layovers || []).length,
          segments,
          cabin,
          durationMinutes: typeof itinerary.total_duration === "number" ? itinerary.total_duration : null,
          price: { amount: itinerary.price, currency: query.currency },
          // SerpAPI's Google Flights engine returns a total, not a tax split.
          taxes: null,
          baggage: null,
          bookingUrl: itinerary.booking_token
            ? `https://www.google.com/travel/flights/booking?token=${encodeURIComponent(itinerary.booking_token)}`
            : `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights ${query.origin} to ${query.destination} on ${query.departureDate}`)}`,
          provider: this.name,
          fetchedAt,
          verificationLevel: this.verificationLevel,
          providerConfidence: this.confidence,
          priceLevel: data.price_insights?.price_level ?? null,
        })
      }
    }
    return out
  }
}

/** "2026-11-10 14:55" → "2026-11-10T14:55"; anything unparseable → null. */
function normaliseTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/)
  return m ? `${m[1]}T${m[2]}:${m[3]}` : null
}
