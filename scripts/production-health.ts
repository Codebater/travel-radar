#!/usr/bin/env tsx
/**
 * §9 - the one command to run after days of not looking.
 *
 *   docker exec travel-radar npm run production:health
 *
 * One screen, everything the deployment brief asks for: scheduler, lease,
 * database, observer, discovery, notifications, ntfy, providers, credential
 * expiry, latest backup, RAM/CPU. It composes what already exists rather than
 * measuring anything new, and its one addition of substance is that it opens
 * the LATEST BACKUP and integrity-checks it - a backup nobody has ever read is
 * a hope, not a backup.
 *
 * No secrets: the channel health line names the host and says "topic hidden";
 * everything else here is counts and timestamps.
 */

import "../load-env.js"
import fs from "fs"
import Database from "better-sqlite3"
import { getDb } from "../db/index.js"
import { observerHealth } from "../observer/health.js"
import { listDiscoveryJobs, listDiscoveryRuns } from "../discovery/store.js"
import { loadNotificationConfig, notificationsEnabled } from "../notifications/config.js"
import { NtfyChannel, readNtfyConfig } from "../notifications/providers/ntfy.js"
import { immediatesToday, listQueue } from "../notifications/store.js"
import { isQuiet, localDay } from "../notifications/quiet-hours.js"
import { credentialWarnings } from "../notifications/credentials.js"
import { listBackups } from "../db/backup.js"

function gb(bytes: number | null): string {
  return bytes === null ? "—" : `${(bytes / 1e6).toFixed(0)} MB`
}

function age(iso: string | null): string {
  if (!iso) return "never"
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  return minutes < 90 ? `${minutes}m ago` : `${(minutes / 60).toFixed(1)}h ago`
}

async function main() {
  const db = getDb()
  const now = new Date()
  const health = observerHealth(db, now)
  const config = loadNotificationConfig()
  const problems: string[] = [...health.warnings]

  console.log("TRAVEL RADAR — production health\n")

  // ── Scheduler and lease ────────────────────────────────────────────────────
  const s = health.scheduler
  console.log(`Scheduler       ${s.running ? (s.stale ? "STALE LEASE (holder gone)" : "RUNNING") : "STOPPED"}`)
  if (s.running) {
    console.log(`  lease         ${s.holder}, heartbeat ${s.heartbeatAgeSeconds}s ago, ${s.ticks} ticks`)
    console.log(`  footprint     ${gb(s.rssBytes)} RSS, ${s.cpuSeconds ?? "—"}s CPU`)
  }

  // ── Database ───────────────────────────────────────────────────────────────
  const integrity = (db.prepare("PRAGMA integrity_check").get() as any).integrity_check
  console.log(`\nDatabase        ${gb(health.resources.dbTotalBytes)} · integrity_check: ${integrity}`)
  if (integrity !== "ok") problems.push("DATABASE INTEGRITY CHECK FAILED")
  console.log(
    `  observations  ${health.observation.totals.cash} cash + ${health.observation.totals.award} award ` +
    `(24h: +${health.observation.last24h.cash}/+${health.observation.last24h.award})`,
  )

  // ── Observer and discovery ─────────────────────────────────────────────────
  const runs = health.runs.last24h
  console.log(`\nObserver        ${runs.total} run(s) in 24h (${runs.success} ok, ${runs.partial} partial, ${runs.failed} failed, ${runs.skippedAuth} auth-skipped)`)
  console.log(`  last obs      ${age(health.observation.lastSuccessfulAt)} (${health.observation.lastSuccessfulJob ?? "—"})`)
  console.log(`  next          ${health.observation.nextScheduledJob ?? "—"} ${health.observation.nextScheduledAt ?? ""}`)

  const discoveryJobs = listDiscoveryJobs(db, { enabledOnly: true })
  const discoveryRuns = listDiscoveryRuns(db, { limit: 5 })
  const lastDiscovery = discoveryRuns[0]
  console.log(`\nDiscovery       ${discoveryJobs.length} job(s) enabled`)
  if (lastDiscovery) {
    console.log(
      `  last run      ${age(lastDiscovery.startedAt)} · ${lastDiscovery.status} · ` +
      `${lastDiscovery.freeCalls} free, ${lastDiscovery.awardCalls} award, ${lastDiscovery.meteredCalls} metered`,
    )
  }
  const backedOff = discoveryJobs.filter(j => j.consecutiveFailures >= 3)
  if (backedOff.length) problems.push(`discovery job(s) backing off: ${backedOff.map(j => j.name).join(", ")}`)

  // ── Notifications and ntfy ─────────────────────────────────────────────────
  const channel = new NtfyChannel()
  const channelHealth = channel.health()
  const day = localDay(now, config)
  const queue = listQueue(db, 100)
  const queued = queue.filter(q => q.status === "QUEUED").length
  const failed = queue.filter(q => q.status === "FAILED").length
  console.log(`\nNotifications   ${notificationsEnabled(config) ? "ENABLED" : "DISABLED"} · threshold ${config.threshold} · ${isQuiet(now, config) ? "quiet hours" : "waking hours"}`)
  console.log(`  today         ${immediatesToday(db, day)}/${config.rateLimits.maxImmediatePerDay} immediate used (${day})`)
  console.log(`  queue         ${queued} queued, ${failed} failed`)
  console.log(`  sent ever     ${(db.prepare("SELECT COUNT(*) c FROM notifications").get() as any).c}`)
  console.log(`  channel       ${channelHealth.status}: ${channelHealth.detail}`)
  if (failed > 0) problems.push(`${failed} notification delivery(ies) FAILED - see notify:report`)

  // A live round trip to the ntfy service itself, not just config validation.
  const ntfyConfig = readNtfyConfig()
  if (ntfyConfig.ok) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(`${ntfyConfig.config.origin}/v1/health`, { signal: controller.signal })
      clearTimeout(timer)
      const body = await response.json() as { healthy?: boolean }
      console.log(`  ntfy service  ${body.healthy === true ? "healthy" : `UNHEALTHY (${response.status})`}`)
      if (body.healthy !== true) problems.push("the ntfy service answered but reports unhealthy")
    } catch {
      console.log("  ntfy service  UNREACHABLE")
      problems.push("the ntfy service is unreachable - deliveries will retry and then fail")
    }
  }

  // ── Providers and credentials ──────────────────────────────────────────────
  console.log(`\nProviders (24h failures)`)
  const failures = [...health.providerFailures24h, ...health.authFailures24h]
  if (failures.length === 0) console.log("  none")
  for (const event of failures.slice(0, 5)) {
    console.log(`  ${event.provider.padEnd(14)} ${event.kind} ×${event.count}  ${String(event.lastDetail ?? "").slice(0, 70)}`)
  }
  for (const warning of credentialWarnings(config, now)) {
    console.log(`  ⚠ ${warning}`)
    problems.push(warning)
  }

  // ── Backups, read back rather than trusted ─────────────────────────────────
  const backups = listBackups()
  const newest = backups[0]
  console.log(`\nBackups         ${backups.length} kept, newest ${newest ? age(newest.createdAt) : "NONE"}`)
  if (!newest) {
    problems.push("no backup exists yet")
  } else {
    try {
      const backupDb = new Database(newest.path, { readonly: true })
      const backupIntegrity = (backupDb.prepare("PRAGMA integrity_check").get() as any).integrity_check
      backupDb.close()
      console.log(`  latest        ${(fs.statSync(newest.path).size / 1e6).toFixed(1)} MB · integrity_check: ${backupIntegrity}`)
      if (backupIntegrity !== "ok") problems.push("THE LATEST BACKUP FAILS ITS INTEGRITY CHECK")
    } catch (err) {
      problems.push(`latest backup unreadable: ${(err as Error).message}`)
    }
  }

  // ── This process ───────────────────────────────────────────────────────────
  const cpu = process.cpuUsage()
  console.log(`\nThis process    ${gb(process.memoryUsage().rss)} RSS, ${((cpu.user + cpu.system) / 1e6).toFixed(1)}s CPU`)

  if (problems.length === 0) {
    console.log("\n✅ No warnings.")
  } else {
    console.log("")
    for (const problem of problems) console.log(`⚠️  ${problem}`)
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error("❌", (err as Error).message)
  process.exit(1)
})
