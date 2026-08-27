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
  acquireLease, heartbeatLease, releaseLease, newHolderId, dueJobs, reapStaleRuns,
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

  let ticks = 0
  let exitReason = "stopped"
  try {
    for (;;) {
      if (stopping) { exitReason = "signal"; break }

      const beat = heartbeatLease(db, holder)
      if (!beat.ok) { exitReason = "lease lost to another scheduler"; break }
      if (beat.stopRequested) { exitReason = "stop requested via observer:stop"; break }

      // Hygiene: runs left 'running' by a crash are closed out.
      const reaped = reapStaleRuns(db)
      if (reaped > 0) console.warn(`OBSERVER reaped ${reaped} stale run(s) from a previous crash`)

      // Jobs already carry per-job jitter in next_run_at, so due jobs simply
      // run in priority order — sequentially, to keep bursts impossible.
      for (const job of dueJobs(db)) {
        if (stopping) break
        await executeJob(job, { db, trigger: "schedule" })
        heartbeatLease(db, holder)   // long jobs must not look crashed
      }

      ticks++
      if (options.maxTicks !== undefined && ticks >= options.maxTicks) { exitReason = "maxTicks"; break }
      await new Promise(r => setTimeout(r, tickSeconds * 1000))
    }
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    releaseLease(db, holder)
    console.log(`OBSERVER SCHEDULER stopped (${exitReason})`)
  }
  return exitReason
}
