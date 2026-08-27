/**
 * Provider mocks. Automated tests must never call SerpAPI, Roame, ATF,
 * AwardWallet or Google — every test in this suite runs offline against these.
 */

import { itineraryHash } from "../cache/key.js"
import type {
  CashFlightProvider, CashFlightQuery, CashFlightSearchResult,
  NormalizedCashFlight, ProviderConfidence, ProviderHealth, ProviderKind,
  ProviderQuota, SearchOptions, VerificationLevel,
} from "../providers/cash-flights/types.js"

export function makeQuery(over: Partial<CashFlightQuery> = {}): CashFlightQuery {
  return {
    origin: "PRG",
    destination: "BKK",
    departureDate: "2026-11-10",
    returnDate: "2026-11-20",
    cabin: "business",
    adults: 1,
    currency: "EUR",
    ...over,
  }
}

export function makeFlight(over: Partial<NormalizedCashFlight> = {}): NormalizedCashFlight {
  const base = {
    origin: "PRG",
    destination: "BKK",
    departureDate: "2026-11-10",
    departureTime: "2026-11-10T14:55",
    arrivalTime: "2026-11-11T13:05",
    returnDate: "2026-11-20",
    cabin: "business" as const,
    airlines: ["Qatar Airways"],
    stops: 1,
    durationMinutes: 730,
  }
  const flight: NormalizedCashFlight = {
    itineraryHash: "",
    ...base,
    airline: "Qatar Airways",
    flightNumbers: [],
    segments: [],
    price: { amount: 405, currency: "EUR" },
    taxes: null,
    baggage: null,
    bookingUrl: "https://example.invalid/book",
    provider: "mock",
    fetchedAt: new Date().toISOString(),
    verificationLevel: "discovered" as VerificationLevel,
    providerConfidence: "medium" as ProviderConfidence,
    priceLevel: null,
    ...over,
  }

  // Derive the identity from the final values, exactly as a real provider does —
  // otherwise an override like `arrivalTime` would not change the hash and the
  // mock would misrepresent how deduplication behaves.
  if (!over.itineraryHash) flight.itineraryHash = itineraryHash(flight)
  return flight
}

export interface MockOptions {
  name?: string
  kind?: ProviderKind
  confidence?: ProviderConfidence
  verificationLevel?: "discovered" | "verified"
  configured?: boolean
  /** Results to return; ignored when `fail` is set. */
  flights?: NormalizedCashFlight[]
  /** Make every search fail with this reason. */
  fail?: CashFlightSearchResult["reason"]
  /** Throw instead of returning — proves the orchestrator survives a bad provider. */
  throws?: boolean
  callsPerSearch?: number
}

export class MockProvider implements CashFlightProvider {
  readonly name: string
  readonly kind: ProviderKind
  readonly confidence: ProviderConfidence
  readonly verificationLevel: "discovered" | "verified"

  /** Every search this provider was asked to perform. */
  readonly calls: { query: CashFlightQuery; options: SearchOptions }[] = []

  constructor(private readonly opts: MockOptions = {}) {
    this.name = opts.name ?? "mock"
    this.kind = opts.kind ?? "free"
    this.confidence = opts.confidence ?? "medium"
    this.verificationLevel = opts.verificationLevel ?? "discovered"
  }

  isConfigured(): boolean {
    return this.opts.configured !== false
  }

  quota(): ProviderQuota | null {
    return null
  }

  async health(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      status: this.isConfigured() ? "ok" : "unconfigured",
      detail: "mock provider",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      quota: null,
    }
  }

  async search(query: CashFlightQuery, options: SearchOptions = {}): Promise<CashFlightSearchResult> {
    this.calls.push({ query, options })

    if (this.opts.throws) throw new Error("mock provider exploded")

    if (this.opts.fail) {
      return {
        provider: this.name, ok: false, flights: [],
        reason: this.opts.fail, error: `mock failure: ${this.opts.fail}`,
        callsSpent: this.opts.callsPerSearch ?? 0, latencyMs: 1,
      }
    }

    const flights = (this.opts.flights ?? [makeFlight()]).map(f => ({
      ...f,
      provider: this.name,
      verificationLevel: this.verificationLevel,
      providerConfidence: this.confidence,
    }))

    return {
      provider: this.name, ok: true, flights,
      callsSpent: this.opts.callsPerSearch ?? (this.kind === "metered" ? 1 : 0),
      latencyMs: 1,
    }
  }
}

// ─── Award mocks (Phase 3) ───────────────────────────────────────────────────

import { itineraryHash as hashItinerary } from "../cache/key.js"
import type {
  AwardFlightProvider, AwardFlightQuery, AwardSearchOptions, AwardSearchResult,
  NormalizedAwardFlight,
} from "../providers/award-flights/types.js"

export function makeAwardQuery(over: Partial<AwardFlightQuery> = {}): AwardFlightQuery {
  return {
    origin: "PRG",
    destination: "BKK",
    departureDate: "2026-11-10",
    returnDate: null,
    searchClass: "PREM",
    adults: 1,
    flexDays: 0,
    ...over,
  }
}

/**
 * A synthetic Austrian-operated VIE→BKK-style award. The itinerary hash derives
 * from the physical-flight fields, so the same flight priced by two programs
 * shares a hash — exactly what the multi-program tests need.
 */
export function makeAwardFlight(over: Partial<NormalizedAwardFlight> = {}): NormalizedAwardFlight {
  const base = {
    origin: "PRG",
    destination: "BKK",
    departureDate: "2026-11-10",
    departureTime: "2026-11-10T10:20",
    arrivalTime: "2026-11-11T06:15",
    returnDate: null as string | null,
    cabin: "business" as const,
    operatingAirlines: ["OS"],
    stops: 1,
    durationMinutes: 715,
  }
  const merged = { ...base, ...over }
  const flight: NormalizedAwardFlight = {
    itineraryHash: "",
    origin: merged.origin,
    destination: merged.destination,
    departureDate: merged.departureDate,
    departureTime: merged.departureTime,
    arrivalTime: merged.arrivalTime,
    returnDate: merged.returnDate,
    airline: null,
    operatingAirlines: merged.operatingAirlines,
    flightNumbers: ["OS 25"],
    stops: merged.stops,
    durationMinutes: merged.durationMinutes,
    airports: [merged.origin, "VIE", merged.destination],
    cabin: merged.cabin,
    equipment: ["77W"],
    loyaltyProgram: "AEROPLAN",
    loyaltyProgramName: "Aeroplan",
    points: 70000,
    taxes: { amount: 80, currency: "USD" },
    availableSeats: 2,
    transferOptions: [],
    bookingUrl: "https://example.invalid/award",
    provider: "mock-award",
    fetchedAt: new Date().toISOString(),
    verificationLevel: "discovered",
    providerConfidence: "medium",
    providerScore: null,
    raw: null,
    ...over,
  }
  if (!over.itineraryHash) {
    flight.itineraryHash = hashItinerary({
      origin: flight.origin, destination: flight.destination,
      departureDate: flight.departureDate, departureTime: flight.departureTime,
      arrivalTime: flight.arrivalTime, returnDate: flight.returnDate,
      cabin: flight.cabin, airlines: flight.operatingAirlines,
      stops: flight.stops, durationMinutes: flight.durationMinutes,
    })
  }
  return flight
}

export interface MockAwardOptions {
  name?: string
  configured?: boolean
  enabled?: boolean
  flights?: NormalizedAwardFlight[]
  fail?: AwardSearchResult["reason"]
  throws?: boolean
  callsPerSearch?: number
  reportedQuota?: { remaining: number; limit: number }
  /** Artificial latency, to exercise concurrent-collapse behaviour. */
  delayMs?: number
}

export class MockAwardProvider implements AwardFlightProvider {
  readonly name: string
  readonly confidence = "medium" as const
  readonly callsPerSearch: number
  readonly calls: { query: AwardFlightQuery; options: AwardSearchOptions }[] = []

  constructor(private readonly opts: MockAwardOptions = {}) {
    this.name = opts.name ?? "mock-award"
    this.callsPerSearch = opts.callsPerSearch ?? 1
  }

  isEnabled(): boolean { return this.opts.enabled !== false }
  isConfigured(): boolean { return this.isEnabled() && this.opts.configured !== false }
  quota() { return null }

  async health() {
    return {
      provider: this.name,
      status: this.isConfigured() ? "ok" as const : "unconfigured" as const,
      detail: "mock award provider", latencyMs: 0,
      checkedAt: new Date().toISOString(), quota: null,
    }
  }

  async search(query: AwardFlightQuery, options: AwardSearchOptions = {}): Promise<AwardSearchResult> {
    this.calls.push({ query, options })
    if (this.opts.delayMs) await new Promise(r => setTimeout(r, this.opts.delayMs))
    if (this.opts.throws) throw new Error("mock award provider exploded")
    if (this.opts.fail) {
      return {
        provider: this.name, ok: false, flights: [], callsSpent: this.callsPerSearch,
        latencyMs: 1, completionPct: null,
        reason: this.opts.fail, error: `mock failure: ${this.opts.fail}`,
      }
    }
    const flights = (this.opts.flights ?? [makeAwardFlight()]).map(f => ({
      ...f, provider: this.name, verificationLevel: "discovered" as const,
    }))
    return {
      provider: this.name, ok: true, flights, callsSpent: this.callsPerSearch,
      latencyMs: 1, completionPct: 100,
      ...(this.opts.reportedQuota ? { reportedQuota: this.opts.reportedQuota } : {}),
    }
  }
}

/** Synthetic balances for tests — NEVER real figures (see §private balances). */
export function syntheticBalances() {
  return [
    { programKey: "chase-ur", program: "Chase UR (synthetic)", balance: 100000 },
    { programKey: "AEROPLAN", program: "Aeroplan (synthetic)", balance: 50000 },
    { programKey: "FLYING_BLUE", program: "Flying Blue (synthetic)", balance: 20000 },
  ]
}
