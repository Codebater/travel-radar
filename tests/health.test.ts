/**
 * §C/§D operational instrumentation: can we tell, without watching, whether
 * unattended collection is healthy?
 *
 * These tests exist because Phase 4's scheduler was correct but unobservable.
 * Every assertion here is about a question that only arises when nobody is
 * looking: did it stay up, did runs happen on time, is something failing
 * quietly, is the cache doing its job.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  recordCallOutcome, recordProviderEvent, providerEventsSince, classifyFailure,
  recordPriceObservations,
} from "../db/repositories.js"
import {
  upsertJob, startRun, finishRun, acquireLease, heartbeatLease, releaseLease,
  newHolderId, completeJobRun,
} from "../observer/store.js"
import { observerHealth } from "../observer/health.js"
import { DEFAULT_DATE_STRATEGY } from "../observer/sampling.js"
import { makeFlight } from "./mocks.js"
import type { NewJob } from "../observer/store.js"

let db: DB
const NOW = new Date("2026-06-01T12:00:00.000Z")
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString()

function job(over: Partial<NewJob> = {}): NewJob {
  return {
    name: "PRG-BKK",
    origin: "PRG",
    destination: "BKK",
    cabins: ["economy"],
    cashProviders: ["fast_flights"],
    awardProviders: ["roame"],
    priority: 1,
    frequencyHours: 84,
    jitterMinutes: 0,
    dateStrategy: { ...DEFAULT_DATE_STRATEGY },
    ...over,
  }
}

/** Write a completed run with explicit timings. */
function run(
  jobId: number,
  over: { startedAt?: string; scheduledFor?: string | null; status?: any; cacheHits?: number; providerCalls?: number; observations?: number } = {},
): number {
  const id = startRun(db, jobId, "schedule", over.scheduledFor ?? null)
  if (over.startedAt) db.prepare(`UPDATE observation_runs SET started_at = ? WHERE id = ?`).run(over.startedAt, id)
  finishRun(db, id, {
    status: over.status ?? "success",
    searchesRun: 4,
    providerCalls: over.providerCalls ?? 2,
    cacheHits: over.cacheHits ?? 2,
    observationsAdded: over.observations ?? 10,
    errors: [],
    durationMs: 1234,
  })
  return id
}

beforeEach(() => {
  db = createMemoryDb()
})

afterEach(() => {
  db.close()
})

describe("scheduler liveness", () => {
  it("reports STOPPED with a warning when no lease is held", () => {
    const h = observerHealth(db, NOW)
    expect(h.scheduler.running).toBe(false)
    expect(h.scheduler.uptimeSeconds).toBeNull()
    expect(h.warnings.join(" ")).toMatch(/not running/)
  })

  it("reports uptime, heartbeat age and the process footprint", () => {
    const holder = newHolderId()
    acquireLease(db, holder, 90, new Date(NOW.getTime() - 7200_000))
    heartbeatLease(db, holder, new Date(NOW.getTime() - 20_000), {
      rssBytes: 90_000_000, cpuSeconds: 12.5, ticks: 42,
    })

    const h = observerHealth(db, NOW)
    expect(h.scheduler.running).toBe(true)
    expect(h.scheduler.uptimeSeconds).toBe(7200)
    expect(h.scheduler.heartbeatAgeSeconds).toBe(20)
    expect(h.scheduler.stale).toBe(false)
    expect(h.scheduler.rssBytes).toBe(90_000_000)
    expect(h.scheduler.cpuSeconds).toBe(12.5)
    expect(h.scheduler.ticks).toBe(42)
    releaseLease(db, holder)
  })

  it("calls out a held lease whose heartbeat died", () => {
    // The dangerous state: the page would otherwise show a comforting
    // "RUNNING" for a process that is gone.
    const holder = newHolderId()
    acquireLease(db, holder, 90, new Date(NOW.getTime() - 7200_000))
    heartbeatLease(db, holder, new Date(NOW.getTime() - 3600_000))

    const h = observerHealth(db, NOW)
    expect(h.scheduler.running).toBe(true)
    expect(h.scheduler.stale).toBe(true)
    expect(h.warnings.join(" ")).toMatch(/heartbeat is \d+s old/)
  })

  it("surfaces a pending stop", () => {
    const holder = newHolderId()
    acquireLease(db, holder, 90, NOW)
    db.prepare(`UPDATE scheduler_state SET stop_requested = 1 WHERE id = 1`).run()
    expect(observerHealth(db, NOW).scheduler.stopRequested).toBe(true)
  })
})

describe("run windows", () => {
  it("separates 24h from 7d and counts each status", () => {
    const j = upsertJob(db, job())
    run(j.id, { startedAt: ago(2), status: "success" })
    run(j.id, { startedAt: ago(5), status: "partial" })
    run(j.id, { startedAt: ago(30), status: "failed" })
    run(j.id, { startedAt: ago(100), status: "skipped_auth" })

    const h = observerHealth(db, NOW)
    expect(h.runs.last24h.total).toBe(2)
    expect(h.runs.last24h.success).toBe(1)
    expect(h.runs.last24h.partial).toBe(1)
    expect(h.runs.last7d.total).toBe(4)
    expect(h.runs.last7d.failed).toBe(1)
    expect(h.runs.last7d.skippedAuth).toBe(1)
  })

  it("computes the cache hit rate from live calls and cache hits", () => {
    const j = upsertJob(db, job())
    run(j.id, { startedAt: ago(1), cacheHits: 3, providerCalls: 1 })
    expect(observerHealth(db, NOW).runs.last24h.cacheHitRate).toBe(75)
  })

  it("says 'no data' rather than 0% when nothing has run", () => {
    // A brand new install has no hit rate. Reporting 0% would read as a
    // broken cache rather than an empty history.
    expect(observerHealth(db, NOW).runs.last24h.cacheHitRate).toBeNull()
  })
})

describe("missed and delayed runs", () => {
  it("flags a job overdue by more than its grace period", () => {
    const j = upsertJob(db, job({ frequencyHours: 84 }))
    // Grace is 10% of the cadence, so 8.4h. Twenty hours late is missed.
    db.prepare(`UPDATE observation_jobs SET next_run_at = ? WHERE id = ?`).run(ago(20), j.id)

    const h = observerHealth(db, NOW)
    expect(h.missedRuns).toHaveLength(1)
    expect(h.missedRuns[0]!.job).toBe("PRG-BKK")
    expect(h.missedRuns[0]!.overdueHours).toBeCloseTo(20, 0)
    expect(h.warnings.join(" ")).toMatch(/overdue/)
  })

  it("does not cry wolf over a job that is merely due", () => {
    const j = upsertJob(db, job({ frequencyHours: 84 }))
    db.prepare(`UPDATE observation_jobs SET next_run_at = ? WHERE id = ?`).run(ago(1), j.id)
    expect(observerHealth(db, NOW).missedRuns).toHaveLength(0)
  })

  it("ignores a disabled job", () => {
    const j = upsertJob(db, job({ enabled: false }))
    db.prepare(`UPDATE observation_jobs SET next_run_at = ? WHERE id = ?`).run(ago(200), j.id)
    expect(observerHealth(db, NOW).missedRuns).toHaveLength(0)
  })

  it("measures how late a run that DID happen was", () => {
    const j = upsertJob(db, job())
    run(j.id, { scheduledFor: ago(3), startedAt: ago(1) })

    const h = observerHealth(db, NOW)
    expect(h.delayedRuns).toHaveLength(1)
    expect(h.delayedRuns[0]!.delayMinutes).toBe(120)
  })

  it("treats a run that started on time as on time", () => {
    const j = upsertJob(db, job())
    run(j.id, { scheduledFor: ago(1), startedAt: ago(1) })
    expect(observerHealth(db, NOW).delayedRuns).toHaveLength(0)
  })

  it("reports the active backoff multiplier", () => {
    const j = upsertJob(db, job())
    for (let i = 0; i < 4; i++) completeJobRun(db, j.id, { failed: true, countsAsRun: true }, NOW)

    const h = observerHealth(db, NOW)
    expect(h.backoff).toHaveLength(1)
    expect(h.backoff[0]!.consecutiveFailures).toBe(4)
    expect(h.backoff[0]!.multiplier).toBe(4)
  })
})

describe("provider failures over time", () => {
  it("classifies failures so an expired session is not filed as a server error", () => {
    expect(classifyFailure("HTTP 401 unauthorized")).toBe("auth")
    expect(classifyFailure("session expired")).toBe("auth")
    expect(classifyFailure("IP_DENIED")).toBe("auth")
    expect(classifyFailure("BUSINESS_ADMINS_REQUIRE_PLUS")).toBe("auth")
    // Live validation caught this: the provider translated the vendor code into
    // a readable sentence, and the sentence alone was filed as a transient
    // server error - so an account-level lockout would have looked like a blip.
    expect(classifyFailure(
      "BUSINESS_ADMINS_REQUIRE_PLUS: AwardWallet accepts this key and this IP, but every admin " +
      "on the business account must hold AwardWallet Plus",
    )).toBe("auth")
    expect(classifyFailure(
      "IP_DENIED: IP not whitelisted for this AwardWallet key",
    )).toBe("auth")
    expect(classifyFailure("monthly quota exhausted")).toBe("quota")
    expect(classifyFailure("429 rate limit")).toBe("quota")
    expect(classifyFailure("socket hang up")).toBe("error")
  })

  it("records an event for every failed call, and none for a success", () => {
    recordCallOutcome(db, "roame", { ok: false, error: "session expired" })
    recordCallOutcome(db, "atf", { ok: false, error: "socket hang up" })
    recordCallOutcome(db, "roame", { ok: true })

    const events = providerEventsSince(db, ago(24))
    expect(events).toHaveLength(2)
    expect(events.find(e => e.provider === "roame")!.kind).toBe("auth")
    expect(events.find(e => e.provider === "atf")!.kind).toBe("error")
  })

  it("answers 'in the last 24 hours', which the monthly counter cannot", () => {
    recordProviderEvent(db, "roame", "auth", "old failure")
    db.prepare(`UPDATE provider_events SET occurred_at = ?`).run(ago(72))
    recordProviderEvent(db, "roame", "error", "recent failure")

    const h = observerHealth(db, NOW)
    expect(h.authFailures24h).toHaveLength(0)
    expect(h.providerFailures24h).toHaveLength(1)
    expect(h.providerFailures24h[0]!.count).toBe(1)
  })

  it("warns about authentication failures specifically", () => {
    recordProviderEvent(db, "awardwallet", "auth", "IP not whitelisted")
    expect(observerHealth(db, NOW).warnings.join(" ")).toMatch(/[Aa]uthentication failures.*awardwallet/)
  })

  it("keeps the last detail for each provider and kind", () => {
    recordProviderEvent(db, "roame", "auth", "first")
    recordProviderEvent(db, "roame", "auth", "second")
    const events = providerEventsSince(db, ago(24))
    expect(events[0]!.count).toBe(2)
    expect(events[0]!.lastDetail).toBe("second")
  })
})

describe("observation and resource reporting", () => {
  it("reports totals and recent additions separately", () => {
    recordPriceObservations(db, [
      makeFlight({ fetchedAt: ago(2) }),
      makeFlight({ fetchedAt: ago(200), departureTime: "2026-11-10T09:00" }),
    ], { adults: 1 })

    const h = observerHealth(db, NOW)
    expect(h.observation.totals.cash).toBe(2)
    expect(h.observation.last24h.cash).toBe(1)
    expect(h.observation.last7d.cash).toBe(1)
  })

  it("names the job behind the last successful observation", () => {
    const j = upsertJob(db, job())
    run(j.id, { startedAt: ago(3), observations: 12 })
    run(j.id, { startedAt: ago(1), observations: 0 })   // a run that found nothing

    const h = observerHealth(db, NOW)
    expect(h.observation.lastSuccessfulJob).toBe("PRG-BKK")
    expect(h.observation.lastSuccessfulAt).toBe(ago(3))
  })

  it("reports the next scheduled observation", () => {
    const soon = upsertJob(db, job({ name: "VIE-CUN", origin: "VIE", destination: "CUN" }))
    const later = upsertJob(db, job({ name: "PRG-MEX", origin: "PRG", destination: "MEX" }))
    db.prepare(`UPDATE observation_jobs SET next_run_at = ? WHERE id = ?`).run(ago(-2), soon.id)
    db.prepare(`UPDATE observation_jobs SET next_run_at = ? WHERE id = ?`).run(ago(-40), later.id)

    expect(observerHealth(db, NOW).observation.nextScheduledJob).toBe("VIE-CUN")
  })

  it("reports database size, backup state and process resources", () => {
    const h = observerHealth(db, NOW)
    expect(h.resources.backupRetention).toBeGreaterThan(0)
    expect(h.resources.backupIntervalHours).toBeGreaterThan(0)
    expect(h.resources.processRssBytes).toBeGreaterThan(0)
    expect(h.resources.processCpuSeconds).toBeGreaterThanOrEqual(0)
    expect(typeof h.resources.dbTotalBytes).toBe("number")
  })

  it("counts cache entries and hits", () => {
    db.prepare(`
      INSERT INTO search_cache (cache_key, provider, origin, destination, departure_date, cabin, adults, payload, result_count, created_at, expires_at, hit_count)
      VALUES ('k', 'mock', 'PRG', 'BKK', '2026-11-10', 'economy', 1, '[]', 0, ?, ?, 7)
    `).run(ago(1), ago(-1))

    const h = observerHealth(db, NOW)
    expect(h.cache.entries).toBe(1)
    expect(h.cache.hits).toBe(7)
    expect(h.cache.expired).toBe(0)
  })
})
