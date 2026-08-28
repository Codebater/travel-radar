import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { loadFareRadarConfig, homeAirports, watchlist, anywhereDestinations } from "../fareradar/config.js"
import { buildSearchPlan, nightsVariants, representativeNights, refinementProbes } from "../fareradar/planner.js"
import { assessQuality, classifyCabinMix, scoreCandidate } from "../fareradar/score.js"
import { recheckTopFares, runFareRadar, type SearchFn } from "../fareradar/engine.js"
import { candidatesForRun, fareWindowKey, latestFareRadarRun, typicalFareFor } from "../fareradar/store.js"
import { getLocator } from "../offers/locators.js"
import { latestVerification } from "../offers/recheck.js"
import type { CashFlightQuery, NormalizedCashFlight } from "../providers/cash-flights/types.js"
import { makeFlight } from "./mocks.js"

const CFG = loadFareRadarConfig(true)

let db: DB

beforeEach(() => {
  db = createMemoryDb()
})

/**
 * A stub search that answers every query from a pricing function AND persists
 * flight_prices rows exactly like the real orchestrator (append-only, linked
 * to the search request) so locators have observations to anchor to.
 */
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
      fromCache: true,          // no politeness sleep in tests
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
    bookingUrl: `https://www.google.com/travel/flights?q=Flights%20${query.origin}%20to%20${query.destination}%20on%20${query.departureDate}`,
    provider: "fast_flights",
    ...over,
  })
}

const RADAR = { destination: "BKK", nextDays: 30, windowStart: "2026-10-01", source: "test" as const }

describe("configuration — airports are data, never code", () => {
  it("primary home airports come from config; extended join only when enabled", () => {
    expect(homeAirports(CFG, false)).toEqual(["VIE", "PRG"])
    expect(homeAirports(CFG, true)).toEqual(["VIE", "PRG", "BUD", "BTS", "MUC"])
  })

  it("origins can be overridden per run without touching config", async () => {
    const { fn, queries } = stubSearch(q => [fareFor(q, 2000)])
    await runFareRadar(db, { ...RADAR, origins: ["MUC"] }, { search: fn, log: () => {} })
    expect(new Set(queries.map(q => q.origin))).toEqual(new Set(["MUC"]))
  })

  it("watchlists resolve from config and ANYWHERE is their union — never invented", () => {
    expect(watchlist(CFG, "asia")).toContain("BKK")
    expect(watchlist(CFG, "nope")).toBeNull()
    const anywhere = anywhereDestinations(CFG)
    expect(anywhere).toEqual(expect.arrayContaining(["BKK", "JFK", "DXB"]))
    expect(new Set(anywhere).size).toBe(anywhere.length)
  })
})

describe("the search planner", () => {
  const base = { origins: ["VIE", "PRG"], windowStart: "2026-10-01", windowEnd: "2026-10-30", minNights: 4, maxNights: 14 }

  it("spreads probe dates across the next-N-days window at a representative trip length", () => {
    const plan = buildSearchPlan(CFG, { ...base, destinations: ["BKK"] })
    expect(plan.probesPerRoute).toBe(CFG.budget.sparseProbesPerRoute)
    expect(plan.sparse[0].departureDate).toBe("2026-10-01")
    expect(plan.sparse[plan.probesPerRoute - 1].departureDate).toBe("2026-10-30")
    expect(new Set(plan.sparse.map(p => p.nights))).toEqual(new Set([plan.representativeNights]))
    expect(plan.representativeNights).toBeGreaterThanOrEqual(4)
    expect(plan.representativeNights).toBeLessThanOrEqual(14)
    expect(plan.lines.join("\n")).toMatch(/Total planned: \d+ \(cap \d+\)/)
  })

  it("varying trip lengths come from preferred lengths, never an assumed 7", () => {
    expect(representativeNights(CFG, 4, 14)).toBe(8)     // preferred length nearest the window middle (9)
    expect(nightsVariants(CFG, 4, 14, 3)).toHaveLength(3)
    expect(nightsVariants(CFG, 10, 12, 3)).toEqual([10, 12])   // only in-range preferred lengths
  })

  it("reduces breadth intelligently under the cap and NAMES every reduction", () => {
    const plan = buildSearchPlan(CFG, {
      ...base,
      destinations: ["BKK", "SIN", "HKT", "NRT", "ICN", "TPE", "DPS", "SGN", "HAN", "MNL", "KUL", "HKG"],
      maxSearches: 40,
    })
    expect(plan.callsPlanned).toBeLessThanOrEqual(40)
    expect(plan.reductions.length).toBeGreaterThan(0)
    expect(plan.lines.join("\n")).toMatch(/REDUCED/)
    // Reductions shrink probes first, destinations last.
    expect(plan.destinations.length).toBeGreaterThan(0)
  })

  it("provider capability is data: fixed-date-only providers get a probe grid, and refinement respects the plan", () => {
    const plan = buildSearchPlan(CFG, { ...base, destinations: ["BKK"] })
    const probes = refinementProbes(CFG, plan, [
      { origin: "VIE", destination: "BKK", departureDate: "2026-10-08", cheapestObserved: 1800 },
    ])
    expect(probes.length).toBeLessThanOrEqual(CFG.budget.refineNightsVariants)
    for (const p of probes) {
      expect(p.nights).toBeGreaterThanOrEqual(4)
      expect(p.nights).toBeLessThanOrEqual(14)
      expect(p.departureDate >= "2026-10-01" && p.departureDate <= "2026-10-30").toBe(true)
    }
  })
})

describe("cabin truth", () => {
  it("echo-check: a provider answering economy to a business request is labelled, never ranked as business", () => {
    const echoed = classifyCabinMix(makeFlight({ cabin: "economy" }), "business")
    expect(echoed.mix).toBe("ECONOMY")
    const scored = scoreCandidate(1400, 1400, echoed.mix, 1, 700, [], CFG)
    expect(scored.dealScore).toBe(0)                       // nonBusinessResult penalty removes it from value ranking
    expect(scored.breakdown.nonBusinessResult).toBe(-CFG.scoring.penalties.premiumEconomyAsResult)
  })

  it("no per-segment cabins → BUSINESS_UNVERIFIED, with the absence stated", () => {
    const c = classifyCabinMix(makeFlight({ segments: [] }), "business")
    expect(c.mix).toBe("BUSINESS_UNVERIFIED")
    expect(c.detail).toMatch(/no per-segment cabin/)
  })

  it("segment evidence classifies FULL vs MIXED; mixed never silently competes", () => {
    const seg = (cabin: string | null) => ({
      origin: "VIE", destination: "DOH", departureTime: null, arrivalTime: null,
      airline: null, flightNumber: null, durationMinutes: null, aircraft: null, cabin,
    })
    const full = classifyCabinMix(makeFlight({ segments: [seg("Business"), seg("Business")] }), "business")
    expect(full.mix).toBe("BUSINESS_FULL")
    const mixed = classifyCabinMix(makeFlight({ segments: [seg("Business"), seg("Economy")] }), "business")
    expect(mixed.mix).toBe("BUSINESS_MIXED")
    expect(mixed.detail).toMatch(/Business \/ Economy/)
    // A partially-stated itinerary is UNVERIFIED, not FULL:
    const partial = classifyCabinMix(makeFlight({ segments: [seg("Business"), seg(null)] }), "business")
    expect(partial.mix).toBe("BUSINESS_UNVERIFIED")
  })

  it("exact business beats a misleadingly cheaper mixed cabin on value — and the raw cheapest order survives", () => {
    const mixed = scoreCandidate(1400, 1400, "BUSINESS_MIXED", 1, 700, [], CFG)
    const full = scoreCandidate(1500, 1400, "BUSINESS_FULL", 1, 700, [], CFG)
    expect(full.dealScore).toBeGreaterThan(mixed.dealScore)
    expect(mixed.breakdown.businessMixed).toBe(-CFG.scoring.penalties.businessMixed)   // WHY it lost is named
  })

  it("deal score is deterministic arithmetic", () => {
    const a = scoreCandidate(1742, 1742, "BUSINESS_UNVERIFIED", 1, 1095, ["LONG_LAYOVER"], CFG)
    const b = scoreCandidate(1742, 1742, "BUSINESS_UNVERIFIED", 1, 1095, ["LONG_LAYOVER"], CFG)
    expect(a).toEqual(b)
    expect(a.dealScore).toBe(100 - CFG.scoring.penalties.businessUnverified - CFG.scoring.penalties.perStop
      - CFG.scoring.penalties.longLayover - Math.round((1095 - 16 * 60) / 60 * CFG.scoring.penalties.durationPerHourOverThreshold * 10) / 10)
  })
})

describe("quality filters", () => {
  it("drops beyond max stops/duration with the drop named; flags nightmare features instead of hiding them", () => {
    expect(assessQuality(makeFlight({ stops: 3 }), CFG).dropped).toMatch(/STOPS/)
    expect(assessQuality(makeFlight({ durationMinutes: 40 * 60 }), CFG).dropped).toMatch(/LONGER/)
    const layover = assessQuality(makeFlight({
      segments: [
        { origin: "VIE", destination: "DOH", departureTime: "2026-10-08T14:00", arrivalTime: "2026-10-08T21:00", airline: null, flightNumber: null, durationMinutes: null, aircraft: null, cabin: null },
        { origin: "DOH", destination: "BKK", departureTime: "2026-10-09T06:30", arrivalTime: "2026-10-09T17:00", airline: null, flightNumber: null, durationMinutes: null, aircraft: null, cabin: null },
      ],
    }), CFG)
    expect(layover.dropped).toBeNull()
    expect(layover.flags).toContain("LONG_LAYOVER")
    expect(layover.flags).toContain("OVERNIGHT_CONNECTION")
  })
})

describe("the engine end-to-end (stubbed provider)", () => {
  it("VIE and PRG compete; the report exposes the fare difference, dedup keeps one row per itinerary", async () => {
    const { fn } = stubSearch(q => [
      fareFor(q, q.origin === "PRG" ? 1742 : 1816, { airline: q.origin === "PRG" ? "Turkish Airlines" : "Etihad", airlines: [q.origin === "PRG" ? "Turkish Airlines" : "Etihad"] }),
      // The same itinerary again (same airline/dates/stops) at a worse price — must dedupe to the cheap one.
      fareFor(q, q.origin === "PRG" ? 1799 : 1900, { airline: q.origin === "PRG" ? "Turkish Airlines" : "Etihad", airlines: [q.origin === "PRG" ? "Turkish Airlines" : "Etihad"] }),
    ])
    const summary = await runFareRadar(db, RADAR, { search: fn, log: () => {} })
    expect(summary.cheapest[0].origin).toBe("PRG")
    expect(summary.cheapest[0].priceAmount).toBe(1742)
    const all = candidatesForRun(db, summary.runId)
    const vieBest = all.find(c => c.origin === "VIE")!
    expect(vieBest.priceAmount).toBe(1816)
    expect(vieBest.priceAmount - summary.cheapest[0].priceAmount).toBe(74)
    // Dedup: per (route, dates, airline) only the cheapest sighting survives.
    const prgRows = all.filter(c => c.origin === "PRG")
    const keys = prgRows.map(c => `${c.departureDate}|${c.returnDate}|${c.airline}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("plans are enforced: request count never exceeds the cap, and the plan is stored with the run", async () => {
    const { fn, queries } = stubSearch(q => [fareFor(q, 2000)])
    const summary = await runFareRadar(db, { ...RADAR, watchlistName: "asia", maxSearches: 25 }, { search: fn, log: () => {} })
    expect(queries.length).toBeLessThanOrEqual(25)
    expect(summary.plan.callsPlanned).toBeLessThanOrEqual(25)
    const run = latestFareRadarRun(db)!
    expect(run.plan.lines).toBeDefined()
    expect(run.callsPlanned).toBe(summary.plan.callsPlanned)
    expect(run.searchesIssued).toBe(queries.length)
  })

  it("candidates carry offer locators with honest navigation and correct replay parameters", async () => {
    const { fn } = stubSearch(q => [fareFor(q, 1742)])
    const summary = await runFareRadar(db, RADAR, { search: fn, log: () => {} })
    const top = summary.cheapest[0]
    expect(top.locatorId).not.toBeNull()
    const locator = getLocator(db, top.locatorId!)!
    expect(locator.kind).toBe("flight")
    expect(locator.navigationQuality).toBe("SEARCH_REPLAY_LINK")   // flights are never EXACT
    expect(locator.searchReplayUrl).toContain("www.google.com")
    expect(locator.searchReplayUrl).toContain(top.departureDate)
  })

  it("fare-window keys use strict dimensions for the future baseline substrate", () => {
    const key = fareWindowKey({ origin: "VIE", destination: "BKK", departureDate: "2026-10-08", nights: 9, cabin: "business", adults: 1, priceCurrency: "EUR" })
    expect(key).toMatch(/^fare\|VIE\|BKK\|d\d+\|medium\|business\|1a\|EUR$/)
  })

  it("typical fares refuse below maturity, and history is append-only — never mutated", async () => {
    const { fn } = stubSearch(q => [fareFor(q, 1742)])
    const summary = await runFareRadar(db, RADAR, { search: fn, log: () => {} })
    const c = summary.cheapest[0]
    const typical = typicalFareFor(db, { origin: c.origin, destination: c.destination, nights: c.nights, cabin: c.cabin, currency: c.priceCurrency })
    expect(typical.mature).toBe(false)
    // A second run with DIFFERENT prices appends rows; existing rows survive
    // byte-identical (append-only, no in-place repricing anywhere).
    const before = db.prepare("SELECT id, price_amount FROM flight_prices ORDER BY id").all() as { id: number; price_amount: number }[]
    const moved = stubSearch(q => [fareFor(q, 1999)])
    await runFareRadar(db, RADAR, { search: moved.fn, log: () => {} })
    const after = db.prepare("SELECT id, price_amount FROM flight_prices ORDER BY id").all() as { id: number; price_amount: number }[]
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.slice(0, before.length)).toEqual(before)
  })
})

describe("recheck finalists", () => {
  it("a moved fare reports PRICE CHANGED into the 8i verification trail without touching the candidate", async () => {
    const first = stubSearch(q => [fareFor(q, 1690)])
    const summary = await runFareRadar(db, RADAR, { search: first.fn, log: () => {} })
    const top = summary.cheapest[0]

    const moved = stubSearch(q => [fareFor(q, 1825)])
    const results = await recheckTopFares(db, summary.runId, 5, { search: moved.fn })
    const hit = results.find(r => r.candidateId === top.id)!
    expect(hit.status).toBe("changed")
    expect(hit.observedPrice).toBe(1690)
    expect(hit.currentPrice).toBe(1825)

    // Candidate row untouched; the change lives in the append-only trail.
    const stored = candidatesForRun(db, summary.runId).find(c => c.id === top.id)!
    expect(stored.priceAmount).toBe(1690)
    const verification = latestVerification(db, top.locatorId!)
    expect(verification?.status).toBe("changed")
    expect(verification?.changes).toEqual([{ dimension: "price", observed: 1690, current: 1825 }])
  })

  it("a vanished fare is unavailable — historical candidate and observation stand", async () => {
    const first = stubSearch(q => [fareFor(q, 1690)])
    const summary = await runFareRadar(db, RADAR, { search: first.fn, log: () => {} })
    const gone = stubSearch(() => [])
    const results = await recheckTopFares(db, summary.runId, 1, { search: gone.fn })
    expect(results[0].status).toBe("unavailable")
    expect(candidatesForRun(db, summary.runId)[0].priceAmount).toBe(1690)
  })

  it("recheck is capped at the configured finalist count", async () => {
    const first = stubSearch(q => [fareFor(q, 1700), fareFor(q, 1800, { airline: "Qatar", airlines: ["Qatar"], stops: 2 })])
    const summary = await runFareRadar(db, RADAR, { search: first.fn, log: () => {} })
    const again = stubSearch(q => [fareFor(q, 1700)])
    const results = await recheckTopFares(db, summary.runId, 99, { search: again.fn })
    expect(results.length).toBeLessThanOrEqual(CFG.budget.confirmFinalists)
  })
})
