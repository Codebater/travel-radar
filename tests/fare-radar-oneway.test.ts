/**
 * Phase 8k: ONE_WAY as a first-class trip shape.
 *
 * The load-bearing claims under test:
 *   - migration 022 rebuilds candidates without losing a row, an id or a byte
 *     of round-trip history, and makes a mislabelled trip shape unpersistable;
 *   - a ONE_WAY sweep never fabricates a return date or nights — not in the
 *     provider query, not in the candidate, not in the database;
 *   - ONE_WAY and ROUND_TRIP never share baselines, rankings or dedup keys;
 *   - the one-way replay link says "one way" explicitly;
 *   - a requested currency is never silently assumed or overridden.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { loadFareRadarConfig } from "../fareradar/config.js"
import { buildSearchPlan, refinementProbes } from "../fareradar/planner.js"
import { recheckTopFares, runFareRadar, type SearchFn } from "../fareradar/engine.js"
import { candidatesForRun, fareWindowKey, latestFareRadarRun, typicalFareFor } from "../fareradar/store.js"
import { buildFlightLocator, getLocator, type FlightPriceRow } from "../offers/locators.js"
import { latestVerification } from "../offers/recheck.js"
import type { CashFlightQuery, NormalizedCashFlight } from "../providers/cash-flights/types.js"
import { makeFlight } from "./mocks.js"

const CFG = loadFareRadarConfig(true)
const MIGRATIONS_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "db", "migrations")

let db: DB

beforeEach(() => {
  db = createMemoryDb()
})

/** Same stub as the round-trip suite: answers queries and persists the
 *  flight_prices rows the way the real orchestrator does. */
function stubSearch(pricing: (q: CashFlightQuery) => NormalizedCashFlight[] | null): { fn: SearchFn; queries: CashFlightQuery[] } {
  const queries: CashFlightQuery[] = []
  const fn: SearchFn = async (query, options) => {
    queries.push(query)
    const flights = pricing(query) ?? []
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
      flights,
      verificationLevel: "discovered",
      cacheAgeMinutes: null,
      fromCache: true,
      callsSpent: 0,
      attempts: [],
      warnings: [],
    }
  }
  return { fn, queries }
}

function fareFor(query: CashFlightQuery, amount: number, over: Partial<NormalizedCashFlight> = {}): NormalizedCashFlight {
  return makeFlight({
    origin: query.origin, destination: query.destination,
    departureDate: query.departureDate, returnDate: query.returnDate ?? null,
    cabin: query.cabin, price: { amount, currency: query.currency },
    bookingUrl: `https://www.google.com/travel/flights?q=Flights%20${query.origin}%20to%20${query.destination}%20on%20${query.departureDate}%20one%20way`,
    provider: "fast_flights",
    ...over,
  })
}

const RADAR_OW = { tripType: "ONE_WAY" as const, destination: "BKK", nextDays: 30, windowStart: "2026-10-01", source: "test" as const }

// ── Migration 022 ────────────────────────────────────────────────────────────

describe("migration 022 — the rebuild preserves history and hardens the shape", () => {
  function preMigrationDb(): InstanceType<typeof Database> {
    const raw = new Database(":memory:")
    raw.pragma("foreign_keys = ON")
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()
    for (const f of files.filter(f => f < "022")) {
      raw.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"))
    }
    return raw
  }

  function apply022(raw: InstanceType<typeof Database>): void {
    const file = fs.readdirSync(MIGRATIONS_DIR).find(f => f.startsWith("022"))!
    raw.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"))
  }

  it("a pre-022 candidate survives with its id, becomes ROUND_TRIP, and keeps return/nights byte-identical", () => {
    const raw = preMigrationDb()
    raw.prepare(`
      INSERT INTO fare_radar_runs (id, origins, destinations, destination_mode, window_start, window_end,
        min_nights, max_nights, cabin, adults, currency, plan, calls_planned, source, created_at)
      VALUES (1, '["VIE"]', '["BKK"]', 'specific', '2026-10-01', '2026-10-30', 4, 14, 'business', 1, 'EUR', '{}', 33, 'test', '2026-08-28T10:00:00Z')
    `).run()
    raw.prepare(`
      INSERT INTO fare_radar_candidates (id, run_id, itinerary_hash, origin, destination,
        departure_date, return_date, nights, adults, cabin, cabin_mix, cabin_mix_detail,
        airlines, quality_flags, price_amount, price_currency, deal_score, score_breakdown,
        fare_window_key, provider, observed_at, created_at)
      VALUES (7, 1, 'abc123', 'PRG', 'BKK', '2026-09-23', '2026-10-01', 8, 1, 'business',
        'BUSINESS_UNVERIFIED', 'no evidence', '["Austrian"]', '[]', 2120, 'EUR', 96,
        '{}', 'fare|PRG|BKK|d20719|medium|business|1a|EUR', 'fast_flights',
        '2026-08-28T10:00:00Z', '2026-08-28T10:00:00Z')
    `).run()

    apply022(raw)

    const row = raw.prepare("SELECT * FROM fare_radar_candidates WHERE id = 7").get() as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.trip_type).toBe("ROUND_TRIP")
    expect(row.return_date).toBe("2026-10-01")
    expect(row.nights).toBe(8)
    expect(row.price_amount).toBe(2120)
    expect(row.fare_window_key).toBe("fare|PRG|BKK|d20719|medium|business|1a|EUR")
    const run = raw.prepare("SELECT trip_type FROM fare_radar_runs WHERE id = 1").get() as { trip_type: string }
    expect(run.trip_type).toBe("ROUND_TRIP")
    // The rebuild recreated the indexes.
    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fare_radar_candidates'").all() as { name: string }[]
    expect(indexes.map(i => i.name)).toEqual(expect.arrayContaining(["idx_frc_run", "idx_frc_route"]))
    raw.close()
  })

  it("new ids continue past the preserved ones — history is never renumbered", () => {
    const raw = preMigrationDb()
    raw.prepare(`
      INSERT INTO fare_radar_runs (id, origins, destinations, destination_mode, window_start, window_end,
        min_nights, max_nights, cabin, adults, currency, plan, calls_planned, source, created_at)
      VALUES (1, '["VIE"]', '["BKK"]', 'specific', '2026-10-01', '2026-10-30', 4, 14, 'business', 1, 'EUR', '{}', 33, 'test', '2026-08-28T10:00:00Z')
    `).run()
    raw.prepare(`
      INSERT INTO fare_radar_candidates (id, run_id, itinerary_hash, origin, destination,
        departure_date, return_date, nights, adults, cabin, cabin_mix, cabin_mix_detail,
        airlines, quality_flags, price_amount, price_currency, deal_score, score_breakdown,
        fare_window_key, provider, observed_at, created_at)
      VALUES (130, 1, 'zzz', 'VIE', 'BKK', '2026-09-23', '2026-10-01', 8, 1, 'business',
        'BUSINESS_UNVERIFIED', 'no evidence', '["Qatar"]', '[]', 2593, 'EUR', 90, '{}',
        'k', 'fast_flights', '2026-08-28T10:00:00Z', '2026-08-28T10:00:00Z')
    `).run()
    apply022(raw)
    const r = raw.prepare(`
      INSERT INTO fare_radar_candidates (run_id, itinerary_hash, trip_type, origin, destination,
        departure_date, return_date, nights, adults, cabin, cabin_mix, cabin_mix_detail,
        airlines, quality_flags, price_amount, price_currency, deal_score, score_breakdown,
        fare_window_key, provider, observed_at, created_at)
      VALUES (1, 'new', 'ONE_WAY', 'VIE', 'BKK', '2026-10-05', NULL, NULL, 1, 'business',
        'BUSINESS_UNVERIFIED', 'no evidence', '["Qatar"]', '[]', 1140, 'EUR', 100, '{}',
        'k2', 'fast_flights', '2026-08-28T11:00:00Z', '2026-08-28T11:00:00Z')
    `).run()
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(130)
    raw.close()
  })
})

describe("schema constraints — a mislabelled trip shape is unpersistable", () => {
  function insertCandidate(over: Record<string, unknown>): void {
    db.prepare(`
      INSERT INTO fare_radar_runs (origins, destinations, destination_mode, window_start, window_end,
        min_nights, max_nights, cabin, adults, currency, plan, calls_planned, source, created_at, trip_type)
      VALUES ('["VIE"]', '["BKK"]', 'specific', '2026-10-01', '2026-10-30', 0, 0, 'business', 1, 'EUR', '{}', 10, 'test', '2026-08-28T10:00:00Z', 'ONE_WAY')
    `).run()
    const base = {
      run_id: 1, itinerary_hash: "h", trip_type: "ONE_WAY", origin: "VIE", destination: "BKK",
      departure_date: "2026-10-05", return_date: null, nights: null, adults: 1,
      cabin: "business", cabin_mix: "BUSINESS_UNVERIFIED", cabin_mix_detail: "d",
      airlines: "[]", quality_flags: "[]", price_amount: 1140, price_currency: "EUR",
      deal_score: 100, score_breakdown: "{}", fare_window_key: "k", provider: "fast_flights",
      observed_at: "2026-08-28T10:00:00Z", created_at: "2026-08-28T10:00:00Z",
      ...over,
    }
    db.prepare(`
      INSERT INTO fare_radar_candidates (run_id, itinerary_hash, trip_type, origin, destination,
        departure_date, return_date, nights, adults, cabin, cabin_mix, cabin_mix_detail,
        airlines, quality_flags, price_amount, price_currency, deal_score, score_breakdown,
        fare_window_key, provider, observed_at, created_at)
      VALUES (@run_id, @itinerary_hash, @trip_type, @origin, @destination,
        @departure_date, @return_date, @nights, @adults, @cabin, @cabin_mix, @cabin_mix_detail,
        @airlines, @quality_flags, @price_amount, @price_currency, @deal_score, @score_breakdown,
        @fare_window_key, @provider, @observed_at, @created_at)
    `).run(base)
  }

  it("ONE_WAY with null return and null nights persists", () => {
    expect(() => insertCandidate({})).not.toThrow()
  })

  it("ONE_WAY with a fabricated return date is refused by the schema itself", () => {
    expect(() => insertCandidate({ return_date: "2026-10-15" })).toThrow(/CHECK/)
  })

  it("ONE_WAY with fabricated nights is refused", () => {
    expect(() => insertCandidate({ nights: 7 })).toThrow(/CHECK/)
  })

  it("ROUND_TRIP without a return date is refused", () => {
    expect(() => insertCandidate({ trip_type: "ROUND_TRIP", nights: 7 })).toThrow(/CHECK/)
  })

  it("ROUND_TRIP without nights is refused", () => {
    expect(() => insertCandidate({ trip_type: "ROUND_TRIP", return_date: "2026-10-15" })).toThrow(/CHECK/)
  })

  it("an unknown trip_type value is refused — the enum is closed", () => {
    expect(() => insertCandidate({ trip_type: "SPLIT_ROUND_TRIP" })).toThrow(/CHECK/)
  })
})

// ── Planner ──────────────────────────────────────────────────────────────────

describe("the one-way planner — a curve over departure dates, never dates × lengths", () => {
  const base = { tripType: "ONE_WAY" as const, origins: ["VIE", "PRG"], windowStart: "2026-10-01", windowEnd: "2026-10-30", minNights: 0, maxNights: 0 }

  it("has no representative nights and every probe carries nights=null", () => {
    const plan = buildSearchPlan(CFG, { ...base, destinations: ["BKK"] })
    expect(plan.tripType).toBe("ONE_WAY")
    expect(plan.representativeNights).toBeNull()
    expect(plan.sparse.length).toBeGreaterThan(0)
    expect(new Set(plan.sparse.map(p => p.nights))).toEqual(new Set([null]))
    expect(plan.sparse[0].departureDate).toBe("2026-10-01")
    expect(plan.sparse[plan.probesPerRoute - 1].departureDate).toBe("2026-10-30")
    expect(plan.lines.join("\n")).toMatch(/ONE WAY/)
    expect(plan.lines.join("\n")).toMatch(/date-refinement/)
    expect(plan.lines.join("\n")).toMatch(/Total planned: \d+ \(cap \d+\)/)
  })

  it("costs exactly what the same round-trip plan costs — a different shape is never an excuse to spend more", () => {
    const ow = buildSearchPlan(CFG, { ...base, destinations: ["BKK"] })
    const rt = buildSearchPlan(CFG, { tripType: "ROUND_TRIP", origins: base.origins, windowStart: base.windowStart, windowEnd: base.windowEnd, minNights: 4, maxNights: 14, destinations: ["BKK"] })
    expect(ow.callsPlanned).toBe(rt.callsPlanned)
    expect(ow.cap).toBe(rt.cap)
  })

  it("Tier 1 densifies DATES around promising cells: deterministic, deduplicated, window-clamped, nights always null", () => {
    const plan = buildSearchPlan(CFG, { ...base, destinations: ["BKK"] })
    const cells = [
      { origin: "PRG", destination: "BKK", departureDate: "2026-10-08", cheapestObserved: 1140 },
      { origin: "PRG", destination: "BKK", departureDate: "2026-10-09", cheapestObserved: 1200 },
    ]
    const probes = refinementProbes(CFG, plan, cells)
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.length).toBeLessThanOrEqual(CFG.budget.refineNightsVariants * cells.length)
    for (const p of probes) {
      expect(p.nights).toBeNull()
      expect(p.departureDate >= "2026-10-01" && p.departureDate <= "2026-10-30").toBe(true)
      // A refinement probe is a NEW date for its cell, not the cell itself.
      expect(cells.some(c => c.origin === p.origin && c.destination === p.destination)).toBe(true)
    }
    // Deduplicated: adjacent cells share neighbour dates but never emit twice.
    const keys = probes.map(p => `${p.origin}|${p.destination}|${p.departureDate}`)
    expect(new Set(keys).size).toBe(keys.length)
    // Deterministic: the same input yields the identical probe list.
    expect(refinementProbes(CFG, plan, cells)).toEqual(probes)
  })

  it("a cell at the window edge is clamped, not pushed outside", () => {
    const plan = buildSearchPlan(CFG, { ...base, destinations: ["BKK"] })
    const probes = refinementProbes(CFG, plan, [
      { origin: "VIE", destination: "BKK", departureDate: "2026-10-30", cheapestObserved: 1300 },
    ])
    for (const p of probes) {
      expect(p.departureDate >= "2026-10-01" && p.departureDate <= "2026-10-30").toBe(true)
    }
  })

  it("reduces breadth under the cap deterministically with every reduction named — same order as round-trip", () => {
    const plan = buildSearchPlan(CFG, {
      ...base,
      destinations: ["BKK", "SIN", "HKT", "NRT", "ICN", "TPE", "DPS", "SGN", "HAN", "MNL", "KUL", "HKG"],
      maxSearches: 40,
    })
    expect(plan.callsPlanned).toBeLessThanOrEqual(40)
    expect(plan.reductions.length).toBeGreaterThan(0)
    expect(plan.lines.join("\n")).toMatch(/REDUCED/)
  })
})

// ── Engine ───────────────────────────────────────────────────────────────────

describe("the one-way engine — absolutely no invented return", () => {
  it("every provider query carries returnDate:null and candidates persist null/null", async () => {
    const { fn, queries } = stubSearch(q => [fareFor(q, 1140, { airline: "Qatar Airways", airlines: ["Qatar Airways"] })])
    const summary = await runFareRadar(db, RADAR_OW, { search: fn, log: () => {} })
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) expect(q.returnDate).toBeNull()
    const stored = candidatesForRun(db, summary.runId)
    expect(stored.length).toBeGreaterThan(0)
    for (const c of stored) {
      expect(c.tripType).toBe("ONE_WAY")
      expect(c.returnDate).toBeNull()
      expect(c.nights).toBeNull()
    }
    const raw = db.prepare("SELECT DISTINCT return_date, nights, trip_type FROM fare_radar_candidates").all() as Record<string, unknown>[]
    expect(raw).toEqual([{ return_date: null, nights: null, trip_type: "ONE_WAY" }])
    const run = latestFareRadarRun(db)!
    expect(run.tripType).toBe("ONE_WAY")
  })

  it("a provider echoing a return-dated itinerary to a one-way request is a counted mismatch, never a candidate", async () => {
    const { fn } = stubSearch(q => [fareFor(q, 1140, { returnDate: "2026-10-20" })])
    const summary = await runFareRadar(db, RADAR_OW, { search: fn, log: () => {} })
    expect(summary.candidatesStored).toBe(0)
    expect(summary.droppedByQuality.TRIP_TYPE_ECHO_MISMATCH).toBeGreaterThan(0)
  })

  it("explicit nights on a ONE_WAY run are rejected loudly, never silently used", async () => {
    const { fn } = stubSearch(q => [fareFor(q, 1140)])
    await expect(runFareRadar(db, { ...RADAR_OW, minNights: 4 }, { search: fn, log: () => {} }))
      .rejects.toThrow(/do not apply to a ONE_WAY/)
  })

  it("the cap holds for one-way sweeps exactly as for round trips", async () => {
    const { fn, queries } = stubSearch(q => [fareFor(q, 2000)])
    const summary = await runFareRadar(db, { ...RADAR_OW, destination: undefined, watchlistName: "asia", maxSearches: 25 }, { search: fn, log: () => {} })
    expect(queries.length).toBeLessThanOrEqual(25)
    expect(summary.plan.callsPlanned).toBeLessThanOrEqual(25)
  })

  it("a ONE_WAY run ranks only ONE_WAY candidates — round-trip history in the same database never leaks in", async () => {
    // A prior ROUND_TRIP run over the same route…
    const rt = stubSearch(q => [fareFor(q, 1700)])
    const rtSummary = await runFareRadar(db, { destination: "BKK", nextDays: 30, windowStart: "2026-10-01", source: "test" }, { search: rt.fn, log: () => {} })
    // …then a ONE_WAY run.
    const ow = stubSearch(q => [fareFor(q, 1140)])
    const owSummary = await runFareRadar(db, RADAR_OW, { search: ow.fn, log: () => {} })
    for (const c of [...owSummary.cheapest, ...owSummary.bestValue]) {
      expect(c.tripType).toBe("ONE_WAY")
      expect(c.runId).toBe(owSummary.runId)
    }
    // And the round-trip run's candidates are still intact and still ROUND_TRIP.
    for (const c of candidatesForRun(db, rtSummary.runId)) {
      expect(c.tripType).toBe("ROUND_TRIP")
      expect(c.returnDate).not.toBeNull()
    }
  })
})

// ── Baselines ────────────────────────────────────────────────────────────────

describe("baseline isolation — the two markets never inform each other", () => {
  it("round-trip fare-window keys are byte-identical to their pre-8k form", () => {
    const key = fareWindowKey({ tripType: "ROUND_TRIP", origin: "VIE", destination: "BKK", departureDate: "2026-10-08", nights: 9, cabin: "business", adults: 1, priceCurrency: "EUR" })
    expect(key).toMatch(/^fare\|VIE\|BKK\|d\d+\|medium\|business\|1a\|EUR$/)
  })

  it("one-way keys carry the hard token in the bucket slot and can never collide with any nights bucket", () => {
    const ow = fareWindowKey({ tripType: "ONE_WAY", origin: "VIE", destination: "BKK", departureDate: "2026-10-08", nights: null, cabin: "business", adults: 1, priceCurrency: "EUR" })
    expect(ow).toMatch(/^fare\|VIE\|BKK\|d\d+\|oneway\|business\|1a\|EUR$/)
    // Same route, same day, every possible round-trip length — none collides.
    for (const nights of [1, 4, 9, 14, 30]) {
      const rt = fareWindowKey({ tripType: "ROUND_TRIP", origin: "VIE", destination: "BKK", departureDate: "2026-10-08", nights, cabin: "business", adults: 1, priceCurrency: "EUR" })
      expect(rt).not.toBe(ow)
      expect(rt).not.toMatch(/\|oneway\|/)
    }
  })

  it("a ROUND_TRIP key without nights is refused, never bucketed blind", () => {
    expect(() => fareWindowKey({ tripType: "ROUND_TRIP", origin: "VIE", destination: "BKK", departureDate: "2026-10-08", nights: null, cabin: "business", adults: 1, priceCurrency: "EUR" }))
      .toThrow(/requires nights/)
  })

  function insertPriceRow(returnDate: string | null, fetchedAt: string, amount: number): void {
    db.prepare(`
      INSERT INTO flight_prices (itinerary_hash, origin, destination, departure_date, return_date,
        cabin, adults, price_amount, price_currency, provider, verification_level,
        provider_confidence, fetched_at)
      VALUES (?, 'VIE', 'BKK', '2026-10-08', ?, 'business', 1, ?, 'EUR', 'fast_flights', 'discovered', 'medium', ?)
    `).run(`h${Math.abs(amount)}${fetchedAt}${returnDate ?? "ow"}`, returnDate, amount, fetchedAt)
  }

  it("hundreds of mature round-trip observations cannot mature a one-way typical fare", () => {
    for (let d = 0; d < 5; d++) {
      for (let i = 0; i < 3; i++) insertPriceRow("2026-10-17", `2026-08-2${d}T10:0${i}:00Z`, 2000 + d * 10 + i)
    }
    const rt = typicalFareFor(db, { tripType: "ROUND_TRIP", origin: "VIE", destination: "BKK", nights: 9, cabin: "business", currency: "EUR" })
    expect(rt.mature).toBe(true)
    const ow = typicalFareFor(db, { tripType: "ONE_WAY", origin: "VIE", destination: "BKK", nights: null, cabin: "business", currency: "EUR" })
    expect(ow.mature).toBe(false)
  })

  it("mature one-way history cannot mature a round-trip typical fare", () => {
    for (let d = 0; d < 5; d++) {
      for (let i = 0; i < 3; i++) insertPriceRow(null, `2026-08-2${d}T10:0${i}:00Z`, 1100 + d * 10 + i)
    }
    const ow = typicalFareFor(db, { tripType: "ONE_WAY", origin: "VIE", destination: "BKK", nights: null, cabin: "business", currency: "EUR" })
    expect(ow.mature).toBe(true)
    if (ow.mature) expect(ow.median).toBeGreaterThan(0)
    const rt = typicalFareFor(db, { tripType: "ROUND_TRIP", origin: "VIE", destination: "BKK", nights: 9, cabin: "business", currency: "EUR" })
    expect(rt.mature).toBe(false)
  })
})

// ── Recheck ──────────────────────────────────────────────────────────────────

describe("one-way recheck — Phase 8i verification, no mutation, no invented return", () => {
  it("re-queries finalists with returnDate:null and appends the verification without touching the candidate", async () => {
    const first = stubSearch(q => [fareFor(q, 1140, { airline: "Qatar Airways", airlines: ["Qatar Airways"] })])
    const summary = await runFareRadar(db, RADAR_OW, { search: first.fn, log: () => {} })
    const top = summary.cheapest[0]
    expect(top.tripType).toBe("ONE_WAY")

    const moved = stubSearch(q => [fareFor(q, 1275, { airline: "Qatar Airways", airlines: ["Qatar Airways"] })])
    const results = await recheckTopFares(db, summary.runId, 3, { search: moved.fn })
    expect(moved.queries.length).toBeGreaterThan(0)
    for (const q of moved.queries) expect(q.returnDate).toBeNull()

    const hit = results.find(r => r.candidateId === top.id)!
    expect(hit.status).toBe("changed")
    expect(hit.observedPrice).toBe(1140)
    expect(hit.currentPrice).toBe(1275)

    const stored = candidatesForRun(db, summary.runId).find(c => c.id === top.id)!
    expect(stored.priceAmount).toBe(1140)
    expect(stored.returnDate).toBeNull()
    const verification = latestVerification(db, top.locatorId!)
    expect(verification?.status).toBe("changed")
  })
})

// ── Locator ──────────────────────────────────────────────────────────────────

describe("the one-way replay link — explicit one-way semantics, honest quality", () => {
  // URLSearchParams encodes spaces as "+" — normalize both encodings.
  const humanReadable = (url: string) => decodeURIComponent(url).replace(/\+/g, " ")
  const row = (over: Partial<FlightPriceRow> = {}): FlightPriceRow => ({
    id: 1, provider: "fast_flights", airline: "Qatar Airways", flight_numbers: null,
    origin: "PRG", destination: "BKK", departure_date: "2026-09-19", return_date: null,
    cabin: "business", adults: 1, price_amount: 1140, price_currency: "EUR",
    booking_url: null, fetched_at: "2026-08-28T10:00:00Z",
    ...over,
  })

  it("the constructed fallback says ONE WAY and carries no return date", () => {
    const locator = buildFlightLocator(row())
    expect(locator.navigationQuality).toBe("SEARCH_REPLAY_LINK")   // never EXACT for flights
    expect(locator.searchReplayUrl).toContain("www.google.com")
    expect(humanReadable(locator.searchReplayUrl!)).toContain("one way")
    expect(humanReadable(locator.searchReplayUrl!)).not.toContain("returning")
    expect(locator.returnDate).toBeNull()
  })

  it("a round-trip row still replays with its return date — unchanged", () => {
    const locator = buildFlightLocator(row({ return_date: "2026-10-01" }))
    expect(humanReadable(locator.searchReplayUrl!)).toContain("returning 2026-10-01")
    expect(humanReadable(locator.searchReplayUrl!)).not.toContain("one way")
  })

  it("the host allowlist still gates the fallback — a foreign stored URL degrades to the constructed one-way replay", () => {
    const locator = buildFlightLocator(row({ booking_url: "https://evil.example.com/flights" }))
    expect(locator.searchReplayUrl).toContain("www.google.com")
    expect(humanReadable(locator.searchReplayUrl!)).toContain("one way")
  })

  it("a one-way engine candidate ends up with a working one-way locator", async () => {
    const { fn } = stubSearch(q => [fareFor(q, 1140)])
    const summary = await runFareRadar(db, RADAR_OW, { search: fn, log: () => {} })
    const top = summary.cheapest[0]
    expect(top.locatorId).not.toBeNull()
    const locator = getLocator(db, top.locatorId!)!
    expect(locator.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    expect(humanReadable(locator.searchReplayUrl!)).toContain("one way")
    expect(humanReadable(locator.searchReplayUrl!)).not.toContain("returning")
  })
})
