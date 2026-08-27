/**
 * The notification pass: the one entry point the scheduler calls.
 *
 * Four phases per tick, in this order and for these reasons:
 *
 *   1. reap    - crash hygiene, before anything reads the queue, so a stale
 *                CLAIMED row is available again this tick rather than next.
 *   2. evaluate- decide about fresh candidates and queue what qualifies.
 *   3. drain   - send what is due, revalidating every row immediately before
 *                it goes out.
 *   4. digest  - one combined message for any morning slot that has come due.
 *
 * The pass is bounded on every axis - candidates examined, sends per tick,
 * metered calls per tick - because it shares a 60-second tick with the
 * collection this whole project exists for. Notification work must be
 * negligible next to discovery, not merely "usually fast".
 *
 * Nothing in here is allowed to throw into the scheduler: every send is
 * wrapped, every revalidation is wrapped, and the channel contract already
 * forbids `send` from rejecting. §40.
 */

import type { DB } from "../db/index.js"
import { getDb, nowIso } from "../db/index.js"
import { getCandidate, listCandidates, type StoredCandidate } from "../anomaly/store.js"
import { loadAnomalyConfig } from "../anomaly/config.js"
import { providerEventsSince } from "../db/repositories.js"
import { loadNotificationConfig, notificationsEnabled, type NotificationConfig } from "./config.js"
import { evaluateEligibility, type Verdict } from "./eligibility.js"
import { renderCandidate, renderDigest, type RenderInput } from "./format.js"
import {
  badSignalOpportunityKeys, claim, digestSentFor, dueQueueRows, enqueue, getQueueRow,
  immediatesToday, markSending, markTerminal, reapStale, recordEvent, recordNotification,
  retryLater,
} from "./store.js"
import { digestSlotFor, isQuiet, localDay, slotIsDue } from "./quiet-hours.js"
import { verifyForNotification } from "./verify.js"
import type { NotificationChannel } from "./providers/types.js"

export interface PassOptions {
  db?: DB
  channel: NotificationChannel
  now?: Date
  /** The scheduler's holder id, so a claim names its owner. */
  holder?: string
  /** Cooperative abort. Checked before every send: the lease can flip mid-await. */
  shouldContinue?: () => boolean
  config?: NotificationConfig
  /** Evaluate and record, but never deliver. Used by notify:dry-run. */
  dryRun?: boolean
}

export interface PassResult {
  evaluated: number
  eligible: number
  queued: number
  sent: number
  failed: number
  cancelled: number
  suppressed: number
  retried: number
  digestsSent: number
  verificationCalls: number
  reaped: { requeued: number; unknown: number }
  /** first_blocker → count, for the dry-run summary. */
  blockers: Record<string, number>
  verdicts: Verdict[]
  errors: string[]
}

function emptyResult(): PassResult {
  return {
    evaluated: 0, eligible: 0, queued: 0, sent: 0, failed: 0, cancelled: 0,
    suppressed: 0, retried: 0, digestsSent: 0, verificationCalls: 0,
    reaped: { requeued: 0, unknown: 0 }, blockers: {}, verdicts: [], errors: [],
  }
}

/** Providers currently failing, so a candidate resting on one stays silent. */
function brokenProviders(db: DB, now: Date): Set<string> {
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString()
  const broken = new Set<string>()
  try {
    for (const event of providerEventsSince(db, since)) {
      if (event.kind === "error" || event.kind === "auth") broken.add(event.provider)
    }
  } catch { /* a provider-health lookup failing must not silence everything */ }
  return broken
}

function renderInputFor(db: DB, candidate: StoredCandidate, verdict: Verdict): RenderInput {
  // The family's date span, when the candidate still belongs to one. Cluster
  // membership is unstable, so its absence is normal rather than exceptional.
  let earliest = candidate.departureDate
  let latest = candidate.departureDate
  let dateCount = 1
  if (candidate.clusterId) {
    const row = db.prepare(
      `SELECT earliest_departure e, latest_departure l, member_count m
       FROM candidate_clusters WHERE id = ?`,
    ).get(candidate.clusterId) as any
    if (row) { earliest = row.e; latest = row.l; dateCount = row.m }
  }
  return {
    candidate,
    dateCount,
    earliestDeparture: earliest,
    latestDeparture: latest,
    lowConfidenceLabel: verdict.labels.find(l => l.includes("LOW BASELINE")) ?? null,
    bypass: verdict.kind === "bypass",
    improvement: verdict.improvement,
  }
}

/**
 * Evaluate candidates and queue what qualifies.
 *
 * Only candidates at or above the near-miss band are examined at all: below
 * that, /deals.html already answers "why is this not an alert?" with its score,
 * and evaluating 4,800 hopeless rows every minute would be the most expensive
 * thing in the tick by an order of magnitude.
 */
function evaluatePhase(
  db: DB, config: NotificationConfig, now: Date, result: PassResult, dryRun = false,
): void {
  const band = config.pass?.nearMissBand ?? 10
  const anomalyConfig = loadAnomalyConfig()
  const broken = brokenProviders(db, now)
  const badSignals = badSignalOpportunityKeys(db)
  const day = localDay(now, config)
  const spentToday = immediatesToday(db, day)
  const quiet = isQuiet(now, config)

  const candidates = listCandidates(db, {
    minScore: Math.max(0, config.threshold - band),
    status: "candidate",
    limit: Math.min(config.pass?.maxCandidatesPerPass ?? 400, 500),
    collapse: true,
  })

  for (const candidate of candidates) {
    result.evaluated++
    const verdict = evaluateEligibility(db, candidate, {
      now, config, anomalyConfig,
      brokenProviders: broken,
      badSignalKeys: badSignals,
      immediatesToday: spentToday,
      channelStatus: "ok",
    })
    result.verdicts.push(verdict)

    const blocker = verdict.firstBlocker ?? "ELIGIBLE"
    result.blockers[blocker] = (result.blockers[blocker] ?? 0) + 1

    // Every decision is recorded, including the silences. An operator has to be
    // able to tell "the radar decided" from "the radar is broken", and only a
    // written-down reason does that.
    recordEvent(db, {
      kind: "decision",
      opportunityKey: verdict.opportunityKey,
      fingerprint: verdict.fingerprint,
      candidateId: candidate.id,
      clusterId: candidate.clusterId,
      score: candidate.score,
      gatesEvaluated: verdict.gatesEvaluated,
      firstBlocker: verdict.firstBlocker,
      allBlockers: verdict.allBlockers,
      detail: verdict.reasons.map(r => `${r.code}: ${r.detail}`).join(" | ").slice(0, 500),
    }, now.toISOString())

    if (!verdict.eligible) continue
    result.eligible++

    // A dry run stops here. It has said what it would do, which is the whole
    // point; queueing would leave real work behind for the next real pass.
    if (dryRun) continue

    // §17 quiet hours QUEUE, they do not cancel. The extreme bypass is the one
    // thing that goes out anyway, and it is about the clock, not the evidence -
    // it passed every gate above to get here.
    const bypassing = verdict.kind === "bypass"
    const goesToDigest = (quiet && !bypassing) || verdict.kind === "digest"
    const slot = goesToDigest ? digestSlotFor(now, config) : null
    const queueId = enqueue(db, {
      verdict,
      kind: goesToDigest ? "digest" : bypassing ? "bypass" : "immediate",
      scheduledFor: now.toISOString(),
      digestSlot: slot,
      priority: bypassing ? 1 : goesToDigest ? 5 : 3,
    }, now.toISOString())

    if (queueId === null) continue   // already in flight; the index said so
    result.queued++
    recordEvent(db, {
      kind: "transition", queueId,
      opportunityKey: verdict.opportunityKey, fingerprint: verdict.fingerprint,
      candidateId: candidate.id, toStatus: "QUEUED", score: candidate.score,
      detail: goesToDigest
        ? `queued for the ${slot} digest (${quiet ? "quiet hours" : "daily cap reached"})`
        : bypassing ? "extreme bypass - going out now" : "queued for immediate delivery",
    }, now.toISOString())
  }
}

/**
 * Revalidate a queued row and send it, or explain why it is not going.
 *
 * The FULL evaluator runs again, not a freshness poke. `saveCandidate`'s upsert
 * rewrites score, status, sanity and verification_status in place, and a
 * verification run calls `evaluateNewObservations` mid-pass - so a row that was
 * eligible nine hours ago at 23:05 may be anything at all by 08:00.
 */
async function sendOne(
  db: DB, queueId: number, options: PassOptions, config: NotificationConfig,
  now: Date, result: PassResult,
): Promise<void> {
  const row = getQueueRow(db, queueId)
  if (!row) return

  // §25 a delayed notification is rechecked. If the deal is dead, it is
  // cancelled rather than delivered.
  const candidate = row.candidateId !== null ? getCandidate(db, row.candidateId) : null
  if (!candidate) {
    markTerminal(db, queueId, "CANCELLED", "the candidate behind this alert no longer exists")
    result.cancelled++
    recordEvent(db, {
      kind: "transition", queueId, opportunityKey: row.opportunityKey,
      fingerprint: row.fingerprint, fromStatus: row.status, toStatus: "CANCELLED",
      firstBlocker: "WITHDRAWN",
      detail: "the decision was withdrawn while this was queued",
    }, now.toISOString())
    return
  }

  const day = localDay(now, config)
  const fresh = evaluateEligibility(db, candidate, {
    now, config,
    brokenProviders: brokenProviders(db, now),
    badSignalKeys: badSignalOpportunityKeys(db),
    immediatesToday: immediatesToday(db, day),
    channelStatus: options.channel.health().status,
  })

  if (!fresh.eligible) {
    if (fresh.firstBlocker) {
      result.blockers[fresh.firstBlocker] = (result.blockers[fresh.firstBlocker] ?? 0) + 1
    }
    const dead = fresh.allBlockers.some(b =>
      b === "WITHDRAWN" || b === "STALE" || b === "SUSPICIOUS_DATA" || b === "INVALID_ITINERARY")
    markTerminal(db, queueId, dead ? "CANCELLED" : "SUPPRESSED",
      fresh.reasons.map(r => `${r.code}: ${r.detail}`).join("; "))
    if (dead) result.cancelled++; else result.suppressed++
    recordEvent(db, {
      kind: "transition", queueId, opportunityKey: row.opportunityKey,
      fingerprint: row.fingerprint, candidateId: candidate.id,
      fromStatus: row.status, toStatus: dead ? "CANCELLED" : "SUPPRESSED",
      firstBlocker: fresh.firstBlocker, allBlockers: fresh.allBlockers,
      detail: "revalidated before sending and no longer eligible",
    }, now.toISOString())
    return
  }

  // The economics moved while it waited: this is a different opportunity now.
  // Let the fresh evaluation queue it on its own terms rather than sending a
  // price that is no longer the price.
  if (fresh.fingerprint !== row.fingerprint) {
    markTerminal(db, queueId, "SUPPRESSED", "the economics changed while this was queued; superseded")
    result.suppressed++
    recordEvent(db, {
      kind: "transition", queueId, opportunityKey: row.opportunityKey,
      fingerprint: row.fingerprint, candidateId: candidate.id,
      fromStatus: row.status, toStatus: "SUPPRESSED", firstBlocker: "SUPERSEDED",
      detail: `fingerprint moved from ${row.fingerprint.slice(0, 40)}… while queued`,
    }, now.toISOString())
    return
  }

  // §26 pay to confirm, if this is a cash fare that has never been confirmed
  // and the budget allows. Bounded to one call per tick.
  if (fresh.needsVerification && result.verificationCalls < (config.verifyBeforeNotify.maxPerTick ?? 1)
      && !options.dryRun) {
    try {
      const verification = await verifyForNotification(db, candidate, config)
      if (verification.attempted) {
        result.verificationCalls += verification.callsSpent
        recordEvent(db, {
          kind: "verify", queueId, opportunityKey: row.opportunityKey,
          candidateId: candidate.id, detail: verification.reason,
        }, now.toISOString())
      }
      if (verification.attempted && !verification.ok && config.verifyBeforeNotify.onFailure === "suppress") {
        markTerminal(db, queueId, "SUPPRESSED", `verification failed: ${verification.reason}`)
        result.suppressed++
        recordEvent(db, {
          kind: "transition", queueId, opportunityKey: row.opportunityKey,
          candidateId: candidate.id, fromStatus: row.status, toStatus: "SUPPRESSED",
          firstBlocker: "VERIFICATION_FAILED", detail: verification.reason,
        }, now.toISOString())
        return
      }
    } catch (err) {
      // Includes the deliberate throw for an open jaw. A verification problem
      // must never take down the pass.
      result.errors.push(`verification: ${(err as Error).message}`)
    }
  }

  if (options.shouldContinue && !options.shouldContinue()) return

  // The payload is rendered HERE, from revalidated values - never stored at
  // queue time. A body rendered at 23:05 and delivered at 08:00 quotes a
  // nine-hour-old price.
  const message = renderCandidate(renderInputFor(db, candidate, fresh), config)

  // Committed BEFORE the network call. A crash after this point costs one
  // attempt; a crash with the increment after the call would replay forever.
  if (!markSending(db, queueId, now.toISOString())) return

  const delivery = await options.channel.send(message)

  if (delivery.ok) {
    const notificationId = recordNotification(db, {
      verdict: fresh,
      kind: row.kind === "bypass" ? "bypass" : "immediate",
      channel: options.channel.name,
      candidateId: candidate.id,
      clusterIdAtSend: candidate.clusterId,
      localDay: day,
      digestSlot: null,
      priority: message.priority,
      deliveryReference: delivery.reference,
      queueId,
      route: fresh.economics.route,
    }, now.toISOString())
    markTerminal(db, queueId, "SENT", null)
    result.sent++
    recordEvent(db, {
      kind: "delivery", queueId, notificationId,
      opportunityKey: fresh.opportunityKey, fingerprint: fresh.fingerprint,
      candidateId: candidate.id, fromStatus: "SENDING", toStatus: "SENT",
      score: candidate.score, detail: `delivered in ${delivery.latencyMs}ms`,
    }, now.toISOString())
    return
  }

  const ladder = config.retry.backoffMinutes
  const attempts = row.attempts + 1
  if (delivery.retryable && attempts < config.retry.maxAttempts && attempts <= ladder.length) {
    const delay = ladder[Math.min(attempts, ladder.length) - 1] ?? ladder[ladder.length - 1]!
    retryLater(db, queueId, delay, delivery.error ?? "delivery failed", now)
    result.retried++
    recordEvent(db, {
      kind: "delivery", queueId, opportunityKey: row.opportunityKey,
      fingerprint: row.fingerprint, candidateId: candidate.id,
      fromStatus: "SENDING", toStatus: "QUEUED",
      detail: `attempt ${attempts} failed (${delivery.error}); retrying in ${delay} minutes`,
    }, now.toISOString())
    return
  }

  markTerminal(db, queueId, "FAILED", delivery.error ?? "delivery failed")
  result.failed++
  recordEvent(db, {
    kind: "delivery", queueId, opportunityKey: row.opportunityKey,
    fingerprint: row.fingerprint, candidateId: candidate.id,
    fromStatus: "SENDING", toStatus: "FAILED",
    detail: `gave up after ${attempts} attempt(s): ${delivery.error}` +
      (delivery.retryable ? "" : " (not retryable)"),
  }, now.toISOString())
}

/**
 * §19 - one digest per morning, combining everything the night queued.
 *
 * Slot-DUE rather than "fire at 08:00": the scheduler sleeps after its work, so
 * a machine that was closed overnight wakes with `now` hours past the slot, and
 * a design that waits for 08:00 to come round again would simply never send it.
 * Several overdue mornings collapse into ONE message, because three digests
 * arriving together is the burst the rate limits exist to prevent.
 */
async function digestPhase(
  db: DB, options: PassOptions, config: NotificationConfig,
  now: Date, result: PassResult, holder: string,
): Promise<void> {
  const slots = db.prepare(`
    SELECT DISTINCT digest_slot FROM notification_queue
    WHERE kind = 'digest' AND status = 'QUEUED' AND digest_slot IS NOT NULL
    ORDER BY digest_slot ASC
  `).all() as { digest_slot: string }[]

  const due = slots
    .map(s => s.digest_slot)
    .filter(slot => slotIsDue(slot, now, config) && !digestSentFor(db, slot))
    .slice(0, config.quietHours.maxCatchUpDays ?? 3)
  if (due.length === 0) return

  const rows = dueQueueRows(db, new Date(now.getTime() + 86_400_000), 200)
    .filter(r => r.kind === "digest" && r.digestSlot !== null && due.includes(r.digestSlot))
  if (rows.length === 0) return

  // Revalidate every item, and say how many survived. "11 queued, 2 still
  // live" is the honest headline; sending 11 stale lines is not.
  const live: { row: typeof rows[number]; candidate: StoredCandidate; verdict: Verdict }[] = []
  const day = localDay(now, config)
  for (const row of rows) {
    if (!claim(db, row.id, holder, now.toISOString())) continue
    const candidate = row.candidateId !== null ? getCandidate(db, row.candidateId) : null
    if (!candidate) {
      markTerminal(db, row.id, "CANCELLED", "the candidate behind this alert no longer exists")
      result.cancelled++
      continue
    }
    const fresh = evaluateEligibility(db, candidate, {
      now, config,
      brokenProviders: brokenProviders(db, now),
      badSignalKeys: badSignalOpportunityKeys(db),
      // The digest is not an immediate interruption, so the immediate cap does
      // not apply to its contents.
      immediatesToday: 0,
      channelStatus: options.channel.health().status,
    })
    if (!fresh.eligible || fresh.fingerprint !== row.fingerprint) {
      markTerminal(db, row.id, "CANCELLED", fresh.reasons.map(r => r.code).join(", ") || "superseded")
      result.cancelled++
      continue
    }
    live.push({ row, candidate, verdict: fresh })
  }

  if (live.length === 0) return
  if (options.shouldContinue && !options.shouldContinue()) return

  // Collapse by fingerprint, then by cooldown key, then cap.
  const seenFingerprint = new Set<string>()
  const seenCooldown = new Set<string>()
  const chosen: typeof live = []
  for (const item of live.sort((a, b) => b.candidate.score - a.candidate.score)) {
    if (seenFingerprint.has(item.verdict.fingerprint)) continue
    if (seenCooldown.has(item.verdict.cooldownKey)) continue
    seenFingerprint.add(item.verdict.fingerprint)
    seenCooldown.add(item.verdict.cooldownKey)
    chosen.push(item)
  }

  const message = renderDigest(
    chosen.map(i => renderInputFor(db, i.candidate, i.verdict)), config,
  )
  for (const item of chosen) markSending(db, item.row.id, now.toISOString())
  const delivery = await options.channel.send(message)

  const slot = due[due.length - 1]!
  if (delivery.ok) {
    for (const [index, item] of chosen.entries()) {
      // Each line gets its own notifications row: its own fingerprint for
      // dedup, its own economics as a re-alert baseline, and the shared
      // delivery reference so the audit trail can put them back together.
      // Only the first carries the digest_slot, because the partial unique
      // index says one digest per morning.
      const notificationId = recordNotification(db, {
        verdict: item.verdict,
        kind: "digest",
        channel: options.channel.name,
        candidateId: item.candidate.id,
        clusterIdAtSend: item.candidate.clusterId,
        localDay: day,
        digestSlot: index === 0 ? slot : null,
        priority: message.priority,
        deliveryReference: delivery.reference,
        queueId: item.row.id,
        route: item.verdict.economics.route,
      }, now.toISOString())
      markTerminal(db, item.row.id, "SENT", null)
      recordEvent(db, {
        kind: "delivery", queueId: item.row.id, notificationId,
        opportunityKey: item.verdict.opportunityKey, fingerprint: item.verdict.fingerprint,
        candidateId: item.candidate.id, fromStatus: "SENDING", toStatus: "SENT",
        detail: `delivered in the ${slot} digest`,
      }, now.toISOString())
    }
    // Everything that was live but did not make the cut is dropped rather than
    // carried forward: yesterday's fifth-best deal is not tomorrow's news.
    for (const item of live) {
      if (!chosen.includes(item)) {
        markTerminal(db, item.row.id, "SUPPRESSED", "did not make the digest cut")
        result.suppressed++
      }
    }
    result.digestsSent++
    result.sent += chosen.length
  } else {
    for (const item of chosen) {
      retryLater(db, item.row.id, config.retry.backoffMinutes[0] ?? 5,
        delivery.error ?? "digest delivery failed", now)
    }
    result.retried += chosen.length
  }
}

/** One notification pass. Never throws into the scheduler. */
export async function runNotificationPass(options: PassOptions): Promise<PassResult> {
  const db = options.db ?? getDb()
  const config = options.config ?? loadNotificationConfig()
  const now = options.now ?? new Date()
  const holder = options.holder ?? `notify@${process.pid}`
  const result = emptyResult()

  // 1. Crash hygiene, before anything reads the queue.
  try {
    result.reaped = reapStale(db, config.retry.staleClaimMinutes ?? 10, now)
  } catch (err) {
    result.errors.push(`reap: ${(err as Error).message}`)
  }

  // 2. Decide. This happens even when delivery is switched off: the whole
  // point of the shadow period is to be able to read what WOULD have been sent.
  try {
    evaluatePhase(db, config, now, result, options.dryRun === true)
  } catch (err) {
    result.errors.push(`evaluate: ${(err as Error).message}`)
  }

  const live = notificationsEnabled(config) && !options.dryRun
  if (!live) return result

  // 3. Drain what is due, bounded per tick.
  const maxSends = config.pass?.maxSendsPerTick ?? 3
  try {
    const day = localDay(now, config)
    for (const row of dueQueueRows(db, now, maxSends * 4)) {
      if (result.sent + result.failed >= maxSends) break
      if (row.kind === "digest") continue        // digests go out as one message
      if (options.shouldContinue && !options.shouldContinue()) break

      // Re-read the allowance for EVERY row rather than trusting the number the
      // evaluation phase computed for the whole batch. immediatesToday counts
      // in-flight rows as spent, so this is also what stops two rows claimed in
      // one tick from both passing a cap of two.
      if (row.kind !== "bypass" && immediatesToday(db, day) >= config.rateLimits.maxImmediatePerDay) {
        // Not dropped: moved to the morning, which is what a cap means as
        // opposed to a fault.
        const slot = digestSlotFor(now, config)
        db.prepare(
          `UPDATE notification_queue SET kind='digest', digest_slot=?, priority=5, updated_at=?
           WHERE id = ? AND status = 'QUEUED'`,
        ).run(slot, now.toISOString(), row.id)
        recordEvent(db, {
          kind: "transition", queueId: row.id, opportunityKey: row.opportunityKey,
          fingerprint: row.fingerprint, candidateId: row.candidateId,
          fromStatus: "QUEUED", toStatus: "QUEUED", firstBlocker: "DAILY_CAP",
          detail: `the day's ${config.rateLimits.maxImmediatePerDay} immediate notifications are ` +
            `spent; held for the ${slot} digest`,
        }, now.toISOString())
        result.blockers.DAILY_CAP = (result.blockers.DAILY_CAP ?? 0) + 1
        continue
      }

      if (!claim(db, row.id, holder, now.toISOString())) continue
      try {
        await sendOne(db, row.id, options, config, now, result)
      } catch (err) {
        result.errors.push(`send ${row.id}: ${(err as Error).message}`)
        try { markTerminal(db, row.id, "FAILED", (err as Error).message) } catch { /* nothing left to do */ }
      }
    }
  } catch (err) {
    result.errors.push(`drain: ${(err as Error).message}`)
  }

  // 4. The morning digest.
  try {
    await digestPhase(db, options, config, now, result, holder)
  } catch (err) {
    result.errors.push(`digest: ${(err as Error).message}`)
  }

  if (result.sent > 0 || result.failed > 0 || result.queued > 0) {
    console.log(
      `NOTIFY: ${result.evaluated} evaluated, ${result.eligible} eligible, ${result.queued} queued, ` +
      `${result.sent} sent, ${result.retried} retrying, ${result.failed} failed, ` +
      `${result.cancelled} cancelled, ${result.suppressed} suppressed`,
    )
  }
  return result
}

export { nowIso }
