#!/usr/bin/env tsx
/**
 * Stay Radar admin (Phase 8a/8b).
 *
 *   npx tsx stays/cli.ts seed                 upsert the Luxury Universe into the db
 *   npx tsx stays/cli.ts properties [--all]   the Active Observation Set (--all: whole universe)
 *   npx tsx stays/cli.ts status               row counts + provider usage + scheduler state
 *   npx tsx stays/cli.ts health               provider health, breakers, ref health
 *   npx tsx stays/cli.ts rates [--property id] [--limit N]     recorded observations
 *   npx tsx stays/cli.ts triggers [--limit N] confirmation triggers + outcomes
 *   npx tsx stays/cli.ts dry-run [--limit N]  the exact next run plan, ZERO external calls
 *   npx tsx stays/cli.ts run [--limit N] [--property a,b]      one bounded scheduler run
 *   npx tsx stays/cli.ts start                the scheduler loop (until stop/signal)
 *   npx tsx stays/cli.ts stop                 request a running scheduler to stop
 *   npx tsx stays/cli.ts resolve-agoda [--property a,b] [--limit N]   resolve Agoda refs
 *   npx tsx stays/cli.ts observe …            (8a) manual ad-hoc observation, unchanged
 *
 * `run`/`start`/`observe`/`resolve-agoda` contact providers; everything else
 * is local database work. All provider spending is budget-ceilinged and a
 * provider failure is a reported line item, never a crash. Nothing here
 * books, pre-books, or holds anything — this system only looks.
 */

import "../load-env.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { getDb } from "../db/index.js"
import { getStayProviders, getStayProvider, runStayCalendarFetch, runStayRateSearch } from "../providers/stays/index.js"
import { XOTELO_PROVIDER } from "../providers/stays/xotelo.js"
import { AGODA_PROVIDER, resolveAgodaRef } from "../providers/stays/agoda.js"
import { readUsage } from "../db/repositories.js"
import { breakerState, confirmationsUsedToday } from "./budget.js"
import { loadStaysConfig } from "./config.js"
import { readStayLease, requestStayStop } from "./lease.js"
import {
  currentRunIndex,
  dryRunStayObservation,
  nextScheduledRunAt,
  runStayObservation,
  startStayScheduler,
} from "./observer.js"
import { loadStayUniverse, listStayProperties, seedStayProperties } from "./registry.js"
import {
  listConfirmationTriggers,
  rateHistory,
  recordCalendarObservations,
  recordRateObservations,
  recordStaySearchRequest,
  stayObservationCounts,
} from "./store.js"
import { evaluateStayObservations } from "./engine.js"
import { getStayCandidate, listStayCandidates, stayCandidateTotals } from "./candidates.js"
import { listStayWindows } from "./windows.js"
import { buildStayOpportunities } from "./opportunities.js"
import { listVerifications, runVerificationPass, selectVerificationTargets, verificationsUsedToday } from "./verification.js"
import { SERPAPI_HOTELS_PROVIDER } from "../providers/stays/serpapi-hotels.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CAPTURE_DIR = path.join(ROOT, "tests", "fixtures", "stays", "captured")

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
function has(name: string): boolean {
  return args.includes(`--${name}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

async function main() {
  const db = getDb()

  switch (command) {
    case "seed": {
      const universe = loadStayUniverse(true)
      const summary = seedStayProperties(db, universe)
      console.log(`Luxury Universe seeded: ${summary.inserted} inserted, ${summary.updated} updated, ${summary.refsWritten} provider refs.`)
      if (summary.orphaned.length) {
        console.log(`Deactivated (in db but no longer in config): ${summary.orphaned.join(", ")}`)
      }
      const active = listStayProperties(db, { activeOnly: true })
      console.log(`Active Observation Set: ${active.length} of ${universe.properties.length} properties.`)
      break
    }

    case "properties": {
      const all = has("all")
      const rows = listStayProperties(db, { activeOnly: !all })
      if (rows.length === 0) {
        console.log(all ? "No properties seeded yet — run stays:seed." : "Active Observation Set is empty.")
        break
      }
      console.log(all
        ? `Luxury Universe (${rows.length} properties; * = active):\n`
        : `Active Observation Set (${rows.length} properties):\n`)
      let group = ""
      for (const p of rows) {
        if (p.destinationGroup !== group) {
          group = p.destinationGroup
          console.log(`  ── ${group} ──`)
        }
        const refs = Object.keys(p.refs).length ? Object.keys(p.refs).join(",") : "NO REFS"
        console.log(
          `  ${p.active ? "*" : " "} P${p.priority} ${p.id.padEnd(32)} ${p.luxuryTier.padEnd(6)} ` +
          `AI:${p.allInclusive.padEnd(9)} ${p.nearestAirports.join("/").padEnd(7)} [${refs}]`,
        )
      }
      break
    }

    case "status": {
      const c = stayObservationCounts(db)
      console.log(`Stay Radar status\n`)
      console.log(`Properties          ${c.properties} (${c.activeProperties} active)`)
      console.log(`Provider refs       ${c.refs}`)
      console.log(`Search requests     ${c.searchRequests}`)
      console.log(`Rate observations   ${c.rateObservations}${c.suspiciousRates ? ` (${c.suspiciousRates} flagged SUSPICIOUS_DATA)` : ""}`)
      console.log(`Calendar days       ${c.calendarObservations}`)
      console.log(`Last fetch          ${c.lastFetchAt ?? "never"}`)
      const usage = readUsage(db, XOTELO_PROVIDER)
      console.log(`\nxotelo this period  ${usage.attempted} attempted, ${usage.succeeded} ok, ${usage.failed} failed` +
        `${usage.lastError ? `\n  last error: ${usage.lastError}` : ""}`)
      break
    }

    case "rates": {
      const rows = rateHistory(db, { propertyId: flag("property"), limit: Number(flag("limit") ?? 40) })
      if (rows.length === 0) { console.log("No rate observations recorded yet."); break }
      for (const r of rows) {
        console.log(
          `#${String(r.id).padEnd(5)} ${r.propertyId.padEnd(30)} ${r.checkIn} +${r.nights}n  ` +
          `${String(r.priceAmount).padStart(8)} ${r.priceCurrency}/${r.priceBasis} ` +
          `tax:${r.taxesFees.padEnd(8)} board:${r.board.padEnd(13)} via ${r.rateSource ?? "?"} ` +
          `(${r.provider}${r.sanity !== "ok" ? ", " + r.sanity : ""})`,
        )
      }
      break
    }

    case "observe": {
      await observe(db)
      break
    }

    case "dry-run": {
      const config = loadStaysConfig()
      const limit = flag("limit") ? Number(flag("limit")) : undefined
      const { plan, observable, skippedNoRef } = dryRunStayObservation(db, config, { limit })
      console.log(`Dry run for run index ${plan.runIndex} — ZERO external calls were made.\n`)
      console.log(`Observable properties  ${observable}${skippedNoRef.length ? ` (no xotelo ref: ${skippedNoRef.join(", ")})` : ""}`)
      console.log(`Planned requests       ${plan.plannedRequests} (ceiling ${limit ?? config.observation.maxRequestsPerRun})`)
      for (const item of plan.items) {
        console.log(`  ${item.property.id.padEnd(32)} ${item.checkIn} +${item.nights}n ${item.kind.padEnd(12)}${item.wantCalendar ? " +calendar" : ""}${item.detail ? `  (${item.detail})` : ""}`)
      }
      const targets = selectVerificationTargets(db, config)
      if (targets.length) {
        console.log(`\nVerification gate would consider (subject to run/day/month ceilings):`)
        for (const t of targets.slice(0, 5)) {
          console.log(`  ${t.propertyId.padEnd(32)} ${t.checkIn}  ${t.gateReason}: ${t.gateDetail}`)
        }
      }
      if (plan.scopeReduced.length) {
        console.log(`\nScope reduced:`)
        for (const s of plan.scopeReduced) console.log(`  - ${s}`)
      }
      console.log(`\nConfirmation tier: up to ${config.budgets.maxConfirmationsPerRun}/run, ` +
        `${confirmationsUsedToday(db)}/${config.budgets.maxConfirmationsPerDay} used today. ` +
        `Triggers decide spend at run time; a dry run cannot know them in advance.`)
      break
    }

    case "run": {
      const config = loadStaysConfig()
      const limit = flag("limit") ? Number(flag("limit")) : undefined
      const propertyIds = flag("property")?.split(",").map(s => s.trim()).filter(Boolean)
      const result = await runStayObservation({ db, config, trigger: "cli", limit, propertyIds })
      const c = result.counters
      console.log(`Run ${result.runId ?? "-"}: ${result.status} — ${result.detail}\n`)
      if (result.verification) {
        const ver = result.verification
        console.log(`Verification pass     ${ver.spent} spent, ${ver.refused} refused, ${ver.considered} gate-qualified`)
      }
      console.log(`Properties planned    ${c.propertiesPlanned}`)
      console.log(`Rates calls           ${c.ratesCalls}`)
      console.log(`Calendar calls        ${c.calendarCalls}`)
      console.log(`Confirmation calls    ${c.confirmationCalls}`)
      console.log(`Observations added    ${c.observationsAdded} (+${c.calendarDaysAdded} calendar days)`)
      console.log(`Triggers fired        ${c.triggersFired} (${c.confirmationsRecorded} confirmed)`)
      console.log(`Transport failures    ${c.transportFailures}, semantic errors ${c.semanticErrors}, empty ${c.emptyResults}`)
      if (c.scopeReduced.length) {
        console.log(`Scope reduced:`)
        for (const s of c.scopeReduced) console.log(`  - ${s}`)
      }
      if (c.errors.length) {
        console.log(`Errors:`)
        for (const e of c.errors) console.log(`  - ${e}`)
      }
      break
    }

    case "start": {
      const config = loadStaysConfig()
      console.log(`Stay scheduler starting: one run every ${config.scheduler.frequencyHours}h, ` +
        `tick ${config.scheduler.tickSeconds}s. Ctrl+C or \`stays:stop\` to stop.`)
      const outcome = await startStayScheduler({ db, config })
      console.log(`Stay scheduler: ${outcome}`)
      break
    }

    case "stop": {
      const requested = requestStayStop(db)
      console.log(requested
        ? "Stop requested — the scheduler will exit on its next tick."
        : "No scheduler lease found — nothing to stop.")
      break
    }

    case "health": {
      const config = loadStaysConfig()
      const lease = readStayLease(db)
      console.log(`Stay Radar health\n`)
      console.log(`Scheduler lease     ${lease.holder ?? "free"}${lease.heartbeatAgeSeconds !== null ? ` (heartbeat ${lease.heartbeatAgeSeconds}s ago)` : ""}${lease.stopRequested ? " STOP REQUESTED" : ""}`)
      console.log(`Run index           ${currentRunIndex(db)}; next scheduled ${nextScheduledRunAt(db) ?? "not scheduled"}`)
      console.log(`Confirmations today ${confirmationsUsedToday(db)}/${config.budgets.maxConfirmationsPerDay}`)
      for (const provider of getStayProviders()) {
        const health = await provider.health()
        const breaker = breakerState(db, provider.name)
        console.log(`\n${provider.name.padEnd(8)} ${health.status.toUpperCase().padEnd(10)} ${health.detail}`)
        if (breaker.open) console.log(`         BREAKER OPEN until ${breaker.until}: ${breaker.reason}`)
        const usage = readUsage(db, provider.name)
        console.log(`         this period: ${usage.attempted} attempted, ${usage.succeeded} ok, ${usage.failed} failed`)
      }
      const suspect = db.prepare(`
        SELECT property_id, provider, empty_streak, calendar_status FROM stay_property_refs
        WHERE empty_streak >= ? OR calendar_status = 'unsupported'
      `).all(config.budgets.emptyStreakSuspect) as { property_id: string; provider: string; empty_streak: number; calendar_status: string | null }[]
      if (suspect.length) {
        console.log(`\nRef health:`)
        for (const s of suspect) {
          const parts = []
          if (s.empty_streak >= config.budgets.emptyStreakSuspect) parts.push(`${s.empty_streak} consecutive empty answers`)
          if (s.calendar_status === "unsupported") parts.push("calendar unsupported")
          console.log(`  ${s.property_id} (${s.provider}): ${parts.join(", ")}`)
        }
      }
      break
    }

    case "triggers": {
      const rows = listConfirmationTriggers(db, { limit: Number(flag("limit") ?? 30) })
      if (rows.length === 0) { console.log("No confirmation triggers recorded yet."); break }
      for (const t of rows) {
        console.log(`#${String(t.id).padEnd(4)} ${t.propertyId.padEnd(30)} ${t.checkIn} → ${t.checkOut}  ${t.reason.padEnd(20)} ${t.status}`)
        console.log(`      ${(t.evidence.detail as string) ?? JSON.stringify(t.evidence)}`)
      }
      break
    }

    case "resolve-agoda": {
      await resolveAgoda(db)
      break
    }

    case "verify": {
      const config = loadStaysConfig()
      console.log(`Verification pass: gate-qualified candidates only, ceilings ` +
        `${config.anomaly.verification.maxPerRun}/run, ${verificationsUsedToday(db)}/${config.anomaly.verification.maxPerDay} today.`)
      const result = await runVerificationPass({
        db, config, provider: getStayProvider(SERPAPI_HOTELS_PROVIDER) ?? null,
      })
      console.log(`\nConsidered ${result.considered}, spent ${result.spent}, refused ${result.refused}, confirmed ${result.confirmed}`)
      for (const d of result.details) console.log(`  - ${d}`)
      break
    }

    case "verifications": {
      const rows = listVerifications(db, { limit: Number(flag("limit") ?? 20) })
      if (rows.length === 0) { console.log("No verification decisions recorded yet."); break }
      for (const v of rows) {
        console.log(`#${String(v.id).padEnd(4)} ${v.propertyId.padEnd(30)} ${v.checkIn} → ${v.checkOut}  ${v.status.padEnd(15)} ${v.gateReason}`)
        console.log(`      why: ${v.gateDetail}`)
        if (Object.keys(v.resultSummary).length) console.log(`      result: ${JSON.stringify(v.resultSummary)}`)
      }
      break
    }

    case "opportunities": {
      const opps = buildStayOpportunities(db, { limit: Number(flag("limit") ?? 10), minScore: Number(flag("min") ?? 35) })
      if (opps.length === 0) { console.log("No opportunities at this bar yet."); break }
      for (const o of opps) {
        console.log(`\n${String(o.scores.final).padStart(5)}  ${o.property.name} (${o.property.destinationGroup}, fly ${o.property.nearestAirports.join("/")})`)
        console.log(`       ${o.checkIn} → ${o.checkOut} (${o.nights}n ${o.product.board}, ${o.product.roomName ?? "property-level"})`)
        console.log(`       flex: ${o.flexWindow.earliestCheckIn}…${o.flexWindow.latestCheckIn} (${o.flexWindow.distinctCheckIns} check-ins, ${o.flexWindow.persistence}), nights ${o.flexWindow.nightsOptions.join("/")}`)
        console.log(`       ${o.pricing.nightly} ${o.pricing.currency}/nt (taxes ${o.pricing.taxStatus})${o.pricing.stayTotal ? `, stay ${o.pricing.stayTotal}` : ""}${o.pricing.cheapestNightlyInWindow ? `, window low ${o.pricing.cheapestNightlyInWindow}` : ""}`)
        console.log(`       scores: final ${o.scores.final} | rel ${o.scores.relative ?? "—"} | abs ${o.scores.absoluteValue ?? "—"} | evid ${o.scores.evidence ?? "—"} | act ${o.scores.actionability ?? "—"}`)
        console.log(`       sources: ${o.sourcePrices.map(s => `${s.provider}/${s.rateSource ?? "?"} ${s.nightly} (tax ${s.taxStatus}, ${s.verificationLevel})`).join(" · ")}`)
        if (o.evidence.cancellation) console.log(`       cancellation: ${o.evidence.cancellation.refundable ? "refundable" : "non-refundable"}${o.evidence.cancellation.deadline ? " until " + o.evidence.cancellation.deadline : ""} (${o.evidence.cancellation.source})`)
        console.log(`       ${o.reasons.join(" ")}`)
      }
      break
    }

    case "windows": {
      const rows = listStayWindows(db, { limit: Number(flag("limit") ?? 15) })
      if (rows.length === 0) { console.log("No opportunity windows — run stays:evaluate first."); break }
      for (const w of rows) {
        console.log(
          `${String(w.bestScore).padStart(5)}  ${w.propertyId.padEnd(30)} ${w.firstCheckIn}${w.distinctCheckIns > 1 ? ` → ${w.lastCheckIn}` : ""} ` +
          `${w.persistence.padEnd(10)} ${w.distinctCheckIns} check-in(s), ${w.memberCount} obs, ` +
          `${w.nightsMin === w.nightsMax ? w.nightsMin : `${w.nightsMin}-${w.nightsMax}`}n ${w.board} ${w.sourceClass} ` +
          `best ${w.bestNightly} ${w.currency}/nt`,
        )
      }
      break
    }

    case "evaluate": {
      const config = loadStaysConfig()
      const fromScratch = has("backfill")
      console.log(fromScratch
        ? "Re-judging EVERY stored stay observation against only its own past (no look-ahead)."
        : "Judging stay observations recorded since the last evaluation.")
      const summary = evaluateStayObservations({ db, config, fromScratch })
      console.log(`\nEvaluated            ${summary.evaluated}`)
      console.log(`Candidates >= ${config.anomaly.candidateThreshold}     ${summary.candidates}`)
      console.log(`Below threshold      ${summary.belowThreshold} (stored for review)`)
      console.log(`Suspicious           ${summary.suspicious}`)
      console.log(`Skipped lead-ins     ${summary.skippedLeadIn}`)
      console.log(`Top score            ${summary.topScore ?? "n/a"}`)
      console.log(`Duration             ${summary.durationMs}ms`)
      console.log(`\nSHADOW — decisions stored, nothing sent, nothing spent.`)
      break
    }

    case "candidates": {
      const config = loadStaysConfig()
      const min = Number(flag("min") ?? config.anomaly.candidateThreshold)
      const rows = listStayCandidates(db, {
        minScore: Number.isFinite(min) ? min : config.anomaly.candidateThreshold,
        limit: Number(flag("limit") ?? 20),
        propertyId: flag("property"),
      }).filter(c => c.status !== "suspicious")
      if (rows.length === 0) { console.log(`No stay decisions at or above ${min}.`); break }
      console.log(`Stay opportunities >= ${min} (SHADOW — no alerts exist)\n`)
      for (const c of rows) {
        const baselineText = c.sampleSize > 0
          ? `vs median ${c.observedMedian} (${c.percentBelowMedian}% below, ${c.percentile}th pct of ${c.sampleSize} obs, ${c.baselineConfidence})`
          : "no baseline"
        console.log(
          `#${String(c.id).padEnd(4)} ${String(c.score).padStart(5)}  ${c.propertyId.padEnd(28)} ` +
          `${c.checkIn} +${c.nights}n  ${String(c.nightlyAmount).padStart(7)} ${c.priceCurrency}/nt ` +
          `${c.board.padEnd(13)} ${c.sourceClass.padEnd(6)} [${c.confirmationState}]`,
        )
        console.log(
          `       rel ${c.relativeScore ?? "—"} | abs ${c.absoluteValueScore ?? "—"} | ` +
          `evid ${c.evidenceScore ?? "—"} | act ${c.actionabilityScore ?? "—"}   ${baselineText}` +
          `${c.absoluteTier ? `  ABS:${c.absoluteTier}` : ""}`,
        )
        console.log(`       ${c.reasons.join(" ")}`)
      }
      break
    }

    case "show": {
      const id = Number(args[0])
      const c = id ? getStayCandidate(db, id) : null
      if (!c) { console.error(`Unknown stay candidate: ${args[0]}`); process.exit(1) }
      console.log(JSON.stringify(c, null, 2))
      break
    }

    case "report": {
      const totals = stayCandidateTotals(db)
      const counts = stayObservationCounts(db)
      console.log(`Stay Radar judgement report\n`)
      console.log(`Observations         ${counts.rateObservations} rates, ${counts.calendarObservations} calendar days`)
      console.log(`Decisions stored     ${totals.decisions} (candidates ${totals.candidates}, below ${totals.belowThreshold}, suspicious ${totals.suspicious})`)
      console.log(`Evidence mix         meta-only ${totals.metaOnly}, retail-confirmed ${totals.retailConfirmed}, retail ${totals.retail}`)
      console.log(`Top score            ${totals.topScore ?? "n/a"}`)
      const byProperty = db.prepare(`
        SELECT property_id, COUNT(*) n, MAX(score) top, AVG(score) avg
        FROM stay_candidates WHERE status != 'suspicious'
        GROUP BY property_id ORDER BY top DESC LIMIT 15
      `).all() as { property_id: string; n: number; top: number; avg: number }[]
      if (byProperty.length) {
        console.log(`\nPer property (decisions / top / avg):`)
        for (const p of byProperty) {
          console.log(`  ${p.property_id.padEnd(30)} ${String(p.n).padStart(4)}  top ${p.top.toFixed(1)}  avg ${p.avg.toFixed(1)}`)
        }
      }
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  seed                        upsert config/stay-properties.json into the database
  properties [--all]          list the Active Observation Set (--all for the whole universe)
  status                      row counts, provider usage, scheduler state
  health                      provider health, circuit breakers, ref health
  rates [--property id] [--limit N]
  triggers [--limit N]        confirmation triggers and their outcomes
  dry-run [--limit N]         the exact next run plan — zero external calls
  run [--limit N] [--property a,b]    one bounded scheduler run (lease-guarded)
  start / stop                the scheduler loop / ask it to stop
  resolve-agoda [--property a,b] [--limit N]    resolve Agoda property refs
  evaluate [--backfill]       judge stored observations (database-only, spends nothing)
  candidates [--min N] [--limit N] [--property id]   scored opportunities
  windows [--limit N]         opportunity windows (neighbouring cheap check-ins grouped)
  verify                      run the METERED verification gate (spends SerpAPI, ceilinged)
  verifications [--limit N]   every paid-verification decision and its recorded WHY
  show <id>                   one decision in full, including its score breakdown
  report                      judgement totals and per-property picture
  observe [--property a,b] [--check-in YYYY-MM-DD] [--nights N]
          [--mode rates|calendar|both] [--limit N] [--capture]

run/start/observe/resolve-agoda contact providers, budget-ceilinged and paced.
Nothing here can book, hold, or spend money — the Stay Radar only looks.`)
      process.exit(command ? 1 : 0)
  }
}

async function observe(db: ReturnType<typeof getDb>): Promise<void> {
  const config = loadStaysConfig()
  const provider = getStayProvider(XOTELO_PROVIDER)
  if (!provider) { console.error("xotelo provider is not registered"); process.exit(1) }

  const mode = (flag("mode") ?? "both") as "rates" | "calendar" | "both"
  if (!["rates", "calendar", "both"].includes(mode)) {
    console.error(`--mode must be rates|calendar|both, got ${mode}`)
    process.exit(1)
  }
  const capture = has("capture")

  // --limit may lower the config ceiling, never raise it.
  const configCeiling = config.observation.maxRequestsPerRun
  const requested = Number(flag("limit") ?? configCeiling)
  const budget = Math.max(1, Math.min(configCeiling, Number.isFinite(requested) ? requested : configCeiling))

  const wanted = flag("property")?.split(",").map(s => s.trim()).filter(Boolean)
  const all = listStayProperties(db, { activeOnly: !wanted })
  const pool = wanted ? all.filter(p => wanted.includes(p.id)) : all
  if (wanted) {
    for (const id of wanted) {
      if (!pool.some(p => p.id === id)) console.log(`(unknown property: ${id})`)
    }
  }
  const observable = pool.filter(p => p.refs[provider.name])
  const skipped = pool.filter(p => !p.refs[provider.name])
  if (skipped.length) {
    console.log(`No ${provider.name} ref (skipped): ${skipped.map(p => p.id).join(", ")}`)
  }
  if (observable.length === 0) { console.log("Nothing to observe."); return }

  const checkIn = flag("check-in") ?? addDays(config.observation.defaultCheckInOffsetDays)
  console.log(
    `Observing up to ${budget} requests across ${observable.length} properties ` +
    `(mode ${mode}, check-in ${checkIn}, currency ${config.observation.currency})\n`,
  )
  if (capture) fs.mkdirSync(CAPTURE_DIR, { recursive: true })

  let spent = 0
  let ratesRecorded = 0
  let daysRecorded = 0
  let failures = 0
  const unresolved: string[] = []

  for (const property of observable) {
    if (spent >= budget) { console.log(`\nRequest budget (${budget}) reached — stopping with properties left over.`); break }
    const ref = property.refs[provider.name]
    const nights = Number(flag("nights") ?? property.typicalStayNights[0] ?? config.observation.defaultNights)
    const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)

    if (mode !== "calendar") {
      if (spent > 0) await sleep(config.observation.politeDelayMs)
      spent++
      const result = await runStayRateSearch(provider, {
        propertyId: property.id, providerRef: ref,
        checkIn, checkOut,
        adults: config.observation.adults, children: config.observation.children,
        currency: config.observation.currency,
      }, { captureRaw: capture })
      if (result.ok) {
        const requestId = recordStaySearchRequest(db, {
          propertyId: property.id, kind: "rates", checkIn, checkOut,
          adults: config.observation.adults, children: config.observation.children,
          currency: config.observation.currency, source: "cli",
        })
        const summary = recordRateObservations(db, property, requestId, result.rates, config.sanity)
        ratesRecorded += summary.inserted
        const cheapest = result.rates.reduce((a, b) => (a.price.amount <= b.price.amount ? a : b))
        console.log(
          `  ${property.id.padEnd(30)} rates    ${summary.inserted} OTA quotes ` +
          `(low ${cheapest.price.amount} ${cheapest.price.currency}/night via ${cheapest.rateSource})` +
          `${summary.suspicious ? `, ${summary.suspicious} flagged` : ""}`,
        )
        if (capture && result.raw !== undefined) {
          const file = path.join(CAPTURE_DIR, `xotelo-rates-${property.id}-${checkIn}.json`)
          fs.writeFileSync(file, JSON.stringify(result.raw, null, 2))
        }
      } else {
        failures++
        if (result.reason === "no-results") unresolved.push(property.id)
        console.log(`  ${property.id.padEnd(30)} rates    FAILED (${result.reason}): ${result.error}`)
      }
    }

    if (mode !== "rates" && spent < budget) {
      await sleep(config.observation.politeDelayMs)
      spent++
      const result = await runStayCalendarFetch(provider, {
        propertyId: property.id, providerRef: ref,
        horizonDays: config.observation.calendarHorizonDays,
      }, { captureRaw: capture })
      if (result.ok) {
        const requestId = recordStaySearchRequest(db, {
          propertyId: property.id, kind: "calendar",
          currency: config.observation.currency, source: "cli",
        })
        daysRecorded += recordCalendarObservations(db, property, provider.name, ref, requestId, result.days)
        const byClass = { cheap: 0, average: 0, high: 0 }
        for (const d of result.days) byClass[d.dayClass]++
        console.log(
          `  ${property.id.padEnd(30)} calendar ${result.days.length} days ` +
          `(${byClass.cheap} cheap / ${byClass.average} avg / ${byClass.high} high)`,
        )
        if (capture && result.raw !== undefined) {
          const file = path.join(CAPTURE_DIR, `xotelo-heatmap-${property.id}.json`)
          fs.writeFileSync(file, JSON.stringify(result.raw, null, 2))
        }
      } else {
        failures++
        console.log(`  ${property.id.padEnd(30)} calendar FAILED (${result.reason}): ${result.error}`)
      }
    }
  }

  console.log(`\nRequests spent      ${spent} of ${budget}`)
  console.log(`Rates recorded      ${ratesRecorded}`)
  console.log(`Calendar days       ${daysRecorded}`)
  console.log(`Failures            ${failures}`)
  if (unresolved.length) console.log(`No results (ref may be wrong or unlisted): ${unresolved.join(", ")}`)
}

/**
 * Resolve Agoda refs for properties that lack one. One suggest request per
 * property, paced; a confident match writes the ref, anything else is
 * reported and left unresolved — a wrong ref poisons history invisibly.
 */
async function resolveAgoda(db: ReturnType<typeof getDb>): Promise<void> {
  const config = loadStaysConfig()
  const wanted = flag("property")?.split(",").map(s => s.trim()).filter(Boolean)
  const all = listStayProperties(db, { activeOnly: !wanted })
  const pool = (wanted ? all.filter(p => wanted.includes(p.id)) : all)
    .filter(p => !p.refs[AGODA_PROVIDER])
  const limit = Math.min(pool.length, Number(flag("limit") ?? 10))
  if (pool.length === 0) { console.log("Nothing to resolve — all selected properties have Agoda refs."); return }
  console.log(`Resolving Agoda refs for ${limit} of ${pool.length} unresolved properties…\n`)

  let resolved = 0
  for (const property of pool.slice(0, limit)) {
    const outcome = await resolveAgodaRef(property.name, { db })
    if ("error" in outcome) {
      console.log(`  ${property.id.padEnd(32)} UNRESOLVED: ${outcome.error}`)
    } else {
      db.prepare(`
        INSERT INTO stay_property_refs (property_id, provider, ref) VALUES (?, ?, ?)
        ON CONFLICT(property_id, provider) DO UPDATE SET ref = excluded.ref
      `).run(property.id, AGODA_PROVIDER, outcome.ref)
      resolved++
      console.log(`  ${property.id.padEnd(32)} ${outcome.ref}  ("${outcome.matchedName}"${outcome.geo ? `, ${outcome.geo}` : ""})`)
    }
    await new Promise(r => setTimeout(r, config.budgets.confirmationDelayMs))
  }
  console.log(`\nResolved ${resolved}/${limit}. Refs are written to stay_property_refs (not the config file).`)
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("stays/cli.ts")
if (isMain) {
  main().catch(err => {
    console.error("❌", (err as Error).message)
    process.exit(1)
  })
}
