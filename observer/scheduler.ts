/**
 * Scheduler: a long-lived loop that owns the single database lease, runs due
 * jobs, and steps aside cleanly.
 *
 * Designed for headless operation (later: inside Docker on the NAS): no
 * browser, no OS task scheduler, no interactive terminal — plain Node process
 * whose lifecycle IS the schedule. Duplicate instances are excluded by the
 * scheduler_state lease; a crashed holder's stale lease is taken over after
 * OBSERVER_LEASE_TTL_SECONDS.
 */

import { getDb, type DB } from "../db/index.js"
import {
  acquireLease, heartbeatLease, releaseLease, newHolderId, dueJobs, reapStaleRuns, getJob,
} from "./store.js"
import { executeJob } from "./engine.js"
import { projectMonthlyBudget } from "./budget.js"

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback
}

export interface SchedulerOptions {
  db?: DB
  tickSeconds?: number
  leaseTtlSeconds?: number
  /** Test hook: stop after this many ticks. */
  maxTicks?: number
}

/**
 * Run the scheduler until stopped (observer:stop, SIGINT, or a lost lease).
 * Returns why it exited.
 */
export async function runScheduler(options: SchedulerOptions = {}): Promise<string> {
  const db = options.db ?? getDb()
  const tickSeconds = options.tickSeconds ?? envInt("OBSERVER_TICK_SECONDS", 60)
  const leaseTtl = options.leaseTtlSeconds ?? envInt("OBSERVER_LEASE_TTL_SECONDS", 90)
  const holder = newHolderId()

  // ── Budget gate: refuse to schedule a plan that exceeds a provider budget ──
  const projection = projectMonthlyBudget(db)
  if (!projection.ok) {
    for (const conflict of projection.conflicts) console.error(`❌ BUDGET CONFLICT: ${conflict}`)
    return "budget-conflict: schedule not started (fix jobs or budgets first)"
  }

  if (!acquireLease(db, holder, leaseTtl)) {
    return "another scheduler already holds the lease (use observer:stop to stop it)"
  }
  console.log(`OBSERVER SCHEDULER started (holder ${holder}, tick ${tickSeconds}s)`)

  let stopping = false
  const onSignal = () => { stopping = true }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // A job can run for minutes (Roame polls up to 90s per class). The lease
  // must stay visibly alive throughout, or a second `observer:start` would
  // "take over" a stale-looking lease from a scheduler that is merely busy —
  // so a timer heartbeats every ttl/3 seconds for the process lifetime, and
  // its result feeds the flags the job loop acts on.
  let leaseLost = false
  let stopViaDb = false
  const beatMs = Math.max(5, Math.floor(leaseTtl / 3)) * 1000
  const beatTimer = setInterval(() => {
    const beat = heartbeatLease(db, holder)
    if (!beat.ok) leaseLost = true
    else if (beat.stopRequested) stopViaDb = true
  }, beatMs)

  const shouldContinue = () => !stopping && !leaseLost && !stopViaDb

  let ticks = 0
  let exitReason = "stopped"
  try {
    for (;;) {
      if (stopping) { exitReason = "signal"; break }
      if (leaseLost) { exitReason = "lease lost to another scheduler"; break }

      const beat = heartbeatLease(db, holder)
      if (!beat.ok) { exitReason = "lease lost to another scheduler"; break }
      if (beat.stopRequested || stopViaDb) { exitReason = "stop requested via observer:stop"; break }

      // Hygiene: runs left 'running' by a crash are closed out.
      const reaped = reapStaleRuns(db)
      if (reaped > 0) console.warn(`OBSERVER reaped ${reaped} stale run(s) from a previous crash`)

      // Jobs already carry per-job jitter in next_run_at, so due jobs simply
      // run in priority order — sequentially, to keep bursts impossible.
      for (const job of dueJobs(db)) {
        if (!shouldContinue()) break
        // Re-verify against FRESH state: another scheduler (or a manual run)
        // may have executed this job after our snapshot — its next_run_at is
        // then in the future and re-running it would double-spend and skew the
        // grid rotation. The fresh row also carries the current runsCompleted.
        const fresh = getJob(db, job.id)
        if (!fresh || !fresh.enabled) continue
        if (fresh.nextRunAt && new Date(fresh.nextRunAt) > new Date()) continue
        await executeJob(fresh, { db, trigger: "schedule", shouldContinue })
      }
      if (leaseLost) { exitReason = "lease lost to another scheduler"; break }
      if (stopViaDb) { exitReason = "stop requested via observer:stop"; break }

      ticks++
      if (options.maxTicks !== undefined && ticks >= options.maxTicks) { exitReason = "maxTicks"; break }
      await new Promise(r => setTimeout(r, tickSeconds * 1000))
    }
  } finally {
    clearInterval(beatTimer)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    releaseLease(db, holder)
    console.log(`OBSERVER SCHEDULER stopped (${exitReason})`)
  }
  return exitReason
}
