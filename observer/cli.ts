#!/usr/bin/env tsx
/**
 * Observer admin.
 *
 *   npx tsx observer/cli.ts seed              create/update jobs from config/travel-profile.json
 *   npx tsx observer/cli.ts status            jobs, lease, recent runs, budget projection
 *   npx tsx observer/cli.ts dry-run           what would run and what it would cost — ZERO external calls
 *   npx tsx observer/cli.ts run [name] [--force]   execute due jobs once (or one job) and exit
 *   npx tsx observer/cli.ts start             run the scheduler loop until stopped
 *   npx tsx observer/cli.ts stop              ask the running scheduler to exit
 *   npx tsx observer/cli.ts enable <name> / disable <name>
 */

import "../load-env.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { getDb } from "../db/index.js"
import { allUsage } from "../db/repositories.js"
import {
  upsertJob, listJobs, getJobByName, dueJobs, listRuns, readLease, requestStop, setJobEnabled,
} from "./store.js"
import { planRun, DEFAULT_DATE_STRATEGY } from "./sampling.js"
import { projectMonthlyBudget } from "./budget.js"
import { executeJob, awardProviderPreflight } from "./engine.js"
import { runScheduler } from "./scheduler.js"
import { observerHealth } from "./health.js"
import { backupDatabase, listBackups } from "../db/backup.js"
import type { DateStrategy, ObservationJob } from "./types.js"
import type { CabinClass } from "../providers/cash-flights/types.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROFILE_PATH = path.join(ROOT, "config", "travel-profile.json")

const [command, ...args] = process.argv.slice(2)

interface Profile {
  observer: {
    seedRoutes: { origin: string; destination: string; priority: number }[]
    cabins: CabinClass[]
    cashProviders: string[]
    awardProviders: string[]
    frequencyHours: number
    jitterMinutes: number
    dateStrategy: DateStrategy
  }
}

export function loadProfile(): Profile {
  return JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8")) as Profile
}

/** Create/update observation jobs from the travel profile. Idempotent. */
export function seedJobsFromProfile(db = getDb(), profile = loadProfile()): ObservationJob[] {
  const o = profile.observer
  const strategy: DateStrategy = { ...DEFAULT_DATE_STRATEGY, ...o.dateStrategy }
  const jobs: ObservationJob[] = []
  for (const route of o.seedRoutes) {
    jobs.push(upsertJob(db, {
      name: `${route.origin}-${route.destination}`,
      origin: route.origin,
      destination: route.destination,
      cabins: o.cabins,
      cashProviders: o.cashProviders,
      awardProviders: o.awardProviders,
      priority: route.priority,
      frequencyHours: o.frequencyHours,
      jitterMinutes: o.jitterMinutes,
      dateStrategy: strategy,
    }))
  }
  return jobs
}

function fmtAge(iso: string | null): string {
  if (!iso) return "never"
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (Math.abs(mins) < 60) return `${mins}m ${mins >= 0 ? "ago" : "ahead"}`
  const hours = Math.round(mins / 6) / 10
  return `${Math.abs(hours)}h ${mins >= 0 ? "ago" : "ahead"}`
}

function printProjection(db = getDb()): void {
  const projection = projectMonthlyBudget(db)
  console.log("\nProjected monthly usage (cold-cache ceiling):")
  for (const p of projection.providers) {
    const budget = p.budget === null ? "unmetered" : `budget ${p.budget}`
    const flag = p.withinBudget ? "✓" : "❌ OVER BUDGET"
    console.log(`  ${flag} ${p.provider.padEnd(13)} ~${String(p.monthlyCalls).padStart(5)} calls/mo  (${budget}, ${p.budgetSource}) — ${p.note}`)
  }
  if (!projection.ok) {
    console.log("\n❌ Budget conflicts — the scheduler will refuse to start:")
    for (const c of projection.conflicts) console.log(`   ${c}`)
  }
}

async function main() {
  const db = getDb()

  switch (command) {
    case "seed": {
      const jobs = seedJobsFromProfile(db)
      console.log(`✅ Seeded ${jobs.length} observation job(s) from ${path.relative(ROOT, PROFILE_PATH)}:`)
      for (const j of jobs) {
        console.log(`   ${j.name.padEnd(9)} p${j.priority}  every ${j.frequencyHours}h ±${j.jitterMinutes}m  cabins ${j.cabins.join("/")}  awards [${j.awardProviders.join(",") || "none"}]`)
      }
      printProjection(db)
      break
    }

    case "status": {
      const lease = readLease(db)
      console.log("Scheduler:")
      if (!lease) console.log("  not running (no lease)")
      else console.log(`  lease held by ${lease.holder}, heartbeat ${fmtAge(lease.heartbeatAt)}${lease.stopRequested ? " — STOP REQUESTED" : ""}`)

      const jobs = listJobs(db)
      console.log(`\nJobs (${jobs.length}):`)
      for (const j of jobs) {
        console.log(
          `  ${j.enabled ? "●" : "○"} ${j.name.padEnd(9)} p${j.priority}  every ${j.frequencyHours}h  ` +
          `last ${fmtAge(j.lastRunAt).padEnd(10)} next ${fmtAge(j.nextRunAt).padEnd(11)} ` +
          `runs ${j.runsCompleted}${j.consecutiveFailures ? `  ⚠ ${j.consecutiveFailures} consecutive failures` : ""}`
        )
      }

      const runs = listRuns(db, { limit: 8 })
      if (runs.length) {
        console.log(`\nRecent runs:`)
        for (const r of runs) {
          const job = jobs.find(j => j.id === r.jobId)
          console.log(
            `  #${r.id} ${(job?.name || r.jobId).toString().padEnd(9)} ${r.status.padEnd(12)} ` +
            `${r.searchesRun} searches, ${r.providerCalls} live, ${r.cacheHits} cached, ` +
            `${r.observationsAdded} obs, ${r.durationMs ?? "?"}ms (${fmtAge(r.startedAt)})`
          )
        }
      }

      const usage = allUsage(db)
      if (usage.length) {
        console.log(`\nProvider usage this month:`)
        for (const u of usage) console.log(`  ${u.provider.padEnd(13)} attempted=${u.attempted} ok=${u.succeeded} failed=${u.failed}`)
      }
      printProjection(db)
      break
    }

    case "dry-run": {
      // ZERO external calls: plans, sampled dates and cost ceilings only.
      const jobs = listJobs(db, { enabledOnly: true })
      if (jobs.length === 0) {
        console.log("No enabled jobs. Run: npm run observer:seed")
        break
      }
      console.log(`DRY RUN — nothing will be fetched.\n`)
      const totals = { cash: 0, roame: 0, atf: 0 }
      for (const job of jobs) {
        const plan = planRun(job)
        const due = !job.nextRunAt || new Date(job.nextRunAt) <= new Date()
        console.log(`${job.name} (run #${job.runsCompleted + 1}${due ? ", DUE NOW" : `, next ${fmtAge(job.nextRunAt)}`})`)
        console.log(`  dates: ${plan.datePairs.map(p => `${p.departureDate}+${p.tripLength}d`).join(", ")}`)
        console.log(`  cash searches: ${plan.cashSearches} (fast_flights, free)  awards this run: ${plan.awardsThisRun ? plan.awardSearches + " searches" : "no (every " + job.dateStrategy.awardEveryNRuns + ". run)"}`)
        console.log(`  expected live calls (cold cache): fast_flights ${plan.expected.fastFlights}, roame jobs ${plan.expected.roameJobs}, atf ${plan.expected.atfCalls}, serpapi 0`)
        const preflight = await awardProviderPreflight(job)
        for (const skipped of preflight.skipped) console.log(`  would SKIP ${skipped.provider}: ${skipped.reason.slice(0, 90)}`)
        totals.cash += plan.expected.fastFlights
        totals.roame += plan.expected.roameJobs
        totals.atf += plan.expected.atfCalls
        console.log()
      }
      console.log(`One full cycle of all enabled jobs (cold cache): fast_flights ${totals.cash}, roame ${totals.roame}, atf ${totals.atf}, serpapi 0`)
      printProjection(db)
      break
    }

    case "run": {
      const force = args.includes("--force")
      const name = args.find(a => !a.startsWith("--"))
      let jobs: ObservationJob[]
      if (name) {
        const job = getJobByName(db, name)
        if (!job) { console.error(`Unknown job: ${name}`); process.exit(1) }
        jobs = [job]
      } else {
        jobs = force ? listJobs(db, { enabledOnly: true }) : dueJobs(db)
        if (jobs.length === 0) { console.log("No jobs due. Use --force or a job name to run anyway."); break }
      }
      for (const job of jobs) {
        if (!job.enabled && !name) continue
        const result = await executeJob(job, { db, trigger: "manual" })
        console.log(`→ ${job.name}: ${result.status} — ${result.searchesRun} searches, ${result.providerCalls} live calls, ${result.cacheHits} cache hits, ${result.observationsAdded} observations in ${result.durationMs}ms`)
        if (result.errors.length) for (const e of result.errors.slice(0, 6)) console.log(`   ⚠ ${e}`)
      }
      break
    }

    case "start": {
      const reason = await runScheduler({ db })
      console.log(`Scheduler exited: ${reason}`)
      break
    }

    case "stop": {
      const lease = readLease(db)
      if (!lease) { console.log("No scheduler is running."); break }
      requestStop(db)
      console.log(`Stop requested — holder ${lease.holder} will exit on its next tick.`)
      break
    }

    case "health": {
      const h = observerHealth(db)
      const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`
      const dur = (sec: number | null) => sec === null ? "—"
        : sec < 3600 ? `${Math.round(sec / 60)}m`
        : sec < 86400 ? `${(sec / 3600).toFixed(1)}h` : `${(sec / 86400).toFixed(1)}d`

      console.log("Observer health\n")
      const s = h.scheduler
      console.log(`Scheduler          ${s.running ? (s.stale ? "STALE (lease held, heartbeat dead)" : "RUNNING") : "STOPPED"}`)
      if (s.running) {
        console.log(`  holder           ${s.holder}`)
        console.log(`  uptime           ${dur(s.uptimeSeconds)}  (${s.ticks ?? 0} ticks)`)
        console.log(`  last heartbeat   ${s.heartbeatAgeSeconds}s ago${s.stopRequested ? "  — STOP REQUESTED" : ""}`)
        console.log(`  footprint        ${s.rssBytes ? mb(s.rssBytes) : "—"} RSS, ${s.cpuSeconds ?? "—"}s CPU`)
      }

      const o = h.observation
      console.log(`\nLast observation   ${o.lastSuccessfulAt ?? "never"}${o.lastSuccessfulJob ? ` (${o.lastSuccessfulJob})` : ""}`)
      console.log(`Next scheduled     ${o.nextScheduledAt ?? "—"}${o.nextScheduledJob ? ` (${o.nextScheduledJob})` : ""}`)
      console.log(`Observations       ${o.totals.cash} cash + ${o.totals.award} award  |  24h: +${o.last24h.cash}/+${o.last24h.award}  7d: +${o.last7d.cash}/+${o.last7d.award}`)

      for (const [label, w] of [["24h", h.runs.last24h], ["7d", h.runs.last7d]] as const) {
        console.log(
          `Runs ${label.padEnd(15)}${w.total} (${w.success} ok, ${w.partial} partial, ${w.failed} failed, ${w.skippedAuth} auth-skipped)` +
          `  cache hit rate ${w.cacheHitRate === null ? "n/a" : w.cacheHitRate + "%"}  live calls ${w.providerCalls}`,
        )
      }

      if (h.missedRuns.length) {
        console.log(`\n⚠ Missed runs:`)
        for (const m of h.missedRuns) console.log(`   ${m.job} due ${m.dueAt} (${m.overdueHours}h overdue)`)
      }
      if (h.delayedRuns.length) {
        console.log(`\nDelayed runs (last 7d):`)
        for (const d of h.delayedRuns.slice(0, 5)) console.log(`   ${d.job} ran ${d.delayMinutes}m after ${d.scheduledFor}`)
      }
      if (h.backoff.length) {
        console.log(`\nBackoff active:`)
        for (const b of h.backoff) console.log(`   ${b.job}: ${b.consecutiveFailures} consecutive failures → interval x${b.multiplier}`)
      }
      if (h.authFailures24h.length || h.providerFailures24h.length) {
        console.log(`\nProvider problems (24h):`)
        for (const e of [...h.authFailures24h, ...h.providerFailures24h]) {
          console.log(`   ${e.provider.padEnd(13)} ${e.kind.padEnd(8)} x${e.count}  ${(e.lastDetail ?? "").slice(0, 90)}`)
        }
      }

      const r = h.resources
      console.log(`\nDatabase           ${mb(r.dbTotalBytes)} (${mb(r.dbBytes)} + ${mb(r.dbWalBytes)} WAL)`)
      console.log(`Backups            ${r.backupCount} kept (retain ${r.backupRetention}, every ${r.backupIntervalHours}h), newest ${r.backupNewestAt ?? "none"}, ${mb(r.backupBytes)} total`)
      console.log(`This process       ${mb(r.processRssBytes)} RSS, ${r.processCpuSeconds}s CPU, up ${dur(r.processUptimeSeconds)}`)

      if (h.warnings.length) {
        console.log(`\nWarnings:`)
        for (const warning of h.warnings) console.log(`   ⚠ ${warning}`)
      } else {
        console.log(`\n✅ No warnings.`)
      }
      break
    }

    case "backup": {
      const result = await backupDatabase(db)
      console.log(`✅ ${result.path}`)
      console.log(`   ${(result.bytes / 1e6).toFixed(1)} MB in ${result.durationMs}ms`)
      if (result.pruned.length) console.log(`   pruned ${result.pruned.length} old backup(s) beyond retention`)
      console.log(`   ${listBackups().length} backup(s) on disk`)
      break
    }

    case "enable":
    case "disable": {
      const name = args[0]
      if (!name) { console.error(`Usage: observer ${command} <job-name>`); process.exit(1) }
      const changed = setJobEnabled(db, name, command === "enable")
      console.log(changed ? `✅ ${name} ${command}d` : `Unknown job: ${name}`)
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  seed        create/update jobs from config/travel-profile.json
  status      jobs, lease, recent runs, usage, budget projection
  health      unattended-operation health: uptime, missed/delayed runs, failures, resources
  backup      take a timestamped SQLite backup now and apply retention
  dry-run     plans + expected cost, ZERO external calls
  run [name] [--force]  execute due jobs (or one job) once
  start       run the scheduler loop (blocks; Ctrl+C or observer:stop to end)
  stop        ask the running scheduler to exit
  enable <name> / disable <name>`)
      process.exit(command ? 1 : 0)
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("observer/cli.ts")
if (isMain) {
  main().catch(err => {
    console.error("❌", (err as Error).message)
    process.exit(1)
  })
}
