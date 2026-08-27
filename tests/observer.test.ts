/**
 * Observer: jobs, sampling, lease locking, backoff, auth skips, budget
 * projection, dry-run and cache-aware execution. Entirely offline — every
 * provider is a mock and no external request is made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"
import Database from "better-sqlite3"
import os from "os"
import { createMemoryDb, migrate, type DB } from "../db/index.js"
import { setProviders } from "../providers/cash-flights/index.js"
import { setAwardProviders } from "../providers/award-flights/index.js"
import { readUsage } from "../db/repositories.js"
import {
  upsertJob, listJobs, dueJobs, getJobByName, setJobEnabled, completeJobRun,
  startRun, tryStartRun, finishRun, listRuns, hasRunningRun, reapStaleRuns,
  acquireLease, heartbeatLease, releaseLease, readLease, requestStop, newHolderId,
} from "../observer/store.js"
import { departureGrid, sampleDatePairs, planRun, cabinsToSearchClass, DEFAULT_DATE_STRATEGY } from "../observer/sampling.js"
import { projectMonthlyBudget } from "../observer/budget.js"
import { executeJob } from "../observer/engine.js"
import { runScheduler } from "../observer/scheduler.js"
import { seedJobsFromProfile } from "../observer/cli.js"
import { searchAwardFlights } from "../providers/award-flights/index.js"
import type { NewJob } from "../observer/store.js"
import { MockProvider, MockAwardProvider, makeFlight, makeAwardFlight, makeAwardQuery } from "./mocks.js"

let db: DB
const savedEnv = { ...process.env }

function testJob(over: Partial<NewJob> = {}): NewJob {
  return {
    name: "PRG-BKK",
    origin: "PRG",
    destination: "BKK",
    cabins: ["economy", "business"],
    cashProviders: ["fast_flights"],
    awardProviders: ["roame"],
    priority: 1,
    frequencyHours: 84,
    jitterMinutes: 0,
    dateStrategy: { ...DEFAULT_DATE_STRATEGY },
    ...over,
  }
}

beforeEach(() => {
  db = createMemoryDb()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  setProviders(null)
  setAwardProviders(null)
  db.close()
  process.env = { ...savedEnv }
  vi.restoreAllMocks()
})

// ─── Jobs ────────────────────────────────────────────────────────────────────

describe("observation jobs", () => {
  it("creates and reads a job round-trip", () => {
    const job = upsertJob(db, testJob())
    expect(job.name).toBe("PRG-BKK")
    expect(job.cabins).toEqual(["economy", "business"])
    expect(job.enabled).toBe(true)
    expect(job.runsCompleted).toBe(0)
  })

  it("upsert by name updates configuration without resetting run bookkeeping", () => {
    const job = upsertJob(db, testJob())
    completeJobRun(db, job.id, { failed: false, countsAsRun: true })
    const updated = upsertJob(db, testJob({ frequencyHours: 24 }))
    expect(updated.frequencyHours).toBe(24)
    expect(updated.runsCompleted).toBe(1)          // preserved
  })

  it("seeds the conservative starter set from the travel profile", () => {
    const jobs = seedJobsFromProfile(db)
    expect(jobs.map(j => j.name).sort()).toEqual(
      ["PRG-BKK", "PRG-CUN", "PRG-MEX", "VIE-BKK", "VIE-CUN", "VIE-MEX"])
    // ATF must NOT be in scheduled award providers (5 calls/search of 150/mo).
    for (const j of jobs) expect(j.awardProviders).not.toContain("atf")
    // Wildcards are configuration only — never seeded.
    expect(jobs.some(j => ["MLE", "DPS", "SIN"].includes(j.destination))).toBe(false)
  })

  it("disabled jobs are never due", () => {
    upsertJob(db, testJob())
    setJobEnabled(db, "PRG-BKK", false)
    expect(dueJobs(db)).toHaveLength(0)
    expect(listJobs(db)).toHaveLength(1)
  })
})

// ─── Date sampling ───────────────────────────────────────────────────────────

describe("date sampling", () => {
  const anchor = new Date("2026-08-27T12:00:00Z")

  it("builds the departure grid inside the horizon", () => {
    const grid = departureGrid(DEFAULT_DATE_STRATEGY, anchor)
    expect(grid[0]).toBe("2026-09-17")                     // +21 days
    expect(grid.length).toBe(12)                           // (180-21)/14 + 1
    expect(grid[grid.length - 1]! <= "2027-02-23").toBe(true)
  })

  it("is deterministic for the same anchor and run index", () => {
    expect(sampleDatePairs(DEFAULT_DATE_STRATEGY, 3, anchor))
      .toEqual(sampleDatePairs(DEFAULT_DATE_STRATEGY, 3, anchor))
  })

  it("samples datesPerRun pairs and rotates through the grid across runs", () => {
    const run0 = sampleDatePairs(DEFAULT_DATE_STRATEGY, 0, anchor)
    const run1 = sampleDatePairs(DEFAULT_DATE_STRATEGY, 1, anchor)
    expect(run0).toHaveLength(4)
    expect(run1).toHaveLength(4)
    const dep0 = new Set(run0.map(p => p.departureDate))
    expect(run1.every(p => !dep0.has(p.departureDate))).toBe(true)   // different slice
  })

  it("uses only the configured trip lengths and computes returns correctly", () => {
    const pairs = sampleDatePairs(DEFAULT_DATE_STRATEGY, 0, anchor)
    for (const p of pairs) {
      expect([7, 10, 14, 21]).toContain(p.tripLength)
      const dep = new Date(p.departureDate + "T00:00:00Z")
      const ret = new Date(p.returnDate + "T00:00:00Z")
      expect((ret.getTime() - dep.getTime()) / 86_400_000).toBe(p.tripLength)
    }
  })

  it("does NOT brute-force the horizon — one run is a small slice", () => {
    const plan = planRun({ ...(upsertJob(db, testJob())), runsCompleted: 0 })
    expect(plan.datePairs.length).toBe(4)                  // not 180, not even 12
    expect(plan.cashSearches).toBe(8)                      // 4 pairs × 2 cabins
  })

  it("maps cabins to award search classes", () => {
    expect(cabinsToSearchClass(["economy", "business"])).toBe("both")
    expect(cabinsToSearchClass(["business"])).toBe("PREM")
    expect(cabinsToSearchClass(["economy"])).toBe("ECON")
  })

  it("skips award searches off the awardEveryNRuns cadence", () => {
    const job = upsertJob(db, testJob())                   // awardEveryNRuns: 2
    expect(planRun(job, 0).awardsThisRun).toBe(true)
    expect(planRun(job, 1).awardsThisRun).toBe(false)
    expect(planRun(job, 2).awardsThisRun).toBe(true)
  })
})

// ─── Scheduler lease ─────────────────────────────────────────────────────────

describe("scheduler lease", () => {
  it("only one holder can acquire; the second is refused", () => {
    const a = newHolderId(), b = newHolderId()
    expect(acquireLease(db, a, 90)).toBe(true)
    expect(acquireLease(db, b, 90)).toBe(false)
    expect(readLease(db)!.holder).toBe(a)
  })

  it("a stale heartbeat lets a new scheduler take over", () => {
    const a = newHolderId(), b = newHolderId()
    const past = new Date(Date.now() - 10 * 60_000)
    acquireLease(db, a, 90, past)
    expect(acquireLease(db, b, 90)).toBe(true)             // a's heartbeat is 10m old, ttl 90s
    expect(readLease(db)!.holder).toBe(b)
  })

  it("heartbeat fails after the lease is lost", () => {
    const a = newHolderId(), b = newHolderId()
    acquireLease(db, a, 90, new Date(Date.now() - 10 * 60_000))
    acquireLease(db, b, 90)
    expect(heartbeatLease(db, a).ok).toBe(false)
    expect(heartbeatLease(db, b).ok).toBe(true)
  })

  it("stop is requested through the database and release clears it", () => {
    const a = newHolderId()
    acquireLease(db, a, 90)
    requestStop(db)
    expect(heartbeatLease(db, a)).toEqual({ ok: true, stopRequested: true })
    releaseLease(db, a)
    expect(readLease(db)).toBeNull()
  })
})

// ─── Budget projection ───────────────────────────────────────────────────────

describe("quota projection", () => {
  it("projects the seeded plan within every budget, with zero SerpAPI", () => {
    seedJobsFromProfile(db)
    const p = projectMonthlyBudget(db)
    expect(p.ok).toBe(true)
    const byName = new Map(p.providers.map(x => [x.provider, x]))
    expect(byName.get("serpapi")!.monthlyCalls).toBe(0)
    expect(byName.get("awardwallet")!.monthlyCalls).toBe(0)
    expect(byName.get("atf")!.monthlyCalls).toBe(0)
    expect(byName.get("fast_flights")!.monthlyCalls).toBeGreaterThan(0)
  })

  it("flags an ATF-scheduled plan that would exceed the allowance", () => {
    upsertJob(db, testJob({ awardProviders: ["atf"], frequencyHours: 12 }))  // 60 runs/mo × 10 calls avg
    const p = projectMonthlyBudget(db)
    expect(p.ok).toBe(false)
    expect(p.conflicts.join(" ")).toContain("atf")
  })

  it("the scheduler refuses to start on a budget conflict", async () => {
    upsertJob(db, testJob({ awardProviders: ["atf"], frequencyHours: 12 }))
    const reason = await runScheduler({ db, tickSeconds: 1, maxTicks: 1 })
    expect(reason).toContain("budget-conflict")
    expect(readLease(db)).toBeNull()                       // never even took the lease
  })
})

// ─── Execution ───────────────────────────────────────────────────────────────

function smallJob(over: Partial<NewJob> = {}) {
  return upsertJob(db, testJob({
    dateStrategy: { ...DEFAULT_DATE_STRATEGY, datesPerRun: 1, awardEveryNRuns: 1 },
    cabins: ["business"],
    ...over,
  }))
}

describe("observer execution", () => {
  it("runs cash + award searches, persists observations and the run record", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    setAwardProviders([new MockAwardProvider({ name: "roame", flights: [makeAwardFlight()] })])
    const job = smallJob()

    const result = await executeJob(job, { db, trigger: "manual" })
    expect(result.status).toBe("success")
    expect(result.searchesRun).toBe(2)                     // 1 cash + 1 award
    expect(result.observationsAdded).toBeGreaterThan(0)

    const runs = listRuns(db, { jobId: job.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("success")
    expect(runs[0]!.observationsAdded).toBe(result.observationsAdded)
    expect(runs[0]!.completedAt).toBeTruthy()

    const updated = getJobByName(db, job.name)!
    expect(updated.runsCompleted).toBe(1)
    expect(updated.nextRunAt! > new Date().toISOString()).toBe(true)
  })

  it("the immediate repeat run is served from cache with zero live calls", async () => {
    const cash = new MockProvider({ name: "free_mock", flights: [makeFlight()] })
    const award = new MockAwardProvider({ name: "roame", flights: [makeAwardFlight()] })
    setProviders([cash]); setAwardProviders([award])
    const job = smallJob()

    const first = await executeJob(job, { db, trigger: "manual" })
    expect(first.providerCalls).toBeGreaterThan(0)

    // Same run index again (repeat of the identical observation).
    const jobAgain = { ...getJobByName(db, job.name)!, runsCompleted: 0 }
    const second = await executeJob(jobAgain, { db, trigger: "manual" })
    expect(second.providerCalls).toBe(0)
    expect(second.cacheHits).toBeGreaterThan(0)
    expect(cash.calls).toHaveLength(1)                     // provider not asked again
    expect(award.calls).toHaveLength(1)
    // Cache replays append no duplicate history.
    expect(second.observationsAdded).toBe(0)
  })

  it("skips unhealthy award providers as SKIPPED_AUTH, not failure", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    setAwardProviders([new MockAwardProvider({ name: "roame", configured: false })])
    const job = smallJob()

    const result = await executeJob(job, { db, trigger: "manual" })
    expect(result.status).toBe("partial")                  // cash worked, award skipped
    expect(result.skippedProviders).toEqual(["roame"])
    expect(result.errors.join(" ")).toContain("SKIPPED_AUTH")
    // An auth skip is not a failure — no backoff pressure.
    expect(getJobByName(db, job.name)!.consecutiveFailures).toBe(0)
  })

  it("award-only job with expired auth records skipped_auth", async () => {
    setAwardProviders([new MockAwardProvider({ name: "roame", configured: false })])
    const job = smallJob({ cashProviders: [] })
    const result = await executeJob(job, { db, trigger: "manual" })
    expect(result.status).toBe("skipped_auth")
  })

  it("prevents duplicate concurrent runs of the same job", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const job = smallJob({ awardProviders: [] })
    const runId = startRun(db, job.id, "manual")           // simulate an in-progress run

    const result = await executeJob(job, { db, trigger: "manual" })
    expect(result.runId).toBeNull()
    expect(result.errors.join(" ")).toContain("already has a run in progress")

    finishRun(db, runId, { status: "success", searchesRun: 0, providerCalls: 0, cacheHits: 0, observationsAdded: 0, errors: [], durationMs: 1 })
  })

  it("reaps stale running rows from a crashed scheduler", () => {
    const job = smallJob({ awardProviders: [] })
    const runId = startRun(db, job.id, "schedule")
    db.prepare("UPDATE observation_runs SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 2 * 3600_000).toISOString(), runId)
    expect(reapStaleRuns(db, 60)).toBe(1)
    expect(hasRunningRun(db, job.id)).toBe(false)
    expect(listRuns(db, { jobId: job.id })[0]!.status).toBe("failed")
  })

  it("backs off after three consecutive failures", async () => {
    setProviders([new MockProvider({ name: "free_mock", fail: "provider-error" })])
    const job = smallJob({ awardProviders: [] })

    // Cash searches that fail still count as searches run... make them hard-fail:
    // a provider-error means searchCashFlights returns empty with warnings, which
    // is partial, not failed. Simulate failures via completeJobRun directly —
    // that is the unit under test.
    for (let i = 0; i < 3; i++) completeJobRun(db, job.id, { failed: true, countsAsRun: false }, new Date())
    const backedOff = getJobByName(db, job.name)!
    expect(backedOff.consecutiveFailures).toBe(3)

    // Interval stretches: next_run at least frequency × 2 away.
    const nextGap = new Date(backedOff.nextRunAt!).getTime() - Date.now()
    expect(nextGap).toBeGreaterThan(job.frequencyHours * 3600_000 * 1.9)

    // A success resets the counter.
    completeJobRun(db, job.id, { failed: false, countsAsRun: true })
    expect(getJobByName(db, job.name)!.consecutiveFailures).toBe(0)
  })

  it("never calls SerpAPI even when the free provider finds nothing", async () => {
    const metered = new MockProvider({ name: "serp_mock", kind: "metered", verificationLevel: "verified" })
    setProviders([new MockProvider({ name: "free_mock", fail: "no-results" }), metered])
    const job = smallJob({ awardProviders: [] })

    await executeJob(job, { db, trigger: "manual" })
    expect(metered.calls).toHaveLength(0)                  // allowMeteredFallback: false
  })

  it("dry-run planning performs zero provider calls", () => {
    const cash = new MockProvider({ name: "free_mock" })
    const award = new MockAwardProvider({ name: "roame" })
    setProviders([cash]); setAwardProviders([award])
    const job = smallJob()

    const plan = planRun(job)
    expect(plan.expected.serpapi).toBe(0)
    expect(plan.expected.fastFlights).toBeGreaterThan(0)
    expect(cash.calls).toHaveLength(0)
    expect(award.calls).toHaveLength(0)

    const projection = projectMonthlyBudget(db)
    expect(projection.providers.length).toBeGreaterThan(0)
    expect(cash.calls).toHaveLength(0)                     // projection is pure math
    expect(award.calls).toHaveLength(0)
  })
})

// ─── Scheduler loop ──────────────────────────────────────────────────────────

describe("scheduler loop", () => {
  it("acquires the lease, runs due jobs once, and releases on exit", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    smallJob({ awardProviders: [] })
    db.prepare("UPDATE observation_jobs SET next_run_at = ?").run(new Date(Date.now() - 1000).toISOString())

    const reason = await runScheduler({ db, tickSeconds: 1, maxTicks: 1 })
    expect(reason).toBe("maxTicks")
    expect(readLease(db)).toBeNull()                       // released
    const runs = listRuns(db)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.trigger).toBe("schedule")
  })

  it("a second scheduler cannot start while the lease is held", async () => {
    const holder = newHolderId()
    acquireLease(db, holder, 90)
    const reason = await runScheduler({ db, tickSeconds: 1, maxTicks: 1 })
    expect(reason).toContain("another scheduler already holds the lease")
    releaseLease(db, holder)
  })
})

// ─── Review-finding regressions (Phase 4 adversarial review) ─────────────────

describe("review fixes", () => {
  it("heartbeat keeps refreshing while a stop is pending — no stale takeover during graceful stop", () => {
    const a = newHolderId(), b = newHolderId()
    acquireLease(db, a, 90)
    requestStop(db)
    const before = readLease(db)!.heartbeatAt
    const later = new Date(Date.now() + 5000)
    expect(heartbeatLease(db, a, later)).toEqual({ ok: true, stopRequested: true })
    expect(readLease(db)!.heartbeatAt > before).toBe(true)   // still refreshed
    // A second scheduler cannot steal the lease while the holder winds down.
    expect(acquireLease(db, b, 90, later)).toBe(false)
    releaseLease(db, a)
  })

  it("reseeding does NOT re-enable a job the operator disabled", () => {
    seedJobsFromProfile(db)
    setJobEnabled(db, "PRG-MEX", false)
    seedJobsFromProfile(db)                                  // reseed
    expect(getJobByName(db, "PRG-MEX")!.enabled).toBe(false) // stays disabled
    expect(getJobByName(db, "PRG-BKK")!.enabled).toBe(true)  // others untouched
  })

  it("an award-only job's off-cadence run is a successful no-op that advances rotation", async () => {
    setAwardProviders([new MockAwardProvider({ name: "roame", flights: [makeAwardFlight()] })])
    const job = smallJob({ cashProviders: [], dateStrategy: { ...DEFAULT_DATE_STRATEGY, datesPerRun: 1, awardEveryNRuns: 2 } })

    // Run 0: awards on — real searches.
    const r0 = await executeJob(job, { db, trigger: "manual" })
    expect(r0.searchesRun).toBe(1)
    expect(getJobByName(db, job.name)!.runsCompleted).toBe(1)

    // Run 1: awards off and no cash — previously wedged forever as "failed".
    const j1 = getJobByName(db, job.name)!
    const r1 = await executeJob(j1, { db, trigger: "manual" })
    expect(r1.status).toBe("success")
    expect(getJobByName(db, job.name)!.runsCompleted).toBe(2)  // rotation advanced
    expect(getJobByName(db, job.name)!.consecutiveFailures).toBe(0)

    // Run 2: awards on again — the cadence recovered.
    const j2 = getJobByName(db, job.name)!
    const r2 = await executeJob(j2, { db, trigger: "manual" })
    expect(r2.searchesRun).toBeGreaterThan(0)
  })

  it("executeJob aborts cooperatively when the scheduler loses the lease", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const job = smallJob({ awardProviders: [] })
    const result = await executeJob(job, { db, trigger: "schedule", shouldContinue: () => false })
    expect(result.errors.join(" ")).toContain("aborted")
    expect(result.searchesRun).toBe(0)                       // stopped before spending
  })

  it("a refused (budget-exhausted) award search reverts its pre-recorded attempts", async () => {
    setAwardProviders([new MockAwardProvider({
      name: "atf-mock", callsPerSearch: 5, fail: "budget-exhausted", failCallsSpent: 0,
    })])
    await searchAwardFlights(makeAwardQuery(), { db })
    // Pre-record +5, refusal spent 0 → settle reverts to 0. Refusals can never
    // inflate usage into a lockout.
    expect(readUsage(db, "atf-mock").attempted).toBe(0)
  })

  it("the ATF guard accounts for pre-recorded attempts instead of double-counting", async () => {
    process.env.ATF_API_KEY = "synthetic-test-key-never-used"
    const { recordCallAttempt: rca } = await import("../db/repositories.js")
    const { getDb, closeDb } = await import("../db/index.js")
    const tmp = path.join(os.tmpdir(), `atf-pre-${process.pid}-${Date.now()}.db`)
    process.env.DATABASE_PATH = tmp
    closeDb()
    const guardDb = getDb()
    // 151 attempted INCLUDING a 5-call pre-record for this search →
    // usedBefore = 146 → 146+5 > 150 → refuse without network.
    rca(guardDb, "atf", undefined, 151)
    const { ATFAwardProvider } = await import("../providers/award-flights/atf.js")
    const result = await new ATFAwardProvider().search({
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10",
      returnDate: null, searchClass: "both", adults: 1,
    }, { quotaPreRecorded: 5 })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("budget-exhausted")
    expect(result.callsSpent).toBe(0)
    closeDb()
    fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + "-wal", { force: true }); fs.rmSync(tmp + "-shm", { force: true })
  })

  it("tryStartRun refuses the second concurrent start atomically", () => {
    const job = smallJob({ awardProviders: [] })
    const first = tryStartRun(db, job.id, "manual")
    expect(first).not.toBeNull()
    expect(tryStartRun(db, job.id, "schedule")).toBeNull()
    finishRun(db, first!, { status: "success", searchesRun: 0, providerCalls: 0, cacheHits: 0, observationsAdded: 0, errors: [], durationMs: 1 })
    expect(tryStartRun(db, job.id, "manual")).not.toBeNull()
  })

  it("the scheduler re-verifies due-ness from fresh state before each job", async () => {
    setProviders([new MockProvider({ name: "free_mock", flights: [makeFlight()] })])
    const job = smallJob({ awardProviders: [] })
    db.prepare("UPDATE observation_jobs SET next_run_at = ?").run(new Date(Date.now() - 1000).toISOString())

    // Simulate another scheduler having just run the job: next_run_at moves to
    // the future between the snapshot and execution. Our loop must skip it.
    // (Direct unit: dueJobs snapshot says due; fresh check says not.)
    const snapshot = dueJobs(db)
    expect(snapshot).toHaveLength(1)
    db.prepare("UPDATE observation_jobs SET next_run_at = ?").run(new Date(Date.now() + 3600_000).toISOString())

    const reason = await runScheduler({ db, tickSeconds: 1, maxTicks: 1 })
    expect(reason).toBe("maxTicks")
    expect(listRuns(db)).toHaveLength(0)                     // nothing executed
  })
})

// ─── ATF self-guard ──────────────────────────────────────────────────────────

describe("ATF quota self-guard", () => {
  it("refuses a search that would exceed the monthly allowance", async () => {
    // 148 of 150 already attempted; a 5-call search must be refused.
    process.env.ATF_API_KEY = "synthetic-test-key-never-used"
    const { recordCallAttempt } = await import("../db/repositories.js")
    const { getDb, closeDb } = await import("../db/index.js")
    // The ATF provider reads usage through getDb() — point it at a temp file DB.
    const tmp = path.join(os.tmpdir(), `atf-guard-${process.pid}-${Date.now()}.db`)
    process.env.DATABASE_PATH = tmp
    closeDb()
    const guardDb = getDb()
    recordCallAttempt(guardDb, "atf", undefined, 148)

    const { ATFAwardProvider } = await import("../providers/award-flights/atf.js")
    const provider = new ATFAwardProvider()
    const result = await provider.search({
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10",
      returnDate: null, searchClass: "both", adults: 1,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("budget-exhausted")
    expect(result.callsSpent).toBe(0)                      // refused BEFORE spending
    expect(readUsage(guardDb, "atf").attempted).toBe(148)  // unchanged

    closeDb()
    fs.rmSync(tmp, { force: true })
    fs.rmSync(tmp + "-wal", { force: true })
    fs.rmSync(tmp + "-shm", { force: true })
  })
})

// ─── Migration ───────────────────────────────────────────────────────────────

describe("Phase 4 migration", () => {
  it("applies 003 to a populated Phase 3 database without losing history", () => {
    const file = path.join(os.tmpdir(), `radar-mig4-${process.pid}-${Date.now()}.db`)
    const raw = new Database(file)
    try {
      raw.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
      for (const m of ["001_init.sql", "002_awards.sql"]) {
        raw.exec(fs.readFileSync(path.join(process.cwd(), "db", "migrations", m), "utf-8"))
        raw.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, '2026-08-27T00:00:00Z')").run(m)
      }
      raw.prepare(`INSERT INTO flight_prices (itinerary_hash, origin, destination, departure_date, cabin, adults, price_amount, price_currency, provider, verification_level, provider_confidence, fetched_at)
                   VALUES ('h1','PRG','BKK','2026-11-10','business',1,2814,'USD','fast_flights','discovered','medium','2026-08-27T10:00:00Z')`).run()
      raw.prepare(`INSERT INTO award_prices (itinerary_hash, origin, destination, departure_date, cabin, loyalty_program, points, provider, verification_level, provider_confidence, fetched_at)
                   VALUES ('h1','PRG','BKK','2026-11-10','business','AEROPLAN',70000,'roame','discovered','high','2026-08-27T11:00:00Z')`).run()
      raw.prepare(`INSERT INTO balance_snapshots (program, program_key, balance, source, fetched_at)
                   VALUES ('Synthetic','synthetic',12345,'awardwallet','2026-08-27T09:00:00Z')`).run()

      const applied = migrate(raw as never)
      expect(applied).toEqual(["003_observer.sql"])
      expect((raw.prepare("SELECT COUNT(*) c FROM flight_prices").get() as any).c).toBe(1)
      expect((raw.prepare("SELECT COUNT(*) c FROM award_prices").get() as any).c).toBe(1)
      expect((raw.prepare("SELECT COUNT(*) c FROM balance_snapshots").get() as any).c).toBe(1)
      // New tables usable.
      raw.prepare(`INSERT INTO observation_jobs (name, origin, destination, cabins, cash_providers, award_providers, date_strategy, created_at, updated_at)
                   VALUES ('T-T','PRG','BKK','["economy"]','["fast_flights"]','[]','{}','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`).run()
      expect((raw.prepare("SELECT COUNT(*) c FROM observation_jobs").get() as any).c).toBe(1)
    } finally {
      raw.close()
      fs.rmSync(file, { force: true })
    }
  })
})
