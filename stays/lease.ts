/**
 * Stay scheduler lease — single-row `stay_scheduler_state`, fully independent
 * from the flight scheduler's `scheduler_state`. Two radars, two leases: the
 * flight scheduler on the NAS and a local stay scheduler must never contend
 * for (or accidentally share) one lock row.
 *
 * Semantics carried over from the flight lease because they are load-bearing:
 * acquisition succeeds when the row is free, already ours, or STALE (heartbeat
 * older than the TTL — a crashed holder must not wedge the radar forever);
 * heartbeating continues even while a stop is pending, so stop-then-restart
 * can never produce two schedulers via a stale takeover.
 */

import os from "os"
import crypto from "crypto"
import { nowIso, type DB } from "../db/index.js"

/** Identifies a process, never a person or a secret. */
export function newStayHolderId(): string {
  return `${process.pid}@${os.hostname()}:${crypto.randomBytes(2).toString("hex")}`
}

export function acquireStayLease(db: DB, holder: string, ttlSeconds: number, at = new Date()): boolean {
  const tx = db.transaction((): boolean => {
    const row = db.prepare("SELECT holder, heartbeat_at FROM stay_scheduler_state WHERE id = 1").get() as
      { holder: string | null; heartbeat_at: string | null } | undefined

    if (row?.holder && row.holder !== holder) {
      const beat = row.heartbeat_at ? Date.parse(row.heartbeat_at) : 0
      const stale = at.getTime() - beat > ttlSeconds * 1000
      if (!stale) return false
    }

    db.prepare(`
      INSERT INTO stay_scheduler_state (id, holder, acquired_at, heartbeat_at, stop_requested)
      VALUES (1, @holder, @now, @now, 0)
      ON CONFLICT(id) DO UPDATE SET
        holder = @holder, acquired_at = @now, heartbeat_at = @now, stop_requested = 0
    `).run({ holder, now: at.toISOString() })
    return true
  })
  return tx()
}

export interface StayHeartbeat {
  ok: boolean
  stopRequested: boolean
}

export function heartbeatStayLease(db: DB, holder: string, at = new Date()): StayHeartbeat {
  const row = db.prepare("SELECT holder, stop_requested FROM stay_scheduler_state WHERE id = 1").get() as
    { holder: string | null; stop_requested: number } | undefined
  if (!row || row.holder !== holder) return { ok: false, stopRequested: false }
  db.prepare("UPDATE stay_scheduler_state SET heartbeat_at = ? WHERE id = 1 AND holder = ?")
    .run(at.toISOString(), holder)
  return { ok: true, stopRequested: row.stop_requested === 1 }
}

export function releaseStayLease(db: DB, holder: string): void {
  db.prepare("DELETE FROM stay_scheduler_state WHERE id = 1 AND holder = ?").run(holder)
}

export function requestStayStop(db: DB): boolean {
  const info = db.prepare("UPDATE stay_scheduler_state SET stop_requested = 1 WHERE id = 1").run()
  return info.changes > 0
}

export interface StayLeaseInfo {
  holder: string | null
  acquiredAt: string | null
  heartbeatAt: string | null
  heartbeatAgeSeconds: number | null
  stopRequested: boolean
}

export function readStayLease(db: DB, at = new Date()): StayLeaseInfo {
  const row = db.prepare("SELECT * FROM stay_scheduler_state WHERE id = 1").get() as
    Record<string, unknown> | undefined
  if (!row) return { holder: null, acquiredAt: null, heartbeatAt: null, heartbeatAgeSeconds: null, stopRequested: false }
  const beat = row.heartbeat_at ? Date.parse(row.heartbeat_at as string) : null
  return {
    holder: (row.holder as string) ?? null,
    acquiredAt: (row.acquired_at as string) ?? null,
    heartbeatAt: (row.heartbeat_at as string) ?? null,
    heartbeatAgeSeconds: beat ? Math.round((at.getTime() - beat) / 1000) : null,
    stopRequested: row.stop_requested === 1,
  }
}

// ─── Run rows ────────────────────────────────────────────────────────────────

/**
 * Start a run only if no run is currently 'running' — the double-run guard,
 * one immediate transaction. Returns the run id or null when refused.
 */
export function tryStartStayRun(db: DB, runIndex: number, trigger: "cli" | "schedule"): number | null {
  const tx = db.transaction((): number | null => {
    const running = db.prepare("SELECT id FROM stay_observation_runs WHERE status = 'running' LIMIT 1").get()
    if (running) return null
    const info = db.prepare(`
      INSERT INTO stay_observation_runs (run_index, started_at, status, trigger)
      VALUES (?, ?, 'running', ?)
    `).run(runIndex, nowIso(), trigger)
    return Number(info.lastInsertRowid)
  })
  return tx.immediate()
}

/** Crash hygiene: a 'running' row older than maxAgeMinutes is dead — close it. */
export function reapStaleStayRuns(db: DB, maxAgeMinutes: number, at = new Date()): number {
  const cutoff = new Date(at.getTime() - maxAgeMinutes * 60_000).toISOString()
  const info = db.prepare(`
    UPDATE stay_observation_runs
    SET status = 'failed', completed_at = ?,
        errors = json_insert(COALESCE(errors, '[]'), '$[#]', 'reaped: stale running row')
    WHERE status = 'running' AND started_at < ?
  `).run(nowIso(), cutoff)
  return info.changes
}

export interface StayRunCounters {
  propertiesPlanned: number
  ratesCalls: number
  calendarCalls: number
  confirmationCalls: number
  transportFailures: number
  semanticErrors: number
  emptyResults: number
  observationsAdded: number
  calendarDaysAdded: number
  triggersFired: number
  confirmationsRecorded: number
  scopeReduced: string[]
  errors: string[]
}

export function newStayRunCounters(): StayRunCounters {
  return {
    propertiesPlanned: 0, ratesCalls: 0, calendarCalls: 0, confirmationCalls: 0,
    transportFailures: 0, semanticErrors: 0, emptyResults: 0,
    observationsAdded: 0, calendarDaysAdded: 0, triggersFired: 0, confirmationsRecorded: 0,
    scopeReduced: [], errors: [],
  }
}

export function completeStayRun(
  db: DB, runId: number, status: "success" | "partial" | "failed",
  counters: StayRunCounters, durationMs: number,
): void {
  db.prepare(`
    UPDATE stay_observation_runs SET
      status = @status, completed_at = @now,
      properties_planned = @propertiesPlanned,
      rates_calls = @ratesCalls, calendar_calls = @calendarCalls,
      confirmation_calls = @confirmationCalls,
      transport_failures = @transportFailures, semantic_errors = @semanticErrors,
      empty_results = @emptyResults,
      observations_added = @observationsAdded, calendar_days_added = @calendarDaysAdded,
      triggers_fired = @triggersFired, confirmations_recorded = @confirmationsRecorded,
      scope_reduced = @scopeReduced, errors = @errors, duration_ms = @durationMs
    WHERE id = @runId
  `).run({
    runId, status, now: nowIso(), durationMs,
    propertiesPlanned: counters.propertiesPlanned,
    ratesCalls: counters.ratesCalls, calendarCalls: counters.calendarCalls,
    confirmationCalls: counters.confirmationCalls,
    transportFailures: counters.transportFailures, semanticErrors: counters.semanticErrors,
    emptyResults: counters.emptyResults,
    observationsAdded: counters.observationsAdded, calendarDaysAdded: counters.calendarDaysAdded,
    triggersFired: counters.triggersFired, confirmationsRecorded: counters.confirmationsRecorded,
    scopeReduced: JSON.stringify(counters.scopeReduced),
    errors: JSON.stringify(counters.errors),
  })
}
