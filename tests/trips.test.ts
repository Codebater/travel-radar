import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import type { NormalizedStayRate } from "../providers/stays/types.js"
import { loadStaysConfig, type StaysConfig } from "../stays/config.js"
import { evaluateStayObservations } from "../stays/engine.js"
import { getStayProperty, seedStayProperties, type StayUniverseConfig } from "../stays/registry.js"
import { recordRateObservations, recordStaySearchRequest } from "../stays/store.js"
import { composeTrips, overpricedComponent } from "../trips/compose.js"
import { listStayCandidates } from "../stays/candidates.js"
import { loadTripsConfig, type TripsConfig } from "../trips/config.js"
import { listTrips, tripTotals } from "../trips/store.js"
import { makeStayRate } from "./stay-mocks.js"

const STAYS: StaysConfig = loadStaysConfig(true)
const TRIPS: TripsConfig = loadTripsConfig(true)

const CHECK_IN = "2026-11-19"
const CHECK_OUT = "2026-11-24"

function universe(): StayUniverseConfig {
  return {
    destinationGroups: { maldives: { label: "Maldives", airports: ["MLE"] } },
    properties: [{
      id: "lily-beach-resort", name: "Lily Beach Resort & Spa", destinationGroup: "maldives",
      country: "Maldives", nearestAirports: ["MLE"], luxuryTier: "luxury", allInclusive: "only",
      defaultBoard: "all_inclusive", typicalStayNights: [5], priority: 1, active: true,
      refs: { xotelo: "g1-d1" },
    }],
  }
}

function stayObs(db: DB, over: Partial<NormalizedStayRate> = {}): void {
  const property = getStayProperty(db, "lily-beach-resort")!
  const requestId = recordStaySearchRequest(db, {
    propertyId: property.id, kind: "rates",
    checkIn: over.checkIn ?? CHECK_IN, checkOut: over.checkOut ?? CHECK_OUT,
    currency: "USD", source: "test",
  })
  recordRateObservations(db, property, requestId, [makeStayRate({
    propertyId: property.id, checkIn: CHECK_IN, checkOut: CHECK_OUT, nights: 5,
    board: "unknown", ...over,
  })], STAYS.sanity)
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The stay side used by most tests: 8-obs history at `median`, plus cheap
 * neighbouring check-ins at `nightly` so the window is sustained.
 */
function seedStaySide(db: DB, opts: { nightly?: number; median?: number } = {}): void {
  const nightly = opts.nightly ?? 640
  const median = opts.median ?? 980
  for (const age of [40, 36, 32, 28, 24, 20, 16, 12]) {
    stayObs(db, { price: { amount: median + (age % 3) * 10, currency: "USD" }, fetchedAt: daysAgo(age) })
  }
  for (const [offset, delta] of [[0, 0], [2, 5], [5, -10]] as const) {
    const checkIn = shiftDay(CHECK_IN, offset)
    stayObs(db, {
      price: { amount: nightly + delta, currency: "USD" },
      checkIn, checkOut: shiftDay(checkIn, 5), fetchedAt: daysAgo(0),
    })
  }
  evaluateStayObservations({ db, config: STAYS, fromScratch: true })
}

function cashFlight(db: DB, over: Partial<{
  origin: string; destination: string; departure: string; ret: string | null
  cabin: string; amount: number; currency: string; stops: number; fetchedAt: string
}> = {}): number {
  const v = {
    origin: "VIE", destination: "MLE", departure: shiftDay(CHECK_IN, -1), ret: CHECK_OUT,
    cabin: "business", amount: 1600, currency: "USD", stops: 1, fetchedAt: daysAgo(0),
    ...over,
  }
  const info = db.prepare(`
    INSERT INTO flight_prices (
      itinerary_hash, origin, destination, departure_date, return_date, cabin, adults,
      airline, stops, price_amount, price_currency, provider, verification_level,
      provider_confidence, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'Emirates', ?, ?, ?, 'fast_flights', 'discovered', 'medium', ?)
  `).run(
    `hash-${Math.abs(JSON.stringify(v).split("").reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}`,
    v.origin, v.destination, v.departure, v.ret, v.cabin, v.stops, v.amount, v.currency, v.fetchedAt,
  )
  return Number(info.lastInsertRowid)
}

function awardFlight(db: DB, over: Partial<{
  origin: string; destination: string; departure: string; cabin: string
  program: string; points: number; taxes: number | null; fetchedAt: string
}> = {}): number {
  const v = {
    origin: "VIE", destination: "MLE", departure: shiftDay(CHECK_IN, -1),
    cabin: "business", program: "LIFEMILES", points: 42000, taxes: 55, fetchedAt: daysAgo(0),
    ...over,
  }
  const info = db.prepare(`
    INSERT INTO award_prices (
      itinerary_hash, origin, destination, departure_date, cabin, loyalty_program, points,
      taxes_amount, taxes_currency, airline, stops, provider, verification_level,
      provider_confidence, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'Turkish', 1, 'roame', 'discovered', 'medium', ?)
  `).run(
    `award-${v.origin}-${v.destination}-${v.departure}-${v.program}-${v.points}`,
    v.origin, v.destination, v.departure, v.cabin, v.program, v.points, v.taxes, v.fetchedAt,
  )
  return Number(info.lastInsertRowid)
}

describe("trip composition", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  it("exceptional flight + reasonable stay → admitted through the flight gate", () => {
    seedStaySide(db, { nightly: 900, median: 980 })      // mild stay, quality ~0.2-0.3
    cashFlight(db, { amount: 900 })                       // business VIE-MLE at 900: crosses flight absolute bars
    const summary = composeTrips(db, TRIPS)
    expect(summary.admitted).toBeGreaterThanOrEqual(1)
    const trip = listTrips(db)[0]
    expect(trip.admissionGate).toBe("EXCEPTIONAL_FLIGHT_REASONABLE_STAY")
    expect(trip.flightScore!).toBeGreaterThan(trip.stayScore!)
  })

  it("exceptional stay + ordinary reasonable flight → admitted through the stay gate", () => {
    seedStaySide(db, { nightly: 560, median: 1100 })      // ~49% below → strong stay
    cashFlight(db, { amount: 2400, cabin: "business" })   // ordinary business fare
    // Need the stay quality >= exceptional (0.6): deep discount + retail confirm
    stayObs(db, {
      price: { amount: 850, currency: "USD" }, sourceClass: "retail", provider: "agoda",
      roomName: "Beach Villa", roomClass: "villa", board: "all_inclusive",
      boardSource: "structured", taxesFees: "included", verificationLevel: "confirmed",
      fetchedAt: daysAgo(0),
    })
    evaluateStayObservations({ db, config: STAYS, fromScratch: true })
    const summary = composeTrips(db, TRIPS)
    expect(summary.admitted).toBeGreaterThanOrEqual(1)
    const trip = listTrips(db)[0]
    expect(["EXCEPTIONAL_STAY_REASONABLE_FLIGHT", "STRONG_FLIGHT_STRONG_STAY", "EXCEPTIONAL_TRIP_ABSOLUTE_VALUE"])
      .toContain(trip.admissionGate)
    expect(trip.stayScore!).toBeGreaterThan(40)
  })

  it("both ordinary → no trip (ordinary × ordinary must stay silent)", () => {
    seedStaySide(db, { nightly: 960, median: 980 })       // 2% below: nothing
    cashFlight(db, { amount: 2600, cabin: "business" })   // ordinary fare
    const summary = composeTrips(db, TRIPS)
    expect(summary.admitted).toBe(0)
    expect(listTrips(db, { status: "interesting" })).toHaveLength(0)
    // Either the weak stay never formed a considered window, or the pair
    // failed every admission gate — both are the required silence.
    const gateRejections = summary.rejected["failed admission gates (ordinary × ordinary)"] ?? 0
    expect(gateRejections + (summary.stayWindowsConsidered === 0 ? 1 : 0)).toBeGreaterThanOrEqual(1)
  })

  it("both exceptional → compounds far above either single-path trip", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { amount: 850 })
    const summary = composeTrips(db, TRIPS)
    expect(summary.admitted).toBeGreaterThanOrEqual(1)
    const trip = listTrips(db)[0]
    expect(trip.score).toBeGreaterThan(60)
    expect(trip.reasons).toContain("ALL_INCLUSIVE")
  })

  it("amazing flight + absurdly expensive stay → never a trip (two independent defences)", () => {
    // Stay at 1.4× its own median: absurd for a deal radar.
    seedStaySide(db, { nightly: 1400, median: 980 })
    cashFlight(db, { amount: 850 })
    const summary = composeTrips(db, TRIPS)
    // First defence: an absurd stay scores so low it never forms a
    // considered opportunity window — the great flight finds no partner.
    expect(listTrips(db, { status: "interesting" })).toHaveLength(0)
    expect(summary.admitted).toBe(0)

    // Second defence, tested directly: had it slipped through, the kill
    // flags it against its own median.
    const candidate = listStayCandidates(db, { limit: 50 }).find(c => c.nightlyAmount === 1400)!
    const verdict = overpricedComponent(db, TRIPS,
      { legs: [], cabin: "business", origin: "VIE", destinationAirport: "MLE" } as never,
      { nightly: 1400, candidateId: candidate.id } as never)
    expect(verdict).toContain("median")
  })

  it("cheap stay + absurdly expensive flight → the kill fires from the flight side", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    // Route median needs >= 5 comparables; the judged fare is 1.5× that.
    for (const amount of [1500, 1550, 1600, 1650, 1700]) {
      cashFlight(db, { amount, departure: shiftDay(CHECK_IN, -40), ret: shiftDay(CHECK_OUT, -40), fetchedAt: daysAgo(20) })
    }
    cashFlight(db, { amount: 2400 })
    composeTrips(db, TRIPS)
    const rejected = listTrips(db, { status: "rejected" })
    expect(rejected.some(t => (t.rejectionReason ?? "").includes("route median"))).toBe(true)
  })

  it("dates barely incompatible → no trip is manufactured", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    // Departs 3 days before the earliest member check-in (limit 2) and a
    // return 3 days after check-out (limit 2): both out of range.
    cashFlight(db, { amount: 850, departure: shiftDay(CHECK_IN, -8), ret: shiftDay(CHECK_OUT, 3) })
    const summary = composeTrips(db, TRIPS)
    expect(summary.admitted).toBe(0)
  })

  it("arrival on check-in day earns reduced date credit and the caution detail", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { amount: 850, departure: CHECK_IN, ret: CHECK_OUT })
    composeTrips(db, TRIPS)
    const trip = listTrips(db)[0]
    const date = trip.scoreBreakdown.dateCompatibility as { raw: number; detail: string }
    expect(date.raw).toBe(0.5)
    expect(date.detail).toContain("overnight arrival may miss")
    expect(trip.reasons).not.toContain("DATES_ALIGN")
  })

  it("award + cash stay correctly separate: miles per program, cash itemised, never blended", () => {
    seedStaySide(db, { nightly: 640, median: 1150 })
    awardFlight(db, { departure: shiftDay(CHECK_IN, -1) })
    awardFlight(db, { origin: "MLE", destination: "VIE", departure: CHECK_OUT, points: 45000, taxes: 62 })
    composeTrips(db, TRIPS)
    const trip = listTrips(db).find(t => t.construction === "award")!
    expect(trip.milesComponents).toEqual([{ program: "LIFEMILES", miles: (42000 + 45000) * 2, legs: "outbound+return" }])
    expect(trip.cashTotal).not.toBeNull()
    // Cash total = award taxes (2 legs × 2 adults) + stay. NO mileage valuation anywhere.
    const expectedCash = (55 + 62) * 2 + trip.cashComponents
      .filter((c: any) => c.kind === "stay").reduce((s: number, c: any) => s + c.amount, 0)
    expect(trip.cashTotal!.amount).toBeCloseTo(expectedCash, 1)
    expect(JSON.stringify(trip.scoreBreakdown)).not.toContain("equivalent")
    // Trip absolute is uncomputable for award trips: a cash bar cannot price miles.
    const abs = trip.scoreBreakdown.tripAbsolute as { raw: number | null }
    expect(abs.raw).toBeNull()
  })

  it("unknown award taxes stay NAMED unknowns, never zeroed", () => {
    seedStaySide(db, { nightly: 640, median: 1150 })
    awardFlight(db, { taxes: null })
    awardFlight(db, { origin: "MLE", destination: "VIE", departure: CHECK_OUT, points: 45000, taxes: null })
    composeTrips(db, TRIPS)
    const trip = listTrips(db).find(t => t.construction === "award")!
    expect(trip.unknownCosts).toContain("outbound award taxes unknown")
    expect(trip.unknownCosts).toContain("return award taxes unknown")
    expect(trip.reasons).toContain("UNKNOWN_COSTS_REMAIN")
  })

  it("incompatible airport → no combination at all", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { destination: "CUN", amount: 850 })   // wrong side of the planet
    const summary = composeTrips(db, TRIPS)
    expect(summary.flightOptionsConsidered).toBe(0)
    expect(summary.rejected["no fresh compatible flight for the window"]).toBe(1)
  })

  it("stale flights are memories, not offers", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { amount: 850, fetchedAt: daysAgo(20) })   // maxFlightAgeDays 14
    const summary = composeTrips(db, TRIPS)
    expect(summary.flightOptionsConsidered).toBe(0)
  })

  it("trip identity is stable when prices change; duplicates upsert", () => {
    seedStaySide(db, { nightly: 640, median: 1150 })
    cashFlight(db, { amount: 900 })
    composeTrips(db, TRIPS)
    const before = listTrips(db)[0]

    // The same flight re-observed cheaper: same trip, new numbers.
    cashFlight(db, { amount: 860 })
    composeTrips(db, TRIPS)
    const after = listTrips(db)
    expect(after.filter(t => t.tripKey === before.tripKey)).toHaveLength(1)
    const updated = after.find(t => t.tripKey === before.tripKey)!
    expect(updated.id).toBe(before.id)
    expect(updated.createdAt).toBe(before.createdAt)
    expect(tripTotals(db).trips).toBe(after.length)      // no duplicate rows
  })

  it("evidence degradation: a verified stay outranks the identical discovered stay", () => {
    seedStaySide(db, { nightly: 640, median: 1150 })
    cashFlight(db, { amount: 900 })
    composeTrips(db, TRIPS)
    const discovered = listTrips(db)[0]

    db.prepare("UPDATE stay_candidates SET verification_status = 'verified'").run()
    evaluateStayObservations({ db, config: STAYS, fromScratch: true })
    db.prepare("UPDATE stay_candidates SET verification_status = 'verified'").run()
    composeTrips(db, TRIPS)
    const verified = listTrips(db).find(t => t.tripKey === discovered.tripKey)!
    expect(verified.score).toBeGreaterThan(discovered.score)
    expect(verified.reasons).toContain("VERIFIED_STAY")
  })

  it("combinatorial ceiling: many flights per stay are trimmed to the best few, and it is reported", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    // Six DISTINCT (departure, return) pairs, all date-compatible: more
    // options than the per-stay ceiling allows.
    for (const dep of [-2, -1]) {
      for (const lag of [0, 1, 2]) {
        cashFlight(db, {
          amount: 900 + dep * 10 + lag * 5,
          departure: shiftDay(CHECK_IN, dep),
          ret: shiftDay(CHECK_OUT, lag),
        })
      }
    }
    const summary = composeTrips(db, TRIPS)
    expect(summary.flightOptionsConsidered).toBe(6)
    expect(summary.combinationsExamined).toBeLessThanOrEqual(TRIPS.matching.maxFlightsPerStay)
    expect(summary.ceilingsHit.some(c => c.includes("maxFlightsPerStay"))).toBe(true)
  })

  it("trip-level absolute value fires only from KNOWN single-currency cash, no fabricated baseline", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { amount: 850 })
    composeTrips(db, TRIPS)
    const trip = listTrips(db).find(t => t.construction === "cash")!
    const abs = trip.scoreBreakdown.tripAbsolute as { raw: number | null; detail: string }
    // (850×2 + ~2800 stay)/5n = ~900/night vs maldives AI business bars: fires.
    expect(abs.raw).not.toBeNull()
    expect(trip.tripAbsoluteTier).not.toBeNull()
    expect(abs.detail).toContain("all-known-cash")
    // The path is a config rule — v1 never invents a historical trip baseline.
    expect(trip.tripAbsolutePath).toBe("maldives|all_inclusive|business")
    // And re-composing does not self-inflate from the stored trips (no history feedback).
    const scoreBefore = trip.score
    composeTrips(db, TRIPS)
    expect(listTrips(db).find(t => t.tripKey === trip.tripKey)!.score).toBe(scoreBefore)
  })

  it("mixed cash currencies stay itemised — never converted into one number", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { amount: 800, currency: "EUR" })
    composeTrips(db, TRIPS)
    const trip = listTrips(db)[0]
    expect(trip.cashTotal).toBeNull()
    expect(trip.cashComponents.length).toBeGreaterThanOrEqual(2)
    const abs = trip.scoreBreakdown.tripAbsolute as { raw: number | null; detail: string }
    expect(abs.raw).toBeNull()
    expect(abs.detail).toContain("never converted")
  })

  it("complexity: a 2-stop itinerary carries the layover penalty as a subtraction", () => {
    seedStaySide(db, { nightly: 560, median: 1150 })
    cashFlight(db, { amount: 850, stops: 2 })
    composeTrips(db, TRIPS)
    const trip = listTrips(db)[0]
    expect((trip.complexity.flags as string[])).toContain("long_layover")
    const penalty = trip.scoreBreakdown.complexityPenalty as { points: number }
    expect(penalty.points).toBeLessThan(0)
    expect(trip.reasons).toContain("COMPLEXITY_LONG_LAYOVER")
  })
})
