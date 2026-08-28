import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { readState, writeState } from "../anomaly/store.js"
import { setStayProviders } from "../providers/stays/index.js"
import { XOTELO_PROVIDER } from "../providers/stays/xotelo.js"
import { AGODA_PROVIDER } from "../providers/stays/agoda.js"
import {
  breakerState,
  confirmationsUsedToday,
  newStayRunBudget,
  reserveConfirmationCall,
  reserveObservationCall,
  TransportFailureCounter,
  tripBreaker,
} from "../stays/budget.js"
import type { StaysConfig } from "../stays/config.js"
import {
  acquireStayLease,
  heartbeatStayLease,
  newStayHolderId,
  releaseStayLease,
  reapStaleStayRuns,
  requestStayStop,
  tryStartStayRun,
} from "../stays/lease.js"
import { currentRunIndex, dryRunStayObservation, runStayObservation } from "../stays/observer.js"
import { checkInGrid, planStayRun } from "../stays/sampling.js"
import { seedStayProperties, type StayUniverseConfig } from "../stays/registry.js"
import { listConfirmationTriggers, rateHistory, recordCalendarObservations, recordRateObservations, recordStaySearchRequest, stayObservationCounts } from "../stays/store.js"
import { evaluateConfirmationTrigger } from "../stays/trigger.js"
import { getStayProperty } from "../stays/registry.js"
import { MockStayProvider, makeStayRate } from "./stay-mocks.js"

function testConfig(overrides: Partial<StaysConfig["observation"]> = {}): StaysConfig {
  return {
    observation: {
      currency: "USD", adults: 2, children: 0,
      defaultCheckInOffsetDays: 45, defaultNights: 5,
      calendarHorizonDays: 90, politeDelayMs: 0, maxRequestsPerRun: 12,
      ...overrides,
    },
    sanity: { nightly: { USD: { min: 10, max: 50000 }, default: { min: 10, max: 50000 } }, maxNights: 30 },
    sampling: {
      firstCheckInOffsetDays: 21, stepDays: 14, horizonDays: 180,
      datesPerPropertyPerRun: 2, calendarEveryNRuns: 2,
      targeted: {
        cheapWindowSamplesPerRun: 3, minCheapRunNights: 3,
        neighborSamplesPerRun: 3, neighborTriggerPercentBelow: 15,
        neighborOffsetsDays: [-2, 2, 4], recentSampleCooldownDays: 3,
      },
    },
    scheduler: { frequencyHours: 24, tickSeconds: 1, leaseTtlSeconds: 90, staleRunMinutes: 60 },
    budgets: {
      maxConfirmationsPerRun: 2, maxConfirmationsPerDay: 5, confirmationDelayMs: 0,
      breakerThreshold: 3, breakerCooldownMinutes: 60,
      emptyStreakSuspect: 3, calendarUnsupportedAfter: 2, rawRetention: 50,
    },
    trigger: {
      calendarTrigger: true, calendarCheapFraction: 0.5,
      minSamplesForMedian: 5, percentBelowMedian: 20, lookbackDays: 120, maxTriggersPerRun: 4,
    },
    // The scheduler's post-run evaluate/verify pass uses this too, so the
    // block must be complete and internally consistent.
    anomaly: {
      engineVersion: "test", weightsVersion: "test", candidateThreshold: 70,
      storeBelowThreshold: true, noHistoryScoreCap: 80,
      baseline: {
        lookbackDays: 365, minSamplesToEmit: 5, maxBaselineAgeDays: 120, staleBaselineDays: 45,
        relaxationOrder: ["nightsBucket"],
        nightsBuckets: [{ label: "short", maxNights: 4 }, { label: "medium", maxNights: 9 }, { label: "long", maxNights: 16 }],
      },
      confidenceTiers: [{ minSamples: 5, label: "VERY_LOW", value: 0.3 }],
      weights: { relative: 0.4, absoluteValue: 0.25, evidence: 0.2, actionability: 0.15 },
      relativeComposition: { percentBelowMedian: 0.7, percentile: 0.3 },
      fullCreditPercentBelowMedian: 35, lowPercentileFullCreditAt: 25,
      actionability: {
        neighborWindowDays: 5, priceTolerancePercent: 8, sustainedSpanDays: 5,
        values: { isolated: 0.2, short: 0.6, sustained: 1.0 },
        calendarSustainedValue: 0.6, requiresNotablePrice: true, minNotableRelative: 0.3,
      },
      evidenceValues: { discovered: 0.35, confirmed: 0.9, verified: 1, metaWithRetailConfirmation: 0.7, metaWithVerified: 0.85 },
      crossSource: { retailSpreadHighPercent: 30, verifiedSpreadHighPercent: 25 },
      category: { minSamples: 20, minProperties: 2, lookbackDays: 365, lowPercentileFullCreditAt: 15 },
      verification: {
        nearMissBand: 20, minRelativeForGate: 0.5, minAbsoluteForGate: 0.3,
        maxPerRun: 2, maxPerDay: 3, monthlyBudget: 15, opportunityCooldownDays: 7,
      },
      calendarSignal: { flipLookbackDays: 45 },
      absolute: { currency: "USD", tierScale: { ultra: 1.4, luxury: 1, upper: 0.75 }, roomScale: { villa: 1.25, suite: 1.1 }, rules: {} },
    },
  }
}

function universe(count: number, active = count): StayUniverseConfig {
  const properties = Array.from({ length: count }, (_, i) => ({
    id: `prop-${String(i).padStart(2, "0")}`,
    name: `Property ${i}`,
    destinationGroup: "maldives",
    country: "Maldives",
    nearestAirports: ["MLE"],
    luxuryTier: "luxury" as const,
    allInclusive: (i % 2 === 0 ? "only" : "none") as "only" | "none",
    defaultBoard: (i % 2 === 0 ? "all_inclusive" : "unknown") as "all_inclusive" | "unknown",
    typicalStayNights: [5, 7],
    priority: (i % 3) + 1,
    active: i < active,
    refs: { xotelo: `g100-d${1000 + i}`, agoda: `${41000 + i}:17759:34` },
  }))
  return { destinationGroups: { maldives: { label: "Maldives", airports: ["MLE"] } }, properties }
}

const NOW = new Date("2026-08-28T12:00:00Z")

describe("stay lease", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  it("grants one holder, refuses a second, allows stale takeover", () => {
    const a = newStayHolderId(); const b = newStayHolderId()
    expect(acquireStayLease(db, a, 90, NOW)).toBe(true)
    expect(acquireStayLease(db, b, 90, NOW)).toBe(false)
    // 91 seconds of silence — holder a is presumed dead.
    const later = new Date(NOW.getTime() + 91_000)
    expect(acquireStayLease(db, b, 90, later)).toBe(true)
    // The evicted holder's heartbeat now fails instead of resurrecting it.
    expect(heartbeatStayLease(db, a, later).ok).toBe(false)
  })

  it("heartbeat reports a stop request without killing the lease", () => {
    const holder = newStayHolderId()
    acquireStayLease(db, holder, 90, NOW)
    expect(requestStayStop(db)).toBe(true)
    const beat = heartbeatStayLease(db, holder, NOW)
    expect(beat).toEqual({ ok: true, stopRequested: true })
    releaseStayLease(db, holder)
    expect(requestStayStop(db)).toBe(false)      // nothing left to stop
  })

  it("prevents duplicate runs and reaps stale ones", () => {
    const first = tryStartStayRun(db, 0, "cli")
    expect(first).not.toBeNull()
    expect(tryStartStayRun(db, 0, "cli")).toBeNull()        // duplicate refused
    // An hour later the crashed run is reaped and a new one may start.
    db.prepare("UPDATE stay_observation_runs SET started_at = ? WHERE id = ?")
      .run(new Date(NOW.getTime() - 61 * 60_000).toISOString(), first)
    expect(reapStaleStayRuns(db, 60, NOW)).toBe(1)
    expect(tryStartStayRun(db, 1, "cli")).not.toBeNull()
  })
})

describe("stay budgets and breaker", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  it("reserve-before-await: concurrent reservations cannot overshoot the ceiling", async () => {
    const budget = newStayRunBudget(5, 2)
    // Simulate 10 concurrent workers all reserving BEFORE their awaits.
    const results = await Promise.all(Array.from({ length: 10 }, async () => {
      const ok = reserveObservationCall(budget)
      await new Promise(r => setTimeout(r, 5))    // the await happens after
      return ok
    }))
    expect(results.filter(Boolean)).toHaveLength(5)
    expect(budget.observationCalls).toBe(5)
  })

  it("confirmation reservations respect run AND daily ceilings, counted before the await", () => {
    const config = testConfig().budgets
    const budget = newStayRunBudget(10, 2)
    expect(reserveConfirmationCall(db, budget, config, NOW).ok).toBe(true)
    expect(reserveConfirmationCall(db, budget, config, NOW).ok).toBe(true)
    const third = reserveConfirmationCall(db, budget, config, NOW)
    expect(third.ok).toBe(false)
    expect(third.reason).toContain("ceiling")
    expect(confirmationsUsedToday(db, NOW)).toBe(2)

    // A fresh run same day: daily ceiling (5) still applies across runs.
    const nextRun = newStayRunBudget(10, 10)
    for (let i = 0; i < 3; i++) expect(reserveConfirmationCall(db, nextRun, config, NOW).ok).toBe(true)
    expect(reserveConfirmationCall(db, nextRun, config, NOW).ok).toBe(false)
    expect(confirmationsUsedToday(db, NOW)).toBe(5)
  })

  it("trips the breaker only on consecutive TRANSPORT failures, and it cools down", () => {
    const config = testConfig().budgets
    const counter = new TransportFailureCounter()
    expect(counter.recordFailure(db, XOTELO_PROVIDER, config, "ECONNRESET")).toBeNull()
    counter.recordSuccess(XOTELO_PROVIDER)        // a success resets the streak
    expect(counter.recordFailure(db, XOTELO_PROVIDER, config, "ECONNRESET")).toBeNull()
    expect(counter.recordFailure(db, XOTELO_PROVIDER, config, "ECONNRESET")).toBeNull()
    const tripped = counter.recordFailure(db, XOTELO_PROVIDER, config, "ECONNRESET")
    expect(tripped).not.toBeNull()
    // tripBreaker stamps from the real clock — read it with the real clock too.
    expect(breakerState(db, XOTELO_PROVIDER).open).toBe(true)
    // After the cooldown the breaker is closed again.
    const later = new Date(Date.now() + 61 * 60_000)
    expect(breakerState(db, XOTELO_PROVIDER, later).open).toBe(false)
  })
})

describe("stay sampling", () => {
  const config = testConfig()

  it("is deterministic and rotates dates between runs", () => {
    const grid0 = checkInGrid(config.sampling, 0, NOW)
    const grid0again = checkInGrid(config.sampling, 0, NOW)
    const grid1 = checkInGrid(config.sampling, 1, NOW)
    expect(grid0).toEqual(grid0again)
    expect(grid1).not.toEqual(grid0)              // phase-shifted, interleaving
    // Every date stays inside the horizon window.
    for (const d of [...grid0, ...grid1]) {
      // isoDay truncates to midnight UTC, so offsets can read up to a day short.
      const offset = (Date.parse(d) - NOW.getTime()) / 86_400_000
      expect(offset).toBeGreaterThanOrEqual(config.sampling.firstCheckInOffsetDays - 1)
      expect(offset).toBeLessThanOrEqual(config.sampling.horizonDays + 1)
    }
  })

  it("plans dates per property from its own typical stay lengths — no brute force", () => {
    const db = createMemoryDb()
    seedStayProperties(db, universe(3))
    const props = [getStayProperty(db, "prop-00")!, getStayProperty(db, "prop-01")!, getStayProperty(db, "prop-02")!]
    const plan = planStayRun(props, config, 0, NOW)
    // 3 properties × 2 dates = 6 rate requests, plus a bounded calendar count.
    expect(plan.items).toHaveLength(6)
    expect(plan.plannedRequests).toBeLessThanOrEqual(config.observation.maxRequestsPerRun)
    for (const item of plan.items) {
      expect([5, 7]).toContain(item.nights)
      expect(Date.parse(item.checkOut) - Date.parse(item.checkIn)).toBe(item.nights * 86_400_000)
    }
    // Different runs sample different check-ins for the same property.
    const plan1 = planStayRun(props, config, 1, NOW)
    const datesRun0 = plan.items.filter(i => i.property.id === "prop-00").map(i => i.checkIn)
    const datesRun1 = plan1.items.filter(i => i.property.id === "prop-00").map(i => i.checkIn)
    expect(datesRun1).not.toEqual(datesRun0)
  })

  it("trims to the request budget, drops calendars before rates, and SAYS SO", () => {
    const db = createMemoryDb()
    seedStayProperties(db, universe(10))
    const props = Array.from({ length: 10 }, (_, i) => getStayProperty(db, `prop-${String(i).padStart(2, "0")}`)!)
    const tight = testConfig({ maxRequestsPerRun: 7 })
    const plan = planStayRun(props, tight, 0, NOW)
    expect(plan.plannedRequests).toBeLessThanOrEqual(7)
    expect(plan.scopeReduced.some(s => s.includes("trimmed to budget"))).toBe(true)
    // What survives the trim is rates work — calendars go first.
    expect(plan.items.filter(i => i.wantCalendar).length).toBe(0)
  })
})

describe("confirmation trigger", () => {
  let db: DB
  const config = testConfig()
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe(1))
  })

  const property = () => getStayProperty(db, "prop-00")!
  const stay = { checkIn: "2026-11-10", checkOut: "2026-11-15", nights: 5 }

  function seedHistory(nightlyPrices: number[]): void {
    const p = property()
    for (const amount of nightlyPrices) {
      const requestId = recordStaySearchRequest(db, {
        propertyId: p.id, kind: "rates", checkIn: stay.checkIn, checkOut: stay.checkOut,
        currency: "USD", source: "test",
      })
      recordRateObservations(db, p, requestId, [makeStayRate({
        propertyId: p.id, price: { amount, currency: "USD" },
        fetchedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      })], config.sanity)
    }
  }

  it("fires PRICE_BELOW_MEDIAN only with enough history and a material discount", () => {
    seedHistory([2000, 2100, 2200, 2300, 2400])   // median 2200
    const cheap = [makeStayRate({ propertyId: "prop-00", price: { amount: 1500, currency: "USD" } })]
    const verdict = evaluateConfirmationTrigger(db, property(), stay, cheap, null, config.trigger)
    expect(verdict.triggered).toBe(true)
    expect(verdict.evidence!.reason).toBe("PRICE_BELOW_MEDIAN")
    expect(verdict.evidence!.numbers.percentBelow).toBeGreaterThanOrEqual(30)

    const ordinary = [makeStayRate({ propertyId: "prop-00", price: { amount: 2100, currency: "USD" } })]
    expect(evaluateConfirmationTrigger(db, property(), stay, ordinary, null, config.trigger).triggered).toBe(false)
  })

  it("stays silent below the minimum sample count — no evidence, no spend", () => {
    seedHistory([2000, 2100, 2200, 2300])         // only 4 priors
    const cheap = [makeStayRate({ propertyId: "prop-00", price: { amount: 900, currency: "USD" } })]
    const noCalendar = { ...config.trigger, calendarTrigger: false }
    expect(evaluateConfirmationTrigger(db, property(), stay, cheap, null, noCalendar).triggered).toBe(false)
  })

  it("excludes same-search siblings from the median (no self-comparison)", () => {
    seedHistory([2000, 2100, 2200, 2300])
    const requestId = recordStaySearchRequest(db, {
      propertyId: "prop-00", kind: "rates", checkIn: stay.checkIn, checkOut: stay.checkOut,
      currency: "USD", source: "test",
    })
    // A fifth sample arrives in the SAME search as the cheap rate: with the
    // sibling excluded there are only 4 priors, so the gate stays silent.
    recordRateObservations(db, property(), requestId, [makeStayRate({ propertyId: "prop-00", price: { amount: 5000, currency: "USD" } })], config.sanity)
    const cheap = [makeStayRate({ propertyId: "prop-00", price: { amount: 900, currency: "USD" } })]
    const noCalendar = { ...config.trigger, calendarTrigger: false }
    expect(evaluateConfirmationTrigger(db, property(), stay, cheap, requestId, noCalendar).triggered).toBe(false)
  })

  it("never counts a lead-in teaser as trigger evidence", () => {
    seedHistory([2000, 2100, 2200, 2300, 2400])
    const teaser = [makeStayRate({ propertyId: "prop-00", priceBasis: "lead_in", price: { amount: 500, currency: "USD" } })]
    const noCalendar = { ...config.trigger, calendarTrigger: false }
    expect(evaluateConfirmationTrigger(db, property(), stay, teaser, null, noCalendar).triggered).toBe(false)
  })

  it("fires CALENDAR_CHEAP from the latest calendar snapshot only", () => {
    const p = property()
    const days = ["2026-11-10", "2026-11-11", "2026-11-12"].map(date => ({ date, dayClass: "cheap" as const }))
    recordCalendarObservations(db, p, "xotelo", p.refs.xotelo, null, days)
    const fresh = [makeStayRate({ propertyId: "prop-00" })]
    const verdict = evaluateConfirmationTrigger(db, p, stay, fresh, null, config.trigger)
    expect(verdict.triggered).toBe(true)
    expect(verdict.evidence!.reason).toBe("CALENDAR_CHEAP")

    // A NEWER snapshot reclassifying the dates as high must silence the gate.
    const laterDays = ["2026-11-10", "2026-11-11", "2026-11-12"].map(date => ({ date, dayClass: "high" as const }))
    recordCalendarObservations(db, p, "xotelo", p.refs.xotelo, null, laterDays)
    expect(evaluateConfirmationTrigger(db, p, stay, fresh, null, config.trigger).triggered).toBe(false)
  })
})

describe("the observation run end to end (mock providers)", () => {
  let db: DB
  const config = testConfig()

  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe(2))
    setStayProviders(null)
  })

  function mockProviders(opts: {
    xotelo?: MockStayProvider
    agoda?: MockStayProvider | null
  } = {}): { xotelo: MockStayProvider; agoda: MockStayProvider | null } {
    const xotelo = opts.xotelo ?? new MockStayProvider({ name: XOTELO_PROVIDER })
    const agoda = opts.agoda === null ? null : (opts.agoda ?? new MockStayProvider({ name: AGODA_PROVIDER }))
    setStayProviders(agoda ? [xotelo, agoda] : [xotelo])
    return { xotelo, agoda }
  }

  it("runs a bounded cycle, records observations, advances the run index", async () => {
    mockProviders()
    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(result.status).toBe("success")
    expect(result.counters.ratesCalls).toBeGreaterThan(0)
    expect(result.counters.observationsAdded).toBeGreaterThan(0)
    expect(currentRunIndex(db)).toBe(1)
    const run = db.prepare("SELECT * FROM stay_observation_runs WHERE id = ?").get(result.runId) as Record<string, unknown>
    expect(run.status).toBe("success")
    expect(run.completed_at).not.toBeNull()
  })

  it("dry-run plans the same work with zero provider contact", () => {
    const { xotelo } = mockProviders()
    const { plan } = dryRunStayObservation(db, config)
    expect(plan.items.length).toBeGreaterThan(0)
    expect(xotelo.searches).toHaveLength(0)
    expect(stayObservationCounts(db).searchRequests).toBe(0)
  })

  it("a provider that THROWS degrades the run to partial — never a crash", async () => {
    mockProviders({ xotelo: new MockStayProvider({ name: XOTELO_PROVIDER, throws: true }) })
    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(["partial", "failed"]).toContain(result.status)
    const run = db.prepare("SELECT status FROM stay_observation_runs WHERE id = ?").get(result.runId) as { status: string }
    expect(run.status).not.toBe("running")        // the run row always closes
  })

  it("cold-cache empties are retry-later: streak counted, property NOT deactivated", async () => {
    mockProviders({ xotelo: new MockStayProvider({ name: XOTELO_PROVIDER, fail: "no-results" }) })
    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(result.counters.semanticErrors).toBeGreaterThan(0)
    expect(result.counters.transportFailures).toBe(0)       // semantic ≠ transport
    expect(breakerState(db, XOTELO_PROVIDER).open).toBe(false)   // never trips the breaker
    expect(getStayProperty(db, "prop-00")!.active).toBe(true)
  })

  it("consecutive transport failures trip the breaker and end the run early", async () => {
    mockProviders({ xotelo: new MockStayProvider({ name: XOTELO_PROVIDER, fail: "provider-error" }) })
    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(result.counters.transportFailures).toBeGreaterThanOrEqual(config.budgets.breakerThreshold)
    expect(result.counters.scopeReduced.some(s => s.includes("breaker"))).toBe(true)
    expect(breakerState(db, XOTELO_PROVIDER).open).toBe(true)
  })

  it("scope reduction is recorded when the budget is smaller than the plan", async () => {
    mockProviders()
    const result = await runStayObservation({ db, config, trigger: "cli", limit: 2, sleep: async () => {} })
    expect(result.counters.ratesCalls + result.counters.calendarCalls).toBeLessThanOrEqual(2)
    expect(result.counters.scopeReduced.length).toBeGreaterThan(0)
  })

  it("a trigger confirms through Agoda and records room-level observations", async () => {
    // Calendar snapshot makes every stay trigger CALENDAR_CHEAP.
    const p = getStayProperty(db, "prop-00")!
    const grid = checkInGrid(config.sampling, 0, new Date())
    const cheapDays = grid.flatMap(d => Array.from({ length: 8 }, (_, i) =>
      ({ date: new Date(Date.parse(d) + i * 86_400_000).toISOString().slice(0, 10), dayClass: "cheap" as const })))
    recordCalendarObservations(db, p, XOTELO_PROVIDER, p.refs.xotelo, null, cheapDays)

    const agoda = new MockStayProvider({
      name: AGODA_PROVIDER,
      rates: [makeStayRate({
        propertyId: "prop-00", roomName: "Lagoon Villa", roomClass: "villa",
        board: "all_inclusive", boardSource: "structured",
        refundable: true, cancellationDeadline: "2026-10-27",
        taxesFees: "included", price: { amount: 937, currency: "USD" },
        verificationLevel: "confirmed", rateSource: "Agoda", sourceClass: "retail",
      })],
    })
    mockProviders({ agoda })

    const result = await runStayObservation({
      db, config, trigger: "cli", propertyIds: ["prop-00"], sleep: async () => {},
    })
    expect(result.counters.triggersFired).toBeGreaterThan(0)
    expect(result.counters.confirmationsRecorded).toBeGreaterThan(0)
    const triggers = listConfirmationTriggers(db)
    expect(triggers.some(t => t.status === "confirmed")).toBe(true)
    const confirmed = rateHistory(db, { propertyId: "prop-00" })
      .filter(r => r.provider === AGODA_PROVIDER)
    expect(confirmed.length).toBeGreaterThan(0)
    expect(confirmed[0].board).toBe("all_inclusive")
    expect(confirmed[0].taxesFees).toBe("included")
  })

  it("degrades gracefully when the confirmation provider disappears entirely", async () => {
    const p = getStayProperty(db, "prop-00")!
    const grid = checkInGrid(config.sampling, 0, new Date())
    const cheapDays = grid.flatMap(d => Array.from({ length: 8 }, (_, i) =>
      ({ date: new Date(Date.parse(d) + i * 86_400_000).toISOString().slice(0, 10), dayClass: "cheap" as const })))
    recordCalendarObservations(db, p, XOTELO_PROVIDER, p.refs.xotelo, null, cheapDays)

    mockProviders({ agoda: null })                 // Agoda is gone
    const result = await runStayObservation({
      db, config, trigger: "cli", propertyIds: ["prop-00"], sleep: async () => {},
    })
    expect(result.status).toBe("success")          // Xotelo-only still works
    expect(result.counters.triggersFired).toBeGreaterThan(0)
    expect(result.counters.confirmationCalls).toBe(0)
    expect(listConfirmationTriggers(db).every(t => t.status === "skipped_unconfigured")).toBe(true)
  })

  it("skips confirmations when the Agoda breaker is open, and says why", async () => {
    const p = getStayProperty(db, "prop-00")!
    const grid = checkInGrid(config.sampling, 0, new Date())
    const cheapDays = grid.flatMap(d => Array.from({ length: 8 }, (_, i) =>
      ({ date: new Date(Date.parse(d) + i * 86_400_000).toISOString().slice(0, 10), dayClass: "cheap" as const })))
    recordCalendarObservations(db, p, XOTELO_PROVIDER, p.refs.xotelo, null, cheapDays)
    tripBreaker(db, AGODA_PROVIDER, "test", 60)

    mockProviders()
    const result = await runStayObservation({
      db, config, trigger: "cli", propertyIds: ["prop-00"], sleep: async () => {},
    })
    expect(result.counters.confirmationCalls).toBe(0)
    expect(listConfirmationTriggers(db).some(t => t.status === "skipped_breaker")).toBe(true)
  })

  it("the daily confirmation ceiling holds across runs", async () => {
    const p0 = getStayProperty(db, "prop-00")!
    const p1 = getStayProperty(db, "prop-01")!
    const grid = checkInGrid(config.sampling, 0, new Date())
    for (const p of [p0, p1]) {
      const cheapDays = grid.flatMap(d => Array.from({ length: 8 }, (_, i) =>
        ({ date: new Date(Date.parse(d) + i * 86_400_000).toISOString().slice(0, 10), dayClass: "cheap" as const })))
      recordCalendarObservations(db, p, XOTELO_PROVIDER, p.refs.xotelo, null, cheapDays)
    }
    writeState(db, `stays.confirmations.${new Date().toISOString().slice(0, 10)}`, "5")  // day already spent
    mockProviders()
    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(result.counters.confirmationCalls).toBe(0)
    expect(listConfirmationTriggers(db).every(t => t.status === "skipped_budget")).toBe(true)
    expect(result.counters.scopeReduced.some(s => s.includes("daily confirmation ceiling"))).toBe(true)
  })

  it("refuses to double-run: a live lease blocks a second scheduler", async () => {
    mockProviders()
    const other = newStayHolderId()
    acquireStayLease(db, other, 90)
    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(result.status).toBe("not-started")
    expect(result.detail).toContain("lease")
    releaseStayLease(db, other)
  })

  it("restart safety: a crashed run's lease and run row do not wedge the next run", async () => {
    mockProviders()
    // Simulate a crash: stale lease + a run row stuck 'running' for an hour.
    const dead = newStayHolderId()
    acquireStayLease(db, dead, 90, new Date(Date.now() - 10 * 60_000))
    db.prepare(`
      INSERT INTO stay_observation_runs (run_index, started_at, status, trigger)
      VALUES (0, ?, 'running', 'cli')
    `).run(new Date(Date.now() - 90 * 60_000).toISOString())

    const result = await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    expect(result.status).toBe("success")          // stale lease taken over, stale run reaped
    const reaped = db.prepare("SELECT status FROM stay_observation_runs WHERE run_index = 0").get() as { status: string }
    expect(reaped.status).toBe("failed")
  })

  it("run index advances so consecutive runs rotate their sampling", async () => {
    const { xotelo } = mockProviders()
    await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    const firstDates = xotelo.searches.map(s => s.checkIn)
    xotelo.searches.length = 0
    await runStayObservation({ db, config, trigger: "cli", sleep: async () => {} })
    const secondDates = xotelo.searches.map(s => s.checkIn)
    expect(readState(db, "stays.observer.runIndex")).toBe("2")
    expect(secondDates).not.toEqual(firstDates)
  })
})
