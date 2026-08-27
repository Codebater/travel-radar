/**
 * Discovery jobs and runs.
 *
 * Deliberately parallel to observer/store.ts rather than shared with it: the
 * two job types answer different questions, fail differently and are budgeted
 * differently, and a single table serving both would grow a `kind` column and
 * a dozen nullable fields that only make sense for one of them.
 */

import type { DB } from "../db/index.js"
import { nowIso } from "../db/index.js"
import type { CabinClass } from "../providers/cash-flights/types.js"
import type { OriginGroup } from "./config.js"
import type { DiscoveryJob, DiscoveryRun, DiscoveryRunStatus, RunBudget } from "./types.js"

function rowToJob(r: any): DiscoveryJob {
  return {
    id: r.id,
    name: r.name,
    originGroup: r.origin_group as OriginGroup,
    destinationGroup: r.destination_group,
    horizonDays: r.horizon_days,
    tripLengths: JSON.parse(r.trip_lengths),
    cabins: JSON.parse(r.cabins) as CabinClass[],
    frequencyHours: r.frequency_hours,
    jitterMinutes: r.jitter_minutes,
    priority: r.priority,
    budget: JSON.parse(r.budget) as RunBudget,
    // Job-level narrowing rides inside the budget blob: it is scope control,
    // it is optional, and two nullable integers do not justify a migration.
    maxDestinations: (JSON.parse(r.budget) as any).maxDestinations ?? null,
    datesPerRoute: (JSON.parse(r.budget) as any).datesPerRoute ?? null,
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    consecutiveFailures: r.consecutive_failures,
    runsCompleted: r.runs_completed,
  }
}

export interface NewDiscoveryJob {
  name: string
  originGroup: OriginGroup
  destinationGroup: string
  horizonDays: number
  tripLengths: number[]
  cabins: CabinClass[]
  frequencyHours: number
  jitterMinutes?: number
  priority: number
  budget: RunBudget & { maxDestinations?: number | null; datesPerRoute?: number | null }
  enabled?: boolean
}

/**
 * Insert or update by name. Like the observer's upsert, this never resets run
 * bookkeeping and never silently re-enables a job the operator turned off —
 * reseeding config must not quietly restart spending.
 */
export function upsertDiscoveryJob(db: DB, job: NewDiscoveryJob): DiscoveryJob {
  const now = nowIso()
  const tx = db.transaction(() => {
    const existing = getDiscoveryJobByName(db, job.name)
    if (!existing) {
      db.prepare(`
        INSERT INTO discovery_jobs
          (name, origin_group, destination_group, horizon_days, trip_lengths, cabins,
           frequency_hours, jitter_minutes, priority, budget, enabled,
           created_at, updated_at, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.name, job.originGroup, job.destinationGroup, job.horizonDays,
        JSON.stringify(job.tripLengths), JSON.stringify(job.cabins),
        job.frequencyHours, job.jitterMinutes ?? 30, job.priority,
        JSON.stringify(job.budget), job.enabled === false ? 0 : 1, now, now, now,
      )
    } else {
      const enabled = job.enabled === undefined ? (existing.enabled ? 1 : 0) : (job.enabled ? 1 : 0)
      db.prepare(`
        UPDATE discovery_jobs SET
          origin_group = ?, destination_group = ?, horizon_days = ?, trip_lengths = ?,
          cabins = ?, frequency_hours = ?, jitter_minutes = ?, priority = ?,
          budget = ?, enabled = ?, updated_at = ?
        WHERE name = ?
      `).run(
        job.originGroup, job.destinationGroup, job.horizonDays,
        JSON.stringify(job.tripLengths), JSON.stringify(job.cabins),
        job.frequencyHours, job.jitterMinutes ?? existing.jitterMinutes, job.priority,
        JSON.stringify(job.budget), enabled, now, job.name,
      )
    }
  })
  tx()
  return getDiscoveryJobByName(db, job.name)!
}

export function getDiscoveryJob(db: DB, id: number): DiscoveryJob | null {
  const r = db.prepare(`SELECT * FROM discovery_jobs WHERE id = ?`).get(id)
  return r ? rowToJob(r) : null
}

export function getDiscoveryJobByName(db: DB, name: string): DiscoveryJob | null {
  const r = db.prepare(`SELECT * FROM discovery_jobs WHERE name = ?`).get(name)
  return r ? rowToJob(r) : null
}

export function listDiscoveryJobs(db: DB, opts: { enabledOnly?: boolean } = {}): DiscoveryJob[] {
  const rows = opts.enabledOnly
    ? db.prepare(`SELECT * FROM discovery_jobs WHERE enabled = 1 ORDER BY priority, name`).all()
    : db.prepare(`SELECT * FROM discovery_jobs ORDER BY priority, name`).all()
  return rows.map(rowToJob)
}

export function dueDiscoveryJobs(db: DB, at: Date = new Date()): DiscoveryJob[] {
  return db.prepare(`
    SELECT * FROM discovery_jobs
    WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
    ORDER BY priority, next_run_at
  `).all(at.toISOString()).map(rowToJob)
}

export function setDiscoveryJobEnabled(db: DB, name: string, enabled: boolean): boolean {
  return db.prepare(`UPDATE discovery_jobs SET enabled = ?, updated_at = ? WHERE name = ?`)
    .run(enabled ? 1 : 0, nowIso(), name).changes > 0
}

/** Same backoff shape as the observer: 3+ consecutive failures stretch the cadence. */
export function completeDiscoveryRun(
  db: DB,
  jobId: number,
  outcome: { failed: boolean; countsAsRun: boolean },
  at: Date = new Date(),
): void {
  const job = getDiscoveryJob(db, jobId)
  if (!job) return

  const failures = outcome.failed ? job.consecutiveFailures + 1 : 0
  const multiplier = failures >= 3 ? Math.min(2 ** (failures - 2), 8) : 1
  const jitterMs = Math.floor(Math.random() * job.jitterMinutes * 60_000)
  const nextRunAt = new Date(
    at.getTime() + job.frequencyHours * 3600_000 * multiplier + jitterMs,
  ).toISOString()

  db.prepare(`
    UPDATE discovery_jobs SET
      last_run_at = ?, next_run_at = ?, consecutive_failures = ?,
      runs_completed = runs_completed + ?, updated_at = ?
    WHERE id = ?
  `).run(at.toISOString(), nextRunAt, failures, outcome.countsAsRun ? 1 : 0, nowIso(), jobId)
}

// ─── Runs ────────────────────────────────────────────────────────────────────

function rowToRun(r: any): DiscoveryRun {
  let errors: string[] = []
  try { errors = r.errors ? JSON.parse(r.errors) : [] } catch { errors = [String(r.errors)] }
  return {
    id: r.id, jobId: r.job_id, startedAt: r.started_at, completedAt: r.completed_at,
    scheduledFor: r.scheduled_for, status: r.status, trigger: r.trigger,
    routesSampled: r.routes_sampled, datePairsSampled: r.date_pairs_sampled,
    stage1Searches: r.stage1_searches, stage2Searches: r.stage2_searches,
    awardSearches: r.award_searches, cacheHits: r.cache_hits,
    freeCalls: r.free_calls, awardCalls: r.award_calls, meteredCalls: r.metered_calls,
    verificationCalls: r.verification_calls,
    observationsAdded: r.observations_added, candidatesProduced: r.candidates_produced,
    scopeReduced: r.scope_reduced, errors, durationMs: r.duration_ms,
  }
}

export function startDiscoveryRun(
  db: DB, jobId: number, trigger: DiscoveryRun["trigger"], scheduledFor?: string | null,
): number {
  const info = db.prepare(`
    INSERT INTO discovery_runs (job_id, started_at, status, trigger, scheduled_for)
    VALUES (?, ?, 'running', ?, ?)
  `).run(jobId, nowIso(), trigger, scheduledFor ?? null)
  return Number(info.lastInsertRowid)
}

/** Refuse a second concurrent run for one job, check and insert in one go. */
export function tryStartDiscoveryRun(
  db: DB, jobId: number, trigger: DiscoveryRun["trigger"], scheduledFor?: string | null,
): number | null {
  const tx = db.transaction((): number | null => {
    const running = db.prepare(
      `SELECT COUNT(*) c FROM discovery_runs WHERE job_id = ? AND status = 'running'`,
    ).get(jobId) as { c: number }
    if (running.c > 0) return null
    return startDiscoveryRun(db, jobId, trigger, scheduledFor)
  })
  return tx.immediate()
}

export interface DiscoveryRunResult {
  status: DiscoveryRunStatus
  routesSampled: number
  datePairsSampled: number
  stage1Searches: number
  stage2Searches: number
  awardSearches: number
  cacheHits: number
  freeCalls: number
  awardCalls: number
  meteredCalls: number
  verificationCalls: number
  observationsAdded: number
  candidatesProduced: number
  scopeReduced: string | null
  errors: string[]
  durationMs: number
}

export function finishDiscoveryRun(db: DB, runId: number, result: DiscoveryRunResult): void {
  db.prepare(`
    UPDATE discovery_runs SET
      completed_at = ?, status = ?, routes_sampled = ?, date_pairs_sampled = ?,
      stage1_searches = ?, stage2_searches = ?, award_searches = ?,
      cache_hits = ?, free_calls = ?, award_calls = ?, metered_calls = ?,
      verification_calls = ?, observations_added = ?, candidates_produced = ?,
      scope_reduced = ?, errors = ?, duration_ms = ?
    WHERE id = ?
  `).run(
    nowIso(), result.status, result.routesSampled, result.datePairsSampled,
    result.stage1Searches, result.stage2Searches, result.awardSearches,
    result.cacheHits, result.freeCalls, result.awardCalls, result.meteredCalls,
    result.verificationCalls, result.observationsAdded, result.candidatesProduced,
    result.scopeReduced,
    result.errors.length ? JSON.stringify(result.errors.map(e => e.slice(0, 300))) : null,
    result.durationMs, runId,
  )
}

export function listDiscoveryRuns(
  db: DB, opts: { jobId?: number; limit?: number } = {},
): DiscoveryRun[] {
  const limit = Math.min(opts.limit ?? 50, 500)
  const rows = opts.jobId
    ? db.prepare(`SELECT * FROM discovery_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?`).all(opts.jobId, limit)
    : db.prepare(`SELECT * FROM discovery_runs ORDER BY id DESC LIMIT ?`).all(limit)
  return rows.map(rowToRun)
}

/** Crash hygiene, mirroring the observer's reaper. */
export function reapStaleDiscoveryRuns(db: DB, maxAgeMinutes = 90): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString()
  return db.prepare(`
    UPDATE discovery_runs SET status = 'failed', completed_at = ?,
      errors = json_array('reaped: run exceeded ' || ? || ' minutes (crash?)')
    WHERE status = 'running' AND started_at < ?
  `).run(nowIso(), maxAgeMinutes, cutoff).changes
}
