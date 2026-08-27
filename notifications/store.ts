/**
 * Persistence for the notification layer.
 *
 * One rule runs through every function here: **every text column that could
 * carry an upstream string goes through `redactSecrets` on the way in.** Not on
 * the way out, and not at the call site. A `fetch` failure names the host and
 * often the topic, `last_error` is rendered on a web page, and there are five
 * different places that write it - so the scrubbing lives at the single choke
 * point rather than in five things somebody has to remember.
 *
 * The second rule is that no `await` ever appears inside a `db.transaction()`.
 * better-sqlite3 transactions are synchronous; an awaited fetch inside one
 * either throws or holds the write lock open across a network round trip.
 */

import type { DB } from "../db/index.js"
import { nowIso } from "../db/index.js"
import { redactSecrets } from "./redact.js"
import type { EvidenceSnapshot, Verdict } from "./eligibility.js"

export type QueueStatus =
  | "QUEUED" | "CLAIMED" | "SENDING" | "SENT"
  | "FAILED" | "CANCELLED" | "SUPPRESSED" | "UNKNOWN"

export interface QueueRow {
  id: number
  fingerprint: string
  opportunityKey: string
  cooldownKey: string
  candidateId: number | null
  kind: "immediate" | "digest" | "bypass"
  status: QueueStatus
  priority: number
  scheduledFor: string
  digestSlot: string | null
  attempts: number
  lastError: string | null
  claimedBy: string | null
  claimedAt: string | null
  sendStartedAt: string | null
  eligibility: Verdict | null
  evidence: EvidenceSnapshot | null
  createdAt: string
  updatedAt: string
}

function parse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function rowToQueue(r: any): QueueRow {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    opportunityKey: r.opportunity_key,
    cooldownKey: r.cooldown_key,
    candidateId: r.candidate_id,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    scheduledFor: r.scheduled_for,
    digestSlot: r.digest_slot,
    attempts: r.attempts,
    lastError: r.last_error,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    sendStartedAt: r.send_started_at,
    eligibility: parse(r.eligibility_json, null),
    evidence: parse(r.evidence_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ─── Events: the decision trail, including every silence ────────────────────

export interface EventInput {
  kind: "decision" | "transition" | "delivery" | "verify" | "pass_error" | "send_outcome_unknown" | "test"
  opportunityKey?: string | null
  fingerprint?: string | null
  candidateId?: number | null
  clusterId?: number | null
  queueId?: number | null
  notificationId?: number | null
  fromStatus?: string | null
  toStatus?: string | null
  score?: number | null
  gatesEvaluated?: string[] | null
  firstBlocker?: string | null
  allBlockers?: string[] | null
  detail?: string | null
}

/**
 * Record one event.
 *
 * A `decision` for an unchanged opportunity UPSERTS - bumping `occurrences` and
 * `last_seen_at` - rather than appending. With 4,928 candidates and a 60-second
 * tick, appending would make this the largest table in the database inside a
 * week, and not one of those rows would say anything the previous one did not.
 */
export function recordEvent(db: DB, input: EventInput, at: string = nowIso()): number {
  const detail = input.detail ? redactSecrets(input.detail) : null
  const blocker = input.firstBlocker ?? "ELIGIBLE"
  if (input.kind === "decision" && input.opportunityKey) {
    db.prepare(`
      INSERT INTO notification_events (
        opportunity_key, fingerprint, candidate_id, cluster_id, queue_id, notification_id,
        kind, from_status, to_status, score, gates_evaluated, first_blocker, all_blockers,
        detail, occurrences, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'decision', NULL, NULL, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(opportunity_key, first_blocker) WHERE kind = 'decision' DO UPDATE SET
        occurrences = occurrences + 1,
        last_seen_at = excluded.last_seen_at,
        fingerprint = excluded.fingerprint,
        candidate_id = excluded.candidate_id,
        score = excluded.score,
        gates_evaluated = excluded.gates_evaluated,
        all_blockers = excluded.all_blockers,
        detail = excluded.detail
    `).run(
      input.opportunityKey, input.fingerprint ?? null, input.candidateId ?? null,
      input.clusterId ?? null, input.queueId ?? null, input.notificationId ?? null,
      input.score ?? null,
      input.gatesEvaluated ? JSON.stringify(input.gatesEvaluated) : null,
      // Never NULL: SQLite treats NULLs as DISTINCT in a unique index, so a
      // NULL blocker would append a fresh row on every tick for exactly the
      // decisions that never change - the eligible ones.
      blocker,
      input.allBlockers ? JSON.stringify(input.allBlockers) : null,
      detail, at, at,
    )
    const row = db.prepare(
      `SELECT id FROM notification_events WHERE kind='decision' AND opportunity_key = ?
        AND first_blocker = ?`,
    ).get(input.opportunityKey, blocker) as { id: number } | undefined
    return row?.id ?? 0
  }

  const info = db.prepare(`
    INSERT INTO notification_events (
      opportunity_key, fingerprint, candidate_id, cluster_id, queue_id, notification_id,
      kind, from_status, to_status, score, gates_evaluated, first_blocker, all_blockers,
      detail, occurrences, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    input.opportunityKey ?? null, input.fingerprint ?? null, input.candidateId ?? null,
    input.clusterId ?? null, input.queueId ?? null, input.notificationId ?? null,
    input.kind, input.fromStatus ?? null, input.toStatus ?? null, input.score ?? null,
    input.gatesEvaluated ? JSON.stringify(input.gatesEvaluated) : null,
    input.firstBlocker ?? null,
    input.allBlockers ? JSON.stringify(input.allBlockers) : null,
    detail, at, at,
  )
  return Number(info.lastInsertRowid)
}

// ─── Queue ───────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  verdict: Verdict
  kind: "immediate" | "digest" | "bypass"
  scheduledFor: string
  digestSlot: string | null
  priority: number
}

/**
 * Put one opportunity in the queue.
 *
 * Returns null when the partial unique index refuses it - which is not an
 * error, it is the index doing exactly its job: the same economics are already
 * in flight, and queueing them twice is how one deal becomes two buzzes.
 */
export function enqueue(db: DB, input: EnqueueInput, at: string = nowIso()): number | null {
  try {
    const info = db.prepare(`
      INSERT INTO notification_queue (
        fingerprint, opportunity_key, cooldown_key, candidate_id, kind, status, priority,
        scheduled_for, digest_slot, attempts, eligibility_json, evidence_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      input.verdict.fingerprint, input.verdict.opportunityKey, input.verdict.cooldownKey,
      input.verdict.candidateId, input.kind, input.priority,
      input.scheduledFor, input.digestSlot,
      JSON.stringify(input.verdict), JSON.stringify(input.verdict.economics),
      at, at,
    )
    return Number(info.lastInsertRowid)
  } catch (err) {
    if (String((err as Error).message).includes("UNIQUE")) return null
    throw err
  }
}

export function dueQueueRows(db: DB, now: Date, limit = 20): QueueRow[] {
  return (db.prepare(`
    SELECT * FROM notification_queue
    WHERE status = 'QUEUED' AND scheduled_for <= ?
    ORDER BY priority ASC, scheduled_for ASC, id ASC LIMIT ?
  `).all(now.toISOString(), limit) as any[]).map(rowToQueue)
}

export function getQueueRow(db: DB, id: number): QueueRow | null {
  const row = db.prepare(`SELECT * FROM notification_queue WHERE id = ?`).get(id)
  return row ? rowToQueue(row) : null
}

/**
 * Take exclusive ownership of a queued row.
 *
 * `changes` is the mutex. The UPDATE only matches while the row is still
 * QUEUED, so two schedulers - or two passes in one process - cannot both claim
 * it, without any lock of our own.
 */
export function claim(db: DB, id: number, holder: string, at: string = nowIso()): boolean {
  const info = db.prepare(`
    UPDATE notification_queue
    SET status = 'CLAIMED', claimed_by = ?, claimed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'QUEUED'
  `).run(holder, at, at, id)
  return info.changes === 1
}

/**
 * Mark a row as being sent RIGHT NOW, and count the attempt.
 *
 * Committed BEFORE the network call, never after. Incrementing afterwards means
 * a crash mid-send replays forever against a two-per-day cap; incrementing
 * before means a crash costs at most one attempt, which is the correct
 * direction to be wrong in.
 */
export function markSending(db: DB, id: number, at: string = nowIso()): boolean {
  const info = db.prepare(`
    UPDATE notification_queue
    SET status = 'SENDING', attempts = attempts + 1, send_started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'CLAIMED'
  `).run(at, at, id)
  return info.changes === 1
}

export function markTerminal(
  db: DB, id: number, status: Extract<QueueStatus, "SENT" | "FAILED" | "CANCELLED" | "SUPPRESSED" | "UNKNOWN">,
  detail: string | null = null, at: string = nowIso(),
): void {
  db.prepare(`
    UPDATE notification_queue SET status = ?, last_error = ?, updated_at = ? WHERE id = ?
  `).run(status, detail ? redactSecrets(detail) : null, at, id)
}

/** Push a failed attempt back to QUEUED with the next rung of the ladder. */
export function retryLater(
  db: DB, id: number, delayMinutes: number, error: string, now: Date,
): void {
  const at = nowIso()
  db.prepare(`
    UPDATE notification_queue
    SET status = 'QUEUED', scheduled_for = ?, last_error = ?, claimed_by = NULL,
        claimed_at = NULL, send_started_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(
    new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
    redactSecrets(error), at, id,
  )
}

/**
 * Crash hygiene. Two different situations, deliberately treated differently:
 *
 *   a stale CLAIMED row was never sent - nothing left the process - so it goes
 *   back to QUEUED and is picked up again;
 *
 *   a stale SENDING row MIGHT have been delivered. ntfy has no idempotency key,
 *   so "the POST completed and we died" and "we died before the POST" are
 *   indistinguishable from here. It becomes UNKNOWN and is never re-sent.
 *
 * At-most-once is the default because this radar has sent zero alerts in its
 * life: the credibility of the first one is the whole asset, and a missed deal
 * is still sitting on /deals.html with an honest status next to it. A duplicate
 * teaches the operator to distrust the channel.
 */
export function reapStale(
  db: DB, staleMinutes: number, now: Date = new Date(),
): { requeued: number; unknown: number } {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString()
  const at = nowIso()

  const stuckSending = db.prepare(
    `SELECT id, fingerprint, opportunity_key, candidate_id FROM notification_queue
     WHERE status = 'SENDING' AND send_started_at < ?`,
  ).all(cutoff) as any[]
  for (const row of stuckSending) {
    db.prepare(
      `UPDATE notification_queue SET status='UNKNOWN', updated_at=?,
       last_error='the sender stopped mid-send; delivery could not be confirmed either way'
       WHERE id = ?`,
    ).run(at, row.id)
    recordEvent(db, {
      kind: "send_outcome_unknown",
      queueId: row.id, fingerprint: row.fingerprint,
      opportunityKey: row.opportunity_key, candidateId: row.candidate_id,
      fromStatus: "SENDING", toStatus: "UNKNOWN",
      detail: "the process stopped between marking this as sending and confirming delivery - " +
        "it is not re-sent, because a duplicate costs more than a miss",
    }, at)
  }

  const requeued = db.prepare(
    `UPDATE notification_queue SET status='QUEUED', claimed_by=NULL, claimed_at=NULL, updated_at=?
     WHERE status='CLAIMED' AND claimed_at < ?`,
  ).run(at, cutoff).changes

  return { requeued, unknown: stuckSending.length }
}

// ─── Notifications: what was delivered ──────────────────────────────────────

export interface RecordNotificationInput {
  verdict: Verdict
  kind: "immediate" | "digest" | "bypass" | "test"
  channel: string
  candidateId: number | null
  clusterIdAtSend: number | null
  localDay: string
  digestSlot: string | null
  priority: number
  deliveryReference: string | null
  queueId: number | null
  route: string
}

export function recordNotification(
  db: DB, input: RecordNotificationInput, at: string = nowIso(),
): number {
  const e = input.verdict.economics
  const info = db.prepare(`
    INSERT INTO notifications (
      fingerprint, opportunity_key, cooldown_key, kind, channel, candidate_id,
      cluster_id_at_send, type, route, cabin, loyalty_program, currency,
      price_amount, points, taxes_amount, effective_cost,
      open_jaw_total, open_jaw_net_saving, open_jaw_comparator,
      score, verification_status, baseline_confidence, sample_size,
      local_day, digest_slot, priority, delivery_reference, payload_version, queue_id, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    input.verdict.fingerprint, input.verdict.opportunityKey, input.verdict.cooldownKey,
    input.kind, input.channel, input.candidateId, input.clusterIdAtSend,
    e.type, input.route, e.cabin, e.loyaltyProgram, e.currency,
    e.priceAmount, e.points, e.taxesAmount, e.effectiveCost,
    e.openJawTotal, e.openJawNetSaving, e.openJawComparator,
    e.score, e.verificationStatus, e.baselineConfidence, e.sampleSize,
    input.localDay, input.digestSlot, input.priority,
    // A provider message id only. NEVER a URL.
    input.deliveryReference ? redactSecrets(input.deliveryReference) : null,
    input.queueId, at,
  )
  return Number(info.lastInsertRowid)
}

/**
 * How many immediate interruptions have been spent today, Prague time.
 *
 * In-flight rows count as spent. Without that, two items claimed in the same
 * tick both read a count of zero and both pass a cap of two - which is how a
 * "maximum 2" becomes 4.
 *
 * `kind='test'` is excluded everywhere it appears: a manual `notify:test` must
 * not silently burn the day's allowance.
 */
export function immediatesToday(db: DB, localDay: string): number {
  const sent = (db.prepare(
    `SELECT COUNT(*) c FROM notifications
     WHERE kind IN ('immediate','bypass') AND local_day = ?`,
  ).get(localDay) as any).c as number
  const inFlight = (db.prepare(
    `SELECT COUNT(*) c FROM notification_queue
     WHERE kind IN ('immediate','bypass') AND status IN ('CLAIMED','SENDING')`,
  ).get() as any).c as number
  return sent + inFlight
}

export function digestSentFor(db: DB, slot: string): boolean {
  return db.prepare(
    `SELECT 1 FROM notifications WHERE kind = 'digest' AND digest_slot = ?`,
  ).get(slot) !== undefined
}

/**
 * Opportunity keys the operator has marked BAD_SIGNAL.
 *
 * Computed by resolving each candidate that carries a latest verdict of
 * BAD_SIGNAL to its opportunity key, because the candidate id itself is not
 * durable - `deleteCandidate` cascades the feedback row away, and ids churn.
 * The `notification_events` decision trail preserves the suppression after the
 * candidate is gone.
 */
export function badSignalOpportunityKeys(db: DB): Set<string> {
  const rows = db.prepare(`
    SELECT c.id FROM deal_candidates c
    JOIN (
      SELECT candidate_id, verdict,
             ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) rn
      FROM deal_feedback
    ) f ON f.candidate_id = c.id AND f.rn = 1
    WHERE f.verdict = 'BAD_SIGNAL'
  `).all() as { id: number }[]
  const keys = new Set<string>()
  for (const row of rows) {
    const event = db.prepare(
      `SELECT opportunity_key FROM notification_events
       WHERE candidate_id = ? AND opportunity_key IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1`,
    ).get(row.id) as { opportunity_key: string } | undefined
    if (event) keys.add(event.opportunity_key)
  }
  // And any opportunity whose suppression was recorded before the candidate
  // went away.
  const remembered = db.prepare(
    `SELECT DISTINCT opportunity_key FROM notification_events
     WHERE kind = 'decision' AND first_blocker = 'USER_BAD_SIGNAL' AND opportunity_key IS NOT NULL`,
  ).all() as { opportunity_key: string }[]
  for (const row of remembered) keys.add(row.opportunity_key)
  return keys
}

export interface NotificationRow {
  id: number
  fingerprint: string
  opportunityKey: string
  kind: string
  channel: string
  candidateId: number | null
  route: string
  cabin: string
  type: string
  score: number
  currency: string | null
  priceAmount: number | null
  points: number | null
  effectiveCost: number | null
  localDay: string
  sentAt: string
  deliveryReference: string | null
}

export function listNotifications(db: DB, limit = 50): NotificationRow[] {
  return (db.prepare(
    `SELECT * FROM notifications ORDER BY sent_at DESC LIMIT ?`,
  ).all(Math.min(limit, 200)) as any[]).map(r => ({
    id: r.id,
    fingerprint: r.fingerprint,
    opportunityKey: r.opportunity_key,
    kind: r.kind,
    channel: r.channel,
    candidateId: r.candidate_id,
    route: r.route,
    cabin: r.cabin,
    type: r.type,
    score: r.score,
    currency: r.currency,
    priceAmount: r.price_amount,
    points: r.points,
    effectiveCost: r.effective_cost,
    localDay: r.local_day,
    sentAt: r.sent_at,
    deliveryReference: r.delivery_reference,
  }))
}

export function listQueue(db: DB, limit = 50): QueueRow[] {
  return (db.prepare(
    `SELECT * FROM notification_queue ORDER BY
       CASE status WHEN 'QUEUED' THEN 0 WHEN 'CLAIMED' THEN 1 WHEN 'SENDING' THEN 2 ELSE 3 END,
       scheduled_for ASC LIMIT ?`,
  ).all(Math.min(limit, 200)) as any[]).map(rowToQueue)
}

export function listEvents(db: DB, limit = 100, kind?: string): any[] {
  const rows = kind
    ? db.prepare(`SELECT * FROM notification_events WHERE kind = ? ORDER BY last_seen_at DESC LIMIT ?`)
        .all(kind, Math.min(limit, 500))
    : db.prepare(`SELECT * FROM notification_events ORDER BY last_seen_at DESC LIMIT ?`)
        .all(Math.min(limit, 500))
  return rows as any[]
}
