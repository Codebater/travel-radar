/**
 * Package persistence. Observations are append-only — re-observing writes a
 * new row and "latest" is per-key MAX(id), never a timestamp comparison.
 * Comparisons are append-only too: the BUILD-vs-BUY verdict has its own
 * auditable history as prices move.
 */

import { nowIso, type DB } from "../db/index.js"
import type { NormalizedPackageOffer } from "../providers/packages/types.js"
import { packageKeyForOffer } from "./identity.js"

export type PackageSearchKind = "calendar" | "offers" | "confirmation"

export interface PackageSearchRequestInput {
  provider: string
  kind: PackageSearchKind
  propertyId: string | null
  origin: string
  rangeStart: string | null
  rangeEnd: string | null
  nights: number | null
  adults: number
  children: number
  currency: string
  source: "cli" | "observer" | "test"
}

export function createPackageSearchRequest(db: DB, input: PackageSearchRequestInput): number {
  const result = db.prepare(`
    INSERT INTO package_search_requests
      (provider, kind, property_id, origin, range_start, range_end, nights, adults, children, currency, source, created_at)
    VALUES (@provider, @kind, @propertyId, @origin, @rangeStart, @rangeEnd, @nights, @adults, @children, @currency, @source, @now)
  `).run({ ...input, now: nowIso() })
  return Number(result.lastInsertRowid)
}

/** Logical searches a provider has issued today (UTC) — the budget input. */
export function packageSearchesToday(db: DB, provider: string, now = new Date()): number {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00`
  const row = db.prepare(`
    SELECT COUNT(*) n FROM package_search_requests
    WHERE provider = ? AND source != 'test' AND created_at >= ?
  `).get(provider, dayStart) as { n: number }
  return row.n
}

export function recordPackageObservations(
  db: DB, offers: NormalizedPackageOffer[], searchRequestId: number | null,
): number[] {
  const insert = db.prepare(`
    INSERT INTO package_offer_observations (
      package_key, provider, tour_operator, property_id, provider_property_ref, giata_id, hotel_name,
      origin, destination_airport, destination_region,
      check_in, check_out, nights, trip_departure, trip_return, trip_days, adults, children,
      room_name, room_class, board, board_source, cabin, flight_segments,
      flight_price_pp, hotel_price_pp, price_split_source,
      baggage_status, transfer_status, cancellation,
      total_price, price_per_person, currency, taxes_fees, unknown_inclusions,
      verification_level, confidence, sanity, sanity_detail, fetched_at, search_request_id,
      provider_ids, provider_urls
    ) VALUES (
      @packageKey, @provider, @tourOperator, @propertyId, @providerPropertyRef, @giataId, @hotelName,
      @origin, @destinationAirport, @destinationRegion,
      @checkIn, @checkOut, @nights, @tripDeparture, @tripReturn, @tripDays, @adults, @children,
      @roomName, @roomClass, @board, @boardSource, @cabin, @flightSegments,
      @flightPricePerPerson, @hotelPricePerPerson, @priceSplitSource,
      @baggage, @transfer, @cancellation,
      @totalPrice, @pricePerPerson, @currency, @taxesFees, @unknownInclusions,
      @verificationLevel, @confidence, 'ok', NULL, @fetchedAt, @searchRequestId,
      @providerIdsJson, @providerUrlsJson
    )
  `)
  const ids: number[] = []
  const tx = db.transaction(() => {
    for (const offer of offers) {
      const result = insert.run({
        packageKey: packageKeyForOffer(offer),
        provider: offer.provider,
        tourOperator: offer.tourOperator,
        propertyId: offer.propertyId,
        providerPropertyRef: offer.providerPropertyRef,
        giataId: offer.giataId,
        hotelName: offer.hotelName,
        origin: offer.origin,
        destinationAirport: offer.destinationAirport,
        destinationRegion: offer.destinationRegion,
        checkIn: offer.checkIn,
        checkOut: offer.checkOut,
        nights: offer.nights,
        tripDeparture: offer.tripDeparture,
        tripReturn: offer.tripReturn,
        tripDays: offer.tripDays,
        adults: offer.adults,
        children: offer.children,
        roomName: offer.roomName,
        roomClass: offer.roomClass,
        board: offer.board,
        boardSource: offer.boardSource,
        cabin: offer.cabin,
        flightSegments: JSON.stringify({ outbound: offer.outboundSegments, return: offer.returnSegments }),
        flightPricePerPerson: offer.flightPricePerPerson,
        hotelPricePerPerson: offer.hotelPricePerPerson,
        priceSplitSource: offer.priceSplitSource,
        baggage: offer.baggage,
        transfer: offer.transfer,
        cancellation: offer.cancellation,
        totalPrice: offer.totalPrice.amount,
        pricePerPerson: offer.pricePerPerson,
        currency: offer.totalPrice.currency,
        taxesFees: offer.taxesFees,
        unknownInclusions: JSON.stringify(offer.unknownInclusions),
        verificationLevel: offer.verificationLevel,
        confidence: offer.confidence,
        fetchedAt: offer.fetchedAt,
        searchRequestId,
        providerIdsJson: JSON.stringify(offer.providerIds ?? {}),
        providerUrlsJson: JSON.stringify(offer.providerUrls ?? {}),
      })
      ids.push(Number(result.lastInsertRowid))
    }
  })
  tx()
  return ids
}

export function recordPackageRaw(
  db: DB, provider: string, kind: PackageSearchKind, propertyId: string | null,
  searchRequestId: number | null, payload: unknown,
): void {
  db.prepare(`
    INSERT INTO package_raw_responses (provider, kind, property_id, search_request_id, payload, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(provider, kind, propertyId, searchRequestId, JSON.stringify(payload), nowIso())
}

export interface StoredPackageObservation {
  id: number
  packageKey: string
  provider: string
  tourOperator: string | null
  propertyId: string | null
  providerPropertyRef: string
  giataId: number | null
  hotelName: string | null
  origin: string
  destinationAirport: string | null
  checkIn: string
  checkOut: string
  nights: number
  tripDeparture: string | null
  tripReturn: string | null
  tripDays: number | null
  adults: number
  children: number
  roomName: string | null
  roomClass: string | null
  board: string
  cabin: string
  flightSegments: { outbound: unknown[]; return: unknown[] }
  flightPricePerPerson: number | null
  hotelPricePerPerson: number | null
  priceSplitSource: string
  baggage: string
  transfer: string
  cancellation: string
  totalPrice: number
  pricePerPerson: number | null
  currency: string
  taxesFees: string
  unknownInclusions: string[]
  verificationLevel: string
  confidence: string
  fetchedAt: string
  searchRequestId: number | null
  providerIds: Record<string, string>
  providerUrls: Record<string, string>
}

function hydrate(r: Record<string, unknown>): StoredPackageObservation {
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    packageKey: r.package_key as string,
    provider: r.provider as string,
    tourOperator: (r.tour_operator as string) ?? null,
    propertyId: (r.property_id as string) ?? null,
    providerPropertyRef: r.provider_property_ref as string,
    giataId: (r.giata_id as number) ?? null,
    hotelName: (r.hotel_name as string) ?? null,
    origin: r.origin as string,
    destinationAirport: (r.destination_airport as string) ?? null,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    nights: r.nights as number,
    tripDeparture: (r.trip_departure as string) ?? null,
    tripReturn: (r.trip_return as string) ?? null,
    tripDays: (r.trip_days as number) ?? null,
    adults: r.adults as number,
    children: r.children as number,
    roomName: (r.room_name as string) ?? null,
    roomClass: (r.room_class as string) ?? null,
    board: r.board as string,
    cabin: r.cabin as string,
    flightSegments: parse(r.flight_segments, { outbound: [], return: [] }),
    flightPricePerPerson: (r.flight_price_pp as number) ?? null,
    hotelPricePerPerson: (r.hotel_price_pp as number) ?? null,
    priceSplitSource: r.price_split_source as string,
    baggage: r.baggage_status as string,
    transfer: r.transfer_status as string,
    cancellation: r.cancellation as string,
    totalPrice: r.total_price as number,
    pricePerPerson: (r.price_per_person as number) ?? null,
    currency: r.currency as string,
    taxesFees: r.taxes_fees as string,
    unknownInclusions: parse(r.unknown_inclusions, []),
    verificationLevel: r.verification_level as string,
    confidence: r.confidence as string,
    fetchedAt: r.fetched_at as string,
    searchRequestId: (r.search_request_id as number) ?? null,
    providerIds: parse(r.provider_ids, {}),
    providerUrls: parse(r.provider_urls, {}),
  }
}

/**
 * The current view of each product-date: from the LATEST search batch that
 * touched a (package_key, check_in), the CHEAPEST row (a batch carries many
 * room/operator variants of one product; the radar's answer is the best
 * currently-quoted one). Batch recency is by id, never `fetched_at =` — the
 * no-look-ahead lesson, carried over verbatim.
 */
export function latestPackageObservations(
  db: DB, opts: { propertyId?: string; maxAgeDays?: number } = {},
): StoredPackageObservation[] {
  const rows = db.prepare(`
    SELECT * FROM package_offer_observations
    WHERE (@propertyId IS NULL OR property_id = @propertyId)
      AND (@minFetched IS NULL OR fetched_at >= @minFetched)
    ORDER BY id
  `).all({
    propertyId: opts.propertyId ?? null,
    minFetched: opts.maxAgeDays != null
      ? new Date(Date.now() - opts.maxAgeDays * 86_400_000).toISOString()
      : null,
  }) as Record<string, unknown>[]

  // Group in plain code — volumes are small and the selection rule must stay
  // auditable: newest batch = the group's MAX(id) row's search request; the
  // representative = the cheapest row of that batch (ties → newest row).
  const groups = new Map<string, StoredPackageObservation[]>()
  for (const raw of rows) {
    const o = hydrate(raw)
    const groupKey = `${o.packageKey} ${o.checkIn}`
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey)!.push(o)
  }
  const result: StoredPackageObservation[] = []
  for (const members of groups.values()) {
    const newest = members[members.length - 1]           // rows arrive ordered by id
    const batch = newest.searchRequestId === null
      ? [newest]
      : members.filter(m => m.searchRequestId === newest.searchRequestId)
    // ONE representative per COMPARABILITY-RELEVANT VARIANT of the newest
    // batch (transfer status x room class), each the cheapest of its variant
    // (ties -> newest row). A cheaper transfer-unknown row must never shadow
    // a transfer-included row that would compare EXACT -- both are current
    // facts about different products; the comparison layer picks by
    // comparability first, price within that class second.
    const variants = new Map<string, StoredPackageObservation>()
    for (const m of batch) {
      const variantKey = `${m.transfer}|${m.roomClass ?? "-"}`
      const best = variants.get(variantKey)
      if (!best || m.totalPrice < best.totalPrice || (m.totalPrice === best.totalPrice && m.id > best.id)) {
        variants.set(variantKey, m)
      }
    }
    result.push(...variants.values())
  }
  return result.sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.totalPrice - b.totalPrice)
}

export function listPackageObservations(
  db: DB, opts: { propertyId?: string; limit?: number } = {},
): StoredPackageObservation[] {
  const rows = db.prepare(`
    SELECT * FROM package_offer_observations
    WHERE (@propertyId IS NULL OR property_id = @propertyId)
    ORDER BY id DESC LIMIT @limit
  `).all({ propertyId: opts.propertyId ?? null, limit: opts.limit ?? 50 }) as Record<string, unknown>[]
  return rows.map(hydrate)
}

export function getPackageObservation(db: DB, id: number): StoredPackageObservation | null {
  const row = db.prepare("SELECT * FROM package_offer_observations WHERE id = ?").get(id) as
    Record<string, unknown> | undefined
  return row ? hydrate(row) : null
}

// ── Comparisons ──────────────────────────────────────────────────────────────

export interface PackageComparisonRecord {
  tripId: number
  tripKey: string
  packageObservationId: number
  packageKey: string
  comparability: string
  comparabilityReasons: string[]
  verdict: string
  verdictReasons: string[]
  syntheticTotal: number | null
  syntheticCurrency: string | null
  packageTotal: number
  packageCurrency: string
  knownDifference: number | null
  knownDifferencePct: number | null
  winner: "diy" | "package" | null
}

export function recordPackageComparison(db: DB, c: PackageComparisonRecord, computeBatch: string | null = null): number {
  const result = db.prepare(`
    INSERT INTO package_comparisons (
      trip_id, trip_key, package_observation_id, package_key,
      comparability, comparability_reasons, verdict, verdict_reasons,
      synthetic_total, synthetic_currency, package_total, package_currency,
      known_difference, known_difference_pct, winner, compute_batch, computed_at
    ) VALUES (
      @tripId, @tripKey, @packageObservationId, @packageKey,
      @comparability, @comparabilityReasons, @verdict, @verdictReasons,
      @syntheticTotal, @syntheticCurrency, @packageTotal, @packageCurrency,
      @knownDifference, @knownDifferencePct, @winner, @computeBatch, @now
    )
  `).run({
    ...c,
    comparabilityReasons: JSON.stringify(c.comparabilityReasons),
    verdictReasons: JSON.stringify(c.verdictReasons),
    computeBatch,
    now: nowIso(),
  })
  return Number(result.lastInsertRowid)
}

export interface StoredPackageComparison extends PackageComparisonRecord {
  id: number
  computedAt: string
}

function hydrateComparison(r: Record<string, unknown>): StoredPackageComparison {
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    tripId: r.trip_id as number,
    tripKey: r.trip_key as string,
    packageObservationId: r.package_observation_id as number,
    packageKey: r.package_key as string,
    comparability: r.comparability as string,
    comparabilityReasons: parse(r.comparability_reasons, []),
    verdict: r.verdict as string,
    verdictReasons: parse(r.verdict_reasons, []),
    syntheticTotal: (r.synthetic_total as number) ?? null,
    syntheticCurrency: (r.synthetic_currency as string) ?? null,
    packageTotal: r.package_total as number,
    packageCurrency: r.package_currency as string,
    knownDifference: (r.known_difference as number) ?? null,
    knownDifferencePct: (r.known_difference_pct as number) ?? null,
    winner: (r.winner as "diy" | "package") ?? null,
    computedAt: r.computed_at as string,
  }
}

/**
 * The CURRENT comparisons for a trip. Batch-scoped: once any stamped compute
 * batch exists for the trip, only the newest batch is current — older batches
 * AND the pre-batch NULL rows (the 8g pre-filter noise) are superseded and
 * cannot pollute a ranking. They remain in the table as history. Trips with
 * only unstamped rows fall back to per-pair MAX(id).
 */
export function latestComparisonsForTrip(db: DB, tripId: number): StoredPackageComparison[] {
  const newestBatch = (db.prepare(
    "SELECT MAX(compute_batch) b FROM package_comparisons WHERE trip_id = ?",
  ).get(tripId) as { b: string | null }).b
  if (newestBatch !== null) {
    const rows = db.prepare(`
      SELECT * FROM package_comparisons
      WHERE trip_id = ? AND compute_batch = ?
      ORDER BY package_total ASC
    `).all(tripId, newestBatch) as Record<string, unknown>[]
    return rows.map(hydrateComparison)
  }
  const rows = db.prepare(`
    SELECT c.* FROM package_comparisons c
    JOIN (
      SELECT trip_id, package_observation_id, MAX(id) max_id
      FROM package_comparisons WHERE trip_id = ?
      GROUP BY trip_id, package_observation_id
    ) latest ON latest.max_id = c.id
    ORDER BY c.package_total ASC
  `).all(tripId) as Record<string, unknown>[]
  return rows.map(hydrateComparison)
}

export function listComparisons(db: DB, opts: { limit?: number } = {}): StoredPackageComparison[] {
  const rows = db.prepare(`
    SELECT * FROM package_comparisons ORDER BY id DESC LIMIT ?
  `).all(opts.limit ?? 50) as Record<string, unknown>[]
  return rows.map(hydrateComparison)
}

export interface PackageTotals {
  observations: number
  distinctKeys: number
  byProvider: Record<string, number>
  comparisons: number
  byVerdict: Record<string, number>
}

export function packageTotals(db: DB): PackageTotals {
  const obs = db.prepare(
    "SELECT provider, COUNT(*) n, COUNT(DISTINCT package_key) k FROM package_offer_observations GROUP BY provider",
  ).all() as { provider: string; n: number; k: number }[]
  const verdicts = db.prepare(
    "SELECT verdict, COUNT(*) n FROM package_comparisons GROUP BY verdict",
  ).all() as { verdict: string; n: number }[]
  const totals: PackageTotals = {
    observations: obs.reduce((a, r) => a + r.n, 0),
    distinctKeys: obs.reduce((a, r) => a + r.k, 0),
    byProvider: {},
    comparisons: verdicts.reduce((a, r) => a + r.n, 0),
    byVerdict: {},
  }
  for (const r of obs) totals.byProvider[r.provider] = r.n
  for (const r of verdicts) totals.byVerdict[r.verdict] = r.n
  return totals
}
