#!/usr/bin/env tsx
/**
 * Discovery admin.
 *
 *   npx tsx discovery/cli.ts seed           create/update jobs from config/discovery.json
 *   npx tsx discovery/cli.ts status         jobs, recent runs, budget projection
 *   npx tsx discovery/cli.ts dry-run        what a cycle would do and cost - ZERO calls
 *   npx tsx discovery/cli.ts run [name]     execute one cycle now
 *   npx tsx discovery/cli.ts openjaw <DEST> open jaws from existing observations - ZERO calls
 *   npx tsx discovery/cli.ts positioning <DEST>  positioning comparison - ZERO calls
 *   npx tsx discovery/cli.ts clusters       the deal families the feed shows
 *   npx tsx discovery/cli.ts enable|disable <name>
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { loadDiscoveryConfig, originsFor } from "./config.js"
import {
  upsertDiscoveryJob, listDiscoveryJobs, getDiscoveryJobByName, dueDiscoveryJobs,
  listDiscoveryRuns, setDiscoveryJobEnabled,
} from "./store.js"
import { planDiscoveryRun, executeDiscoveryJob } from "./engine.js"
import { projectDiscoveryBudget, discoveryVerificationPool } from "./budget.js"
import { routesFor } from "./sampling.js"
import { findOpenJaws } from "./openjaw.js"
import { assessPositioning, bestHomeFare } from "./positioning.js"
import { listClusters, rebuildClusters } from "../anomaly/clustering.js"
import type { DiscoveryJob } from "./types.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

function fmtAge(iso: string | null): string {
  if (!iso) return "never"
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (Math.abs(mins) < 60) return `${mins}m ${mins >= 0 ? "ago" : "ahead"}`
  const hours = Math.round(mins / 6) / 10
  return `${Math.abs(hours)}h ${mins >= 0 ? "ago" : "ahead"}`
}

/** Create/update discovery jobs from config. Idempotent. */
export function seedDiscoveryJobs(db = getDb(), config = loadDiscoveryConfig()): DiscoveryJob[] {
  const jobs: DiscoveryJob[] = []
  for (const j of config.jobs) {
    const group = config.destinationGroups[j.destinationGroup]
    jobs.push(upsertDiscoveryJob(db, {
      name: j.name,
      originGroup: j.originGroup,
      destinationGroup: j.destinationGroup,
      horizonDays: j.horizonDays,
      tripLengths: group?.tripLengths ?? [7, 10, 14],
      cabins: j.cabins,
      frequencyHours: j.frequencyHours,
      priority: j.priority,
      budget: {
        ...config.budgets,
        maxDestinations: j.maxDestinations ?? null,
        datesPerRoute: j.datesPerRoute ?? null,
      },
      enabled: j.enabled,
    }))
  }
  return jobs
}

function printProjection(db = getDb()): void {
  const p = projectDiscoveryBudget(db)
  console.log("\nProjected monthly discovery usage (cold-cache ceiling):")
  for (const job of p.jobs) {
    console.log(
      `  ${job.name.padEnd(30)} ${String(job.routes).padStart(3)} routes  ` +
      `${String(job.stage1Searches).padStart(4)} sparse searches/run  ` +
      `${job.runsPerMonth} runs/mo  ~${job.monthlyFreeCalls} free calls/mo`,
    )
  }
  console.log(
    `  TOTAL: ~${p.totals.monthlyFreeCalls} free, ` +
    `<=${p.totals.monthlyAwardCallsMax} award, ` +
    `<=${p.totals.monthlyMeteredCallsEffective} metered per month ` +
    `(the schedule could ask for ${p.totals.monthlyMeteredCallsMax}; the pool decides)`,
  )
  const pool = p.serpapi
  console.log(
    `  SerpAPI: discovery pool ${pool.remaining}/${pool.discoveryCeiling} left ` +
    `(automation ceiling ${pool.automationCeiling}, manual reserve ${pool.manualReserve} untouchable)`,
  )
  for (const w of p.warnings) console.log(`  ⚠ ${w}`)
  if (!p.ok) for (const c of p.conflicts) console.log(`  ❌ ${c}`)
}

async function main() {
  const db = getDb()
  const config = loadDiscoveryConfig()

  switch (command) {
    case "seed": {
      const jobs = seedDiscoveryJobs(db, config)
      console.log(`✅ Seeded ${jobs.length} discovery job(s):`)
      for (const j of jobs) {
        const routes = routesFor(j, config).length
        console.log(
          `   ${j.name.padEnd(30)} ${j.originGroup.padEnd(11)} -> ${j.destinationGroup.padEnd(10)} ` +
          `${routes} routes, every ${j.frequencyHours}h, cabins ${j.cabins.join("/")}`,
        )
      }
      printProjection(db)
      break
    }

    case "status": {
      const jobs = listDiscoveryJobs(db)
      console.log(`Discovery jobs (${jobs.length}):`)
      for (const j of jobs) {
        console.log(
          `  ${j.enabled ? "●" : "○"} ${j.name.padEnd(30)} p${j.priority} every ${j.frequencyHours}h  ` +
          `last ${fmtAge(j.lastRunAt).padEnd(12)} next ${fmtAge(j.nextRunAt).padEnd(12)} runs ${j.runsCompleted}` +
          `${j.consecutiveFailures ? `  ⚠ ${j.consecutiveFailures} consecutive failures` : ""}`,
        )
      }

      const runs = listDiscoveryRuns(db, { limit: 8 })
      if (runs.length) {
        console.log(`\nRecent discovery runs:`)
        for (const r of runs) {
          const job = jobs.find(j => j.id === r.jobId)
          console.log(
            `  #${r.id} ${(job?.name ?? r.jobId).toString().padEnd(30)} ${r.status.padEnd(14)} ` +
            `${r.stage1Searches}+${r.stage2Searches} searches, ${r.freeCalls} free, ${r.awardCalls} award, ` +
            `${r.meteredCalls} metered, ${r.cacheHits} cached, ${r.candidatesProduced} candidates, ` +
            `${r.durationMs ?? "?"}ms (${fmtAge(r.startedAt)})`,
          )
          if (r.scopeReduced) console.log(`      scope reduced: ${r.scopeReduced}`)
        }
      }
      printProjection(db)
      break
    }

    case "dry-run": {
      const jobs = listDiscoveryJobs(db, { enabledOnly: true })
      if (jobs.length === 0) { console.log("No enabled discovery jobs. Run: npm run discovery:seed"); break }
      console.log("DRY RUN - nothing will be fetched.\n")

      let totalSparse = 0
      for (const job of jobs) {
        const plan = planDiscoveryRun(job, job.runsCompleted, config)
        const due = !job.nextRunAt || new Date(job.nextRunAt) <= new Date()
        console.log(`${job.name} (run #${job.runsCompleted + 1}${due ? ", DUE NOW" : `, next ${fmtAge(job.nextRunAt)}`})`)
        console.log(`  routes: ${plan.routes.length} (${plan.routes.slice(0, 6).map(r => `${r.origin}-${r.destination}`).join(", ")}${plan.routes.length > 6 ? ", ..." : ""})`)
        console.log(`  stage 1: ${plan.stage1.length} sparse searches`)
        console.log(`  stage 2 ceiling: ${plan.estimatedStage2Max} dense searches (only where stage 1 finds something)`)
        console.log(`  expected: ${plan.expected.freeCalls} free, <=${plan.expected.awardCalls} award, <=${plan.expected.meteredCalls} metered`)
        if (plan.scopeReduced) console.log(`  ⚠ ${plan.scopeReduced}`)
        totalSparse += plan.stage1.length
        console.log()
      }
      console.log(`One full cycle of every enabled job: ${totalSparse} sparse searches, all on the free provider.`)
      printProjection(db)
      break
    }

    case "run": {
      const name = args.find(a => !a.startsWith("--"))
      const cashOnly = args.includes("--cash-only")
      const jobs = name
        ? [getDiscoveryJobByName(db, name)].filter(Boolean) as DiscoveryJob[]
        : dueDiscoveryJobs(db)
      if (jobs.length === 0) { console.log("No discovery jobs due. Pass a job name to run one anyway."); break }

      for (const job of jobs) {
        const execution = await executeDiscoveryJob(job, { db, trigger: "manual", cashOnly })
        const r = execution.result
        console.log(
          `→ ${job.name}: ${r.status} - ${r.routesSampled} routes, ` +
          `${r.stage1Searches} sparse + ${r.stage2Searches} dense searches, ` +
          `${r.freeCalls} free calls, ${r.awardCalls} award, ${r.meteredCalls} metered, ` +
          `${r.cacheHits} cache hits, ${r.observationsAdded} observations, ` +
          `${r.candidatesProduced} candidates, ${(r.durationMs / 1000).toFixed(1)}s`,
        )
        if (r.scopeReduced) console.log(`   scope reduced: ${r.scopeReduced}`)
        for (const e of r.errors.slice(0, 5)) console.log(`   ⚠ ${e}`)
      }
      break
    }

    case "openjaw": {
      const destination = (args[0] || "").toUpperCase()
      if (!destination) { console.error("Usage: discovery openjaw <DESTINATION>"); process.exit(1) }
      const cabin = flag("cabin") ?? "economy"
      const from = flag("from") ?? new Date().toISOString().slice(0, 10)
      const to = flag("to") ?? new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10)

      const options = {
        cabin, currency: process.env.CASH_CURRENCY || "USD",
        asOf: new Date().toISOString(),
        window: { from, to },
        tripLengths: config.destinationGroups.thailand?.tripLengths ?? [7, 10, 14, 21],
        includeNonQualifying: true,
      }
      const all = findOpenJaws(db, destination, options, config)
      const jaws = all.filter(j => j.qualifies)
      console.log(`Open jaws to ${destination} (${cabin}) from stored observations - no provider was called.\n`)
      if (all.length === 0) {
        console.log("No combination could even be assembled: there are no stored one-way legs for")
        console.log("these routes in this window. Discovery collects them as it runs.")
        break
      }
      if (jaws.length === 0) {
        console.log(`None qualified. ${all.length} combination(s) were evaluated and rejected -`)
        console.log(`here is the arithmetic, rather than a blank answer:\n`)
        for (const jaw of all.slice(0, 3)) {
          console.log(
            `  ${jaw.outbound.origin}->${jaw.outbound.destination} ${jaw.outbound.departureDate} ` +
            `${jaw.outbound.price} + ${jaw.inbound.origin}->${jaw.inbound.destination} ` +
            `${jaw.inbound.departureDate} ${jaw.inbound.price} = ${jaw.totalPrice} ${jaw.currency}`,
          )
          console.log(`      vs best round trip ${jaw.comparableRoundTrip} -> ${jaw.saving} (${jaw.savingPercent}%)`)
        }
        break
      }
      for (const jaw of jaws.slice(0, 10)) {
        console.log(
          `  ${jaw.outbound.origin}->${jaw.outbound.destination} ${jaw.outbound.departureDate} ` +
          `${jaw.outbound.price} + ${jaw.inbound.origin}->${jaw.inbound.destination} ` +
          `${jaw.inbound.departureDate} ${jaw.inbound.price} = ${jaw.totalPrice} ${jaw.currency}`,
        )
        console.log(
          `      vs best round trip ${jaw.comparableRoundTrip} -> saves ${jaw.saving} ` +
          `(${jaw.savingPercent}%), ${jaw.tripLengthNights} nights`,
        )
      }
      break
    }

    case "positioning": {
      const destination = (args[0] || "").toUpperCase()
      if (!destination) { console.error("Usage: discovery positioning <DESTINATION>"); process.exit(1) }
      const cabin = flag("cabin") ?? "economy"
      const currency = process.env.CASH_CURRENCY || "USD"
      const asOf = new Date().toISOString()

      // Round trips only, on both sides. A one-way positioning fare next to a
      // home round trip is not a comparison, it is a category error that always
      // makes positioning look brilliant.
      const tripType = "return" as const
      const home = bestHomeFare(db, destination, cabin, currency, asOf, config, { tripType })
      console.log(`Positioning comparison for ${destination} (${cabin}, return trips), from stored observations.\n`)
      console.log(`Best observed return fare from a home airport: ${home ?? "none observed"} ${home ? currency : ""}\n`)

      for (const airport of originsFor("positioning", config)) {
        const observed = db.prepare(`
          SELECT price_amount price, departure_date, departure_time
          FROM flight_prices WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
            AND return_date IS NOT NULL
          ORDER BY price_amount ASC LIMIT 1
        `).get(airport, destination, cabin, currency) as { price: number | null; departure_date: string; departure_time: string | null }
        if (!observed?.price) {
          console.log(`  ${airport}: no fare observed yet`)
          continue
        }
        const a = assessPositioning(db, {
          positioningAirport: airport, destination,
          departureDate: observed.departure_date, departureTime: observed.departure_time,
          cabin, mainFare: observed.price, currency, asOf, tripType,
        }, config)
        console.log(
          `  ${airport}: fare ${a.mainFare} + ${a.mode} ${a.positioningCost}` +
          `${a.overnightCost ? ` + hotel ${a.overnightCost}` : ""} = ` +
          `TRUE START COST ${a.trueTripStartCost} ${a.currency}`,
        )
        console.log(
          `      vs home ${a.comparableHomeFare ?? "?"} -> saving ${a.savingVsHome ?? "?"} ` +
          `(${a.savingPercent ?? "?"}%), penalty ${a.penalty} ` +
          `[${a.penaltyReasons.join("; ")}] -> ${a.worthwhile ? "WORTH IT" : "not worth it"}`,
        )
      }
      break
    }

    case "clusters": {
      const result = rebuildClusters(db, { minScore: Number(flag("min") ?? 0) })
      console.log(`Rebuilt ${result.clusters} clusters from ${result.candidatesClustered} candidates (largest family: ${result.largestCluster})\n`)
      for (const c of listClusters(db, { minScore: Number(flag("min") ?? 70), limit: 20 })) {
        const value = c.type === "cash"
          ? `${c.bestPrice} ${c.bestCurrency}`
          : `${(c.bestPoints ?? 0).toLocaleString("en-US")} pts`
        const dates = c.earliestDeparture === c.latestDeparture
          ? c.earliestDeparture
          : `${c.earliestDeparture} - ${c.latestDeparture}`
        console.log(
          `  ${String(c.bestScore).padStart(5)}  ${c.route} ${c.cabin.padEnd(9)} from ${value}  ` +
          `${dates}  (${c.memberCount} date${c.memberCount === 1 ? "" : "s"}, ${c.discoveredBy})`,
        )
      }
      break
    }

    case "pool": {
      const pool = discoveryVerificationPool(db, config)
      console.log("SerpAPI verification pools:")
      console.log(`  monthly budget      ${pool.monthlyBudget}`)
      console.log(`  manual reserve      ${pool.manualReserve}  (never reachable from an automated path)`)
      console.log(`  automation ceiling  ${pool.automationCeiling}`)
      console.log(`  discovery pool      ${pool.discoveryCeiling}  (${Math.round(config.verification.pools.automatedShare * 100)}% of automation)`)
      console.log(`  used this month     ${pool.used}`)
      console.log(`  discovery remaining ${pool.remaining}`)
      break
    }

    case "enable":
    case "disable": {
      const name = args[0]
      if (!name) { console.error(`Usage: discovery ${command} <job-name>`); process.exit(1) }
      const changed = setDiscoveryJobEnabled(db, name, command === "enable")
      console.log(changed ? `✅ ${name} ${command}d` : `Unknown discovery job: ${name}`)
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  seed                      create/update discovery jobs from config/discovery.json
  status                    jobs, recent runs, budget projection
  dry-run                   planned scope and cost, ZERO calls
  run [name] [--cash-only]  execute one discovery cycle
  openjaw <DEST>            open-jaw combinations from stored observations, ZERO calls
  positioning <DEST>        true-trip-start-cost comparison, ZERO calls
  clusters [--min N]        rebuild and list deal families
  pool                      SerpAPI verification pools
  enable <name> / disable <name>`)
      process.exit(command ? 1 : 0)
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("discovery/cli.ts")
if (isMain) {
  main().catch(err => {
    console.error("❌", (err as Error).message)
    process.exit(1)
  })
}
