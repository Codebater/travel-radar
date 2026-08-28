/**
 * fast-flights (Google Flights) — free, unmetered discovery provider.
 *
 * Phase 2 diagnostics found the Phase 1 failure was not Google blocking us: an
 * un-consented request gets a language-selection interstitial with HTTP 200 and
 * no flights. Sending the standard SOCS consent cookie fixes it. Verified
 * 10/10 across PRG-BKK and VIE-CUN, economy and business, one-way and
 * round-trip, at ~0.5s per call. See scripts/google-flights.py.
 *
 * Confidence is "medium", not "high": this is a scraped source with no
 * contractual guarantee and no tax or baggage breakdown. Results are labelled
 * `discovered` and are meant to be confirmed by a metered provider before being
 * treated as a bookable price.
 */

import path from "path"
import { runPythonJson, runPythonJsonSync, resolvePython } from "./python-bridge.js"
import { itineraryHash } from "../../cache/key.js"
import type {
  CashFlightProvider, CashFlightQuery, CashFlightSearchResult,
  NormalizedCashFlight, NormalizedSegment, ProviderHealth,
} from "./types.js"

const SCRIPT = path.join("scripts", "google-flights.py")
const TIMEOUT_MS = 45_000

/** Cabin names used by our contract vs. those fast-flights accepts. */
const CABIN_TO_FF: Record<string, string> = {
  economy: "economy",
  premium_economy: "premium-economy",
  business: "business",
  first: "first",
}

interface FFSegment {
  origin: string | null
  destination: string | null
  departureTime: string | null
  arrivalTime: string | null
  durationMinutes: number | null
  aircraft: string | null
}

interface FFItinerary {
  price: number | null
  currency: string
  airlines: string[]
  carrierCode: string | null
  segments: FFSegment[]
  stops: number | null
  durationMinutes: number | null
  departureTime: string | null
  arrivalTime: string | null
}

interface FFPayload {
  ok: boolean
  reason?: string
  error?: string
  flights: FFItinerary[]
  count?: number
  currency?: string
}

function googleFlightsUrl(q: CashFlightQuery): string {
  const leg = `${q.origin} to ${q.destination} on ${q.departureDate}`
  const full = q.returnDate ? `${leg} returning ${q.returnDate}` : `${leg} one way`
  return `https://www.google.com/travel/flights?q=${encodeURIComponent("Flights " + full)}`
}

export class FastFlightsProvider implements CashFlightProvider {
  readonly name = "fast_flights"
  readonly kind = "free" as const
  readonly confidence = "medium" as const
  readonly verificationLevel = "discovered" as const

  private available: boolean | null = null

  isConfigured(): boolean {
    if (this.available !== null) return this.available
    // A cheap import probe — no network, no search.
    const probe = runPythonJsonSync<{ ok: boolean }>(
      path.join("scripts", "_probe_fast_flights.py"), [], 20_000,
    )
    // The probe script is optional; fall back to assuming configured and let
    // the first real search report the truth.
    this.available = probe.ok ? Boolean(probe.data?.ok) : true
    return this.available
  }

  quota() {
    return null   // unmetered
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const probe = await runPythonJson<{ ok: boolean; version?: string; error?: string }>(
      path.join("scripts", "_probe_fast_flights.py"), [], 20_000,
    )
    const latencyMs = Date.now() - started

    if (!probe.ok || !probe.data) {
      return {
        provider: this.name, status: "error", latencyMs, checkedAt: new Date().toISOString(),
        detail: probe.error || "probe failed", quota: null,
      }
    }
    if (!probe.data.ok) {
      return {
        provider: this.name, status: "unconfigured", latencyMs, checkedAt: new Date().toISOString(),
        detail: probe.data.error || `Python deps missing — run: ${resolvePython()} -m pip install -r requirements.txt`,
        quota: null,
      }
    }
    return {
      provider: this.name, status: "ok", latencyMs, checkedAt: new Date().toISOString(),
      detail: `fast-flights ${probe.data.version ?? "?"} ready (free, unmetered)`,
      quota: null,
    }
  }

  async search(query: CashFlightQuery): Promise<CashFlightSearchResult> {
    const started = Date.now()
    const cabin = CABIN_TO_FF[query.cabin] || "economy"

    const argv = [
      query.origin, query.destination, query.departureDate,
      "--class", cabin,
      "--currency", query.currency,
      "--adults", String(Math.max(1, query.adults)),
    ]
    if (query.returnDate) argv.push("--return", query.returnDate)

    const run = await runPythonJson<FFPayload>(SCRIPT, argv, TIMEOUT_MS)
    const latencyMs = Date.now() - started

    if (!run.ok || !run.data) {
      const timedOut = (run.error || "").includes("timed out")
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs,
        reason: timedOut ? "timeout" : "provider-error",
        error: run.error || "helper failed",
      }
    }

    const payload = run.data
    if (!payload.ok) {
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs,
        reason: payload.reason === "unconfigured" ? "unconfigured" : "provider-error",
        error: payload.error || "provider reported failure",
      }
    }

    // One clock reading for the whole search - see normalise().
    const fetchedAt = new Date().toISOString()
    const priced = payload.flights.filter(f => typeof f.price === "number" && f.price > 0)

    // Currency defence: a price is only stored under the REQUESTED currency
    // when the helper states exactly that currency for it. A stated different
    // currency is a proven mismatch and an unstated one is unknown — neither
    // is ever relabelled as the requested currency, and a currency is never
    // invented. (The helper echoes the requested currency today, so this
    // costs nothing in normal operation and bites only when that changes.)
    const wanted = query.currency.trim().toUpperCase()
    const currencyProblems = new Set<string>()
    const flights: NormalizedCashFlight[] = []
    for (const f of priced) {
      const stated = (f.currency || payload.currency || "").trim().toUpperCase()
      if (!stated) { currencyProblems.add("unstated"); continue }
      if (stated !== wanted) { currencyProblems.add(stated); continue }
      flights.push(this.normalise(f, query, fetchedAt, stated))
    }

    if (flights.length === 0) {
      if (currencyProblems.size > 0) {
        return {
          provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs,
          reason: "provider-error",
          error: `currency could not be established as ${wanted} `
            + `(provider stated: ${[...currencyProblems].join(", ")}) — refusing to label prices`,
        }
      }
      return {
        provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs,
        reason: "no-results", error: "provider returned no priced itineraries",
      }
    }

    return { provider: this.name, ok: true, flights, callsSpent: 0, latencyMs }
  }

  private normalise(f: FFItinerary, query: CashFlightQuery, fetchedAt: string, currency: string): NormalizedCashFlight {
    const segments: NormalizedSegment[] = f.segments.map(s => ({
      origin: s.origin || query.origin,
      destination: s.destination || query.destination,
      departureTime: s.departureTime,
      arrivalTime: s.arrivalTime,
      // fast-flights reports carriers per itinerary, not per leg.
      airline: null,
      flightNumber: null,
      durationMinutes: s.durationMinutes,
      aircraft: s.aircraft,
      // The free Google path never states per-segment cabins; unknown stays null.
      cabin: null,
    }))

    const airlines = f.airlines.filter(Boolean)
    const departureDate = f.departureTime?.slice(0, 10) || query.departureDate

    return {
      itineraryHash: itineraryHash({
        origin: query.origin,
        destination: query.destination,
        departureDate,
        departureTime: f.departureTime,
        arrivalTime: f.arrivalTime,
        returnDate: query.returnDate ?? null,
        cabin: query.cabin,
        airlines,
        stops: f.stops,
        durationMinutes: f.durationMinutes,
      }),
      origin: query.origin.toUpperCase(),
      destination: query.destination.toUpperCase(),
      departureDate,
      departureTime: f.departureTime,
      arrivalTime: f.arrivalTime,
      returnDate: query.returnDate ?? null,
      airline: airlines[0] ?? null,
      airlines,
      // Google Flights does not expose flight numbers in this payload.
      flightNumbers: [],
      stops: f.stops,
      segments,
      cabin: query.cabin,
      durationMinutes: f.durationMinutes,
      price: { amount: f.price!, currency },   // validated against the request in search()
      // Not exposed by this source — left null rather than guessed.
      taxes: null,
      baggage: null,
      bookingUrl: googleFlightsUrl(query),
      provider: this.name,
      // One reading per search — a per-row clock makes same-fetch rows look
      // like each other's history to anything that orders by fetched_at.
      fetchedAt,
      verificationLevel: this.verificationLevel,
      providerConfidence: this.confidence,
      priceLevel: null,
    }
  }
}
