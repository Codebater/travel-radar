#!/usr/bin/env tsx
/**
 * Notification admin.
 *
 *   npm run notify:dry-run   what WOULD be sent, and why everything else is not
 *   npm run notify:test      one synthetic message; no candidate involved
 *   npm run notify:status    channel, threshold, quiet hours, allowance, queue
 *   npm run notify:report    what was sent, suppressed and fed back
 *
 * `dry-run` is the only one of these that must be run before enabling
 * anything, and it is built so that it CANNOT deliver: it constructs a channel
 * that has no transport and never reads the destination from the environment.
 * "It cannot send" is a property of the object, not a promise in a comment.
 *
 * No command here prints the ntfy server, topic or token. `status` names the
 * HOST because knowing whether you are pointed at ntfy.sh or your own box is
 * operationally useful; the topic is withheld because on public ntfy the topic
 * is the entire access control.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { loadNotificationConfig, notificationsEnabled, deepLinkFor } from "./config.js"
import { runNotificationPass } from "./dispatcher.js"
import { NtfyChannel } from "./providers/ntfy.js"
import { NullChannel } from "./providers/null.js"
import { renderTest } from "./format.js"
import { recordEvent, listNotifications, listQueue, immediatesToday, listEvents } from "./store.js"
import { isQuiet, localDay, digestSlotFor, slotDueAt, timezoneSupported } from "./quiet-hours.js"
import { credentialWarnings } from "./credentials.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

async function main() {
  const db = getDb()
  const config = loadNotificationConfig()
  const now = new Date()

  switch (command) {
    case "dry-run": {
      console.log("DRY RUN - no network request is made and nothing can be delivered.\n")
      const before = {
        notifications: (db.prepare(`SELECT COUNT(*) c FROM notifications`).get() as any).c,
        queue: (db.prepare(`SELECT COUNT(*) c FROM notification_queue`).get() as any).c,
      }

      const channel = new NullChannel()
      const result = await runNotificationPass({ db, channel, now, dryRun: true, config })

      const eligible = result.verdicts.filter(v => v.eligible)
      const bands = db.prepare(`
        SELECT SUM(CASE WHEN score >= 90 THEN 1 ELSE 0 END) b90,
               SUM(CASE WHEN score >= 85 AND score < 90 THEN 1 ELSE 0 END) b85,
               SUM(CASE WHEN score >= 80 AND score < 85 THEN 1 ELSE 0 END) b80,
               SUM(CASE WHEN score >= 70 AND score < 80 THEN 1 ELSE 0 END) b70,
               SUM(CASE WHEN score < 70 THEN 1 ELSE 0 END) below,
               MAX(score) top
        FROM deal_candidates WHERE status = 'candidate'
      `).get() as any
      const topRow = db.prepare(`
        SELECT route, cabin, type, score, price_amount, price_currency, points,
               verification_status, absolute_tier, baseline_confidence, sample_size
        FROM deal_candidates WHERE status = 'candidate' ORDER BY score DESC LIMIT 1
      `).get() as any

      console.log(`${eligible.length} would notify.`)
      if (topRow) {
        console.log(
          `Highest score ${topRow.score} (${topRow.route} ${topRow.cabin} ` +
          `${topRow.type === "award" ? `${topRow.points} pts` : `${topRow.price_amount} ${topRow.price_currency}`}, ` +
          `${topRow.verification_status}, ${topRow.absolute_tier ?? "no absolute tier"}, ` +
          `${topRow.baseline_confidence}/${topRow.sample_size} obs) - threshold ${config.threshold}.`,
        )
      }
      console.log(
        `Bands: >=90: ${bands.b90 ?? 0} · 85-90: ${bands.b85 ?? 0} · 80-85: ${bands.b80 ?? 0} · ` +
        `70-80: ${bands.b70 ?? 0} · below 70: ${bands.below ?? 0}`,
      )
      console.log(`Evaluated in this pass: ${result.evaluated} (score >= ${config.threshold - (config.pass?.nearMissBand ?? 10)})\n`)

      const blockers = Object.entries(result.blockers).sort((a, b) => b[1] - a[1])
      if (blockers.length > 0) {
        console.log("Why each was silent:")
        for (const [code, count] of blockers) {
          console.log(`  ${String(count).padStart(4)}  ${code}`)
        }
        console.log()
      }

      for (const verdict of result.verdicts.filter(v => v.nearMiss).slice(0, 20)) {
        const mark = verdict.eligible ? "WOULD NOTIFY" : `SUPPRESSED ${verdict.firstBlocker}`
        console.log(`${mark.padEnd(30)} ${verdict.economics.route} ${verdict.economics.cabin} score ${verdict.economics.score}`)
        for (const reason of verdict.reasons.slice(0, 3)) {
          console.log(`      ${reason.code}: ${reason.detail}`)
        }
      }

      console.log(`\nQueued this pass: ${result.queued}. Nothing was delivered: the dry run has no transport.`)
      if (result.errors.length) for (const e of result.errors) console.log(`  ⚠ ${e}`)

      // §10 a dry run that writes rows is not a dry run. It records DECISIONS
      // (that is the point) but must not queue or send.
      const after = {
        notifications: (db.prepare(`SELECT COUNT(*) c FROM notifications`).get() as any).c,
        queue: (db.prepare(`SELECT COUNT(*) c FROM notification_queue`).get() as any).c,
      }
      if (after.notifications !== before.notifications || after.queue !== before.queue) {
        console.log(
          `\n❌ a dry run changed the database: ` +
          `${after.notifications - before.notifications} notification row(s), ` +
          `${after.queue - before.queue} queue row(s). That is a bug, not a dry run.`,
        )
        process.exitCode = 1
      } else {
        console.log("Wrote 0 notification and 0 queue rows, as a dry run must.")
      }
      console.log(
        `\nDeliveries attempted: ${channel.sent.length} (a dry run must show 0 network sends; ` +
        `${channel.sent.length} message(s) were rendered against the null channel)`,
      )
      break
    }

    case "test": {
      // §11 one clearly labelled synthetic message. No candidate is involved,
      // and the notifications table is not touched - so a manual test can never
      // burn the day's allowance or provide a re-alert baseline.
      const channel = new NtfyChannel()
      const health = channel.health()
      console.log(`Channel: ${health.channel} — ${health.status}: ${health.detail}\n`)
      if (health.status !== "ok") {
        console.log("Not sending: the channel is not usable. Set NTFY_TOPIC (and NTFY_SERVER/NTFY_TOKEN) in .env.")
        process.exitCode = 1
        break
      }
      const message = renderTest()
      console.log(`Sending:\n  ${message.title}\n  ${message.body.replace(/\n/g, "\n  ")}\n`)
      const delivery = await channel.send(message)
      recordEvent(db, {
        kind: "test",
        detail: delivery.ok
          ? `test notification delivered in ${delivery.latencyMs}ms`
          : `test notification failed: ${delivery.error}`,
      })
      console.log(
        `Result: ${delivery.ok ? "✅ delivered" : "❌ failed"} · status ${delivery.status ?? "—"} · ` +
        `${delivery.latencyMs}ms${delivery.reference ? ` · reference ${delivery.reference}` : ""}`,
      )
      if (delivery.error) console.log(`Error: ${delivery.error}`)
      if (!delivery.ok) process.exitCode = 1
      break
    }

    case "status": {
      const channel = new NtfyChannel()
      const health = channel.health()
      const day = localDay(now, config)
      const spent = immediatesToday(db, day)
      const quiet = isQuiet(now, config)
      const slot = digestSlotFor(now, config)
      const due = slotDueAt(slot, config)
      const queue = listQueue(db, 200)
      const byStatus: Record<string, number> = {}
      for (const row of queue) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1

      console.log("Notification status\n")
      console.log(`Enabled            ${notificationsEnabled(config) ? "YES" : "NO"}` +
        `${config.enabled ? "" : " (config.enabled = false)"}` +
        `${process.env.NOTIFICATIONS_ENABLED === "false" ? " (NOTIFICATIONS_ENABLED=false)" : ""}`)
      console.log(`Channel            ${health.channel} — ${health.status}: ${health.detail}`)
      console.log(`Threshold          ${config.threshold} (shadow candidate threshold is unchanged)`)
      console.log(`Quiet hours        ${config.quietHours.start}–${config.quietHours.end} ${config.quietHours.timezone}` +
        ` — right now it is ${quiet ? "QUIET (alerts queue for the morning)" : "waking hours"}`)
      console.log(`Today (Prague)     ${day}: ${spent}/${config.rateLimits.maxImmediatePerDay} immediate notifications used`)
      console.log(`Next digest slot   ${slot}${due ? ` (due ${due.toISOString()})` : " (could not be resolved)"}`)
      console.log(`Queue              ${queue.length} row(s)` +
        (Object.keys(byStatus).length ? `: ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""))
      console.log(`Sent (all time)    ${(db.prepare(`SELECT COUNT(*) c FROM notifications`).get() as any).c}`)
      console.log(`Deep link          ${deepLinkFor(1, config) ?? "NOT USABLE - alerts would have no tap target"}`)

      const warnings: string[] = []
      if (!timezoneSupported(config.quietHours.timezone)) {
        warnings.push(`this runtime does not know ${config.quietHours.timezone} - everything is being treated as quiet hours`)
      }
      if (!deepLinkFor(1, config)) warnings.push("deepLink.baseUrl is not usable - alerts will have no tap target")
      if (health.status === "error") warnings.push(`the notification channel is misconfigured: ${health.detail}`)
      warnings.push(...credentialWarnings(config, now))

      if (warnings.length) {
        console.log()
        for (const w of warnings) console.log(`⚠️  ${w}`)
      } else {
        console.log("\n✅ No warnings.")
      }
      break
    }

    case "report": {
      const since = flag("since") ?? new Date(now.getTime() - 30 * 86_400_000).toISOString()
      const sent = listNotifications(db, 200).filter(n => n.sentAt >= since)
      const decisions = listEvents(db, 500, "decision")
      const queue = listQueue(db, 200)

      console.log(`Notification report since ${since.slice(0, 10)}\n`)
      console.log(`Sent            ${sent.length}` +
        ` (${sent.filter(n => n.kind === "immediate").length} immediate, ` +
        `${sent.filter(n => n.kind === "bypass").length} bypass, ` +
        `${sent.filter(n => n.kind === "digest").length} in digests)`)
      console.log(`Queued now      ${queue.filter(q => q.status === "QUEUED").length}`)
      console.log(`Failed          ${queue.filter(q => q.status === "FAILED").length}`)
      console.log(`Cancelled       ${queue.filter(q => q.status === "CANCELLED").length}`)
      console.log(`Suppressed      ${queue.filter(q => q.status === "SUPPRESSED").length}`)
      console.log(`Unknown         ${queue.filter(q => q.status === "UNKNOWN").length} (sender stopped mid-send; never re-sent)`)

      const blockerCounts = new Map<string, number>()
      for (const d of decisions) {
        if (!d.first_blocker) continue
        blockerCounts.set(d.first_blocker, (blockerCounts.get(d.first_blocker) ?? 0) + (d.occurrences ?? 1))
      }
      if (blockerCounts.size) {
        console.log(`\nWhy the radar stayed silent (distinct opportunities × times seen):`)
        for (const [code, count] of [...blockerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
          console.log(`  ${String(count).padStart(6)}  ${code}`)
        }
      }

      // §31/§32 the question this whole phase exists to answer.
      const feedback = db.prepare(`
        SELECT f.verdict, COUNT(*) n,
               SUM(CASE WHEN f.notification_id IS NOT NULL THEN 1 ELSE 0 END) fromAlert
        FROM (
          SELECT candidate_id, verdict, notification_id,
                 ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) rn
          FROM deal_feedback
        ) f WHERE f.rn = 1 GROUP BY f.verdict
      `).all() as any[]
      console.log(`\nOperator feedback:`)
      if (feedback.length === 0) {
        console.log(`  none yet. Until there is, the threshold of ${config.threshold} is a judgement, not a`)
        console.log(`  measurement - there is nothing to calibrate against and nothing has been tuned.`)
      } else {
        for (const row of feedback) {
          console.log(`  ${String(row.n).padStart(4)}  ${row.verdict.padEnd(12)} (${row.fromAlert} prompted by a notification)`)
        }
      }

      // §33 calibration by score band. Say plainly where there is no evidence.
      console.log(`\nBy score band (candidates · notified · WOULD_BOOK · GOOD · NORMAL · BAD):`)
      const bands: [string, number, number][] = [
        ["70-79", 70, 80], ["80-84", 80, 85], ["85-89", 85, 90], ["90-94", 90, 95], ["95+", 95, 1000],
      ]
      for (const [label, lo, hi] of bands) {
        const row = db.prepare(`
          SELECT COUNT(*) candidates,
            (SELECT COUNT(*) FROM notifications n WHERE n.score >= ? AND n.score < ?) notified,
            SUM(CASE WHEN v.verdict = 'WOULD_BOOK' THEN 1 ELSE 0 END) wouldBook,
            SUM(CASE WHEN v.verdict = 'GOOD_DEAL' THEN 1 ELSE 0 END) good,
            SUM(CASE WHEN v.verdict = 'NORMAL' THEN 1 ELSE 0 END) normal,
            SUM(CASE WHEN v.verdict = 'BAD_SIGNAL' THEN 1 ELSE 0 END) bad
          FROM deal_candidates c
          LEFT JOIN (
            SELECT candidate_id, verdict,
                   ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) rn
            FROM deal_feedback
          ) v ON v.candidate_id = c.id AND v.rn = 1
          WHERE c.status = 'candidate' AND c.score >= ? AND c.score < ?
        `).get(lo, hi, lo, hi) as any
        const judged = (row.wouldBook ?? 0) + (row.good ?? 0) + (row.normal ?? 0) + (row.bad ?? 0)
        console.log(
          `  ${label.padEnd(7)} ${String(row.candidates ?? 0).padStart(5)} · ${String(row.notified ?? 0).padStart(3)} · ` +
          `${String(row.wouldBook ?? 0).padStart(3)} · ${String(row.good ?? 0).padStart(3)} · ` +
          `${String(row.normal ?? 0).padStart(3)} · ${String(row.bad ?? 0).padStart(3)}` +
          (judged === 0 ? "   (no feedback in this band yet)" : ""),
        )
      }
      console.log(
        `\nThis is not a measure of accuracy. It is a record of what was sent next to what a ` +
        `person\nthought of it, and nothing in this system tunes itself from it (§34).`,
      )
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  dry-run    what would be sent and why everything else is not. No network.
  test       one synthetic TRAVEL RADAR TEST message. No candidate involved.
  status     channel, threshold, quiet hours, allowance, queue, credentials
  report     sent / suppressed / failed history and operator feedback`)
      process.exitCode = command ? 1 : 0
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("notifications/cli.ts")
if (isMain) {
  main().catch(err => {
    console.error("❌", (err as Error).message)
    process.exit(1)
  })
}
