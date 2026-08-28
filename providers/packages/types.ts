/**
 * Package (tour-operator flight+hotel bundle) provider contract.
 *
 * Same posture as stays: every seller is replaceable (TUI's CloudFront hosts
 * may rotate, CHECK24 may challenge), so nothing outside a provider file may
 * know a seller's name, response shape or quirks. What a provider CAN do is
 * declared as data, and the comparison layer consumes only the normalized
 * shape below.
 *
 * The package-specific doctrine:
 *   - the package TOTAL is the authoritative price. A flight/hotel split is
 *     stored only when the seller genuinely supplied one, and even then it is
 *     operator-internal pricing, not a market quote.
 *   - inclusions are identity. transfer/baggage status is included /
 *     not_included / unknown — an inclusion is never inferred, only evidenced.
 *   - a package's HOTEL nights (check-in..check-out) are the comparable unit;
 *     trip days (door to door) are carried separately because overnight
 *     long-haul departures make them differ by design.
 */

import type {
  Money,
  ProviderConfidence,
  ProviderHealth,
  ProviderKind,
  ProviderQuota,
  SearchFailureReason,
} from "../cash-flights/types.js"
import type { BoardBasis, BoardSource, RoomClass, TaxesFeesStatus } from "../stays/types.js"

export type { Money, ProviderConfidence, ProviderHealth, ProviderKind, ProviderQuota }
export type { BoardBasis, BoardSource, RoomClass, TaxesFeesStatus }

/**
 * The package trust ladder:
 *   discovered — a broad seasonal sweep saw it (Tier 0 calendar)
 *   confirmed  — a dated, room-level offer from the same seller (Tier 1)
 *   verified   — an INDEPENDENT second seller quoted the same product (Tier 2)
 */
export type PackageVerificationLevel = "discovered" | "confirmed" | "verified"

/** "blocked" is package-specific: a bot wall answered instead of the API.
 *  The response to blocked is stop/degrade, never retry or circumvent. */
export type PackageFailureReason = SearchFailureReason | "blocked"

export type InclusionStatus = "included" | "not_included" | "unknown"
export type CancellationStatus = "refundable" | "nonrefundable" | "unknown"
export type FlightCabin = "economy" | "premium_economy" | "business" | "first" | "unknown"

export interface PackageFlightSegment {
  airline: string | null       // IATA code, e.g. "QR"
  airlineName: string | null
  flightNumber: string | null
  from: string | null          // IATA
  to: string | null
  departure: string | null     // provider's local datetime string, unmodified
  arrival: string | null
}

/**
 * The single shape every package provider must produce. Fields a provider
 * cannot supply are null/unknown — never faked, never defaulted.
 */
export interface NormalizedPackageOffer {
  /** Canonical registry id — echoed from the query, never invented. Null when
   *  the offer's hotel is outside our universe (region sweeps). */
  propertyId: string | null
  providerPropertyRef: string
  giataId: number | null
  hotelName: string | null

  origin: string
  destinationAirport: string | null
  destinationRegion: string | null

  checkIn: string              // YYYY-MM-DD — hotel nights
  checkOut: string
  nights: number
  tripDeparture: string | null // door-to-door envelope
  tripReturn: string | null
  tripDays: number | null
  adults: number
  children: number

  roomName: string | null
  roomClass: RoomClass | null
  board: BoardBasis
  boardSource: BoardSource
  cabin: FlightCabin
  outboundSegments: PackageFlightSegment[]
  returnSegments: PackageFlightSegment[]

  /** Present ONLY when the seller itself split the price. Never derived. */
  flightPricePerPerson: number | null
  hotelPricePerPerson: number | null
  priceSplitSource: "provider" | "absent"

  baggage: InclusionStatus
  transfer: InclusionStatus
  cancellation: CancellationStatus

  totalPrice: Money            // the authoritative package price
  pricePerPerson: number | null
  taxesFees: TaxesFeesStatus
  /** What this offer does NOT state, by name. Absent ≠ included. */
  unknownInclusions: string[]

  tourOperator: string | null  // organizer (e.g. LTUR), when stated

  /** Raw provider identifiers, retained verbatim for offer locators. Only
   *  what the provider actually returned — never invented. */
  providerIds: Record<string, string>
  /** Provider-returned URLs/paths, verbatim (safety-checked at RENDER time,
   *  stored untouched). */
  providerUrls: Record<string, string>

  provider: string             // the SELLER this was observed at
  fetchedAt: string
  verificationLevel: PackageVerificationLevel
  confidence: ProviderConfidence
}

/** Tier 0: one property's seasonal curve of cheapest packages. */
export interface PackageCalendarQuery {
  propertyId: string
  /** Seller-native hotel ref, resolved by the caller from stay_property_refs. */
  providerRef: string
  origin: string               // IATA departure airport
  nights: number
  adults: number
  children: number
  board: BoardBasis            // packages are board-filtered at query time
  rangeStart: string           // YYYY-MM-DD
  rangeEnd: string
  currency: string
}

/**
 * Tier 1/2: dated offers for one property window.
 *
 * Two date vocabularies coexist by design: checkInFrom/checkInTo bound the
 * HOTEL check-in (TUI's dialect), tripDeparture/tripReturn are the door-to-
 * door envelope (CHECK24's dialect — its "departureDate/returnDate" are trip
 * days, and an overnight outbound makes hotel nights differ from trip days).
 * A provider that needs the envelope and does not receive it fails the query
 * rather than guessing.
 */
export interface PackageOffersQuery {
  propertyId: string
  providerRef: string
  origin: string
  checkInFrom: string
  checkInTo: string
  nights: number
  tripDeparture?: string       // YYYY-MM-DD
  tripReturn?: string
  adults: number
  children: number
  board: BoardBasis
  currency: string
}

export interface PackageSearchResult {
  provider: string
  ok: boolean
  offers: NormalizedPackageOffer[]
  reason?: PackageFailureReason
  error?: string
  /** Logical searches consumed (a poll loop is ONE search). */
  callsSpent: number
  latencyMs: number
  raw?: unknown
}

export interface PackageSearchOptions {
  captureRaw?: boolean
  timeoutMs?: number
}

export interface PackageProviderCapabilities {
  /** Can return a seasonal calendar of dated cheapest offers in one call. */
  calendar: boolean
  /** Can return dated offers for a specific window. */
  datedOffers: boolean
  /** Quotes more than one tour operator per search. */
  multiOperator: boolean
  flightIdentity: boolean
  /** Supplies a genuine flight/hotel price split. */
  priceSplit: boolean
  taxesFees: TaxesFeesStatus
}

/**
 * Every package provider implements this. Neither method may throw — a
 * failing provider returns ok:false and the funnel carries on without it.
 */
export interface PackageProvider {
  readonly name: string
  readonly kind: ProviderKind
  readonly confidence: ProviderConfidence
  readonly capabilities: PackageProviderCapabilities

  isConfigured(): boolean
  /** Cheap status probe. Must not perform a countable fetch. */
  health(): Promise<ProviderHealth>
  quota(): ProviderQuota | null

  /** Only present when capabilities.calendar is true. */
  fetchCalendar?(query: PackageCalendarQuery, options?: PackageSearchOptions): Promise<PackageSearchResult>
  /** Only present when capabilities.datedOffers is true. */
  searchOffers?(query: PackageOffersQuery, options?: PackageSearchOptions): Promise<PackageSearchResult>
}
