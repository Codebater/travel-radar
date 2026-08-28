/**
 * Offer locators — the way BACK to an observed offer.
 *
 * One locator per source observation. Navigation quality is an honest label,
 * decided by what the provider actually gave us:
 *
 *   EXACT_DEEP_LINK       the provider returned a URL for THIS offer
 *                         (preserved verbatim, safety-checked at build time)
 *   SEARCH_REPLAY_LINK    a provider search reconstructed from the offer's
 *                         own parameters (dates, airports, travellers, hotel,
 *                         board) — the user may need to re-select the result
 *   PROVIDER_LANDING_LINK a plain hotel/provider page — useful, but never
 *                         dressed up as a booking link
 *   UNAVAILABLE           no trustworthy URL can be produced
 *
 * URLs are never invented: every constructed URL uses only parameters the
 * observation actually carries, and every provider-returned URL must pass the
 * scheme+domain assertion or it is dropped (the locator degrades).
 */

import { nowIso, type DB } from "../db/index.js"
import { tuiBoardCode } from "../packages/normalize.js"
import type { StoredPackageObservation } from "../packages/store.js"
import { dateOnly } from "../packages/normalize.js"
import { buildQueryUrl, resolveProviderPath, safeProviderUrl, slugSegment } from "./urls.js"

export type NavigationQuality =
  | "EXACT_DEEP_LINK"
  | "SEARCH_REPLAY_LINK"
  | "PROVIDER_LANDING_LINK"
  | "UNAVAILABLE"

export type OfferKind = "package" | "flight" | "stay" | "hotel_award"

export interface BuiltLocator {
  kind: OfferKind
  sourceTable: string
  sourceId: number
  provider: string
  seller: string | null
  operator: string | null
  navigationQuality: NavigationQuality
  landingUrl: string | null
  deepLinkUrl: string | null
  bookingUrl: string | null
  searchReplayUrl: string | null
  searchReplayParams: Record<string, string | number>
  providerIds: Record<string, string>
  rawResponseRef: string | null
  origin: string | null
  destination: string | null
  outboundDate: string | null
  returnDate: string | null
  checkIn: string | null
  checkOut: string | null
  nights: number | null
  adults: number | null
  children: number | null
  cabin: string | null
  board: string | null
  roomClass: string | null
  roomName: string | null
  transferStatus: string | null
  nativeCurrency: string | null
  nativePrice: number | null
  observedAt: string
  expiresAt: string | null
}

export interface StoredLocator extends BuiltLocator {
  id: number
  createdAt: string
}

// ── Package locators ─────────────────────────────────────────────────────────

/**
 * TUI: no per-offer URL exists in any response (measured), so EXACT is never
 * claimed. The tui.com offer page IS parameterized (…/pauschalreisen/suchen/
 * angebote/<slug>/<giataId>/offer/?…, the tuiwatch-documented dialect), so a
 * SEARCH_REPLAY_LINK carrying dates, duration, travellers, airport, board and
 * operator is honest and reproducible.
 */
function buildTuiPackageLocator(obs: StoredPackageObservation): Pick<
  BuiltLocator,
  "navigationQuality" | "landingUrl" | "deepLinkUrl" | "bookingUrl" | "searchReplayUrl" | "searchReplayParams"
> {
  if (obs.giataId === null) {
    return {
      navigationQuality: "UNAVAILABLE", landingUrl: null, deepLinkUrl: null,
      bookingUrl: null, searchReplayUrl: null, searchReplayParams: {},
    }
  }
  const slug = slugSegment(obs.hotelName, "hotel")
  const base = `https://www.tui.com/pauschalreisen/suchen/angebote/${slug}/${obs.giataId}/offer/`
  const params: Record<string, string | number> = {
    startDate: obs.checkIn,
    endDate: obs.checkOut,
    duration: obs.nights,
    travellers: obs.adults,
    searchScope: "PACKAGE",
    departureAirports: obs.origin,
  }
  const boardCode = tuiBoardCode(obs.board as never)
  if (boardCode) params.boardTypes = boardCode
  if (obs.tourOperator) params.operators = obs.tourOperator
  const replay = safeProviderUrl(obs.provider, buildQueryUrl(base, params))
  const landing = safeProviderUrl(obs.provider, base)
  if (!replay) {
    return {
      navigationQuality: landing ? "PROVIDER_LANDING_LINK" : "UNAVAILABLE",
      landingUrl: landing, deepLinkUrl: null, bookingUrl: null,
      searchReplayUrl: null, searchReplayParams: {},
    }
  }
  return {
    navigationQuality: "SEARCH_REPLAY_LINK",
    landingUrl: landing, deepLinkUrl: null, bookingUrl: null,
    searchReplayUrl: replay, searchReplayParams: params,
  }
}

/**
 * CHECK24: the response carries a per-offer detailsUrl (relative) — the
 * provider's own link for that result row, preserved verbatim and resolved
 * against the provider origin. That is the EXACT_DEEP_LINK. The user-facing
 * search page (/suche/hotel?…) is always reconstructable as SEARCH_REPLAY.
 */
function buildCheck24PackageLocator(obs: StoredPackageObservation): Pick<
  BuiltLocator,
  "navigationQuality" | "landingUrl" | "deepLinkUrl" | "bookingUrl" | "searchReplayUrl" | "searchReplayParams"
> {
  const origin = "https://urlaub.check24.de"
  const deepLink = resolveProviderPath(obs.provider, origin, obs.providerUrls.detailsPath ?? null)

  const tripDeparture = dateOnly(obs.tripDeparture)
  const tripReturn = dateOnly(obs.tripReturn)
  let replay: string | null = null
  let params: Record<string, string | number> = {}
  if (tripDeparture && tripReturn) {
    params = {
      hotelId: obs.providerPropertyRef,
      airport: obs.origin,
      departureDate: tripDeparture,
      returnDate: tripReturn,
      days: "exact",
      roomAllocation: Array(obs.adults).fill("A").join("-"),
      transportType: "flight",
      pageArea: "package",
    }
    replay = safeProviderUrl(obs.provider, buildQueryUrl(`${origin}/suche/hotel`, params))
  }
  const landing = safeProviderUrl(obs.provider, `${origin}/hib/${encodeURIComponent(obs.providerPropertyRef)}/hotel`)

  if (deepLink) {
    return {
      navigationQuality: "EXACT_DEEP_LINK",
      landingUrl: landing, deepLinkUrl: deepLink, bookingUrl: null,
      searchReplayUrl: replay, searchReplayParams: params,
    }
  }
  if (replay) {
    return {
      navigationQuality: "SEARCH_REPLAY_LINK",
      landingUrl: landing, deepLinkUrl: null, bookingUrl: null,
      searchReplayUrl: replay, searchReplayParams: params,
    }
  }
  return {
    navigationQuality: landing ? "PROVIDER_LANDING_LINK" : "UNAVAILABLE",
    landingUrl: landing, deepLinkUrl: null, bookingUrl: null,
    searchReplayUrl: null, searchReplayParams: {},
  }
}

export function buildPackageLocator(obs: StoredPackageObservation): BuiltLocator {
  const navigation = obs.provider === "tui_packages"
    ? buildTuiPackageLocator(obs)
    : obs.provider === "check24_packages"
      ? buildCheck24PackageLocator(obs)
      : {
          navigationQuality: "UNAVAILABLE" as const, landingUrl: null, deepLinkUrl: null,
          bookingUrl: null, searchReplayUrl: null, searchReplayParams: {},
        }
  return {
    kind: "package",
    sourceTable: "package_offer_observations",
    sourceId: obs.id,
    provider: obs.provider,
    seller: obs.provider,
    operator: obs.tourOperator,
    ...navigation,
    // The seller-native hotel ref rides along so a recheck can re-issue the
    // provider search without re-joining the refs table.
    providerIds: { hotelRef: obs.providerPropertyRef, ...obs.providerIds },
    rawResponseRef: obs.searchRequestId !== null ? `package_search_request:${obs.searchRequestId}` : null,
    origin: obs.origin,
    destination: obs.destinationAirport,
    outboundDate: dateOnly(obs.tripDeparture),
    returnDate: dateOnly(obs.tripReturn),
    checkIn: obs.checkIn,
    checkOut: obs.checkOut,
    nights: obs.nights,
    adults: obs.adults,
    children: obs.children,
    cabin: obs.cabin,
    board: obs.board,
    roomClass: obs.roomClass,
    roomName: obs.roomName,
    transferStatus: obs.transfer,
    nativeCurrency: obs.currency,
    nativePrice: obs.totalPrice,
    observedAt: obs.fetchedAt,
    expiresAt: null,             // no package provider exposes an expiry
  }
}

// ── Flight locators ──────────────────────────────────────────────────────────

export interface FlightPriceRow {
  id: number
  provider: string
  airline: string | null
  flight_numbers: string | null
  origin: string
  destination: string
  departure_date: string
  return_date: string | null
  cabin: string
  adults: number
  price_amount: number
  price_currency: string
  booking_url: string | null
  fetched_at: string
}

/**
 * fast_flights stores a Google Flights QUERY link — a search replay by
 * nature (it restores the search, the user re-selects the itinerary). No
 * provider gives us an itinerary-restoring token, so EXACT is never claimed
 * for flights. A stored URL is preserved verbatim when it passes the domain
 * assertion; otherwise an equivalent replay is constructed from the row's own
 * route/dates.
 */
export function buildFlightLocator(row: FlightPriceRow): BuiltLocator {
  const storedUrl = safeProviderUrl(row.provider, row.booking_url)
  // A missing return date MUST say "one way" explicitly — the same semantics
  // the provider's own stored URL uses. Without it Google parses the query as
  // an open-return round trip and the replay reopens the wrong search shape.
  const params: Record<string, string | number> = {
    q: `Flights ${row.origin} to ${row.destination} on ${row.departure_date}`
      + (row.return_date ? ` returning ${row.return_date}` : " one way"),
  }
  const constructed = safeProviderUrl(row.provider, buildQueryUrl("https://www.google.com/travel/flights", params))
  const replay = storedUrl ?? constructed
  return {
    kind: "flight",
    sourceTable: "flight_prices",
    sourceId: row.id,
    provider: row.provider,
    seller: row.provider,
    operator: row.airline,
    navigationQuality: replay ? "SEARCH_REPLAY_LINK" : "UNAVAILABLE",
    landingUrl: null,
    deepLinkUrl: null,
    bookingUrl: null,
    searchReplayUrl: replay,
    searchReplayParams: replay === storedUrl && storedUrl !== null ? { storedProviderUrl: 1 } : params,
    providerIds: {
      ...(row.flight_numbers ? { flightNumbers: row.flight_numbers } : {}),
      ...(row.airline ? { airline: row.airline } : {}),
    },
    rawResponseRef: null,
    origin: row.origin,
    destination: row.destination,
    outboundDate: row.departure_date,
    returnDate: row.return_date,
    checkIn: null,
    checkOut: null,
    nights: null,
    adults: row.adults,
    children: null,
    cabin: row.cabin,
    board: null,
    roomClass: null,
    roomName: null,
    transferStatus: null,
    nativeCurrency: row.price_currency,
    nativePrice: row.price_amount,
    observedAt: row.fetched_at,
    expiresAt: null,
  }
}

// ── Stay locators ────────────────────────────────────────────────────────────

export interface StayRateRow {
  id: number
  provider: string
  provider_property_ref: string
  property_id: string
  rate_source: string | null
  room_name: string | null
  room_class: string | null
  board: string
  check_in: string
  check_out: string
  nights: number
  adults: number
  price_amount: number
  price_currency: string
  fetched_at: string
}

export function buildStayLocator(row: StayRateRow, propertyName: string | null): BuiltLocator {
  let navigation: Pick<BuiltLocator, "navigationQuality" | "landingUrl" | "searchReplayUrl" | "searchReplayParams">
    = { navigationQuality: "UNAVAILABLE", landingUrl: null, searchReplayUrl: null, searchReplayParams: {} }

  if (row.provider === "xotelo" && /^g\d+-d\d+$/.test(row.provider_property_ref)) {
    // Xotelo quotes are TripAdvisor meta sightings; the honest destination is
    // the TripAdvisor hotel page — a LANDING link, not a booking link.
    const landing = safeProviderUrl("xotelo",
      `https://www.tripadvisor.com/Hotel_Review-${row.provider_property_ref}`)
    navigation = {
      navigationQuality: landing ? "PROVIDER_LANDING_LINK" : "UNAVAILABLE",
      landingUrl: landing, searchReplayUrl: null, searchReplayParams: {},
    }
  } else if (row.provider === "agoda" && /^\d+:\d+:\d+$/.test(row.provider_property_ref)) {
    const propertyId = row.provider_property_ref.split(":")[0]
    const params: Record<string, string | number> = {
      selectedproperty: propertyId,
      checkIn: row.check_in,
      los: row.nights,
      rooms: 1,
      adults: row.adults,
    }
    const replay = safeProviderUrl("agoda", buildQueryUrl("https://www.agoda.com/search", params))
    navigation = {
      navigationQuality: replay ? "SEARCH_REPLAY_LINK" : "UNAVAILABLE",
      landingUrl: null, searchReplayUrl: replay, searchReplayParams: params,
    }
  } else if (row.provider === "serpapi_hotels" && propertyName) {
    const params: Record<string, string | number> = {
      q: propertyName, checkin: row.check_in, checkout: row.check_out,
    }
    const replay = safeProviderUrl("serpapi_hotels", buildQueryUrl("https://www.google.com/travel/search", params))
    navigation = {
      navigationQuality: replay ? "SEARCH_REPLAY_LINK" : "UNAVAILABLE",
      landingUrl: null, searchReplayUrl: replay, searchReplayParams: params,
    }
  }

  return {
    kind: "stay",
    sourceTable: "stay_rate_observations",
    sourceId: row.id,
    provider: row.provider,
    seller: row.rate_source ?? row.provider,
    operator: null,
    deepLinkUrl: null,
    bookingUrl: null,
    ...navigation,
    providerIds: { propertyRef: row.provider_property_ref },
    rawResponseRef: null,
    origin: null,
    destination: null,
    outboundDate: null,
    returnDate: null,
    checkIn: row.check_in,
    checkOut: row.check_out,
    nights: row.nights,
    adults: row.adults,
    children: null,
    cabin: null,
    board: row.board,
    roomClass: row.room_class,
    roomName: row.room_name,
    transferStatus: null,
    nativeCurrency: row.price_currency,
    nativePrice: row.price_amount,
    observedAt: row.fetched_at,
    expiresAt: null,
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Idempotent per source observation: rebuilding from the same observation is
 * deterministic, so the upsert can only restate the same facts. Verification
 * NEVER writes here — old links survive every recheck.
 */
export function upsertLocator(db: DB, built: BuiltLocator): number {
  db.prepare(`
    INSERT INTO offer_locators (
      kind, source_table, source_id, provider, seller, operator,
      navigation_quality, landing_url, deep_link_url, booking_url,
      search_replay_url, search_replay_params, provider_ids, raw_response_ref,
      origin, destination, outbound_date, return_date, check_in, check_out,
      nights, adults, children, cabin, board, room_class, room_name,
      transfer_status, native_currency, native_price, observed_at, expires_at, created_at
    ) VALUES (
      @kind, @sourceTable, @sourceId, @provider, @seller, @operator,
      @navigationQuality, @landingUrl, @deepLinkUrl, @bookingUrl,
      @searchReplayUrl, @searchReplayParams, @providerIds, @rawResponseRef,
      @origin, @destination, @outboundDate, @returnDate, @checkIn, @checkOut,
      @nights, @adults, @children, @cabin, @board, @roomClass, @roomName,
      @transferStatus, @nativeCurrency, @nativePrice, @observedAt, @expiresAt, @now
    )
    ON CONFLICT(source_table, source_id) DO UPDATE SET
      navigation_quality = excluded.navigation_quality,
      landing_url = excluded.landing_url,
      deep_link_url = excluded.deep_link_url,
      booking_url = excluded.booking_url,
      search_replay_url = excluded.search_replay_url,
      search_replay_params = excluded.search_replay_params,
      provider_ids = excluded.provider_ids
  `).run({
    ...built,
    searchReplayParams: JSON.stringify(built.searchReplayParams),
    providerIds: JSON.stringify(built.providerIds),
    now: nowIso(),
  })
  const row = db.prepare(
    "SELECT id FROM offer_locators WHERE source_table = ? AND source_id = ?",
  ).get(built.sourceTable, built.sourceId) as { id: number }
  return row.id
}

export function getLocator(db: DB, id: number): StoredLocator | null {
  const r = db.prepare("SELECT * FROM offer_locators WHERE id = ?").get(id) as
    Record<string, unknown> | undefined
  return r ? hydrate(r) : null
}

export function locatorForSource(db: DB, sourceTable: string, sourceId: number): StoredLocator | null {
  const r = db.prepare(
    "SELECT * FROM offer_locators WHERE source_table = ? AND source_id = ?",
  ).get(sourceTable, sourceId) as Record<string, unknown> | undefined
  return r ? hydrate(r) : null
}

function hydrate(r: Record<string, unknown>): StoredLocator {
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    kind: r.kind as OfferKind,
    sourceTable: r.source_table as string,
    sourceId: r.source_id as number,
    provider: r.provider as string,
    seller: (r.seller as string) ?? null,
    operator: (r.operator as string) ?? null,
    navigationQuality: r.navigation_quality as NavigationQuality,
    landingUrl: (r.landing_url as string) ?? null,
    deepLinkUrl: (r.deep_link_url as string) ?? null,
    bookingUrl: (r.booking_url as string) ?? null,
    searchReplayUrl: (r.search_replay_url as string) ?? null,
    searchReplayParams: parse(r.search_replay_params, {}),
    providerIds: parse(r.provider_ids, {}),
    rawResponseRef: (r.raw_response_ref as string) ?? null,
    origin: (r.origin as string) ?? null,
    destination: (r.destination as string) ?? null,
    outboundDate: (r.outbound_date as string) ?? null,
    returnDate: (r.return_date as string) ?? null,
    checkIn: (r.check_in as string) ?? null,
    checkOut: (r.check_out as string) ?? null,
    nights: (r.nights as number) ?? null,
    adults: (r.adults as number) ?? null,
    children: (r.children as number) ?? null,
    cabin: (r.cabin as string) ?? null,
    board: (r.board as string) ?? null,
    roomClass: (r.room_class as string) ?? null,
    roomName: (r.room_name as string) ?? null,
    transferStatus: (r.transfer_status as string) ?? null,
    nativeCurrency: (r.native_currency as string) ?? null,
    nativePrice: (r.native_price as number) ?? null,
    observedAt: r.observed_at as string,
    expiresAt: (r.expires_at as string) ?? null,
    createdAt: r.created_at as string,
  }
}
