/**
 * Stay (hotel/resort) provider contract.
 *
 * The application talks to this interface only. Every external source is
 * assumed replaceable — Xotelo may disappear, Agoda may block, LiteAPI may
 * revoke radar-style usage, SerpAPI costs money — so nothing outside a
 * provider file may know a provider's name, response shape or quirks. What a
 * provider CAN do is declared as data (`capabilities`), never inferred from
 * which provider it is, and the anomaly engine will consume only the
 * normalized shapes below.
 */

import type {
  Money,
  ProviderConfidence,
  ProviderHealth,
  ProviderKind,
  ProviderQuota,
  SearchFailureReason,
} from "../cash-flights/types.js"

export type { Money, ProviderConfidence, ProviderHealth, ProviderKind, ProviderQuota, SearchFailureReason }

/**
 * The stay funnel's trust ladder, mirroring cash flights' cached/discovered/
 * verified but with an extra rung, because hotel products have an identity
 * problem flights don't: a cheap broad source proves the PRICE moved, a
 * room-level source proves WHAT is being sold (room, board), and a metered
 * source proves it is real at retail.
 *   discovered — a free broad source saw it; enough to spot an anomaly
 *   confirmed  — a room-level source established the actual product
 *   verified   — a metered/high-trust source confirmed it is bookable
 */
export type StayVerificationLevel = "discovered" | "confirmed" | "verified"

/**
 * Board basis is part of product identity, never a detail: an all-inclusive
 * rate and a room-only rate at the same property are different products and
 * must never share a baseline.
 */
export type BoardBasis =
  | "room_only"
  | "breakfast"
  | "half_board"
  | "full_board"
  | "all_inclusive"
  | "unknown"

/** Where a board label came from — a provider field, or property metadata. */
export type BoardSource = "structured" | "property_default" | "unknown"

export type RoomClass = "entry" | "premium" | "suite" | "villa" | "unknown"

/**
 * The collection channel a number came from. Channels price systematically
 * differently (bedbank net vs retail vs official direct), so this is a hard
 * comparability dimension: baselines never mix source classes.
 */
export type SourceClass = "meta" | "retail" | "bedbank" | "official" | "unknown"

/**
 * What a price number actually IS. The single most dangerous number in hotel
 * data is a teaser — a property-level "from" price with no date, room or tax
 * semantics. It is still worth storing, but nothing may treat it as bookable:
 *   lead_in      — property-level teaser; unit and content ambiguous
 *   nightly_room — per room per night for the requested stay
 *   stay_room    — total for the stay, for a specific room
 *   stay_total   — total for the stay, all rooms/guests as queried
 */
export type PriceBasis = "lead_in" | "nightly_room" | "stay_room" | "stay_total"

/** What the price contains. "partial" = some taxes/fees in, some at the desk. */
export type TaxesFeesStatus = "included" | "excluded" | "partial" | "unknown"

/**
 * What a provider can actually deliver, declared as data so orchestration and
 * reporting never special-case provider names.
 */
export interface StayProviderCapabilities {
  /** Prices genuinely respond to the requested check-in/check-out. */
  dateSpecificRates: boolean
  /** Can return a forward day-class calendar for a property. */
  calendar: boolean
  roomLevel: boolean
  structuredBoard: boolean
  cancellation: boolean
  /** What its prices normally contain, as a default expectation only. */
  taxesFees: TaxesFeesStatus
}

/**
 * The single shape every stay provider must produce. Fields a provider cannot
 * supply are null — never faked, never defaulted to a plausible-looking value.
 */
export interface NormalizedStayRate {
  /** Canonical registry id — providers echo it from the query, never invent it. */
  propertyId: string
  /** The provider-native identity this rate was fetched with. */
  providerPropertyRef: string

  checkIn: string                  // YYYY-MM-DD
  checkOut: string
  nights: number
  adults: number
  children: number

  roomName: string | null          // provider's own words, unmodified
  roomClass: RoomClass | null
  board: BoardBasis
  boardSource: BoardSource
  refundable: boolean | null
  cancellationDeadline: string | null

  /** The OTA/channel actually quoting, where the provider reports one. */
  rateSource: string | null
  sourceClass: SourceClass

  price: Money
  priceBasis: PriceBasis
  taxesFees: TaxesFeesStatus
  taxesFeesAmount: number | null

  provider: string
  fetchedAt: string                // ISO 8601, our clock
  /** The provider's own data timestamp, when it reports one (cache age). */
  providerAsOf: string | null
  verificationLevel: StayVerificationLevel
  confidence: ProviderConfidence
}

export interface StayRateQuery {
  propertyId: string
  /** Resolved by the caller from stay_property_refs — providers never look it up. */
  providerRef: string
  checkIn: string                  // YYYY-MM-DD
  checkOut: string
  adults: number
  children: number
  currency: string                 // ISO 4217 requested from the provider
}

export interface StayCalendarQuery {
  propertyId: string
  providerRef: string
  /** How far forward the calendar should reach, from today. */
  horizonDays: number
}

export type StayDayClass = "cheap" | "average" | "high"

export interface StayCalendarDay {
  date: string                     // YYYY-MM-DD
  dayClass: StayDayClass
}

export interface StayRateSearchResult {
  provider: string
  ok: boolean
  rates: NormalizedStayRate[]
  /** Set when ok === false. */
  reason?: SearchFailureReason
  error?: string
  /** Number of billable calls this search actually consumed. */
  callsSpent: number
  latencyMs: number
  /** Raw provider payload, present only when options.captureRaw was set. */
  raw?: unknown
}

export interface StayCalendarResult {
  provider: string
  ok: boolean
  propertyId: string
  days: StayCalendarDay[]
  reason?: SearchFailureReason
  error?: string
  callsSpent: number
  latencyMs: number
  raw?: unknown
}

export interface StaySearchOptions {
  /**
   * Keep the raw provider payload on the result so the caller can persist it
   * as a parser-regression fixture. Off by default — raw payloads are large
   * and only fixture capture wants them.
   */
  captureRaw?: boolean
  timeoutMs?: number
}

/**
 * Every stay provider implements this. `searchRates` and `fetchCalendar` must
 * never throw — a failing provider returns ok:false so the orchestrator (and
 * later the scheduler) carries on with the providers that still work.
 */
export interface StayProvider {
  readonly name: string
  readonly kind: ProviderKind
  readonly confidence: ProviderConfidence
  /** What a fresh result from this provider is labelled. */
  readonly verificationLevel: StayVerificationLevel
  readonly capabilities: StayProviderCapabilities

  /** Are the credentials/dependencies for this provider present? */
  isConfigured(): boolean

  /** Cheap status probe. Must not perform a billable or countable fetch. */
  health(): Promise<ProviderHealth>

  /** Current quota picture, or null for providers without one. */
  quota(): ProviderQuota | null

  searchRates(query: StayRateQuery, options?: StaySearchOptions): Promise<StayRateSearchResult>

  /** Only present when capabilities.calendar is true. */
  fetchCalendar?(query: StayCalendarQuery, options?: StaySearchOptions): Promise<StayCalendarResult>
}
