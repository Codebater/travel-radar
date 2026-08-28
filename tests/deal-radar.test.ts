/**
 * Phase 8l-a: the Deal Radar feed — a read-only aggregator over decisions the
 * radar already made. Under test:
 *   - categories stay separate (no composite rank, RT/OW never share a section);
 *   - fare "deal" language exists ONLY above typical-fare maturity — below it a
 *     card says "cheapest observed";
 *   - bounded verdict reasons pass through byte-identical;
 *   - a cheaper CLOSE package never hides the best EXACT;
 *   - unknown DIY costs stay named, config floors/limits are respected, and
 *     navigation quality is passed through untouched.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, nowIso, type DB } from "../db/index.js"
import { buildDealRadarFeed, loadDealRadarConfig } from "../dealradar/feed.js"
import { runFareRadar, type SearchFn } from "../fareradar/engine.js"
import type { CashFlightQuery, NormalizedCashFlight } from "../providers/cash-flights/types.js"
import { makeFlight } from "./mocks.js"

const CFG = loadDealRadarConfig(true)

let db: DB

beforeEach(() => {
  db = createMemoryDb()
})

// ── Seeding helpers (existing engines and plain rows — never new scoring) ────

function stubSearch(pricing: (q: CashFlightQuery) => NormalizedCashFlight[]): SearchFn {
  return async (query, options) => {
    const flights = pricing(query)
    const insert = db.prepare(`
      INSERT INTO flight_prices (
        itinerary_hash, origin, destination, departure_date, return_date, cabin, adults,
        airline, booking_url, price_amount, price_currency, provider,
        verification_level, provider_confidence, fetched_at, search_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', 'medium', ?, ?)
    `)
    for (const f of flights) {
      insert.run(
        f.itineraryHash, f.origin, f.destination, f.departureDate, f.returnDate, f.cabin,
        query.adults, f.airline, f.bookingUrl, f.price.amount, f.price.currency,
        f.provider, f.fetchedAt, options.searchRequestId ?? null,
      )
    }
    return {
      flights, verificationLevel: "discovered", cacheAgeMinutes: null,
      fromCache: true, callsSpent: 0, attempts: [], warnings: [],
    }
  }
}

function fareFor(query: CashFlightQuery, amount: number): NormalizedCashFlight {
  return makeFlight({
    origin: query.origin, destination: query.destination,
    departureDate: query.departureDate, returnDate: query.returnDate ?? null,
    cabin: query.cabin, price: { amount, currency: query.currency },
    bookingUrl: `https://www.google.com/travel/flights?q=Flights%20${query.origin}%20to%20${query.destination}%20on%20${query.departureDate}${query.returnDate ? "" : "%20one%20way"}`,
    provider: "fast_flights",
  })
}

async function seedFareRuns(): Promise<void> {
  const rt = stubSearch(q => [fareFor(q, 2100)])
  await runFareRadar(db, { destination: "BKK", windowStart: "2026-10-01", nextDays: 30, source: "test" }, { search: rt, log: () => {} })
  // One PRG standout so BOTH origins land inside the section limit.
  const ow = stubSearch(q => [fareFor(q, q.origin === "PRG" && q.departureDate === "2026-10-01" ? 1380 : 1400)])
  await runFareRadar(db, { tripType: "ONE_WAY", destination: "BKK", windowStart: "2026-10-01", nextDays: 30, source: "test" }, { search: ow, log: () => {} })
}

/**
 * Mature the ONE_WAY typical fare for VIE→BKK business EUR. Deep enough
 * (20 rows near 2000) that the median stays ~2000 even after the radar run
 * appends its own 1400-priced observations — typicalFareFor is display
 * context and reads the whole one-way history by design.
 */
function matureOneWayBaseline(): void {
  const insert = db.prepare(`
    INSERT INTO flight_prices (itinerary_hash, origin, destination, departure_date, return_date,
      cabin, adults, price_amount, price_currency, provider, verification_level, provider_confidence, fetched_at)
    VALUES (?, 'VIE', 'BKK', '2026-10-05', NULL, 'business', 1, ?, 'EUR', 'fast_flights', 'discovered', 'medium', ?)
  `)
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < 4; i++) insert.run(`ow-hist-${d}-${i}`, 2000 + d * 10 + i, `2026-08-2${d}T09:0${i}:00Z`)
  }
}

const BOUNDED = "DIY is currently EUR 1643.06 lower BEFORE the unknown transfers — NOT a saving"

function seedProperty(): void {
  db.prepare(`
    INSERT INTO stay_properties (id, name, destination_group, country, nearest_airports, luxury_tier,
      all_inclusive, default_board, typical_stay_nights, priority, active, created_at, updated_at)
    VALUES ('lily-beach', 'Lily Beach Resort & Spa', 'maldives', 'MV', '["MLE"]', 'luxury', 1,
      'all_inclusive', 5, 1, 1, ?, ?)
  `).run(nowIso(), nowIso())
}

function seedPackageObservation(id: number, total: number, transfer: string): void {
  db.prepare(`
    INSERT INTO package_offer_observations (id, package_key, provider, tour_operator, provider_property_ref,
      giata_id, hotel_name, origin, check_in, check_out, nights, adults, children, board, board_source,
      cabin, flight_segments, price_split_source, baggage_status, transfer_status, cancellation,
      total_price, currency, taxes_fees, unknown_inclusions, verification_level, confidence, sanity, fetched_at)
    VALUES (?, ?, 'tui_packages', 'LTUR', '16356', '16356', 'Lily Beach Resort & Spa', 'VIE',
      '2026-11-21', '2026-11-26', 5, 2, 0, 'all_inclusive', 'provider', 'economy', '[]', 'none',
      'unknown', ?, 'unknown', ?, 'EUR', 'included', '[]', 'confirmed', 'high', 'ok', ?)
  `).run(id, `pkg-${id}`, transfer, total, nowIso())
}

function seedTripWithVerdicts(over: {
  tripKey?: string; checkIn?: string; checkOut?: string; nights?: number; board?: string
  obsBase?: number; exactTotal?: number; closeTotal?: number; cashTotal?: number
} = {}): number {
  const tripKey = over.tripKey ?? "trip-lily"
  db.prepare(`
    INSERT INTO trip_opportunities (trip_key, origin, destination_airport, destination_group, property_id,
      check_in, check_out, nights, adults, construction, cabin, board,
      outbound_departure, return_departure, flight_detail, flight_score, flight_provenance,
      stay_window_key, stay_detail, stay_score, stay_provenance, cash_components,
      cash_total_amount, cash_total_currency, miles_components, unknown_costs, score, score_breakdown,
      trip_absolute_path, complexity, evidence, reasons, admission_gate, status, created_at, evaluated_at)
    VALUES (?, 'VIE', 'MLE', 'maldives', 'lily-beach',
      ?, ?, ?, 2, 'cash', 'economy', ?,
      '2026-11-20', '2026-11-26', '{}', 25, '[]',
      'w', '{}', 61, '{}', '[]',
      ?, 'USD', '[]', '["resort/airport transfer not priced"]', 48.2, '{}',
      'p', '{}', '{}', '["STAY_EXCEPTIONAL"]', 'gate', 'interesting', ?, ?)
  `).run(tripKey, over.checkIn ?? "2026-11-21", over.checkOut ?? "2026-11-28",
    over.nights ?? 7, over.board ?? "all_inclusive",
    over.cashTotal ?? 6131, nowIso(), nowIso())
  const tripId = (db.prepare("SELECT id FROM trip_opportunities WHERE trip_key=?").get(tripKey) as { id: number }).id

  const obsBase = over.obsBase ?? 901
  seedPackageObservation(obsBase, over.exactTotal ?? 6908, "included")       // EXACT
  seedPackageObservation(obsBase + 1, over.closeTotal ?? 6094, "unknown")    // CLOSE, cheaper

  const insertVerdict = db.prepare(`
    INSERT INTO market_verdicts (compute_batch, slot_key, trip_id, trip_key, package_observation_id,
      package_key, comparability, confidence, verdict, winner, reasons, comparison_currency,
      diy_known_total, package_total, absolute_difference, percent_difference,
      diy_ledger, package_ledger, fx_observation_ids, computed_at)
    VALUES (?, 'slot', ?, ?, ?, ?, ?, 'LOW', 'INSUFFICIENT_COMPARABILITY', NULL, ?, 'EUR',
      5264.94, ?, NULL, NULL, '{}', '{}', '[1]', ?)
  `)
  const batch = "2026-08-28T16:00:00.000Z"
  insertVerdict.run(batch, tripId, tripKey, obsBase, `pkg-${obsBase}`, "EXACT_MATCH",
    JSON.stringify([BOUNDED]), over.exactTotal ?? 6908, nowIso())
  insertVerdict.run(batch, tripId, tripKey, obsBase + 1, `pkg-${obsBase + 1}`, "CLOSE_MATCH",
    JSON.stringify(["transfer unknown caps comparability to CLOSE"]), over.closeTotal ?? 6094, nowIso())
  return tripId
}

function seedStayCandidate(over: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO stay_rate_observations (id, property_id, provider, provider_property_ref, check_in, check_out,
      nights, adults, children, board, board_source, source_class, price_amount, price_currency,
      price_basis, taxes_fees, verification_level, confidence, sanity, fetched_at)
    VALUES (@obsId, 'lily-beach', 'xotelo', 'g-d', '2026-11-19', '2026-11-24', 5, 2, 0,
      'all_inclusive', 'property_default', 'meta', 681, 'EUR', 'nightly_room', 'unknown',
      'discovered', 'medium', 'ok', @now)
  `).run({ obsId: over.obsId ?? 501, now: nowIso() })
  db.prepare(`
    INSERT INTO stay_candidates (source_id, opportunity_key, property_id, observed_at, as_of, evaluated_at,
      check_in, check_out, nights, adults, children, board, board_source, source_class, provider,
      verification_level, nightly_amount, price_currency, taxes_fees, sample_size, observed_median,
      percent_below_median, baseline_confidence, absolute_rule_path, confirmation_state, evidence,
      score, score_breakdown, reasons, threshold, status, sanity, engine_version, weights_version, created_at,
      verification_status)
    VALUES (@sourceId, @oppKey, 'lily-beach', @now, @now, @now,
      '2026-11-19', '2026-11-24', 5, 2, 0, 'all_inclusive', 'property_default', 'meta', 'xotelo',
      'discovered', @nightly, 'EUR', 'unknown', 34, 1019, @below, 'mature', 'p', 'meta_only', '{}',
      @score, '{}', '["RELATIVE_ANOMALY"]', 70, @status, 'ok', 'v', 'w', @now, 'not_gated')
  `).run({
    sourceId: over.obsId ?? 501, oppKey: over.oppKey ?? "opp-lily", now: nowIso(),
    nightly: over.nightly ?? 681, below: over.below ?? 33.2, score: over.score ?? 65.2,
    status: over.status ?? "candidate",
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("the deal radar feed — separation and honesty", () => {
  it("keeps the four categories separate with no cross-category composite rank", async () => {
    await seedFareRuns()
    const feed = buildDealRadarFeed(db)
    expect(Object.keys(feed)).toEqual(expect.arrayContaining(["packages", "faresRoundTrip", "faresOneWay", "stays", "diy"]))
    expect(feed).not.toHaveProperty("topDeals")
    expect(feed).not.toHaveProperty("ranked")
    // RT and OW never share a section and never share candidates.
    for (const c of feed.faresRoundTrip.cards) expect(c.tripType).toBe("ROUND_TRIP")
    for (const c of feed.faresOneWay.cards) expect(c.tripType).toBe("ONE_WAY")
  })

  it("below typical-fare maturity a fare card says 'cheapest observed', never 'deal'", async () => {
    await seedFareRuns()
    const feed = buildDealRadarFeed(db)
    expect(feed.faresRoundTrip.cards.length).toBeGreaterThan(0)
    for (const c of [...feed.faresRoundTrip.cards, ...feed.faresOneWay.cards]) {
      expect(c.evidence.kind).toBe("cheapest_observed")
      expect(c.evidence.label).toMatch(/cheapest observed/)
      expect(c.evidence.label.toLowerCase()).not.toContain("deal")
    }
  })

  it("a mature typical fare produces a relative position with its evidence counts", async () => {
    matureOneWayBaseline()
    await seedFareRuns()
    const feed = buildDealRadarFeed(db)
    const vie = feed.faresOneWay.cards.find(c => c.origin === "VIE")!
    expect(vie.evidence.kind).toBe("typical")
    expect(vie.evidence.percentVsTypical).toBeLessThan(0)          // 1400 vs median ~2000
    expect(vie.evidence.label).toMatch(/below typical/)
    expect(vie.evidence.label).toMatch(/\d+ obs over \d+ days/)
    expect(vie.evidence.samples).toBeGreaterThanOrEqual(20)
    // PRG has no mature baseline — its card must still refuse.
    const prg = feed.faresOneWay.cards.find(c => c.origin === "PRG")!
    expect(prg.evidence.kind).toBe("cheapest_observed")
  })

  it("one-way cards carry no return, no nights, a one-way replay link — and no 'saving' language anywhere", async () => {
    await seedFareRuns()
    const feed = buildDealRadarFeed(db)
    expect(feed.faresOneWay.cards.length).toBeGreaterThan(0)
    for (const c of feed.faresOneWay.cards) {
      expect(c.returnDate).toBeNull()
      expect(c.nights).toBeNull()
      expect(c.locator).not.toBeNull()
      expect(c.locator!.navigationQuality).toBe("SEARCH_REPLAY_LINK")
      expect(decodeURIComponent(c.locator!.searchReplayUrl!)).toContain("one way")
      expect(JSON.stringify(c).toLowerCase()).not.toContain("saving")
    }
    expect(feed.oneWayNote).toMatch(/never a saving/)
  })

  it("respects the configured section limits", async () => {
    await seedFareRuns()
    const feed = buildDealRadarFeed(db)
    expect(feed.faresRoundTrip.cards.length).toBeLessThanOrEqual(CFG.sections.fares.limit)
    expect(feed.faresOneWay.cards.length).toBeLessThanOrEqual(CFG.sections.fares.limit)
  })
})

describe("packages and DIY — verdict language and variant honesty", () => {
  it("passes the bounded verdict reasons through byte-identical", () => {
    seedProperty()
    seedTripWithVerdicts()
    const feed = buildDealRadarFeed(db)
    expect(feed.packages).toHaveLength(1)
    const card = feed.packages[0]
    expect(card.verdict.reasons).toContain(BOUNDED)                 // exact string, untouched
    expect(card.verdict.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(card.verdict.confidence).toBe("LOW")
    expect(card.verdict.fxObservationIds).toEqual([1])              // FX provenance retained
  })

  it("the cheaper CLOSE never hides the best EXACT — both are surfaced separately", () => {
    seedProperty()
    seedTripWithVerdicts()
    const feed = buildDealRadarFeed(db)
    const card = feed.packages[0]
    expect(card.bestExact).not.toBeNull()
    expect(card.bestExact!.locator.nativePrice).toBe(6908)
    expect(card.bestExact!.locator.transferStatus).toBe("included")
    expect(card.bestClose).not.toBeNull()
    expect(card.bestClose!.locator.nativePrice).toBe(6094)
    expect(card.bestClose!.locator.transferStatus).toBe("unknown")
  })

  it("DIY cards keep unknown costs named — never zeroed, never dropped", () => {
    seedProperty()
    seedTripWithVerdicts()
    const feed = buildDealRadarFeed(db)
    expect(feed.diy).toHaveLength(1)
    expect(feed.diy[0].unknownCosts).toEqual(["resort/airport transfer not priced"])
    expect(feed.diy[0].cashTotal).toEqual({ amount: 6131, currency: "USD" })
    expect(feed.diy[0].score).toBe(48.2)
  })
})

describe("all-inclusive holiday-length rule — package section only, projection only", () => {
  it("a 5-night all-inclusive package is excluded from discovery — observations untouched, DIY unaffected", () => {
    seedProperty()
    seedTripWithVerdicts({ nights: 5, checkOut: "2026-11-26" })
    const feed = buildDealRadarFeed(db)
    expect(feed.packages).toHaveLength(0)
    // Nothing deleted or mutated — the trip and its verdicts are still stored…
    expect((db.prepare("SELECT COUNT(*) AS c FROM trip_opportunities").get() as { c: number }).c).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS c FROM market_verdicts").get() as { c: number }).c).toBe(2)
    expect((db.prepare("SELECT COUNT(*) AS c FROM package_offer_observations").get() as { c: number }).c).toBe(2)
    // …and the rule does not bleed into other categories: the DIY card remains.
    expect(feed.diy).toHaveLength(1)
    expect(feed.diy[0].nights).toBe(5)
  })

  it("a 7-night all-inclusive package is included (threshold from config, default 7)", () => {
    expect(CFG.sections.packages.allInclusiveMinNights).toBe(7)
    seedProperty()
    seedTripWithVerdicts({ nights: 7, checkOut: "2026-11-28" })
    expect(buildDealRadarFeed(db).packages).toHaveLength(1)
  })

  it("a 10-night all-inclusive package is included", () => {
    seedProperty()
    seedTripWithVerdicts({ nights: 10, checkOut: "2026-12-01" })
    const feed = buildDealRadarFeed(db)
    expect(feed.packages).toHaveLength(1)
    expect(feed.packages[0].nights).toBe(10)
  })

  it("a short NON-all-inclusive package keeps its existing behavior", () => {
    seedProperty()
    seedTripWithVerdicts({ nights: 5, checkOut: "2026-11-26", board: "half_board" })
    const feed = buildDealRadarFeed(db)
    expect(feed.packages).toHaveLength(1)
    expect(feed.packages[0].board).toBe("half_board")
    expect(feed.packages[0].nights).toBe(5)
  })
})

describe("discovery grouping — one card per real discovery, nothing lost", () => {
  it("near-identical package trips collapse into one card with the cheapest first and variants intact", () => {
    seedProperty()
    seedTripWithVerdicts()   // Nov 21-28 (7n AI), EXACT 6908
    seedTripWithVerdicts({ tripKey: "trip-lily-2", checkIn: "2026-11-19", checkOut: "2026-11-26", obsBase: 911, exactTotal: 10450, closeTotal: 6808, cashTotal: 6347 })
    const feed = buildDealRadarFeed(db)
    expect(feed.packages).toHaveLength(1)                        // one discovery, not two Lily cards
    const card = feed.packages[0]
    expect(card.bestExact!.locator.nativePrice).toBe(6908)       // primary = cheapest best package
    expect(card.variants).toHaveLength(1)
    expect(card.variants[0].bestExact!.locator.nativePrice).toBe(10450)
    // Evidence survives verbatim INSIDE the variant too.
    expect(card.variants[0].verdict.reasons).toContain(BOUNDED)
    // Nothing was deleted or merged in storage.
    expect((db.prepare("SELECT COUNT(*) AS c FROM trip_opportunities").get() as { c: number }).c).toBe(2)
    expect((db.prepare("SELECT COUNT(*) AS c FROM market_verdicts").get() as { c: number }).c).toBe(4)
    // DIY groups the same way: cheapest same-currency total leads.
    expect(feed.diy).toHaveLength(1)
    expect(feed.diy[0].cashTotal).toEqual({ amount: 6131, currency: "USD" })
    expect(feed.diy[0].variants).toHaveLength(1)
    expect(feed.diy[0].variants[0].cashTotal).toEqual({ amount: 6347, currency: "USD" })
  })

  it("stay windows of one product group into one card, best existing score first", () => {
    seedProperty()
    seedStayCandidate({ obsId: 501, oppKey: "a", score: 65.2, below: 33.2 })
    seedStayCandidate({ obsId: 502, oppKey: "b", score: 55, below: 20, nightly: 720 })
    const feed = buildDealRadarFeed(db)
    expect(feed.stays).toHaveLength(1)
    expect(feed.stays[0].candidate.score).toBe(65.2)
    expect(feed.stays[0].variants).toHaveLength(1)
    expect(feed.stays[0].variants[0].candidate.nightlyAmount).toBe(720)
  })
})

describe("stays — existing scores, source-class honesty, floors", () => {
  it("surfaces a scored stay candidate with its stored evidence and a locator", () => {
    seedProperty()
    seedStayCandidate()
    const feed = buildDealRadarFeed(db)
    expect(feed.stays).toHaveLength(1)
    const s = feed.stays[0]
    expect(s.candidate.score).toBe(65.2)
    expect(s.candidate.percentBelowMedian).toBe(33.2)
    expect(s.candidate.sourceClass).toBe("meta")                    // labelled, never blended
    expect(s.locator).not.toBeNull()
  })

  it("excludes candidates below the configured floor and suspicious rows", () => {
    seedProperty()
    seedStayCandidate({ obsId: 501, oppKey: "low", score: CFG.sections.stays.minScore - 1 })
    seedStayCandidate({ obsId: 502, oppKey: "sus", score: 80, status: "suspicious" })
    const feed = buildDealRadarFeed(db)
    expect(feed.stays).toHaveLength(0)
  })
})
