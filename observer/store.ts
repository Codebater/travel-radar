/**
 * Observer data access: jobs, run history and the scheduler lease.
 * Same discipline as db/repositories.ts — atomic statements in transactions.
 */

import os from "os"
import crypto from "crypto"
import type { DB } from "../db/index.js"
import { nowIso } from "../db/index.js"
import type { ObservationJob, ObservationRun, RunStatus, DateStrategy } from "./types.js"
import type { CabinClass } from "../providers/cash-flights/types.js"

// ─── Jobs ────────────────────────────────────────────────────────────────────

function rowToJob(r: any): ObservationJob {
  return {
    id: r.id,
    name: r.name,
    origin: r.origin,
    destination: r.destination,
    cabins: JSON.parse(r.cabins) as CabinClass[],
    cashProviders: JSON.parse(r.cash_providers),
    awardProviders: JSON.parse(r.award_providers),
    priority: r.priority,
    frequencyHours: r.frequency_hours,
    jitterMinutes: r.jitter_minutes,
    dateStrategy: JSON.parse(r.date_strategy) as DateStrategy,
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    consecutiveFailures: r.consecutive_failures,
    runsCompleted: r.runs_completed,
  }
}

export interface NewJob {
  name: string
  origin: string
  destination: string
  cabins: CabinClass[]
  cashProviders: string[]
  awardProviders: string[]
  priority: number
  frequencyHours: number
  jitterMinutes: number
  dateStrategy: DateStrategy
  enabled?: boolean
}

/**
 * Insert or update a job by name. Never resets run bookkeeping on reseed, and
 * — unless the caller passes `enabled` explicitly — never flips the enabled
 * flag either: a route the operator disabled must not silently resume
 * scheduled provider spend just because the profile was reseeded.
 */
export function upsertJob(db: DB, job: NewJob): ObservationJob {
  const now = nowIso()
  const tx = db.transaction(() => {
    const existing = getJobByName(db, job.name)
    if (!existing) {
      db.prepare(`
        INSERT INTO observation_jobs
          (name, origin, destination, cabins, cash_providers, award_providers,
           priority, frequency_hours, jitter_minutes, date_strategy, enabled,
           created_at, updated_at, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.name, job.origin.toUpperCase(), job.destination.toUpperCase(),
        JSON.stringify(job.cabins), JSON.stringify(job.cashProviders), JSON.stringify(job.awardProviders),
        job.priority, job.frequencyHours, job.jitterMinutes, JSON.stringify(job.dateStrategy),
        job.enabled === false ? 0 : 1, now, now, now,
      )
    } else {
      const enabled = job.enabled === undefined ? (existing.enabled ? 1 : 0) : (job.enabled ? 1 : 0)
      db.prepare(`
        UPDATE observation_jobs SET
          origin = ?, destination = ?, cabins = ?, cash_providers = ?, award_providers = ?,
          priority = ?, frequency_hours = ?, jitter_minutes = ?, date_strategy = ?,
          enabled = ?, updated_at = ?
        WHERE name = ?
      `).run(
        job.origin.toUpperCase(), job.destination.toUpperCase(),
        JSON.stringify(job.cabins), JSON.stringify(job.cashProviders), JSON.stringify(job.awardProviders),
        job.priority, job.frequencyHours, job.jitterMinutes, JSON.stringify(job.dateStrategy),
        enabled, now, job.name,
      )
    }
  })
  tx()
  return getJobByName(db, job.name)!
}

export function getJob(db: DB, id: number): ObservationJob | null {
  const r = db.prepare(`SELECT * FROM observation_jobs WHERE id = ?`).get(id)
  return r ? rowToJob(r) : null
}

export function getJobByName(db: DB, name: string): ObservationJob | null {
  const r = db.prepare(`SELECT * FROM observation_jobs WHERE name = ?`).get(name)
  return r ? rowToJob(r) : null
}

export function listJobs(db: DB, opts: { enabledOnly?: boolean } = {}): ObservationJob[] {
  const rows = opts.enabledOnly
    ? db.prepare(`SELECT * FROM observation_jobs WHERE enabled = 1 ORDER BY priority, name`).all()
    : db.prepare(`SELECT * FROM observation_jobs ORDER BY priority, name`).all()
  return rows.map(rowToJob)
}

/** Jobs whose next_run_at has arrived, most important first. */
export function dueJobs(db: DB, at: Date = new Date()): ObservationJob[] {
  return db.prepare(`
    SELECT * FROM observation_jobs
    WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
    ORDER BY priority, next_run_at
  `).all(at.toISOString()).map(rowToJob)
}

export function setJobEnabled(db: DB, name: string, enabled: boolean): boolean {
  return db.prepare(`UPDATE observation_jobs SET enabled = ?, updated_at = ? WHERE name = ?`)
    .run(enabled ? 1 : 0, nowIso(), name).changes > 0
}

/**
 * Record a completed execution against the job: schedule the next run with
 * jitter, track consecutive failures, and apply backoff — three or more
 * consecutive failures stretch the interval so a broken provider is not
 * hammered on the normal cadence.
 */
export function completeJobRun(
  db: DB,
  jobId: number,
  outcome: { failed: boolean; countsAsRun: boolean },
  at: Date = new Date(),
): void {
  const job = getJob(db, jobId)
  if (!job) return

  const failures = outcome.failed ? job.consecutiveFailures + 1 : 0
  const backoffMultiplier = failures >= 3 ? Math.min(2 ** (failures - 2), 8) : 1
  const jitterMs = Math.floor(Math.random() * job.jitterMinutes * 60_000)
  const nextRunAt = new Date(
    at.getTime() + job.frequencyHours * 3600_000 * backoffMultiplier + jitterMs,
  ).toISOString()

  db.prepare(`
    UPDATE observation_jobs SET
      last_run_at = ?, next_run_at = ?, consecutive_failures = ?,
      runs_completed = runs_completed + ?, updated_at = ?
    WHERE id = ?
  `).run(at.toISOString(), nextRunAt, failures, outcome.countsAsRun ? 1 : 0, nowIso(), jobId)
}

// ─── Runs ────────────────────────────────────────────────────────────────────

function rowToRun(r: any): ObservationRun {
  let errors: string[] = []
  try { errors = r.errors ? JSON.parse(r.errors) : [] } catch { errors = [String(r.errors)] }
  return {
    id: r.id, jobId: r.job_id, startedAt: r.started_at, completedAt: r.completed_at,
    status: r.status, trigger: r.trigger, searchesRun: r.searches_run,
    providerCalls: r.provider_calls, cacheHits: r.cache_hits,
    observationsAdded: r.observations_added, errors, durationMs: r.duration_ms,
  }
}

export function startRun(db: DB, jobId: number, trigger: ObservationRun["trigger"]): number {
  const info = db.prepare(`
    INSERT INTO observation_runs (job_id, started_at, status, trigger)
    VALUES (?, ?, 'running', ?)
  `).run(jobId, nowIso(), trigger)
  return Number(info.lastInsertRowid)
}

/**
 * Atomically start a run IF none is running for the job. The check and the
 * insert share one immediate transaction, so a concurrent manual run and a
 * scheduler tick cannot both slip past the guard. Returns null when refused.
 */
export function tryStartRun(db: DB, jobId: number, trigger: ObservationRun["trigger"]): number | null {
  const tx = db.transaction((): number | null => {
    if (hasRunningRun(db, jobId)) return null
    return startRun(db, jobId, trigger)
  })
  return tx.immediate()
}

export function finishRun(
  db: DB,
  runId: number,
  result: {
    status: RunStatus
    searchesRun: number
    providerCalls: number
    cacheHits: number
    observationsAdded: number
    errors: string[]
    durationMs: number
  },
): void {
  db.prepare(`
    UPDATE observation_runs SET
      completed_at = ?, status = ?, searches_run = ?, provider_calls = ?,
      cache_hits = ?, observations_added = ?, errors = ?, duration_ms = ?
    WHERE id = ?
  `).run(
    nowIso(), result.status, result.searchesRun, result.providerCalls,
    result.cacheHits, result.observationsAdded,
    result.errors.length ? JSON.stringify(result.errors.map(e => e.slice(0, 300))) : null,
    result.durationMs, runId,
  )
}

export function listRuns(db: DB, opts: { jobId?: number; limit?: number } = {}): ObservationRun[] {
  const limit = Math.min(opts.limit ?? 50, 500)
  const rows = opts.jobId
    ? db.prepare(`SELECT * FROM observation_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?`).all(opts.jobId, limit)
    : db.prepare(`SELECT * FROM observation_runs ORDER BY id DESC LIMIT ?`).all(limit)
  return rows.map(rowToRun)
}

/** Is a run currently marked running for this job? Guards double execution. */
export function hasRunningRun(db: DB, jobId: number): boolean {
  const r = db.prepare(
    `SELECT COUNT(*) c FROM observation_runs WHERE job_id = ? AND status = 'running'`
  ).get(jobId) as { c: number }
  return r.c > 0
}

/** Crash hygiene: a 'running' row older than maxAgeMinutes is marked failed. */
export function reapStaleRuns(db: DB, maxAgeMinutes = 60): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString()
  return db.prepare(`
    UPDATE observation_runs SET status = 'failed', completed_at = ?,
      errors = json_array('reaped: run exceeded ' || ? || ' minutes (scheduler crash?)')
    WHERE status = 'running' AND started_at < ?
  `).run(nowIso(), maxAgeMinutes, cutoff).changes
}

// ─── Scheduler lease ─────────────────────────────────────────────────────────

export interface Lease {
  holder: string
  acquiredAt: string
  heartbeatAt: string
  stopRequested: boolean
}

export function newHolderId(): string {
  // Identifies a process, never a person or a secret.
  return `${process.pid}@${os.hostname()}:${crypto.randomBytes(4).toString("hex")}`
}

export function readLease(db: DB): Lease | null {
  const r = db.prepare(`SELECT * FROM scheduler_state WHERE id = 1`).get() as any
  if (!r) return null
  return {
    holder: r.holder, acquiredAt: r.acquired_at,
    heartbeatAt: r.heartbeat_at, stopRequested: Boolean(r.stop_requested),
  }
}

/**
 * Acquire the single scheduler lease. Succeeds when no lease exists, when we
 * already hold it, or when the current holder's heartbeat is stale (crashed).
 * All inside one transaction, so two starting schedulers cannot both win.
 */
export function acquireLease(db: DB, holder: string, ttlSeconds: number, at: Date = new Date()): boolean {
  const tx = db.transaction((): boolean => {
    const existing = readLease(db)
    const now = at.toISOString()
    if (!existing) {
      db.prepare(`
        INSERT INTO scheduler_state (id, holder, acquired_at, heartbeat_at, stop_requested)
        VALUES (1, ?, ?, ?, 0)
      `).run(holder, now, now)
      return true
    }
    const stale = at.getTime() - new Date(existing.heartbeatAt).getTime() > ttlSeconds * 1000
    if (existing.holder === holder || stale) {
      db.prepare(`
        UPDATE scheduler_state SET holder = ?, acquired_at = ?, heartbeat_at = ?, stop_requested = 0
        WHERE id = 1
      `).run(holder, now, now)
      return true
    }
    return false
  })
  return tx()
}

/** Refresh the heartbeat. Returns false when the lease was lost. The
 *  heartbeat is refreshed even while a stop is pending — the holder remains
 *  the owner until it actually releases, so a stop-then-restart can never
 *  produce two live schedulers via a "stale" takeover. */
export function heartbeatLease(db: DB, holder: string, at: Date = new Date()): { ok: boolean; stopRequested: boolean } {
  const lease = readLease(db)
  if (!lease || lease.holder !== holder) return { ok: false, stopRequested: false }
  db.prepare(`UPDATE scheduler_state SET heartbeat_at = ? WHERE id = 1 AND holder = ?`)
    .run(at.toISOString(), holder)
  return { ok: true, stopRequested: lease.stopRequested }
}

export function releaseLease(db: DB, holder: string): void {
  db.prepare(`DELETE FROM scheduler_state WHERE id = 1 AND holder = ?`).run(holder)
}

/** observer:stop — ask whichever scheduler holds the lease to exit cleanly. */
export function requestStop(db: DB): boolean {
  return db.prepare(`UPDATE scheduler_state SET stop_requested = 1 WHERE id = 1`).run().changes > 0
}
