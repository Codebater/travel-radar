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
