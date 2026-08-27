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
  planStage2, planOpenJawLegs, selectStage2Windows, routesFor, sparseDates, sparseCabins,
  type SparseObservation,
} from "../discovery/sampling.js"
import { assessPositioning, bestHomeFare, observedFare } from "../discovery/positioning.js"
import { findOpenJaws, bestComparableRoundTrip } from "../discovery/openjaw.js"
import {
  upsertDiscoveryJob, listDiscoveryJobs, listDiscoveryRuns, startDiscoveryRun,
  type NewDiscoveryJob,
} from "../discovery/store.js"
import { planDiscoveryRun, executeDiscoveryJob } from "../discovery/engine.js"
import { projectDiscoveryBudget, discoveryVerificationPool, newRunBudget, canSpend, spend } from "../discovery/budget.js"
import { selectForVerification } from "../discovery/verification.js"
import { loadAnomalyConfig } from "../anomaly/config.js"
import { assessCashAbsolute, assessAwardAbsolute, routeDesirability } from "../anomaly/absolute.js"
import { scoreCash } from "../anomaly/scoring.js"
import { checkCashSanity, checkAwardSanity, checkComparabilityGuards, checkOpenJawSanity } from "../anomaly/sanity.js"
import { rebuildClusters, listClusters } from "../anomaly/clustering.js"
import { evaluateOpenJaws, openJawArrivals } from "../anomaly/openjaw.js"
import { buildFeed, dealDetail } from "../anomaly/feed.js"
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

  it("attributes a leg's price to the observation it actually came from", () => {
    // MIN(price) and MAX(fetched_at) in one GROUP BY forfeits SQLite's
    // bare-column guarantee, so a 300 USD fare was reported as having come from
    // the provider that quoted 900, at a timestamp when it did not exist.
    recordPriceObservations(db, [makeFlight({
      origin: "PRG", destination: "BKK", cabin: "economy", returnDate: null,
      departureDate: day(30), price: { amount: 300, currency: "USD" },
      provider: "cheap_provider", fetchedAt: at(-10),
    })], { adults: 1 })
    recordPriceObservations(db, [makeFlight({
      origin: "PRG", destination: "BKK", cabin: "economy", returnDate: null,
      departureDate: day(30), price: { amount: 900, currency: "USD" },
      provider: "expensive_provider", fetchedAt: at(-1),
    })], { adults: 1 })
    oneWay("BKK", "VIE", day(37), 200)
    roundTrip("PRG", "BKK", day(30), day(37), 900)

    const jaws = findOpenJaws(db, "BKK", { ...options(), includeNonQualifying: true }, config)
    const jaw = jaws.find(j => j.outbound.departureDate === day(30))
    expect(jaw).toBeDefined()
    expect(jaw!.outbound.price).toBe(300)
    expect(jaw!.outbound.provider).toBe("cheap_provider")
    expect(jaw!.outbound.observedAt).toBe(at(-10))
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

  it("drops the absolute component when no rule matches, rather than scoring it zero", () => {
    // A rule that did not MATCH is not a rule saying "bad price". Scoring it
    // zero penalised a route for a gap in our own config - the same mistake
    // the CPP component was explicitly designed to avoid.
    const baseline = {
      key: "k", scope: "strict", count: 30, min: 900, max: 3000, median: 1850,
      percentile: 10, percentBelowMedian: 20, differenceFromMinimum: 100,
      firstAt: at(-30), lastAt: at(-1), ageDays: 1,
      confidence: "MEDIUM" as const, confidenceValue: 0.75,
      medianTaxes: null, taxesCurrency: null, isNewObservedLow: false,
    }
    const input = {
      price: 1500, currency: "USD", stops: 1,
      providerConfidence: "medium", verificationLevel: "discovered", baseline,
    }
    const noRule = scoreCash(input, loadAnomalyConfig(true), {
      absolute: { tier: null, score: 0, thresholdUsed: null, rulePath: "none", detail: "no rule" },
    })
    // Dropped: zero weight, and the remaining components renormalise around it.
    expect(noRule.components.absolutePrice!.weight).toBe(0)
    expect(noRule.components.absolutePrice!.points).toBe(0)
    const applied = Object.values(noRule.effectiveWeights).reduce((a, b) => a + b, 0)
    expect(applied).toBeCloseTo(1, 2)

    // With a rule that DID match, the component carries real weight - and it
    // cuts both ways: a strong absolute price raises the score, a mediocre one
    // lowers it, which is exactly what a real signal should do.
    const strong = scoreCash(input, loadAnomalyConfig(true), {
      absolute: { tier: "wtf", score: 1, thresholdUsed: 1090, rulePath: "cash.thailand.business", detail: "matched" },
    })
    const mediocre = scoreCash(input, loadAnomalyConfig(true), {
      absolute: { tier: "interesting", score: 0.1, thresholdUsed: 1630, rulePath: "cash.thailand.business", detail: "matched" },
    })
    expect(strong.components.absolutePrice!.weight).toBeGreaterThan(0)
    expect(strong.score).toBeGreaterThan(noRule.score)
    expect(mediocre.score).toBeLessThan(noRule.score)
  })

  it("KEEPS the absolute component when the rule ran and said 'ordinary'", () => {
    // The distinction the first fix got wrong, and it inflated every ordinary
    // fare by 1/(1-0.18):
    //   no rule for this group/cabin  -> uncomputable, drop it
    //   rule ran and returned "above the threshold" -> a computed 0, keep it
    // Dropping the second pushed unremarkable fares over the verification gate,
    // where they would have spent metered calls confirming ordinary prices.
    const c = loadAnomalyConfig(true)
    const baseline = {
      key: "k", scope: "strict", count: 40, min: 2000, max: 4000, median: 3000,
      percentile: 5, percentBelowMedian: 30, differenceFromMinimum: 100,
      firstAt: at(-40), lastAt: at(-2), ageDays: 2,
      confidence: "HIGHER" as const, confidenceValue: 1,
      medianTaxes: null, taxesCurrency: null, isNewObservedLow: false,
    }
    const input = {
      price: 2100, currency: "USD", stops: 0,
      providerConfidence: "medium", verificationLevel: "discovered", baseline,
    }

    const ordinary = assessCashAbsolute(
      { price: 2100, currency: "USD", cabin: "business", destinationGroup: "thailand" }, c)
    expect(ordinary.tier).toBeNull()
    expect(ordinary.rulePath).not.toBe("none")

    const withVerdict = scoreCash(input, c, {
      absolute: ordinary, routeDesirability: 1, verificationStatus: "unverified",
    })
    expect(withVerdict.components.absolutePrice!.weight).toBeGreaterThan(0)
    expect(withVerdict.components.absolutePrice!.points).toBe(0)

    // And it must stay clear of the metered verification gate.
    const gate = loadDiscoveryConfig(true).verification.minScore
    expect(withVerdict.score).toBeLessThan(gate)

    // A route with no rule at all still drops the component.
    const noRule = scoreCash(input, c, {
      absolute: { tier: null, score: 0, thresholdUsed: null, rulePath: "none", detail: "no rule" },
      routeDesirability: 1, verificationStatus: "unverified",
    })
    expect(noRule.components.absolutePrice!.weight).toBe(0)
    expect(noRule.score).toBeGreaterThan(withVerdict.score)
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

  it("keeps a suspicious observation out of every later baseline", () => {
    // A 9 USD business fare correctly refused as a candidate would otherwise go
    // on dragging the median down for every honest observation after it -
    // quietly turning one bad row into a permanently distorted route.
    for (let i = 0; i < 20; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "BKK", cabin: "business", returnDate: null,
        price: { amount: 2000, currency: "USD" }, fetchedAt: at(-40 + i),
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "business", returnDate: null,
      price: { amount: 9, currency: "USD" }, fetchedAt: at(-2),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })

    // A later honest observation must be judged against the 2000s alone.
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "BKK", cabin: "business", returnDate: null,
      price: { amount: 1400, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })

    const later = db.prepare(
      `SELECT observed_median, observed_minimum FROM deal_candidates WHERE price_amount = 1400`,
    ).get() as any
    expect(later.observed_minimum).toBe(2000)
    expect(later.observed_median).toBe(2000)
  })

  it("flags an impossible first observation on a route it has never watched", () => {
    // The failure this prevents: a 12 USD first-class fare arrives on a brand
    // new route, is skipped for having no baseline, and is therefore never
    // flagged, never stored and never visible - while remaining that route's
    // observed minimum for the whole lookback. The guard was switched off in
    // exactly the situation it was written for.
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "DPS", cabin: "first", returnDate: null,
      price: { amount: 12, currency: "USD" }, fetchedAt: at(-20),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })

    const flagged = db.prepare(
      `SELECT sanity, status, sample_size FROM deal_candidates WHERE price_amount = 12`,
    ).get() as any
    expect(flagged).toBeDefined()
    expect(flagged.sanity).toBe("SUSPICIOUS_DATA")
    expect(flagged.status).toBe("below-threshold")

    // And because it now HAS a row, the baseline exclusion has something to
    // exclude by: the 12 must never become anybody's observed minimum.
    for (let i = 0; i < 10; i++) {
      recordPriceObservations(db, [makeFlight({
        origin: "VIE", destination: "DPS", cabin: "first", returnDate: null,
        price: { amount: 4000, currency: "USD" }, fetchedAt: at(-15 + i),
      })], { adults: 1 })
    }
    recordPriceObservations(db, [makeFlight({
      origin: "VIE", destination: "DPS", cabin: "first", returnDate: null,
      price: { amount: 2600, currency: "USD" }, fetchedAt: at(0),
    })], { adults: 1 })
    evaluateNewObservations({ db, quiet: true })

    const later = db.prepare(
      `SELECT observed_minimum, observed_median FROM deal_candidates WHERE price_amount = 2600`,
    ).get() as any
    expect(later.observed_minimum).toBe(4000)
    expect(later.observed_median).toBe(4000)
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

    // Every search it performed is labelled with the method that made it, and a
    // cycle now performs two kinds: the sparse return-trip scan, and the one-way
    // legs collected so open jaws can be assembled.
    const methods = db.prepare(`
      SELECT DISTINCT discovery_method, (return_date IS NULL) oneWay
      FROM search_requests WHERE discovery_run_id = ?
    `).all(runs[0]!.id) as { discovery_method: string; oneWay: number }[]

    // A priority-1 group is flexible-date discovery, not a wildcard sweep.
    // This was wrong for every job until an operator-precedence bug was fixed.
    const returnSearches = methods.filter(m => m.oneWay === 0)
    expect(returnSearches.length).toBe(1)
    expect(returnSearches[0]!.discovery_method).toBe("FLEXIBLE_DATE")
    // And the one-way searches are labelled for what they are, so "was open-jaw
    // collection worth its calls?" has an answer in a few weeks.
    expect(methods.filter(m => m.oneWay === 1).every(m => m.discovery_method === "OPEN_JAW")).toBe(true)
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

  it("closes the run and reschedules the job even when a stage throws", async () => {
    // A throw used to leave the run row marked 'running' forever: the job's
    // next cycle was blocked until the reaper noticed, and next_run_at was
    // never advanced - so the job came due again on the very next tick and
    // re-spent its whole budget, over and over.
    const exploding = new MockProvider({ name: "free_mock", throws: true })
    setProviders([exploding])
    const j = job({ name: "throws", budget: {
      maxFreeCallsPerRun: 4, maxAwardCallsPerRun: 0, maxMeteredCallsPerRun: 0,
      maxRuntimeMs: 60_000, maxDestinations: 1, datesPerRoute: 1,
    } as any })

    const execution = await executeDiscoveryJob(j, { db, trigger: "manual", cashOnly: true, config })

    const runs = listDiscoveryRuns(db, { jobId: j.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).not.toBe("running")
    expect(runs[0]!.completedAt).toBeTruthy()
    void execution

    const after = db.prepare(`SELECT next_run_at FROM discovery_jobs WHERE id = ?`).get(j.id) as any
    expect(after.next_run_at).toBeTruthy()
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it("stops before the award stage when the scheduler has been asked to stop", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const award = new MockAwardProvider({ name: "roame", flights: [makeAwardFlight()] })
    setAwardProviders([award])

    const j = job({ name: "stopping", budget: {
      maxFreeCallsPerRun: 4, maxAwardCallsPerRun: 8, maxMeteredCallsPerRun: 0,
      maxRuntimeMs: 60_000, maxDestinations: 1, datesPerRoute: 1,
    } as any })

    // Stage 1 runs, then the operator stops the scheduler. Award searches are
    // the slowest and most quota-bound thing here; continuing to spend them
    // after being asked to stop is the worst moment to keep going.
    let calls = 0
    await executeDiscoveryJob(j, {
      db, trigger: "manual", config,
      shouldContinue: () => { calls += 1; return calls <= 1 },
    })

    expect(award.calls.length).toBe(0)
    const runs = listDiscoveryRuns(db, { jobId: j.id })
    expect(runs[0]!.awardSearches).toBe(0)
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

// ─── §2/§22 open jaw as a real discovery method ─────────────────────────────

describe("open jaw as a discovery method", () => {
  // Before Phase 6.5 every one of these assertions was unreachable: both
  // evaluation sites hard-coded isOpenJaw false, so the column, the reason
  // codes, the clustering split and the detail panel described a capability
  // that could not fire.

  function leg(origin: string, destination: string, date: string, price: number, over: any = {}) {
    recordPriceObservations(db, [makeFlight({
      origin, destination, cabin: "economy", returnDate: null,
      departureDate: date, departureTime: `${date}T09:00`,
      price: { amount: price, currency: "USD" }, fetchedAt: at(-1),
      stops: 0, provider: "fast_flights", ...over,
    })], { adults: 1 })
  }
  function ret(origin: string, destination: string, date: string, back: string, price: number, over: any = {}) {
    recordPriceObservations(db, [makeFlight({
      origin, destination, cabin: "economy", returnDate: back,
      departureDate: date, departureTime: `${date}T09:00`,
      price: { amount: price, currency: "USD" }, fetchedAt: at(-1),
      stops: 0, provider: "fast_flights", ...over,
    })], { adults: 1 })
  }
  const run = (arrivals = ["BKK"]) => evaluateOpenJaws({
    db, discoveryConfig: config, arrivals, cabins: ["economy"], now: NOW, quiet: true,
  })
  const stored = (): any[] =>
    db.prepare(`SELECT * FROM deal_candidates WHERE is_open_jaw = 1 ORDER BY score DESC`).all() as any[]
  const jawOf = (row: any) => JSON.parse(row.open_jaw)
  const codes = (row: any) => JSON.parse(row.reasons).map((r: any) => r.code)

  it("produces a real candidate carrying isOpenJaw, not a zero column", () => {
    leg("PRG", "BKK", day(30), 300)
    leg("BKK", "VIE", day(37), 260)
    ret("PRG", "BKK", day(30), day(37), 800)

    const summary = run()
    expect(summary.combinationsStored).toBeGreaterThan(0)

    const rows = stored()
    expect(rows.length).toBeGreaterThan(0)
    const row = rows[0]!
    expect(row.is_open_jaw).toBe(1)
    expect(row.discovered_by).toBe("OPEN_JAW")
    // An open jaw is a decision about TWO observations, so it points at a pair
    // row rather than at a fare.
    expect(row.source_table).toBe("open_jaw")
    expect(row.route).toBe("PRG-BKK/BKK-VIE")
    expect(row.price_amount).toBe(560)
    expect(row.trip_type).toBe("return")
    expect(codes(row)).toContain("OPEN_JAW")
    expect(codes(row)).toContain("FOUND_BY_OPEN_JAW")
  })

  it("keeps each leg's own price, seller and timestamp all the way to the row", () => {
    // §3 the pair must never be presentable as one provider quoting a return.
    leg("PRG", "BKK", day(30), 300, { provider: "seller_a", fetchedAt: at(-4) })
    leg("BKK", "VIE", day(37), 260, { provider: "seller_b", fetchedAt: at(-1) })
    ret("PRG", "BKK", day(30), day(37), 800)
    run()

    const row = stored()[0]!
    const jaw = jawOf(row)
    const pair = db.prepare(`SELECT * FROM open_jaw_pairs WHERE id = ?`).get(row.source_id) as any
    expect(pair.outbound_price_id).toBe(jaw.outbound.priceId)
    expect(pair.inbound_price_id).toBe(jaw.inbound.priceId)

    for (const side of ["outbound", "inbound"] as const) {
      const observation = db.prepare(
        `SELECT * FROM flight_prices WHERE id = ?`,
      ).get(jaw[side].priceId) as any
      expect(observation).toBeDefined()
      expect(observation.price_amount).toBe(jaw[side].price)
      expect(observation.provider).toBe(jaw[side].provider)
      expect(observation.fetched_at).toBe(jaw[side].observedAt)
      expect(observation.origin).toBe(jaw[side].origin)
      expect(observation.return_date).toBeNull()
    }
    // And the candidate's own provider field says two tickets, whatever it says.
    expect(row.provider).toBe("seller_a + seller_b")
  })

  it("compares against a round trip of the SAME trip length, not merely the cheapest", () => {
    leg("PRG", "BKK", day(30), 300)
    leg("BKK", "VIE", day(37), 260)
    ret("PRG", "BKK", day(30), day(51), 400)   // 21 nights - a different trip
    ret("PRG", "BKK", day(30), day(37), 800)   // 7 nights - the real comparator
    run()

    const jaw = jawOf(stored()[0]!)
    expect(jaw.comparator.price).toBe(800)
    expect(jaw.comparator.nights).toBe(7)
    // The comparator carries the row it came from, so the figure can be checked.
    const observation = db.prepare(
      `SELECT * FROM flight_prices WHERE id = ?`,
    ).get(jaw.comparator.priceId) as any
    expect(observation.price_amount).toBe(800)
    expect(observation.return_date).toBe(day(37))
  })

  it("states the saving as arithmetic a reader can redo", () => {
    leg("PRG", "BKK", day(30), 300)
    leg("BKK", "VIE", day(37), 260)
    ret("PRG", "BKK", day(30), day(37), 800)
    run()

    const row = stored()[0]!
    const jaw = jawOf(row)
    expect(jaw.totalPrice).toBe(560)
    // The comparator is the ROW, not a copied number: there is one place the
    // 800 comes from, and it can be looked up.
    expect(jaw.comparator.price).toBe(800)
    expect(jaw.saving).toBe(240)
    expect(jaw.savingPercent).toBe(30)
    // Landing at VIE instead of PRG costs a train, and that comes off the saving.
    expect(jaw.homeTransferCost).toBeGreaterThan(0)
    expect(jaw.trueTripCost).toBe(560 + jaw.transferCost)
    expect(jaw.netSaving).toBe(800 - jaw.trueTripCost)
    expect(codes(row)).toContain("OPEN_JAW_SAVES_240")
  })

  it("refuses to invent a saving when no comparable round trip exists", () => {
    // §6 the honest answer to "how much does this save?" is sometimes "we have
    // never seen the trip it would be saving against".
    leg("PRG", "BKK", day(30), 300)
    leg("BKK", "VIE", day(37), 260)
    const summary = run()
    expect(summary.noComparator).toBeGreaterThan(0)

    const row = stored()[0]!
    const jaw = jawOf(row)
    expect(jaw.comparator).toBeNull()
    expect(jaw.saving).toBeNull()
    expect(jaw.savingPercent).toBeNull()
    expect(codes(row)).toContain("OPEN_JAW_NO_COMPARATOR")
    expect(codes(row)).toContain("NO_ROUNDTRIP_COMPARATOR")
    // Dropped and renormalised, NOT scored zero - scoring it zero would punish
    // the open jaw for a gap in our own observations.
    const breakdown = JSON.parse(row.score_breakdown)
    expect(breakdown.components.savingVsRoundTrip.weight).toBe(0)
    expect(breakdown.effectiveWeights.savingVsRoundTrip).toBeUndefined()
  })

  it("assembles a configured cross-city pairing", () => {
    // §8 Bangkok in, Phuket out is a real Thailand itinerary, and it is in the
    // config precisely so it can exist.
    leg("PRG", "BKK", day(30), 300)
    leg("HKT", "VIE", day(37), 200)
    run()

    const row = stored().find(r => r.route === "PRG-BKK/HKT-VIE")
    expect(row).toBeDefined()
    const jaw = jawOf(row!)
    expect(jaw.destinationPair.arrive).toBe("BKK")
    expect(jaw.destinationPair.depart).toBe("HKT")
    // The domestic hop is money, and it is counted.
    expect(jaw.destinationTransferCost).toBeGreaterThan(0)
    expect(jaw.trueTripCost).toBeGreaterThan(jaw.totalPrice)
  })

  it("will not pair two cities merely because both have a cheap one-way", () => {
    // §7/§8 Bangkok in, Bali out is two flights and a 4,000km gap. It is not a
    // trip, and no amount of cheapness should be able to make it one.
    leg("PRG", "BKK", day(30), 300)
    leg("DPS", "VIE", day(37), 90)
    run()

    expect(stored().some(r => JSON.parse(r.open_jaw).inbound.origin === "DPS")).toBe(false)
    expect(config.openJaw.destinationPairs.some(p => p.depart === "DPS")).toBe(false)
  })

  it("says when the two legs come from different sellers", () => {
    leg("PRG", "BKK", day(30), 300, { provider: "seller_a" })
    leg("BKK", "VIE", day(37), 260, { provider: "seller_b" })
    ret("PRG", "BKK", day(30), day(37), 800)
    run()

    const row = stored()[0]!
    expect(codes(row)).toContain("OPEN_JAW_MIXED_PROVIDER")
    expect(jawOf(row).mixedProvider).toBe(true)

    // The same trip from one seller is the same trip with less to go wrong.
    db.prepare(`DELETE FROM deal_candidates`).run()
    db.prepare(`DELETE FROM open_jaw_pairs`).run()
    db.prepare(`DELETE FROM flight_prices`).run()
    leg("PRG", "BKK", day(30), 300, { provider: "seller_a" })
    leg("BKK", "VIE", day(37), 260, { provider: "seller_a" })
    ret("PRG", "BKK", day(30), day(37), 800)
    run()
    const single = stored()[0]!
    expect(codes(single)).not.toContain("OPEN_JAW_MIXED_PROVIDER")
    expect(jawOf(single).friction).toBeLessThan(jawOf(row).friction)
  })

  it("applies friction as a penalty rather than as a component", () => {
    // A component can be outvoted by a large enough discount. "You land in a
    // different country" must not be votable away.
    leg("PRG", "BKK", day(30), 300)
    leg("BKK", "VIE", day(37), 260)
    ret("PRG", "BKK", day(30), day(37), 800)
    run()

    const breakdown = JSON.parse(stored()[0]!.score_breakdown)
    expect(breakdown.components.openJawFriction).toBeDefined()
    expect(breakdown.components.openJawFriction.points).toBeLessThan(0)
    expect(breakdown.components.openJawFriction.weight).toBe(0)
    // And the score is still explainable: every surviving component is named.
    expect(Object.keys(breakdown.effectiveWeights).length).toBeGreaterThan(3)
  })

  it("flags a suspicious leg even when the total looks ordinary", () => {
    // 9 USD to Bangkok is a bug, not a fare - but 9 + 260 is a plausible total,
    // so checking only the combined price would wave it through.
    leg("PRG", "BKK", day(30), 9)
    leg("BKK", "VIE", day(37), 260)
    ret("PRG", "BKK", day(30), day(37), 800)
    run()

    const row = stored()[0]!
    expect(row.sanity).toBe("SUSPICIOUS_DATA")
    expect(row.status).toBe("below-threshold")
    expect(String(row.sanity_detail)).toContain("leg")

    rebuildClusters(db, { minScore: 0 })
    const feed = buildFeed(db, { minScore: 0 })
    expect(feed.sections.openjaw.every(c => c.sanity === "ok")).toBe(true)
  })

  it("rejects the shapes that are not trips", () => {
    // §14 each of these has been a real bug in some itinerary builder.
    const anomalyConfig = loadAnomalyConfig(true)
    const base = {
      outbound: {
        origin: "PRG", destination: "BKK", departureDate: day(30), price: 300,
        currency: "USD", cabin: "economy", observedAt: at(-1), stops: 0, durationMinutes: 700,
      },
      inbound: {
        origin: "BKK", destination: "VIE", departureDate: day(37), price: 260,
        currency: "USD", cabin: "economy", observedAt: at(-1), stops: 0, durationMinutes: 700,
      },
      totalPrice: 560, tripLengthNights: 7, destinationGroup: "thailand",
      homeAirports: ["PRG", "VIE"], suspiciousLegs: [] as string[],
    }
    expect(checkOpenJawSanity(base, anomalyConfig).verdict).toBe("ok")

    const bad = (over: any) => checkOpenJawSanity({ ...base, ...over }, anomalyConfig)

    // The return departs before the outbound.
    expect(bad({
      inbound: { ...base.inbound, departureDate: day(20) }, tripLengthNights: -10,
    }).verdict).toBe("SUSPICIOUS_DATA")
    // Two prices in two currencies, added together.
    expect(bad({ inbound: { ...base.inbound, currency: "EUR" } }).detail).toContain("conversion")
    // Two outbound legs dressed up as a trip.
    expect(bad({ inbound: { ...base.inbound, origin: "PRG", destination: "BKK" } }).verdict)
      .toBe("SUSPICIOUS_DATA")
    // A return that does not land anywhere I live.
    expect(bad({ inbound: { ...base.inbound, destination: "FRA" } }).detail).toContain("home airport")
    // Cabins that do not match.
    expect(bad({ inbound: { ...base.inbound, cabin: "business" } }).detail).toContain("cabin")
    // A trip length nobody takes.
    expect(bad({ tripLengthNights: 400 }).verdict).toBe("SUSPICIOUS_DATA")
    // Two fares observed months apart are not two fares you can buy today.
    expect(bad({ outbound: { ...base.outbound, observedAt: at(-90) } }).detail)
      .toContain("days apart")
    // And a leg already judged unbelievable in its own right.
    expect(bad({ suspiciousLegs: ["outbound PRG-BKK: below the floor"] }).verdict)
      .toBe("SUSPICIOUS_DATA")
  })

  it("never files an open jaw into the same family as an ordinary round trip", () => {
    // §11 they are different products at the same price on the same day, and a
    // feed that merges them tells the reader the wrong thing about both.
    leg("PRG", "BKK", day(30), 300)
    leg("BKK", "VIE", day(37), 260)
    for (let i = 0; i < 8; i++) {
      ret("PRG", "BKK", day(30 + i), day(37 + i), 560, { fetchedAt: at(-30 + i) })
    }
    evaluateNewObservations({ db, quiet: true })
    run()
    rebuildClusters(db, { minScore: 0 })

    const mixed = db.prepare(`
      SELECT cluster_id, COUNT(DISTINCT is_open_jaw) kinds
      FROM deal_candidates WHERE cluster_id IS NOT NULL
      GROUP BY cluster_id HAVING kinds > 1
    `).all()
    expect(mixed).toHaveLength(0)

    const jaw = stored()[0]!
    const family = db.prepare(
      `SELECT is_open_jaw FROM deal_candidates WHERE cluster_id = ?`,
    ).all(jaw.cluster_id) as any[]
    expect(family.every(m => m.is_open_jaw === 1)).toBe(true)
  })

  it("serialises both legs all the way to the feed and the detail panel", () => {
    // §12/§13 the panel used to print the raw JSON, which is not a UI - it is
    // an admission that nothing rendered it.
    leg("PRG", "BKK", day(30), 300, { provider: "seller_a", airline: "Emirates" })
    leg("BKK", "VIE", day(37), 260, { provider: "seller_b", airline: "Qatar Airways" })
    ret("PRG", "BKK", day(30), day(37), 800)
    run()
    rebuildClusters(db, { minScore: 0 })

    const feed = buildFeed(db, { minScore: 0 })
    expect(feed.counts.openjaw).toBeGreaterThan(0)
    const card = feed.sections.openjaw[0]!
    expect(card.isOpenJaw).toBe(true)
    expect(card.openJaw).not.toBeNull()
    expect(card.openJaw!.outbound.origin).toBe("PRG")
    expect(card.openJaw!.outbound.provider).toBe("seller_a")
    expect(card.openJaw!.inbound.destination).toBe("VIE")
    expect(card.openJaw!.inbound.provider).toBe("seller_b")
    expect(card.openJaw!.comparator!.price).toBe(800)

    const detail = dealDetail(db, card.candidateId!)!
    expect(detail.candidate.isOpenJaw).toBe(true)
    expect(detail.warnings.some(w => w.includes("TWO one-way tickets"))).toBe(true)
  })

  it("collects the one-way legs it needs without doubling the search budget", () => {
    // §4/§5 the legs are deliberately collected, sparsely, out of the SAME
    // ceiling the rest of the run spends from.
    const j = job({ name: "oj-plan", destinationGroup: "thailand" })
    const legs = planOpenJawLegs(j, 0, config, NOW)
    const sampling = config.openJaw.sampling

    expect(legs.length).toBeGreaterThan(0)
    expect(legs.length).toBeLessThanOrEqual(sampling.maxLegSearchesPerRun)
    // One-ways only: a return fare cannot be half of an open jaw.
    expect(legs.every(t => t.returnDate === null)).toBe(true)
    // Only the priority airports of a configured group, only home origins.
    const allowed = new Set([...sampling.airports.thailand!, ...sampling.origins])
    expect(legs.every(t => allowed.has(t.route.origin) && allowed.has(t.route.destination))).toBe(true)
    // Outbound legs reuse the dates stage 1 already chose - no second grid.
    const sparse = new Set(sparseDates(j, 0, config, NOW))
    const outbound = legs.filter(t => sampling.origins.includes(t.route.origin))
    expect(outbound.length).toBeGreaterThan(0)
    expect(outbound.every(t => sparse.has(t.departureDate))).toBe(true)
    // Every outbound has a partner: half a couple is a wasted call.
    expect(legs.length - outbound.length).toBe(outbound.length)

    // Wildcards are deliberately excluded: an open jaw needs both legs AND a
    // comparable round trip, so collecting one-ways for ten unwatched
    // destinations would cost more than the sparse scan and find nothing.
    const wild = job({ name: "oj-wild", destinationGroup: "wildcard", cabins: ["economy"] })
    expect(planOpenJawLegs(wild, 0, config, NOW)).toHaveLength(0)

    // And the incremental cost is stated rather than buried in "free calls".
    const plan = planDiscoveryRun(j, 0, config, NOW)
    expect(plan.expected.openJawLegCalls).toBe(legs.length)
    expect(plan.openJawLegs).toHaveLength(legs.length)

    const projection = projectDiscoveryBudget(db, config, NOW)
    const row = projection.jobs.find(r => r.name === "oj-plan")!
    expect(row.openJawLegSearches).toBe(legs.length)
    expect(projection.totals.monthlyOpenJawLegCalls).toBeGreaterThan(0)
  })

  it("rotates through the couples so a week of runs covers them all", () => {
    const j = job({ name: "oj-rotate", destinationGroup: "thailand" })
    const first = planOpenJawLegs(j, 0, config, NOW).map(t => `${t.route.origin}-${t.route.destination}`)
    const later = planOpenJawLegs(j, 3, config, NOW).map(t => `${t.route.origin}-${t.route.destination}`)
    expect(first.join()).not.toBe(later.join())
  })

  it("records the legs it collected and the candidates they produced", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const j = job({
      name: "oj-run", destinationGroup: "thailand",
      budget: {
        maxFreeCallsPerRun: 40, maxAwardCallsPerRun: 0, maxMeteredCallsPerRun: 0,
        maxRuntimeMs: 60_000, maxDestinations: 1, datesPerRoute: 1,
      } as any,
    })

    const { result, runId } = await executeDiscoveryJob(j, {
      db, trigger: "manual", cashOnly: true, config,
    })

    expect(result.openJawLegSearches).toBeGreaterThan(0)
    expect(result.freeCalls).toBeLessThanOrEqual(40)
    expect(result.meteredCalls).toBe(0)

    // §20 the cost of open-jaw support is on the run row, in the same units as
    // every other cost class. A capability whose price is not recorded cannot
    // be judged worth keeping.
    const row = db.prepare(`SELECT * FROM discovery_runs WHERE id = ?`).get(runId) as any
    expect(row.open_jaw_leg_searches).toBe(result.openJawLegSearches)
    expect(row.open_jaw_candidates).toBe(result.openJawCandidates)

    // And the legs really were one-ways, recorded with their own provenance.
    const oneWays = db.prepare(`
      SELECT COUNT(*) c FROM flight_prices WHERE search_request_id IN (
        SELECT id FROM search_requests WHERE discovery_method = 'OPEN_JAW' AND discovery_run_id = ?
      )
    `).get(runId) as any
    expect(oneWays.c).toBeGreaterThan(0)
    const requests = db.prepare(`
      SELECT COUNT(*) c FROM search_requests
      WHERE discovery_method = 'OPEN_JAW' AND return_date IS NOT NULL
    `).get() as any
    expect(requests.c).toBe(0)
  })

  it("says an open jaw is worse rather than claiming it saves a negative amount", () => {
    // The first live run produced OPEN_JAW_SAVES_-259, which is not a sentence.
    // A negative saving is a different fact and gets its own name - which also
    // keeps OPEN_JAW_SAVES_X meaning exactly one thing wherever it appears.
    leg("PRG", "BKK", day(30), 472)
    leg("BKK", "VIE", day(37), 396)
    ret("PRG", "BKK", day(30), day(37), 609)
    run()

    const row = stored()[0]!
    const jaw = jawOf(row)
    expect(jaw.saving).toBeLessThan(0)
    expect(codes(row)).toContain("OPEN_JAW_WORSE_THAN_ROUND_TRIP")
    expect(codes(row).some((c: string) => c.startsWith("OPEN_JAW_SAVES_"))).toBe(false)
    expect(row.status).toBe("below-threshold")

    // §19 and it is still SHOWN, with the arithmetic. "Nothing found" cannot
    // distinguish "no legs" from "the sums came out against it".
    rebuildClusters(db, { minScore: 0 })
    const feed = buildFeed(db, { minScore: 0 })
    expect(feed.counts.openjaw).toBeGreaterThan(0)
  })

  it("does not let a busy feed truncate the open-jaw section out of existence", () => {
    // Sections are filtered views of the top-N families by score, so a small
    // section can be emptied by the truncation rather than by being empty -
    // "no open jaws" would then mean "none made the cut", which is a different
    // and much less useful statement.
    leg("PRG", "BKK", day(30), 472)
    leg("BKK", "VIE", day(37), 396)
    ret("PRG", "BKK", day(30), day(37), 609)
    // Higher-scoring families than the open jaw, more of them than the pool.
    for (let i = 0; i < 12; i++) {
      ret("VIE", "HKT", day(40 + i * 5), day(47 + i * 5), 300 + i, { fetchedAt: at(-40 + i) })
    }
    evaluateNewObservations({ db, quiet: true })
    run()
    rebuildClusters(db, { minScore: 0 })

    const pool = buildFeed(db, { minScore: 0, poolLimit: 2 })
    expect(pool.counts.openjaw).toBeGreaterThan(0)
    // The open jaw is genuinely outside the truncated pool - it is in the feed
    // because it was fetched for its own section, not by luck of the ranking.
    const topTwo = listClusters(db, { minScore: 0, limit: 2 })
    expect(topTwo.some(c => c.isOpenJaw)).toBe(false)
  })

  it("does not mistake a leg the open-jaw stage paid for FOR an open jaw", () => {
    // `discovered_by` records WHICH METHOD SPENT THE CALL. The open-jaw stage
    // spends its calls on ordinary one-way legs, and labelling them OPEN_JAW is
    // how §20 answers "was collecting them worth it". A single one-way fare is
    // still not an open jaw - and on the first live run the legs outnumbered
    // and outscored the real pairs, filling the fetch and emptying the section
    // that exists to show them.
    for (let i = 0; i < 8; i++) {
      // One search request per fetch, exactly as a real run produces them.
      // Sharing one across all eight would make them siblings, and siblings are
      // excluded from each other's baselines by design.
      const requestId = recordSearchRequest(db, {
        origin: "HKT", destination: "PRG", departureDate: day(37),
        returnDate: null, cabin: "economy", adults: 1, currency: "USD",
      }, "discovery", { discoveryMethod: "OPEN_JAW", discoveryRunId: null, discoveryStage: 1 })
      recordPriceObservations(db, [makeFlight({
        origin: "HKT", destination: "PRG", cabin: "economy", returnDate: null,
        departureDate: day(37), price: { amount: 900 - i * 40, currency: "USD" },
        fetchedAt: at(-20 + i),
      })], { adults: 1, searchRequestId: requestId })
    }
    evaluateNewObservations({ db, quiet: true })
    rebuildClusters(db, { minScore: 0 })

    const legCandidate = db.prepare(
      `SELECT discovered_by, is_open_jaw FROM deal_candidates WHERE route = 'HKT-PRG' LIMIT 1`,
    ).get() as any
    expect(legCandidate.discovered_by).toBe("OPEN_JAW")   // correct: it paid for it
    expect(legCandidate.is_open_jaw).toBe(0)              // and it is still one fare

    // The cluster carries the same distinction, so the section can filter on it.
    const byLabel = listClusters(db, { minScore: 0, limit: 50, discoveredBy: "OPEN_JAW" })
    const byNature = listClusters(db, { minScore: 0, limit: 50, isOpenJaw: true })
    expect(byLabel.length).toBeGreaterThan(byNature.length)
    expect(byNature.every(c => c.isOpenJaw)).toBe(true)
    expect(buildFeed(db, { minScore: 0 }).sections.openjaw.every(c => c.isOpenJaw)).toBe(true)
  })

  it("never spends a metered call re-searching an open jaw as a round trip", () => {
    // The metered confirmation re-searches (origin, destination, departure,
    // return) as ONE round trip. For an open jaw those four fields describe a
    // trip that does not exist, so the call would confirm the wrong fare and
    // then stamp `verified` on the candidate on the strength of it. Open jaws
    // score far below the gate today, which is luck rather than a guard.
    const j = job({ name: "oj-verify" })
    const runId = startDiscoveryRun(db, j.id, "manual")

    db.prepare(`
      INSERT INTO deal_candidates (
        source_table, source_id, observed_at, as_of, evaluated_at, type,
        origin, destination, route, departure_date, return_date, trip_type, cabin,
        price_amount, price_currency, baseline_key, baseline_scope,
        observed_median, observed_minimum, observed_maximum, percent_below_median,
        percentile, sample_size, baseline_confidence, baseline_first_at,
        baseline_last_at, baseline_age_days, provider, provider_confidence,
        verification_level, score, score_breakdown, weights_version, engine_version,
        reasons, features, presets_matched, threshold, mode, status, notified,
        created_at, discovered_by, discovery_run_id, sanity, verification_status,
        is_open_jaw
      ) VALUES (
        'open_jaw', 9001, ?, ?, ?, 'cash',
        'PRG', 'BKK', 'PRG-BKK/HKT-VIE', ?, ?, 'return', 'economy',
        400, 'USD', 'k', 'strict',
        900, 800, 1000, 55,
        2, 40, 'HIGHER', ?, ?, 1, 'a + b', 'medium',
        'discovered', 95, '{}', 'shadow-2', 'shadow-2',
        '[]', '{}', '[]', 70, 'shadow', 'candidate', 0,
        ?, 'OPEN_JAW', ?, 'ok', 'unverified', 1
      )
    `).run(at(0), at(0), at(0), day(30), day(37), at(-30), at(-1), at(0), runId)

    // Same row shape, ordinary round trip: the gate is genuinely open.
    db.prepare(`
      UPDATE deal_candidates SET is_open_jaw = 0, route = 'PRG-BKK', source_id = 9002
      WHERE source_id = 9001
    `).run()
    expect(selectForVerification(db, runId, config).length).toBe(1)

    db.prepare(`
      UPDATE deal_candidates SET is_open_jaw = 1, route = 'PRG-BKK/HKT-VIE'
      WHERE source_id = 9002
    `).run()
    expect(selectForVerification(db, runId, config)).toHaveLength(0)
  })

  it("knows which arrivals it is configured to assemble", () => {
    const arrivals = openJawArrivals(config)
    expect(arrivals.map(a => a.arrive)).toContain("BKK")
    expect(arrivals.map(a => a.arrive)).toContain("CUN")
    // Not a wildcard destination: nothing collects its legs, so scanning it
    // every cycle would be work that cannot produce an answer.
    expect(arrivals.map(a => a.arrive)).not.toContain("MLE")
  })

  it("looks up a comparable round trip by row, never by aggregate", () => {
    ret("PRG", "BKK", day(30), day(37), 800, { provider: "expensive_seller", fetchedAt: at(-2) })
    ret("PRG", "BKK", day(30), day(37), 620, { provider: "cheap_seller", fetchedAt: at(-8) })

    const found = bestComparableRoundTrip(
      db, "PRG", ["BKK"], "economy", "USD", at(0),
      { from: day(0), to: day(90) }, 45, 7, 2,
    )!
    expect(found.price).toBe(620)
    // The cheapest PRICE and the newest TIMESTAMP describe different rows here,
    // which is exactly the shape that used to attribute one row's fare to
    // another row's seller.
    expect(found.provider).toBe("cheap_seller")
    expect(found.observedAt).toBe(at(-8))
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
