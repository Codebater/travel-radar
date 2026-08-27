/**
 * Cash flight provider contract.
 *
 * The application talks to this interface only — never to SerpAPI, Google or
 * any other vendor directly. Adding or removing a provider must not require
 * touching the search orchestrator or the value engine.
 */

export type CabinClass = "economy" | "premium_economy" | "business" | "first"

/**
 * How much we trust that this price is real and bookable right now.
 *   cached     — replayed from our own store, not re-fetched
 *   discovered — a free/unmetered provider found it; good enough to spot an anomaly
 *   verified   — a metered provider we pay for confirmed it
 */
export type VerificationLevel = "cached" | "discovered" | "verified"

/**
 * Application metadata, not a statistical claim. It reflects how complete and
 * how trustworthy a given provider's output tends to be, nothing more.
 */
export type ProviderConfidence = "high" | "medium" | "low"

export type ProviderKind = "free" | "metered"

export type ProviderStatus = "ok" | "degraded" | "unconfigured" | "error"

/** A price is never a bare number — it always carries its ISO 4217 currency. */
export interface Money {
  amount: number
  currency: string
}

export interface BaggageInfo {
  carryOn?: number | null
  checked?: number | null
  note?: string | null
}

export interface NormalizedSegment {
  origin: string
  destination: string
  departureTime: string | null   // ISO 8601 local, no zone offset available from all providers
  arrivalTime: string | null
  airline: string | null
  flightNumber: string | null
  durationMinutes: number | null
  aircraft: string | null
}

/**
 * The single shape every cash provider must produce. Fields a provider cannot
 * supply are null — never faked, never defaulted to a plausible-looking value.
 */
export interface NormalizedCashFlight {
  /** Stable identity across providers — see itineraryHash(). */
  itineraryHash: string

  origin: string
  destination: string
  departureDate: string            // YYYY-MM-DD
  departureTime: string | null
  arrivalTime: string | null
  returnDate: string | null

  airline: string | null           // primary / marketing carrier
  airlines: string[]
  flightNumbers: string[]
  stops: number | null
  segments: NormalizedSegment[]
  cabin: CabinClass
  durationMinutes: number | null

  price: Money
  taxes: Money | null
  baggage: BaggageInfo | null

  bookingUrl: string

  provider: string
  fetchedAt: string                // ISO 8601
  verificationLevel: VerificationLevel
  providerConfidence: ProviderConfidence
  /** Provider's own "is this cheap for this route" hint, where it offers one. */
  priceLevel: "low" | "typical" | "high" | null
}

export interface CashFlightQuery {
  origin: string
  destination: string
  departureDate: string            // YYYY-MM-DD
  returnDate?: string | null
  cabin: CabinClass
  adults: number
  currency: string                 // ISO 4217 requested from the provider
}

export interface ProviderQuota {
  /** What we counted locally. An estimate — never presented as authoritative. */
  estimatedUsed: number
  /** Configured ceiling for automated use. */
  budget: number | null
  /** Calls held back for explicit user-initiated verification. */
  reserve: number
  /** Remaining before automation must stop (excludes the reserve). */
  automationRemaining: number | null
  /** Only set when the provider itself reports it. */
  reportedRemaining: number | null
  reportedLimit: number | null
  reportedAt: string | null
}

export interface ProviderHealth {
  provider: string
  status: ProviderStatus
  detail: string
  latencyMs: number | null
  checkedAt: string
  quota: ProviderQuota | null
}

export type SearchFailureReason =
  | "unconfigured"
  | "budget-exhausted"
  | "provider-error"
  | "timeout"
  | "no-results"

export interface CashFlightSearchResult {
  provider: string
  ok: boolean
  flights: NormalizedCashFlight[]
  /** Set when ok === false. */
  reason?: SearchFailureReason
  error?: string
  /** Number of billable calls this search actually consumed. */
  callsSpent: number
  latencyMs: number
}

/**
 * Options a caller can use to override normal provider policy.
 */
export interface SearchOptions {
  /** Skip the cache and force a live fetch. */
  forceRefresh?: boolean
  /**
   * The user explicitly asked for this (clicked "refresh live price"), which
   * permits spending the reserved metered calls. Automated paths must not set it.
   */
  userInitiated?: boolean
}

/**
 * Every cash flight provider implements this. `search` must never throw —
 * a failing provider returns ok:false so the orchestrator can carry on.
 */
export interface CashFlightProvider {
  readonly name: string
  readonly kind: ProviderKind
  readonly confidence: ProviderConfidence
  /** What a fresh (non-cached) result from this provider is labelled. */
  readonly verificationLevel: Exclude<VerificationLevel, "cached">

  /** Are the credentials/dependencies for this provider present? */
  isConfigured(): boolean

  /** Cheap status probe. Must not perform a billable search. */
  health(): Promise<ProviderHealth>

  /** Current quota picture, or null for providers without one. */
  quota(): ProviderQuota | null

  search(query: CashFlightQuery, options?: SearchOptions): Promise<CashFlightSearchResult>
}
