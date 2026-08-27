/**
 * §C/§D/§AD - is unattended collection actually healthy?
 *
 * The scheduler was tested in Phase 4 but never watched across days. This
 * answers the questions that only matter once nobody is looking: did it stay
 * up, did runs happen when they were supposed to, is anything failing quietly,
 * and is the cache doing its job.
 *
 * Deliberately NOT enterprise observability - no metrics daemon, no time-series
 * store, no exporter. Every number here is a SQL query over tables the system
 * already writes, computed on demand.
 */

import fs from "fs"
import type { DB } from "../db/index.js"
import { getDb, DEFAULT_DB_PATH } from "../db/index.js"
import { allUsage, providerEventsSince, type ProviderEventSummary } from "../db/repositories.js"
import { listJobs, readLease } from "./store.js"
import { listBackups, backupRetention, backupIntervalHours } from "../db/backup.js"

export interface SchedulerHealth {
  running: boolean
  holder: string | null
  acquiredAt: string | null
  uptimeSeconds: number | null
  lastHeartbeatAt: string | null
  heartbeatAgeSeconds: number | null
  /** Lease exists but the heartbeat stopped - a crashed or hung holder. */
  stale: boolean
  stopRequested: boolean
  ticks: number | null
  /** Resource picture of the scheduler process, written by its own heartbeat. */
  rssBytes: number | null
  cpuSeconds: number | null
}

export interface RunWindow {
  total: number
  success: number
  partial: number
  failed: number
  skippedAuth: number
  observationsAdded: number
  providerCalls: number
  cacheHits: number
  cacheHitRate: number | null
}

export interface ObserverHealth {
  checkedAt: string
  scheduler: SchedulerHealth
  observation: {
    lastSuccessfulAt: string | null
    lastSuccessfulJob: string | null
    nextScheduledAt: string | null
    nextScheduledJob: string | null
    totals: { cash: number; award: number }
    last24h: { cash: number; award: number }
    last7d: { cash: number; award: number }
  }
  runs: { last24h: RunWindow; last7d: RunWindow }
  /** Enabled jobs whose scheduled time passed without a run (§C missed runs). */
  missedRuns: { job: string; dueAt: string; overdueHours: number }[]
  /** Runs that did start, but late (§C delayed runs). */
  delayedRuns: { job: string; scheduledFor: string; startedAt: string; delayMinutes: number }[]
  backoff: { job: string; consecutiveFailures: number; multiplier: number }[]
  providerFailures24h: ProviderEventSummary[]
  authFailures24h: ProviderEventSummary[]
  providerCalls: { provider: string; attempted: number; succeeded: number; failed: number }[]
  cache: { entries: number; hits: number; expired: number }
  resources: {
    dbBytes: number
    dbWalBytes: number
    dbTotalBytes: number
    backupCount: number
    backupNewestAt: string | null
    backupBytes: number
    backupRetention: number
    backupIntervalHours: number
    /** The process answering this request, not the scheduler. */
    processRssBytes: number
    processCpuSeconds: number
    processUptimeSeconds: number
  }
  warnings: string[]
}

function ago(iso: string | null, now: Date): number | null {
  return iso ? Math.round((now.getTime() - Date.parse(iso)) / 1000) : null
}

function fileBytes(file: string): number {
  try { return fs.statSync(file).size } catch { return 0 }
}

function runWindow(db: DB, since: string): RunWindow {
  const r = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) partial,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed,
           SUM(CASE WHEN status = 'skipped_auth' THEN 1 ELSE 0 END) skippedAuth,
           COALESCE(SUM(observations_added), 0) observationsAdded,
           COALESCE(SUM(provider_calls), 0) providerCalls,
           COALESCE(SUM(cache_hits), 0) cacheHits,
           COALESCE(SUM(searches_run), 0) searchesRun
    FROM observation_runs WHERE started_at >= ?
  `).get(since) as any
  // Searches, not calls. cache_hits counts LOOKUPS while provider_calls counts
  // CALLS, and one award search can spend two calls (one per cabin class), so
  // mixing them understated the hit rate. searches_run is the same unit as
  // cache_hits, and every search is either served from cache or fetched.
  const lookups = r.total > 0 ? (r.searchesRun ?? 0) : 0
  return {
    total: r.total ?? 0,
    success: r.success ?? 0,
    partial: r.partial ?? 0,
    failed: r.failed ?? 0,
    skippedAuth: r.skippedAuth ?? 0,
    observationsAdded: r.observationsAdded ?? 0,
    providerCalls: r.providerCalls ?? 0,
    cacheHits: r.cacheHits ?? 0,
    // Null rather than 0 when nothing ran: "no data" and "0% hit rate" are
    // different states and a health page must not confuse them.
    cacheHitRate: lookups > 0 ? Math.round((r.cacheHits / lookups) * 1000) / 10 : null,
  }
}

function observationsSince(db: DB, since: string): { cash: number; award: number } {
  return {
    cash: (db.prepare(`SELECT COUNT(*) c FROM flight_prices WHERE fetched_at >= ?`).get(since) as any).c,
    award: (db.prepare(`SELECT COUNT(*) c FROM award_prices WHERE fetched_at >= ?`).get(since) as any).c,
  }
}

export function observerHealth(db: DB = getDb(), now: Date = new Date()): ObserverHealth {
  const leaseTtl = Number(process.env.OBSERVER_LEASE_TTL_SECONDS) || 90
  const day = new Date(now.getTime() - 24 * 3600_000).toISOString()
  const week = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString()

  const lease = readLease(db)
  const leaseRow = lease
    ? db.prepare(`SELECT rss_bytes, cpu_seconds, ticks FROM scheduler_state WHERE id = 1`).get() as any
    : null
  const heartbeatAge = ago(lease?.heartbeatAt ?? null, now)

  const scheduler: SchedulerHealth = {
    running: Boolean(lease),
    holder: lease?.holder ?? null,
    acquiredAt: lease?.acquiredAt ?? null,
    uptimeSeconds: ago(lease?.acquiredAt ?? null, now),
    lastHeartbeatAt: lease?.heartbeatAt ?? null,
    heartbeatAgeSeconds: heartbeatAge,
    // A lease whose heartbeat stopped is worse than no scheduler at all: the
    // page would otherwise show a comforting "RUNNING" for a dead process.
    stale: Boolean(lease) && heartbeatAge !== null && heartbeatAge > leaseTtl,
    stopRequested: lease?.stopRequested ?? false,
    ticks: leaseRow?.ticks ?? null,
    rssBytes: leaseRow?.rss_bytes ?? null,
    cpuSeconds: leaseRow?.cpu_seconds ?? null,
  }

  const jobs = listJobs(db)
  const enabled = jobs.filter(j => j.enabled)

  const lastSuccessful = db.prepare(`
    SELECT r.started_at startedAt, j.name job
    FROM observation_runs r JOIN observation_jobs j ON j.id = r.job_id
    WHERE r.observations_added > 0
    ORDER BY r.started_at DESC LIMIT 1
  `).get() as { startedAt: string; job: string } | undefined

  const upcoming = enabled
    .filter(j => j.nextRunAt)
    .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))[0]

  // A run is "missed" when its scheduled time passed by more than a grace
  // period. The grace scales with the cadence: 30 minutes late matters on an
  // hourly job and means nothing on an 84-hour one.
  const missedRuns = enabled
    .filter(j => j.nextRunAt && Date.parse(j.nextRunAt) < now.getTime())
    .map(j => {
      const overdueHours = (now.getTime() - Date.parse(j.nextRunAt!)) / 3600_000
      return { job: j.name, dueAt: j.nextRunAt!, overdueHours: Math.round(overdueHours * 10) / 10, grace: Math.max(0.5, j.frequencyHours * 0.1) }
    })
    .filter(m => m.overdueHours > m.grace)
    .map(({ job, dueAt, overdueHours }) => ({ job, dueAt, overdueHours }))

  // The threshold is applied in SQL, before the limit. Filtering after a
  // LIMIT 50 would hide older late runs behind recent punctual ones — exactly
  // backwards, since the late ones are the ones worth seeing.
  const delayedRuns = (db.prepare(`
    SELECT j.name job, r.scheduled_for scheduledFor, r.started_at startedAt,
           CAST((julianday(r.started_at) - julianday(r.scheduled_for)) * 1440 AS INTEGER) delayMinutes
    FROM observation_runs r JOIN observation_jobs j ON j.id = r.job_id
    WHERE r.scheduled_for IS NOT NULL AND r.started_at >= ?
      AND (julianday(r.started_at) - julianday(r.scheduled_for)) * 1440 > 15
    ORDER BY r.started_at DESC LIMIT 50
  `).all(week) as { job: string; scheduledFor: string; startedAt: string; delayMinutes: number }[])

  const backoff = jobs
    .filter(j => j.consecutiveFailures >= 3)
    .map(j => ({
      job: j.name,
      consecutiveFailures: j.consecutiveFailures,
      multiplier: Math.min(2 ** (j.consecutiveFailures - 2), 8),
    }))

  const events = providerEventsSince(db, day)
  const cache = db.prepare(`
    SELECT COUNT(*) entries, COALESCE(SUM(hit_count), 0) hits,
           SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END) expired
    FROM search_cache
  `).get(now.toISOString()) as any

  const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH
  const backups = listBackups()
  const cpu = process.cpuUsage()

  const warnings: string[] = []
  if (scheduler.stale) warnings.push(`scheduler lease is held by ${scheduler.holder} but its heartbeat is ${scheduler.heartbeatAgeSeconds}s old — the process is gone or hung`)
  if (!scheduler.running) warnings.push("scheduler is not running — no observations will be collected until it is started")
  if (missedRuns.length) warnings.push(`${missedRuns.length} job(s) overdue`)
  const authEvents = events.filter(e => e.kind === "auth")
  if (authEvents.length) warnings.push(`authentication failures in the last 24h: ${authEvents.map(e => e.provider).join(", ")}`)
  if (backups.length === 0) warnings.push("no database backup has been taken yet")

  return {
    checkedAt: now.toISOString(),
    scheduler,
    observation: {
      lastSuccessfulAt: lastSuccessful?.startedAt ?? null,
      lastSuccessfulJob: lastSuccessful?.job ?? null,
      nextScheduledAt: upcoming?.nextRunAt ?? null,
      nextScheduledJob: upcoming?.name ?? null,
      totals: {
        cash: (db.prepare(`SELECT COUNT(*) c FROM flight_prices`).get() as any).c,
        award: (db.prepare(`SELECT COUNT(*) c FROM award_prices`).get() as any).c,
      },
      last24h: observationsSince(db, day),
      last7d: observationsSince(db, week),
    },
    runs: { last24h: runWindow(db, day), last7d: runWindow(db, week) },
    missedRuns,
    delayedRuns,
    backoff,
    providerFailures24h: events.filter(e => e.kind !== "auth"),
    authFailures24h: authEvents,
    providerCalls: allUsage(db).map(u => ({
      provider: u.provider, attempted: u.attempted, succeeded: u.succeeded, failed: u.failed,
    })),
    cache: { entries: cache.entries ?? 0, hits: cache.hits ?? 0, expired: cache.expired ?? 0 },
    resources: {
      dbBytes: fileBytes(dbPath),
      dbWalBytes: fileBytes(`${dbPath}-wal`),
      dbTotalBytes: fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`),
      backupCount: backups.length,
      backupNewestAt: backups[0]?.createdAt ?? null,
      backupBytes: backups.reduce((sum, b) => sum + b.bytes, 0),
      backupRetention: backupRetention(),
      backupIntervalHours: backupIntervalHours(),
      processRssBytes: process.memoryUsage().rss,
      processCpuSeconds: Math.round(((cpu.user + cpu.system) / 1e6) * 100) / 100,
      processUptimeSeconds: Math.round(process.uptime()),
    },
    warnings,
  }
}
