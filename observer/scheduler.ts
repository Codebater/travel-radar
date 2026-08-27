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
import { backupIfDue } from "../db/backup.js"
import { evaluateNewObservations } from "../anomaly/engine.js"
import { dueDiscoveryJobs, getDiscoveryJob, reapStaleDiscoveryRuns } from "../discovery/store.js"
import { executeDiscoveryJob } from "../discovery/engine.js"

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
  let ticks = 0
  const beatMs = Math.max(5, Math.floor(leaseTtl / 3)) * 1000
  const beatTimer = setInterval(() => {
    // §AD the heartbeat carries the process footprint, so the health page can
    // answer "will this fit on the DS723+" without a metrics daemon.
    const cpu = process.cpuUsage()
    const beat = heartbeatLease(db, holder, new Date(), {
      rssBytes: process.memoryUsage().rss,
      cpuSeconds: Math.round(((cpu.user + cpu.system) / 1e6) * 100) / 100,
      ticks,
    })
    if (!beat.ok) leaseLost = true
    else if (beat.stopRequested) stopViaDb = true
  }, beatMs)

  const shouldContinue = () => !stopping && !leaseLost && !stopViaDb

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
      // Discovery jobs run on the SAME scheduler and the same lease, so the
      // two engines can never overlap on one machine and there is one process
      // to supervise rather than two. Observation jobs go first: they are the
      // long, comparable series that everything else is judged against, and a
      // discovery cycle that overruns must never delay them.
      // The whole discovery block is guarded, enumeration included. A throw
      // from dueDiscoveryJobs or getDiscoveryJob sat OUTSIDE the per-job catch,
      // and would have taken the scheduler down with it - along with the
      // observation collection that is the more valuable of the two.
      try {
        const reapedDiscovery = reapStaleDiscoveryRuns(db)
        if (reapedDiscovery > 0) {
          console.warn(`OBSERVER reaped ${reapedDiscovery} stale discovery run(s) from a previous crash`)
        }
        for (const job of dueDiscoveryJobs(db)) {
          if (!shouldContinue()) break
          const fresh = getDiscoveryJob(db, job.id)
          if (!fresh || !fresh.enabled) continue
          if (fresh.nextRunAt && new Date(fresh.nextRunAt) > new Date()) continue
          try {
            await executeDiscoveryJob(fresh, { db, trigger: "schedule", shouldContinue })
          } catch (err) {
            console.warn(`⚠️ discovery job ${fresh.name} failed: ${(err as Error).message}`)
          }
        }
      } catch (err) {
        console.warn(`⚠️ discovery scheduling failed, observation collection continues: ${(err as Error).message}`)
      }

      if (leaseLost) { exitReason = "lease lost to another scheduler"; break }
      if (stopViaDb) { exitReason = "stop requested via observer:stop"; break }

      // §I evaluate what was just collected. Database-only: it contacts no
      // provider, spends no budget, and notifies nobody - decisions are
      // written to deal_candidates and left there for review.
      try {
        evaluateNewObservations({ db, quiet: false })
      } catch (err) {
        console.warn(`⚠️ anomaly evaluation failed (observation collection is unaffected): ${(err as Error).message}`)
      }

      // §AC a rolling local backup, taken by whoever holds the lease. Cheap
      // (one online snapshot per day) and the only thing standing between a
      // corrupt page and a year of irreplaceable history.
      try {
        const backup = await backupIfDue(db)
        if (backup) {
          console.log(
            `OBSERVER BACKUP ${backup.path} (${(backup.bytes / 1e6).toFixed(1)} MB, ${backup.durationMs}ms` +
            `${backup.pruned.length ? `, pruned ${backup.pruned.length} old` : ""})`,
          )
        }
      } catch (err) {
        console.warn(`⚠️ backup failed: ${(err as Error).message}`)
      }

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
