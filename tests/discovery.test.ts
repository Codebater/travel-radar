/**
 * Discovery: staged sampling, positioning economics, open jaws, absolute
 * rules, sanity guards, clustering, budgets and concurrency.
 *
 * The most important test in this file is the synthetic stress test: it proves
 * that asking the engine to cover 5 origins x 15 destinations x a 180-day
 * horizon x several trip lengths does NOT produce the 100,000-search cross
 * product that the naive reading of "flexible dates" implies.
 *
 * Entirely offline. Every provider is a mock; no external request is made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { recordPriceObservations, recordSearchRequest } from "../db/repositories.js"
import { setProviders } from "../providers/cash-flights/index.js"
import { setAwardProviders } from "../providers/award-flights/index.js"
import { loadDiscoveryConfig, groupForDestination, isPrimaryOrigin, type DiscoveryConfig } from "../discovery/config.js"
import {
  planStage2, selectStage2Windows, routesFor, sparseDates, sparseCabins,
  type SparseObservation,
} from "../discovery/sampling.js"
import { assessPositioning, bestHomeFare, observedFare } from "../discovery/positioning.js"
import { findOpenJaws } from "../discovery/openjaw.js"
import { upsertDiscoveryJob, listDiscoveryJobs, listDiscoveryRuns, type NewDiscoveryJob } from "../discovery/store.js"
import { planDiscoveryRun, executeDiscoveryJob } from "../discovery/engine.js"
import { projectDiscoveryBudget, discoveryVerificationPool, newRunBudget, canSpend, spend } from "../discovery/budget.js"
import { selectForVerification } from "../discovery/verification.js"
import { loadAnomalyConfig } from "../anomaly/config.js"
import { assessCashAbsolute, assessAwardAbsolute, routeDesirability } from "../anomaly/absolute.js"
import { checkCashSanity, checkAwardSanity, checkComparabilityGuards } from "../anomaly/sanity.js"
import { rebuildClusters, listClusters } from "../anomaly/clustering.js"
import { evaluateNewObservations } from "../anomaly/engine.js"
import { listCandidates } from "../anomaly/store.js"
import { MockProvider, MockAwardProvider, makeFlight, makeAwardFlight } from "./mocks.js"
import type { DiscoveryJob } from "../discovery/types.js"

let db: DB
let config: DiscoveryConfig
const NOW = new Date("2026-06-01T00:00:00.000Z")
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString()
const day = (days: number) => at(days).slice(0, 10)

function job(over: Partial<NewDiscoveryJob> = {}): DiscoveryJob {
  return upsertDiscoveryJob(db, {
    name: "discover-test",
    originGroup: "primary",
    destinationGroup: "thailand",
    horizonDays: 180,
    tripLengths: [7, 10, 14, 21],
    cabins: ["economy", "business"],
    frequencyHours: 24,
    priority: 1,
    budget: {
      maxFreeCallsPerRun: 90, maxAwardCallsPerRun: 8,
      maxMeteredCallsPerRun: 2, maxRuntimeMs: 1_800_000,
    },
    ...over,
  })
}

beforeEach(() => {
  db = createMemoryDb()
  config = loadDiscoveryConfig(true)
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  setProviders(null)
  setAwardProviders(null)
  db.close()
  vi.restoreAllMocks()
})

// ─── §38 the test the whole design exists to pass ───────────────────────────

describe("progressive sampling instead of brute force", () => {
  it("does not generate the cross product for a large scope", () => {
    // 5 origins x 15 destinations x 180 days x 7 trip lengths x 2 cabins.
    const wide = job({
      name: "stress",
      originGroup: "positioning",          // 5 airports
      destinationGroup: "wildcard",        // 10 airports
      horizonDays: 180,
      tripLengths: [4, 5, 7, 10, 14, 21, 28],
      cabins: ["economy", "business"],
    })

    const routes = routesFor(wide, config)
    const plan = planDiscoveryRun(wide, 0, config, NOW)

    // The naive reading of "search flexibly across the horizon".
    const bruteForce = routes.length * 180 * wide.tripLengths.length * wide.cabins.length
    expect(bruteForce).toBeGreaterThan(100_000)

    // What the engine actually asks for.
    expect(plan.stage1.length).toBeLessThanOrEqual(wide.budget.maxFreeCallsPerRun)
    expect(plan.expected.freeCalls).toBeLessThanOrEqual(wide.budget.maxFreeCallsPerRun)
    expect(plan.stage1.length / bruteForce).toBeLessThan(0.002)
  })

  it("trims the plan to the budget BEFORE searching, and says it did", () => {
    const tiny = job({
      name: "tiny-budget",
      destinationGroup: "wildcard",
      budget: {
        maxFreeCallsPerRun: 10, maxAwardCallsPerRun: 0,
        maxMeteredCallsPerRun: 0, maxRuntimeMs: 60_000,
      },
    })
    const plan = planDiscoveryRun(tiny, 0, config, NOW)
    expect(plan.stage1).toHaveLength(10)
    expect(plan.scopeReduced).toMatch(/trimmed from \d+ to 10/)
  })

  it("covers the horizon across runs rather than within one run", () => {
    const j = job()
    const runs = [0, 1, 2, 3].map(i => sparseDates(j, i, config, NOW))
    const union = new Set(runs.flat())
    // Each run samples a handful; four runs see meaningfully more than one.
    expect(runs[0]!.length).toBeLessThanOrEqual(config.sampling.stage1.datesPerRoute)
    expect(union.size).toBeGreaterThan(runs[0]!.length)
  })

  it("keeps every sampled date inside the horizon and in the future", () => {
    const j = job()
    for (const date of sparseDates(j, 3, config, NOW)) {
      const offset = (Date.parse(`${date}T00:00:00Z`) - NOW.getTime()) / 86_400_000
      expect(offset).toBeGreaterThanOrEqual(config.sampling.stage1.firstDepartureOffsetDays - 1)
      expect(offset).toBeLessThanOrEqual(j.horizonDays + 1)
    }
  })

  it("samples wildcard destinations in economy only, to buy breadth cheaply", () => {
    const wildcard = job({ name: "w", destinationGroup: "wildcard", cabins: ["economy", "business"] })
    const priority = job({ name: "p", destinationGroup: "thailand", cabins: ["economy", "business"] })
    expect(sparseCabins(wildcard, config)).toEqual(["economy"])
    expect(sparseCabins(priority, config)).toEqual(["economy", "business"])
  })

  it("narrows a job to its most wanted destinations when configured", () => {
    const narrow = job({ name: "narrow", budget: {
      maxFreeCallsPerRun: 90, maxAwardCallsPerRun: 8, maxMeteredCallsPerRun: 2,
      maxRuntimeMs: 60_000, maxDestinations: 2,
    } as any })
    const destinations = new Set(routesFor(narrow, config).map(r => r.destination))
    expect(destinations.size).toBe(2)
  })
})

// ─── §6 stage 2 fires only where stage 1 found something ────────────────────

describe("dense resolution only where it is earned", () => {
  const route = {
    origin: "VIE", destination: "BKK", destinationGroup: "thailand",
    requiresPositioning: false, desirability: 1,
  }
  const sparse = (price: number, date: string): SparseObservation => ({
    route, departureDate: date, cabin: "economy", tripLengthNights: 7,
    price, currency: "USD",
  })

  it("triggers on a sample well under its own route's sparse median", () => {
    const windows = selectStage2Windows([
      sparse(1000, day(30)), sparse(1050, day(60)), sparse(980, day(90)), sparse(600, day(120)),
    ], config)
    expect(windows).toHaveLength(1)
    expect(windows[0]!.observation.price).toBe(600)
    expect(windows[0]!.percentBelowSparseMedian).toBeGreaterThan(20)
  })

  it("does not trigger on an ordinary spread", () => {
    expect(selectStage2Windows([
      sparse(1000, day(30)), sparse(1050, day(60)), sparse(980, day(90)), sparse(1020, day(120)),
    ], config)).toHaveLength(0)
  })

  it("compares each route against ITSELF, not against other routes", () => {
    // An expensive route having a normal day must not trigger just because a
    // cheap route exists, and a cheap route must not trigger constantly.
    const expensive = { ...route, destination: "HKT" }
    const windows = selectStage2Windows([
      sparse(1000, day(30)), sparse(1000, day(60)), sparse(1000, day(90)),
      { ...sparse(2000, day(30)), route: expensive },
      { ...sparse(2000, day(60)), route: expensive },
      { ...sparse(2000, day(90)), route: expensive },
    ], config)
    expect(windows).toHaveLength(0)
  })

  it("refuses to call two samples a median", () => {
    expect(selectStage2Windows([sparse(1000, day(30)), sparse(400, day(60))], config)).toHaveLength(0)
  })

  it("caps how many windows one run resolves", () => {
    const many: SparseObservation[] = []
    for (let i = 0; i < 12; i++) {
      many.push({ ...sparse(1000, day(10 + i)), route: { ...route, destination: `X${i}` } })
      many.push({ ...sparse(1000, day(40 + i)), route: { ...route, destination: `X${i}` } })
      many.push({ ...sparse(200, day(70 + i)), route: { ...route, destination: `X${i}` } })
    }
    expect(selectStage2Windows(many, config).length)
      .toBeLessThanOrEqual(config.sampling.stage2.maxWindowsPerRun)
  })

  it("resolves neighbouring days without repeating the sample it came from", () => {
    const j = job()
    const targets = planStage2(sparse(600, day(120)), j, config)
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every(t => t.stage === 2)).toBe(true)
    const repeat = targets.find(t => t.departureDate === day(120) && t.tripLengthNights === 7)
    expect(repeat).toBeUndefined()
  })
})

// ─── §3/§4 positioning ──────────────────────────────────────────────────────

describe("positioning economics", () => {
  function homeFare(price: number, destination = "BKK") {
    for (let i = 0; i < 3; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination, cabin: "economy", returnDate: null,
        price: { amount: price, currency: "USD" }, fetchedAt: at(-i - 1),
        departureTime: `${day(30)}T10:00`,
      })], { adults: 1 })
    }
  }

  it("adds the train and the hotel to the fare rather than hiding them", () => {
    homeFare(790)
    const a = assessPositioning(db, {
      positioningAirport: "BUD", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T11:00`, cabin: "economy",
      mainFare: 430, currency: "USD", asOf: at(0), tripType: "oneway",
    }, config)

    expect(a.required).toBe(true)
    expect(a.mode).toBe("train")
    expect(a.positioningCost).toBeGreaterThan(0)
    expect(a.trueTripStartCost).toBe(430 + a.positioningCost + a.overnightCost)
    expect(a.comparableHomeFare).toBe(790)
    expect(a.savingVsHome).toBe(790 - a.trueTripStartCost)
    expect(a.worthwhile).toBe(true)
  })

  it("requires an overnight for a long transfer to an early departure", () => {
    homeFare(900)
    const a = assessPositioning(db, {
      positioningAirport: "MUC", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T06:20`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0),
    }, config)
    expect(a.overnightRequired).toBe(true)
    expect(a.overnightCost).toBeGreaterThan(0)
    expect(a.penaltyReasons.join(" ")).toMatch(/overnight/i)
  })

  it("never treats a positioning airport as being as convenient as home", () => {
    homeFare(900)
    const a = assessPositioning(db, {
      positioningAirport: "BTS", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0),
    }, config)
    // Even the closest, cheapest, most convenient positioning airport carries
    // the separate-ticket risk.
    expect(a.penalty).toBeGreaterThan(0)
    expect(a.penaltyReasons.join(" ")).toMatch(/separate ticket/i)
  })

  it("penalises a positioning leg that is itself a flight", () => {
    homeFare(900)
    const byFlight = assessPositioning(db, {
      positioningAirport: "WAW", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0),
    }, config)
    const byTrain = assessPositioning(db, {
      positioningAirport: "BUD", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0),
    }, config)
    expect(byFlight.penalty).toBeGreaterThan(byTrain.penalty)
    expect(byFlight.penaltyReasons.join(" ")).toMatch(/itself a flight/i)
  })

  it("refuses a saving that does not justify the inconvenience", () => {
    homeFare(500)
    const a = assessPositioning(db, {
      positioningAirport: "MUC", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T06:00`, cabin: "economy",
      mainFare: 470, currency: "USD", asOf: at(0),
    }, config)
    // 470 + bus + hotel is not cheaper than 500 from home.
    expect(a.worthwhile).toBe(false)
  })

  it("says so when there is no home fare to compare against", () => {
    const a = assessPositioning(db, {
      positioningAirport: "BUD", destination: "MLE", departureDate: day(30),
      cabin: "economy", mainFare: 400, currency: "USD", asOf: at(0),
    }, config)
    expect(a.comparableHomeFare).toBeNull()
    expect(a.savingVsHome).toBeNull()
    expect(a.worthwhile).toBe(false)
    expect(a.note).toMatch(/no comparable home-airport fare/i)
  })

  it("prefers an observed positioning fare over the configured estimate", () => {
    homeFare(900)
    for (let i = 0; i < 3; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "PRG", destination: "WAW", cabin: "economy", returnDate: null,
        // On the DATE being priced: the cheapest PRG-WAW fare in the window is
        // a different journey from the one this traveller has to take.
        departureDate: day(30),
        price: { amount: 41, currency: "USD" }, fetchedAt: at(-i - 1),
      })], { adults: 1 })
    }
    const a = assessPositioning(db, {
      positioningAirport: "WAW", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0), tripType: "oneway",
    }, config)
    expect(a.costBasis).toBe("observed")
    expect(a.positioningCost).toBe(41)
  })

  it("ignores a cheap positioning fare on a DIFFERENT date", () => {
    // It used to take the cheapest fare on any date in the window, which is a
    // cheaper journey than the one being priced - and every distortion here
    // has to be checked in the direction of flattering positioning.
    homeFare(900)
    recordPriceObservations(db, [makeFlight({
      origin: "PRG", destination: "WAW", cabin: "economy", returnDate: null,
      departureDate: day(90), price: { amount: 12, currency: "USD" }, fetchedAt: at(-1),
    })], { adults: 1 })

    const a = assessPositioning(db, {
      positioningAirport: "WAW", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0), tripType: "oneway",
    }, config)
    expect(a.positioningCost).not.toBe(12)
    expect(a.costBasis).toBe("estimated")
  })

  it("charges a return trip for BOTH positioning legs", () => {
    // You have to get to Budapest and back from it. Counting the train once
    // was a straight understatement of the thing this module exists to expose.
    homeFare(900)
    // A return home fare too, so the comparison line has something to say -
    // the helper above only seeds one-ways.
    for (let i = 0; i < 3; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "economy",
        departureDate: day(30), returnDate: day(44),
        price: { amount: 900, currency: "USD" }, fetchedAt: at(-i - 1),
      })], { adults: 1 })
    }
    const oneWay = assessPositioning(db, {
      positioningAirport: "BUD", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0), tripType: "oneway",
    }, config)
    const returnTrip = assessPositioning(db, {
      positioningAirport: "BUD", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 500, currency: "USD", asOf: at(0), tripType: "return",
    }, config)

    expect(returnTrip.positioningCost).toBe(oneWay.positioningCost * 2)
    expect(returnTrip.trueTripStartCost).toBeGreaterThan(oneWay.trueTripStartCost)
    expect(returnTrip.note).toMatch(/two positioning legs/)
  })

  it("compares a return positioning fare against a return home fare", () => {
    // A one-way positioning fare beside a home round trip would look like a
    // spectacular saving and be a category error.
    for (let i = 0; i < 3; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "economy",
        departureDate: day(30), returnDate: day(44),
        price: { amount: 800, currency: "USD" }, fetchedAt: at(-i - 1),
      })], { adults: 1 })
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "economy",
        departureDate: day(30), returnDate: null,
        price: { amount: 420, currency: "USD" }, fetchedAt: at(-i - 1),
      })], { adults: 1 })
    }
    const a = assessPositioning(db, {
      positioningAirport: "BUD", destination: "BKK", departureDate: day(30),
      departureTime: `${day(30)}T14:00`, cabin: "economy",
      mainFare: 600, currency: "USD", asOf: at(0), tripType: "return",
    }, config)
    // The 420 one-way must not be the yardstick for a return trip.
    expect(a.comparableHomeFare).toBe(800)
  })

  it("compares against the CHEAPEST home airport, not an arbitrary one", () => {
    homeFare(900)
    for (let i = 0; i < 3; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "PRG", destination: "BKK", cabin: "economy", returnDate: null,
        price: { amount: 640, currency: "USD" }, fetchedAt: at(-i - 1),
      })], { adults: 1 })
    }
    expect(bestHomeFare(db, "BKK", "economy", "USD", at(0), config)).toBe(640)
  })

  it("only counts observations recorded before the moment being judged", () => {
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "economy", returnDate: null,
      price: { amount: 100, currency: "USD" }, fetchedAt: at(5),
    })], { adults: 1 })
    expect(observedFare(db, "VIE", "BKK", "economy", "USD", at(0))).toBeNull()
  })
})

// ─── §8 open jaw ────────────────────────────────────────────────────────────

describe("open jaw", () => {
  function oneWay(origin: string, destination: string, date: string, price: number) {
    recordPriceObservations(db, [makeFlight({
      origin, destination, cabin: "economy", returnDate: null,
      departureDate: date, departureTime: `${date}T09:00`,
      price: { amount: price, currency: "USD" }, fetchedAt: at(-1),
    })], { adults: 1 })
  }
  function roundTrip(origin: string, destination: string, date: string, ret: string, price: number) {
    recordPriceObservations(db, [makeFlight({
      origin, destination, cabin: "economy", returnDate: ret,
      departureDate: date, departureTime: `${date}T09:00`,
      price: { amount: price, currency: "USD" }, fetchedAt: at(-1),
    })], { adults: 1 })
  }

  const options = () => ({
    cabin: "economy", currency: "USD", asOf: at(0),
    window: { from: day(0), to: day(90) },
    tripLengths: [7, 10, 14],
  })

  it("finds PRG out, VIE back, and scores the combination", () => {
    oneWay("PRG", "BKK", day(30), 300)
    oneWay("BKK", "VIE", day(37), 260)
    roundTrip("PRG", "BKK", day(30), day(37), 800)

    const jaws = findOpenJaws(db, "BKK", options(), config)
    expect(jaws.length).toBeGreaterThan(0)
    const jaw = jaws[0]!
    expect(jaw.outbound.origin).toBe("PRG")
    expect(jaw.inbound.destination).toBe("VIE")
    expect(jaw.totalPrice).toBe(560)
    expect(jaw.comparableRoundTrip).toBe(800)
    expect(jaw.saving).toBe(240)
    expect(jaw.tripLengthNights).toBe(7)
  })

  it("costs nothing to discover", async () => {
    // No provider is registered at all: a call would throw rather than be
    // silently mocked, which is the point.
    oneWay("PRG", "BKK", day(30), 300)
    oneWay("BKK", "VIE", day(37), 260)
    roundTrip("PRG", "BKK", day(30), day(37), 800)
    expect(() => findOpenJaws(db, "BKK", options(), config)).not.toThrow()
  })

  it("ignores a combination that does not beat the round trip by enough", () => {
    oneWay("PRG", "BKK", day(30), 390)
    oneWay("BKK", "VIE", day(37), 390)
    roundTrip("PRG", "BKK", day(30), day(37), 800)
    expect(findOpenJaws(db, "BKK", options(), config)).toHaveLength(0)
  })

  it("never builds a leg out of half a return fare", () => {
    // Only round trips exist, so there is nothing legitimate to combine.
    roundTrip("PRG", "BKK", day(30), day(37), 500)
    roundTrip("BKK", "VIE", day(37), day(44), 500)
    expect(findOpenJaws(db, "BKK", options(), config)).toHaveLength(0)
  })

  it("does not treat a same-airport return as an open jaw", () => {
    oneWay("PRG", "BKK", day(30), 300)
    oneWay("BKK", "PRG", day(37), 260)
    roundTrip("PRG", "BKK", day(30), day(37), 800)
    const jaws = findOpenJaws(db, "BKK", options(), config)
    expect(jaws.every(j => j.outbound.origin !== j.inbound.destination)).toBe(true)
  })
})

// ─── §21/§22 absolute rules ─────────────────────────────────────────────────

describe("absolute price rules", () => {
  const anomalyConfig = () => loadAnomalyConfig(true)

  it("recognises a good long-haul economy fare with no history at all", () => {
    const a = assessCashAbsolute(
      { price: 380, currency: "EUR", cabin: "economy", destinationGroup: "thailand" },
      anomalyConfig(),
    )
    expect(a.tier).toBe("extreme")
    expect(a.score).toBeGreaterThan(0)
  })

  it("tiers business fares the way the operator thinks about them", () => {
    const c = anomalyConfig()
    const base = { currency: "EUR", cabin: "business", destinationGroup: "thailand" as string | null }
    expect(assessCashAbsolute({ ...base, price: 1450 }, c).tier).toBe("interesting")
    expect(assessCashAbsolute({ ...base, price: 1150 }, c).tier).toBe("extreme")
    expect(assessCashAbsolute({ ...base, price: 950 }, c).tier).toBe("wtf")
    expect(assessCashAbsolute({ ...base, price: 2200 }, c).tier).toBeNull()
  })

  it("uses per-program thresholds for awards", () => {
    const c = anomalyConfig()
    const fb = assessAwardAbsolute({
      points: 60000, cabin: "business", loyaltyProgram: "FLYING_BLUE",
      taxesAmount: 80, taxesCurrency: "USD",
    }, c)
    const ae = assessAwardAbsolute({
      points: 60000, cabin: "business", loyaltyProgram: "AEROPLAN",
      taxesAmount: 80, taxesCurrency: "USD",
    }, c)
    // The same 60,000 points is an exceptional Aeroplan business redemption and
    // merely a good Flying Blue one, because Flying Blue prices that cabin far
    // lower to begin with. A single threshold across both programs would call
    // them identical, which is exactly the mistake §22 exists to prevent.
    expect(ae.tier).toBe("wtf")
    expect(fb.tier).toBe("extreme")
    expect(ae.score).toBeGreaterThan(fb.score)
  })

  it("lets a fuel surcharge demote a tier it cannot promote", () => {
    const c = anomalyConfig()
    const cheap = assessAwardAbsolute({
      points: 50000, cabin: "business", loyaltyProgram: "FLYING_BLUE",
      taxesAmount: 80, taxesCurrency: "USD",
    }, c)
    const surcharged = assessAwardAbsolute({
      points: 50000, cabin: "business", loyaltyProgram: "FLYING_BLUE",
      taxesAmount: 600, taxesCurrency: "USD",
    }, c)
    expect(cheap.tier).toBe("wtf")
    expect(surcharged.tier).not.toBe("wtf")
    expect(surcharged.detail).toMatch(/demoted/)
  })

  it("falls back to a default rule for an unconfigured group", () => {
    const a = assessCashAbsolute(
      { price: 300, currency: "EUR", cabin: "economy", destinationGroup: "somewhere-new" },
      anomalyConfig(),
    )
    expect(a.rulePath).toMatch(/default/)
    expect(a.tier).not.toBeNull()
  })

  it("scores desirability per airport", () => {
    const c = anomalyConfig()
    expect(routeDesirability("BKK", "thailand", c)).toBeGreaterThan(routeDesirability("DOH", "wildcard", c))
  })
})

// ─── §25/§26 guards and sanity ──────────────────────────────────────────────

describe("false-positive guards", () => {
  const anomalyConfig = () => loadAnomalyConfig(true)

  it("flags an impossible business fare instead of celebrating it", () => {
    const result = checkCashSanity({
      price: 12, currency: "EUR", cabin: "business", destinationGroup: "thailand",
      stops: 1, durationMinutes: 700, departureDate: day(30),
    }, anomalyConfig())
    expect(result.verdict).toBe("SUSPICIOUS_DATA")
    expect(result.detail).toMatch(/below the .* floor/)
  })

  it("still accepts a remarkable but possible fare", () => {
    // The floors must catch the impossible, not the merely extraordinary -
    // finding fares nobody expects is the entire point of the radar.
    expect(checkCashSanity({
      price: 620, currency: "EUR", cabin: "business", destinationGroup: "thailand",
      stops: 1, durationMinutes: 800, departureDate: day(30),
    }, anomalyConfig()).verdict).toBe("ok")
  })

  it("flags an absurd points value", () => {
    expect(checkAwardSanity({
      points: 900, taxesAmount: 50, taxesCurrency: "USD",
      stops: 1, durationMinutes: 700, departureDate: day(30),
    }, anomalyConfig()).verdict).toBe("SUSPICIOUS_DATA")
  })

  it("does not flag a real but awful routing", () => {
    // The first calibration used a 50-hour ceiling and flagged 33 genuine award
    // routings with long layovers. Mislabelling real data as suspicious is not
    // a harmless false positive: it poisons the very diagnostic that tells us
    // when a provider HAS started returning nonsense.
    expect(checkAwardSanity({
      points: 63500, taxesAmount: 120, taxesCurrency: "USD",
      stops: 2, durationMinutes: 3160, departureDate: day(30),
    }, anomalyConfig()).verdict).toBe("ok")
  })

  it("still flags a duration that can only be two itineraries joined together", () => {
    expect(checkAwardSanity({
      points: 63500, taxesAmount: 120, taxesCurrency: "USD",
      stops: 2, durationMinutes: 7000, departureDate: day(30),
    }, anomalyConfig()).verdict).toBe("SUSPICIOUS_DATA")
  })

  it("flags a malformed itinerary", () => {
    const result = checkCashSanity({
      price: 500, currency: "EUR", cabin: "economy", destinationGroup: "thailand",
      stops: 9, durationMinutes: 5, departureDate: null,
    }, anomalyConfig())
    expect(result.verdict).toBe("SUSPICIOUS_DATA")
    // Nine stops, a five-minute flight and no departure date: three separate
    // impossibilities, each named rather than collapsed into "looks wrong".
    expect(result.reasons.length).toBeGreaterThanOrEqual(3)
  })

  it("keeps a suspicious observation out of the candidate list but in the record", () => {
    for (let i = 0; i < 20; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "business", returnDate: null,
        price: { amount: 2000, currency: "USD" }, fetchedAt: at(-30 + i),
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "business", returnDate: null,
      price: { amount: 9, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })

    evaluateNewObservations({ db, quiet: true })
    const row = db.prepare(
      `SELECT sanity, status, score FROM deal_candidates WHERE price_amount = 9`,
    ).get() as any
    expect(row.sanity).toBe("SUSPICIOUS_DATA")
    expect(row.status).toBe("below-threshold")
    expect(listCandidates(db, { status: "candidate" }).some(c => c.priceAmount === 9)).toBe(false)
  })

  it("asserts the whole comparability guard set in one place", () => {
    const good = {
      observationCabin: "business", baselineCabin: "business",
      observationTripType: "return", baselineTripType: "return",
      observationCurrency: "USD", baselineCurrency: "USD",
      observationOrigin: "VIE", observationDestination: "BKK",
      baselineOrigin: "VIE", baselineDestination: "BKK",
      observationProgram: null, baselineProgram: null,
      sharesSearchWithBaseline: false,
    }
    expect(checkComparabilityGuards(good).verdict).toBe("ok")
    expect(checkComparabilityGuards({ ...good, baselineCabin: "economy" }).verdict).toBe("SUSPICIOUS_DATA")
    expect(checkComparabilityGuards({ ...good, baselineTripType: "oneway" }).verdict).toBe("SUSPICIOUS_DATA")
    expect(checkComparabilityGuards({ ...good, baselineCurrency: "EUR" }).verdict).toBe("SUSPICIOUS_DATA")
    expect(checkComparabilityGuards({ ...good, baselineDestination: "HKT" }).verdict).toBe("SUSPICIOUS_DATA")
    expect(checkComparabilityGuards({ ...good, baselineProgram: "AEROPLAN" }).verdict).toBe("SUSPICIOUS_DATA")
    expect(checkComparabilityGuards({ ...good, sharesSearchWithBaseline: true }).verdict).toBe("SUSPICIOUS_DATA")
  })
})

// ─── no-history decisions must not borrow history's language ───────────────

describe("a decision with no history makes no historical claims", () => {
  it("never claims a percentile it does not have", () => {
    // The empty baseline's zeroed percentile used to read as "0th percentile",
    // so a card with no observations at all announced itself as being in the
    // top 5% of a sample that did not exist.
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "MLE", cabin: "economy", returnDate: null,
      price: { amount: 300, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })

    const row = db.prepare(
      `SELECT reasons, sample_size, percentile FROM deal_candidates WHERE price_amount = 300`,
    ).get() as any
    expect(row.sample_size).toBe(0)
    const codes = JSON.parse(row.reasons).map((r: any) => r.code)
    expect(codes).toContain("NO_PRIOR_HISTORY")
    for (const claim of [
      "TOP_5_PERCENT_OBSERVED_PRICE", "TOP_10_PERCENT_OBSERVED_PRICE",
      "NEW_OBSERVED_LOW", "PERCENT_BELOW_MEDIAN", "THIN_BASELINE", "RELAXED_BASELINE",
    ]) {
      expect(codes).not.toContain(claim)
    }
  })

  it("cannot outrank a decision that is actually evidenced", () => {
    // Dropping four components concentrates the weight on the survivors, so
    // without a cap an unevidenced fare beats one backed by real observations
    // making the same claim. Evidence has to win.
    // Direct, wtf-tier, to a destination scored 1.0 for desirability: about as
    // strong as an evidence-free decision can possibly be.
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "MLE", cabin: "economy", returnDate: null, stops: 0,
      price: { amount: 200, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })

    const row = db.prepare(
      `SELECT score, score_breakdown FROM deal_candidates WHERE price_amount = 200`,
    ).get() as any
    const cap = loadAnomalyConfig(true) as any
    expect(row.score).toBeLessThanOrEqual(cap.noHistoryScoreCap ?? 85)
    expect(JSON.parse(row.score_breakdown).components.noHistoryCap).toBeDefined()
  })

  it("still says what it CAN say - the absolute price", () => {
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "MLE", cabin: "economy", returnDate: null,
      price: { amount: 300, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })
    const row = db.prepare(
      `SELECT absolute_tier, reasons FROM deal_candidates WHERE price_amount = 300`,
    ).get() as any
    expect(row.absolute_tier).not.toBeNull()
    expect(JSON.parse(row.reasons).map((r: any) => r.code).join(" ")).toMatch(/ABSOLUTE_/)
  })
})

// ─── §27 clustering ─────────────────────────────────────────────────────────

describe("clustering", () => {
  function candidate(price: number, date: string, over: Record<string, any> = {}) {
    for (let i = 0; i < 20; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "economy", returnDate: null,
        price: { amount: 1000, currency: "USD" }, fetchedAt: at(-40 + i),
        departureDate: date,
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "economy", returnDate: null,
      departureDate: date, price: { amount: price, currency: "USD" },
      fetchedAt: at(0), ...over,
    })], { adults: 1 })
  }

  it("shows three consecutive cheap days as one opportunity", () => {
    candidate(410, day(30))
    candidate(415, day(31))
    candidate(409, day(32))
    evaluateNewObservations({ db, quiet: true })

    const result = rebuildClusters(db, { minScore: 0 })
    const families = listClusters(db, { minScore: 0, limit: 20 })
      .filter(c => c.route === "VIE-BKK" && c.bestPrice !== null && c.bestPrice < 500)

    expect(families).toHaveLength(1)
    expect(families[0]!.memberCount).toBe(3)
    expect(families[0]!.bestPrice).toBe(409)
    expect(families[0]!.earliestDeparture).toBe(day(30))
    expect(families[0]!.latestDeparture).toBe(day(32))
    expect(result.largestCluster).toBeGreaterThanOrEqual(3)
  })

  it("keeps genuinely different prices apart", () => {
    candidate(410, day(30))
    candidate(900, day(31))
    evaluateNewObservations({ db, quiet: true })
    rebuildClusters(db, { minScore: 0 })
    const families = listClusters(db, { minScore: 0, limit: 20 }).filter(c => c.route === "VIE-BKK")
    expect(families.length).toBeGreaterThan(1)
  })

  it("keeps dates far apart in separate families", () => {
    candidate(410, day(30))
    candidate(412, day(90))
    evaluateNewObservations({ db, quiet: true })
    rebuildClusters(db, { minScore: 0 })
    const cheap = listClusters(db, { minScore: 0, limit: 20 })
      .filter(c => c.bestPrice !== null && c.bestPrice < 500)
    expect(cheap).toHaveLength(2)
  })

  it("represents a family with its best member", () => {
    candidate(500, day(30))
    candidate(409, day(31))
    evaluateNewObservations({ db, quiet: true })
    rebuildClusters(db, { minScore: 0 })
    const family = listClusters(db, { minScore: 0, limit: 20 })
      .find(c => c.memberCount > 1 && c.bestPrice !== null && c.bestPrice < 600)
    if (family) {
      const members = db.prepare(
        `SELECT score FROM deal_candidates WHERE cluster_id = ? ORDER BY score DESC`,
      ).all(family.id) as { score: number }[]
      expect(family.bestScore).toBe(members[0]!.score)
    }
  })

  it("never puts a suspicious observation into a family", () => {
    candidate(9, day(30))
    evaluateNewObservations({ db, quiet: true })
    rebuildClusters(db, { minScore: 0 })
    const clustered = db.prepare(
      `SELECT COUNT(*) c FROM deal_candidates WHERE sanity != 'ok' AND cluster_id IS NOT NULL`,
    ).get() as { c: number }
    expect(clustered.c).toBe(0)
  })
})

// ─── §14/§15/§35 budgets ────────────────────────────────────────────────────

describe("budgets and the verification gate", () => {
  it("keeps the manual reserve unreachable from the discovery pool", () => {
    const pool = discoveryVerificationPool(db, config)
    expect(pool.discoveryCeiling).toBeLessThanOrEqual(pool.automationCeiling)
    expect(pool.automationCeiling).toBe(pool.monthlyBudget - pool.manualReserve)
    expect(pool.discoveryCeiling + pool.manualReserve).toBeLessThan(pool.monthlyBudget + 1)
  })

  it("stops spending when a per-run ceiling is reached, and records why", () => {
    const j = job({ budget: {
      maxFreeCallsPerRun: 2, maxAwardCallsPerRun: 0,
      maxMeteredCallsPerRun: 0, maxRuntimeMs: 60_000,
    } })
    const state = newRunBudget()
    expect(canSpend(state, j, "free")).toBe(true)
    spend(state, "free", 2)
    expect(canSpend(state, j, "free")).toBe(false)
    expect(canSpend(state, j, "award")).toBe(false)
    expect(state.scopeReduced.join(" ")).toMatch(/ceiling/)
  })

  it("projects a month of the configured schedule", () => {
    job({ name: "p1", destinationGroup: "thailand" })
    const projection = projectDiscoveryBudget(db, config, NOW)
    expect(projection.jobs.length).toBeGreaterThan(0)
    expect(projection.totals.monthlyFreeCalls).toBeGreaterThan(0)
    // Whatever the schedule asks for, the pool decides what it gets.
    expect(projection.totals.monthlyMeteredCallsEffective)
      .toBeLessThanOrEqual(projection.serpapi.discoveryCeiling)
  })

  it("refuses to verify a candidate on a thin baseline", () => {
    const j = job()
    const runId = db.prepare(
      `INSERT INTO discovery_runs (job_id, started_at, status, trigger) VALUES (?, ?, 'running', 'manual')`,
    ).run(j.id, at(0)).lastInsertRowid as number

    const insert = (score: number, confidence: string, percent: number) => db.prepare(`
      INSERT INTO deal_candidates (
        source_table, source_id, observed_at, as_of, evaluated_at, type, origin, destination,
        route, departure_date, trip_type, cabin, baseline_key, baseline_scope, sample_size,
        baseline_confidence, percent_below_median, provider, provider_confidence,
        verification_level, score, score_breakdown, weights_version, engine_version,
        reasons, features, threshold, status, created_at, discovery_run_id, sanity,
        verification_status, price_amount, price_currency
      ) VALUES (
        'flight_prices', ?, ?, ?, ?, 'cash', 'VIE', 'BKK', 'VIE-BKK', ?, 'oneway', 'economy',
        'k', 'strict', 30, ?, ?, 'fast_flights', 'medium', 'discovered', ?, '{}', 'v', 'v',
        '[]', '{}', 70, 'candidate', ?, ?, 'ok', 'unverified', 400, 'USD'
      )
    `).run(
      Math.floor(Math.random() * 1e6), at(0), at(0), at(0), day(30),
      confidence, percent, score, at(0), runId,
    )

    insert(90, "HIGHER", 45)      // should qualify
    insert(90, "VERY_LOW", 45)    // thin baseline: the percentage itself is unreliable
    insert(60, "HIGHER", 45)      // score too low
    insert(90, "HIGHER", 5)       // not anomalous enough

    const selected = selectForVerification(db, runId, config)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.baseline_confidence).toBe("HIGHER")
  })
})

// ─── §20 provenance ─────────────────────────────────────────────────────────

describe("discovery provenance", () => {
  it("records the method that found a candidate rather than guessing it", () => {
    const searchId = recordSearchRequest(db, {
      origin: "VIE", destination: "MLE", departureDate: day(30), returnDate: null,
      cabin: "economy", adults: 1, currency: "USD",
    }, "discovery", { discoveryMethod: "WILDCARD", discoveryRunId: null, discoveryStage: 1 })

    for (let i = 0; i < 20; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "MLE", cabin: "economy", returnDate: null,
        price: { amount: 900, currency: "USD" }, fetchedAt: at(-30 + i),
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "MLE", cabin: "economy", returnDate: null,
      price: { amount: 420, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1, searchRequestId: searchId })

    evaluateNewObservations({ db, quiet: true })
    const row = db.prepare(
      `SELECT discovered_by, destination_group FROM deal_candidates WHERE price_amount = 420`,
    ).get() as any
    expect(row.discovered_by).toBe("WILDCARD")
    expect(row.destination_group).toBe("wildcard")
  })

  it("defaults to the fixed observer for a search with no discovery context", () => {
    for (let i = 0; i < 20; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "economy", returnDate: null,
        price: { amount: 900, currency: "USD" }, fetchedAt: at(-30 + i),
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "economy", returnDate: null,
      price: { amount: 420, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })
    const row = db.prepare(
      `SELECT discovered_by FROM deal_candidates WHERE price_amount = 420`,
    ).get() as any
    expect(row.discovered_by).toBe("FIXED_OBSERVER")
  })

  it("carries a positioning penalty onto the candidate", () => {
    for (let i = 0; i < 20; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "BUD", destination: "BKK", cabin: "economy", returnDate: null,
        price: { amount: 900, currency: "USD" }, fetchedAt: at(-30 + i),
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "BUD", destination: "BKK", cabin: "economy", returnDate: null,
      price: { amount: 430, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })

    evaluateNewObservations({ db, quiet: true })
    const row = db.prepare(
      `SELECT requires_positioning, positioning_penalty, true_trip_start_cost, reasons
       FROM deal_candidates WHERE price_amount = 430`,
    ).get() as any
    expect(row.requires_positioning).toBe(1)
    expect(row.positioning_penalty).toBeGreaterThan(0)
    expect(row.true_trip_start_cost).toBeGreaterThan(430)
    expect(row.reasons).toMatch(/POSITIONING_REQUIRED/)
  })

  it("scores a positioning fare below an identical home fare", () => {
    const seed = (origin: string) => {
      for (let i = 0; i < 20; i++) {
        recordPriceObservations(db, [makeFlight({
          origin, destination: "BKK", cabin: "economy", returnDate: null,
          price: { amount: 900, currency: "USD" }, fetchedAt: at(-30 + i),
        })], { adults: 1 })
      }
      recordPriceObservations(db, [makeFlight({
        origin, destination: "BKK", cabin: "economy", returnDate: null,
        price: { amount: 430, currency: "USD" }, fetchedAt: at(0),
      })], { adults: 1 })
    }
    seed("VIE")
    seed("BUD")
    evaluateNewObservations({ db, quiet: true })

    const home = db.prepare(`SELECT score FROM deal_candidates WHERE origin = 'VIE' AND price_amount = 430`).get() as any
    const positioned = db.prepare(`SELECT score FROM deal_candidates WHERE origin = 'BUD' AND price_amount = 430`).get() as any
    expect(positioned.score).toBeLessThan(home.score)
  })
})

// ─── engine integration, entirely mocked ────────────────────────────────────

describe("a discovery cycle end to end (mocked providers)", () => {
  it("runs the stages, records the run, and never touches a metered provider", async () => {
    const cash = new MockProvider({ name: "free_mock", flights: [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "economy", returnDate: null,
      price: { amount: 500, currency: "USD" },
    })] })
    setProviders([cash])
    setAwardProviders([new MockAwardProvider({ name: "roame", flights: [makeAwardFlight()] })])

    const j = job({
      name: "cycle",
      budget: {
        maxFreeCallsPerRun: 12, maxAwardCallsPerRun: 0,
        maxMeteredCallsPerRun: 0, maxRuntimeMs: 60_000,
        maxDestinations: 1, datesPerRoute: 2,
      } as any,
    })

    const execution = await executeDiscoveryJob(j, { db, trigger: "manual", cashOnly: true, config })
    const r = execution.result

    expect(r.status).toBe("success")
    expect(r.stage1Searches).toBeGreaterThan(0)
    expect(r.freeCalls).toBeLessThanOrEqual(12)
    expect(r.meteredCalls).toBe(0)
    expect(r.observationsAdded).toBeGreaterThan(0)

    const runs = listDiscoveryRuns(db, { jobId: j.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("success")

    // Every search it performed is labelled with the method that made it.
    const methods = db.prepare(
      `SELECT DISTINCT discovery_method FROM search_requests WHERE discovery_run_id = ?`,
    ).all(runs[0]!.id) as { discovery_method: string }[]
    expect(methods.length).toBe(1)
    // A priority-1 group is flexible-date discovery, not a wildcard sweep.
    // This was wrong for every job until an operator-precedence bug was fixed.
    expect(methods[0]!.discovery_method).toBe("FLEXIBLE_DATE")
  })

  it("labels a wildcard job as a wildcard sweep and a positioning job as positioning", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const budget = {
      maxFreeCallsPerRun: 2, maxAwardCallsPerRun: 0, maxMeteredCallsPerRun: 0,
      maxRuntimeMs: 60_000, maxDestinations: 1, datesPerRoute: 1,
    } as any

    const wildcard = job({ name: "w-label", destinationGroup: "wildcard", cabins: ["economy"], budget })
    await executeDiscoveryJob(wildcard, { db, trigger: "manual", cashOnly: true, config })

    const positioning = job({
      name: "p-label", originGroup: "positioning", destinationGroup: "thailand",
      cabins: ["economy"], budget,
    })
    await executeDiscoveryJob(positioning, { db, trigger: "manual", cashOnly: true, config })

    const labels = db.prepare(
      `SELECT DISTINCT discovery_method FROM search_requests WHERE discovery_method IS NOT NULL`,
    ).all() as { discovery_method: string }[]
    const set = new Set(labels.map(l => l.discovery_method))
    expect(set.has("WILDCARD")).toBe(true)
    expect(set.has("POSITIONING")).toBe(true)
  })

  it("refuses a second concurrent run of the same job", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const j = job({ name: "concurrent", budget: {
      maxFreeCallsPerRun: 2, maxAwardCallsPerRun: 0, maxMeteredCallsPerRun: 0,
      maxRuntimeMs: 60_000, maxDestinations: 1, datesPerRoute: 1,
    } as any })

    db.prepare(
      `INSERT INTO discovery_runs (job_id, started_at, status, trigger) VALUES (?, ?, 'running', 'manual')`,
    ).run(j.id, at(0))

    const execution = await executeDiscoveryJob(j, { db, trigger: "manual", cashOnly: true, config })
    expect(execution.runId).toBeNull()
    expect(execution.result.errors.join(" ")).toMatch(/already has a run in progress/)
  })

  it("keeps the fixed observer's jobs untouched", () => {
    // Phase 6 must not disturb Phase 4: different table, different rows.
    const before = db.prepare(`SELECT COUNT(*) c FROM observation_jobs`).get() as { c: number }
    job({ name: "isolated" })
    const after = db.prepare(`SELECT COUNT(*) c FROM observation_jobs`).get() as { c: number }
    expect(after.c).toBe(before.c)
    expect(listDiscoveryJobs(db).length).toBeGreaterThan(0)
  })
})

// ─── config sanity ──────────────────────────────────────────────────────────

describe("configuration", () => {
  it("knows which airports are home and which need positioning", () => {
    expect(isPrimaryOrigin("PRG", config)).toBe(true)
    expect(isPrimaryOrigin("VIE", config)).toBe(true)
    expect(isPrimaryOrigin("BUD", config)).toBe(false)
  })

  it("assigns a destination to its most important group", () => {
    expect(groupForDestination("BKK", config)?.key).toBe("thailand")
    expect(groupForDestination("CUN", config)?.key).toBe("mexico")
    expect(groupForDestination("MLE", config)?.key).toBe("wildcard")
    expect(groupForDestination("XXX", config)).toBeNull()
  })

  it("keeps alerts off", () => {
    expect(config.alerts.enabled).toBe(false)
  })

  it("has a positioning leg for every positioning airport", () => {
    for (const airport of config.homeRegion.positioning) {
      expect(config.homeRegion.positioningLegs[airport]).toBeDefined()
    }
  })
})
