/**
 * Hotel award provider contract — provider-neutral like cash-flights.
 *
 * The application talks to this interface only. Hotel AWARD observations are
 * a separate product from cash stay observations and never blend with them;
 * valuation (cash vs points vs buy-points) is a later phase and nothing here
 * anticipates it.
 *
 * Load-bearing honesty rules every provider must obey:
 *   - an N-night award quote exists ONLY when the source quoted that stay
 *     (`quoteBasis: "full_stay"`); a nightly price is NEVER multiplied into
 *     a stay total by us;
 *   - pointsTotal / pointsPerNight only when the source states them;
 *   - unknown taxes are a state, never zero;
 *   - programs, dates, nights and property identity are echo-checked;
 *   - blocked / empty / incomplete outcomes are structured states — search
 *     never throws.
 */

export type HotelAwardQuoteBasis = "full_stay" | "per_night"
export type HotelAwardTaxesState = "stated" | "included" | "unknown"
export type HotelAwardAvailability = "available" | "unavailable" | "unknown"
export type HotelAwardType = "points" | "points_plus_cash" | "unknown"

/** Honest walk/search outcomes — vocabulary informed by measured reality
 *  (the getaway walker's states): a clamp or a wall is recorded, never
 *  papered over. */
export type HotelAwardSearchState = "complete" | "empty" | "night_clamped" | "blocked" | "incomplete"

export interface HotelAwardQuery {
  /** Free-text destination (city/area), exactly what the provider searches. */
  location: string
  /** Optional provider-side narrowing — passed through verbatim. */
  hotelName?: string
  chainName?: string
  checkIn: string                  // YYYY-MM-DD
  checkOut: string
  adults: number
  /** Minimum-nights FILTER passed to the source. LIVE-VERIFIED (2026-08-29):
   *  Roame is an exact-window quote engine — it always returns the requested
   *  check-in and the exact requested night count regardless of this value;
   *  minNights only filters which hotels qualify, it never enumerates
   *  shorter periods. Long-range coverage comes from the sparse window
   *  planner (planner.ts) issuing multiple exact sub-window queries; one
   *  window's quotes are NEVER extrapolated to another (adjacent windows
   *  were measured to price differently). Omitted = config default, else the
   *  window length. Gondola ignores this field. */
  minNights?: number
}

export interface NormalizedHotelAward {
  provider: string
  providerPropertyRef: string
  /** Our stay_properties id ONLY when an explicit provider ref maps to it —
   *  never matched by name. Null in Phase 1 (no refs exist yet). */
  propertyId: string | null
  propertyName: string
  chain: string | null

  /** Config-mapped program enum; when unmapped, the source's own program
   *  name normalized (explicit either way — never guessed). */
  program: string
  sourceProgramName: string

  checkIn: string
  checkOut: string
  nights: number

  quoteBasis: HotelAwardQuoteBasis
  roomClass: string | null         // null = property-level quote, room unstated
  roomName: string | null

  pointsTotal: number | null       // only when the source states a stay total
  pointsPerNight: number | null    // only when the source states it

  taxesFeesAmount: number | null
  taxesFeesCurrency: string | null
  taxesFeesState: HotelAwardTaxesState

  awardType: HotelAwardType

  /** Labelled cash context from the same response — never a valuation. */
  cashComparisonAmount: number | null
  cashComparisonCurrency: string | null

  availabilityState: HotelAwardAvailability
  searchState: HotelAwardSearchState
  verificationLevel: "cached" | "discovered" | "verified"
  /** The source's own freshness statement, when it makes one. */
  sourceFreshness: string | null

  /** Provider-returned booking/replay URL, verbatim (allowlist-gated later). */
  bookingUrl: string | null

  fetchedAt: string
}

/** Capabilities are DATA — never name checks. */
export interface HotelAwardProviderCapabilities {
  /** Can the source quote a whole multi-night stay as one unit? */
  multiNightQuotes: boolean
  /** Does it state per-night points? */
  statesPointsPerNight: boolean
  /** Does it state award taxes/fees? (Gondola: no — unknown stays unknown.) */
  statesTaxes: boolean
  /** Does it state room name/class on award quotes? */
  statesRooms: boolean
  /** Program coverage is dynamic (whatever the source returns) vs fixed list. */
  dynamicPrograms: boolean
  metered: boolean
}

export type HotelAwardFailureReason =
  | "unconfigured"
  | "blocked"
  | "provider-error"
  | "timeout"
  | "format-changed"
  | "budget-exhausted"

export interface HotelAwardSearchResult {
  provider: string
  ok: boolean
  searchState: HotelAwardSearchState
  awards: NormalizedHotelAward[]
  reason?: HotelAwardFailureReason
  error?: string
  callsSpent: number
  latencyMs: number
  /** The minimum-nights value the provider ACTUALLY searched with, when the
   *  provider supports discovery. Differs from the requested minimum only on
   *  a night_clamped result (a known cap reduced it) — never silently. */
  appliedMinNights?: number
}

/** Every hotel award provider implements this. `search` must never throw. */
export interface HotelAwardProvider {
  readonly name: string
  readonly capabilities: HotelAwardProviderCapabilities
  isConfigured(): boolean
  search(query: HotelAwardQuery): Promise<HotelAwardSearchResult>
}
