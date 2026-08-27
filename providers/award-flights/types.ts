/**
 * Award flight provider contract.
 *
 * Mirrors providers/cash-flights/types.ts: the application talks to this
 * interface only, and adding or removing an award source must not require
 * touching the search orchestrator, the value engine or the dashboard.
 *
 * The single most important modelling rule here: AIRLINE and LOYALTY PROGRAM
 * are different things. One Austrian-operated flight may be bookable through
 * Miles & More, Aeroplan, United MileagePlus and LifeMiles at four different
 * prices. Those are four NormalizedAwardFlight rows sharing one itineraryHash —
 * never one row, and never four "duplicates".
 */

import type {
  CabinClass, Money, ProviderConfidence, ProviderHealth, ProviderQuota,
  ProviderStatus, SearchFailureReason,
} from "../cash-flights/types.js"

export type { CabinClass, Money, ProviderConfidence, ProviderHealth, ProviderQuota, ProviderStatus }

/** Roame's native search granularity; ATF ignores it and returns all cabins. */
export type AwardSearchClass = "ECON" | "PREM" | "both"

/**
 * Award provenance.
 *   cached          — replayed from our own store, nothing re-fetched
 *   discovered      — one provider reported it
 *   cross-verified  — two INDEPENDENT providers reported the same
 *                     program + cabin + date availability. The same provider
 *                     returning a fare twice is not verification.
 */
export type AwardVerificationLevel = "cached" | "discovered" | "cross-verified"

export interface TransferOption {
  /** Source currency key, e.g. "chase-ur". */
  from: string
  fromName: string
  /** Standard published ratio (1.0 = 1:1). */
  ratio: number
  transferTime: string
  /**
   * Temporary promotional bonus, only when explicitly known from a dated
   * source. Never fabricated; absent means "no bonus data", not "no bonus".
   */
  bonus?: {
    ratio: number
    startDate: string     // YYYY-MM-DD inclusive
    endDate: string       // YYYY-MM-DD inclusive
    source: string
  }
}

/**
 * One redemption option: a physical itinerary priced by one loyalty program.
 * Fields a provider cannot supply are null — never guessed.
 */
export interface NormalizedAwardFlight {
  /** Physical-flight identity — SHARED across programs pricing the same flight. */
  itineraryHash: string

  origin: string
  destination: string
  departureDate: string             // YYYY-MM-DD
  departureTime: string | null
  arrivalTime: string | null
  returnDate: string | null

  /** Marketing carrier where known. */
  airline: string | null
  /** Operating carrier(s) — who actually flies the metal. */
  operatingAirlines: string[]
  flightNumbers: string[]
  stops: number | null
  durationMinutes: number | null
  airports: string[]
  cabin: CabinClass
  equipment: string[]

  /** The loyalty program pricing this redemption — NOT the airline. */
  loyaltyProgram: string
  loyaltyProgramName: string
  points: number
  taxes: Money | null
  availableSeats: number | null

  /** Ways to fund this program from transferable currencies (from the transfer graph). */
  transferOptions: TransferOption[]

  bookingUrl: string
  provider: string
  fetchedAt: string
  verificationLevel: AwardVerificationLevel
  providerConfidence: ProviderConfidence

  /** Provider's own quality metric where it has one (Roame score). */
  providerScore: number | null
  /** Provider-specific raw fields worth keeping (fare class etc.). */
  raw: Record<string, unknown> | null
}

export interface AwardFlightQuery {
  origin: string
  destination: string
  departureDate: string
  returnDate?: string | null
  searchClass: AwardSearchClass
  adults: number
  /** Roame ±N days. */
  flexDays?: number
}

export interface AwardSearchResult {
  provider: string
  ok: boolean
  flights: NormalizedAwardFlight[]
  reason?: SearchFailureReason
  error?: string
  /** Billable/quota-relevant calls this search consumed (ATF: one per airline). */
  callsSpent: number
  latencyMs: number
  /** Provider-reported completion, where the provider streams results (Roame). */
  completionPct: number | null
  /** Quota the provider itself reported alongside this response (ATF does). */
  reportedQuota?: { remaining: number; limit: number }
  /**
   * ok:true but incomplete: part of the search failed (one Roame class, some
   * ATF airlines). Partial results are served and recorded as observations but
   * MUST NOT be cached — caching one would freeze the missing part's absence
   * for the whole TTL. `error` describes what failed.
   */
  partial?: boolean
}

export interface AwardSearchOptions {
  forceRefresh?: boolean
  /** Cancels a long-running provider search (Roame polling). */
  signal?: AbortSignal
  /**
   * How many of this search's calls the caller ALREADY recorded in
   * provider_usage before invoking search(). The orchestrator pre-records
   * callsPerSearch (so a crash still leaves a trace); a provider's own quota
   * guard must subtract this or it double-counts the in-flight search and
   * refuses too early — and every refusal would inflate usage further.
   */
  quotaPreRecorded?: number
}

/**
 * Every award provider implements this. `search` must never throw — a failing
 * provider returns ok:false and the search carries on without it.
 */
export interface AwardFlightProvider {
  readonly name: string
  readonly confidence: ProviderConfidence
  /** How many quota-relevant calls one search costs (informational). */
  readonly callsPerSearch: number

  /** Enabled via config AND has whatever credentials it needs. */
  isConfigured(): boolean
  /** Explicitly disabled via ENABLE_* config (distinct from unconfigured). */
  isEnabled(): boolean

  /** Cheap status probe. Must never perform a billable or quota-relevant call. */
  health(): Promise<ProviderHealth>
  quota(): ProviderQuota | null

  search(query: AwardFlightQuery, options?: AwardSearchOptions): Promise<AwardSearchResult>

  /**
   * Optionally collapse query dimensions this provider ignores, so its cache
   * key does not fragment. ATF's request is (origin, destination, date) only
   * and always returns all cabins - searching "PREM" after "both" must hit the
   * same entry instead of re-spending 5 of its 150 monthly calls.
   */
  normalizeCacheQuery?(query: AwardFlightQuery): AwardFlightQuery
}
