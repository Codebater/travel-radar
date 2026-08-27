/**
 * Observer engine: execute one observation job.
 *
 * Discipline: cache → free discovery. Metered cash fallback is forbidden
 * (allowMeteredFallback: false), the award layer's own per-provider cache and
 * quota guards apply, and every search joins one search_requests row per
 * date-pair with source "observer". Observations land in flight_prices /
 * award_prices exactly like interactive searches — same tables, same quality
 * metadata (provider, verification level, confidence, fetched time), plus the
 * run row that says what it cost.
 */

import { getDb, type DB } from "../db/index.js"
import { recordSearchRequest } from "../db/repositories.js"
import { searchCashFlights } from "../providers/cash-flights/index.js"
import { searchAwardFlights, getAwardProviders } from "../providers/award-flights/index.js"
import {
  startRun, finishRun, completeJobRun, hasRunningRun,
} from "./store.js"
import { planRun, cabinsToSearchClass } from "./sampling.js"
import type { ObservationJob, ObservationRun, RunPlan, RunStatus } from "./types.js"

const CASH_CURRENCY = process.env.CASH_CURRENCY || "USD"

export interface ExecutionResult {
  runId: number | null
  status: RunStatus
  plan: RunPlan
  searchesRun: number
  providerCalls: number
  cacheHits: number
  observationsAdded: number
  errors: string[]
  durationMs: number
  skippedProviders: string[]
}

/**
 * Which of the job's award providers are actually worth calling right now.
 * Expired sessions and missing keys are skipped BEFORE launching doomed
 * searches (recorded as skipped, not failed) — nobody hammers a broken
 * authentication endpoint on a schedule.
 */
export async function awardProviderPreflight(job: ObservationJob): Promise<{ usable: string[]; skipped: { provider: string; reason: string }[] }> {
  const usable: string[] = []
  const skipped: { provider: string; reason: string }[] = []

  for (const name of job.awardProviders) {
    const provider = getAwardProviders().find(p => p.name === name)
    if (!provider) { skipped.push({ provider: name, reason: "unknown provider" }); continue }
    try {
      const health = await provider.health()
      if (health.status === "ok") usable.push(name)
      else skipped.push({ provider: name, reason: `${health.status}: ${health.detail}` })
    } catch (err) {
      skipped.push({ provider: name, reason: (err as Error).message })
    }
  }
  return { usable, skipped }
}

/** Rows in the observation tables written under these search requests. */
function countObservations(db: DB, searchRequestIds: number[]): number {
  if (searchRequestIds.length === 0) return 0
  const marks = searchRequestIds.map(() => "?").join(",")
  const cash = (db.prepare(`SELECT COUNT(*) c FROM flight_prices  WHERE search_request_id IN (${marks})`).get(...searchRequestIds) as any).c
  const award = (db.prepare(`SELECT COUNT(*) c FROM award_prices WHERE search_request_id IN (${marks})`).get(...searchRequestIds) as any).c
  return cash + award
}

/**
 * Execute one job. `trigger` "manual" bypasses the scheduler but follows the
 * same cost discipline. Never throws.
 */
export async function executeJob(
  job: ObservationJob,
  options: { db?: DB; trigger?: ObservationRun["trigger"]; now?: Date } = {},
): Promise<ExecutionResult> {
  const db = options.db ?? getDb()
  const trigger = options.trigger ?? "schedule"
  const now = options.now ?? new Date()
  const started = Date.now()
  const plan = planRun(job, job.runsCompleted, now)
  const errors: string[] = []

  // Duplicate-run guard: one execution per job at a time.
  if (hasRunningRun(db, job.id)) {
    return {
      runId: null, status: "failed", plan, searchesRun: 0, providerCalls: 0,
      cacheHits: 0, observationsAdded: 0, durationMs: 0,
      errors: [`job ${job.name} already has a run in progress`], skippedProviders: [],
    }
  }

  const runId = startRun(db, job.id, trigger)
  let searchesRun = 0
  let providerCalls = 0
  let cacheHits = 0
  const searchRequestIds: number[] = []

  // ── Award provider preflight (§ no doomed searches) ─────────────────────
  const preflight = plan.awardsThisRun
    ? await awardProviderPreflight(job)
    : { usable: [], skipped: [] as { provider: string; reason: string }[] }
  for (const s of preflight.skipped) {
    errors.push(`SKIPPED_AUTH ${s.provider}: ${s.reason}`)
    console.log(`OBSERVER SKIPPED_AUTH ${job.name} ${s.provider} (${s.reason.slice(0, 80)})`)
  }

  // ── The searches ────────────────────────────────────────────────────────
  for (const pair of plan.datePairs) {
    let searchRequestId: number | null = null
    try {
      searchRequestId = recordSearchRequest(db, {
        origin: job.origin, destination: job.destination,
        departureDate: pair.departureDate, returnDate: pair.returnDate,
        cabin: cabinsToSearchClass(job.cabins), adults: 1, currency: CASH_CURRENCY,
      }, "observer")
      searchRequestIds.push(searchRequestId)
    } catch (err) {
      errors.push(`search request: ${(err as Error).message}`)
    }

    // Cash: cache → free discovery. Metered fallback is forbidden here.
    if (job.cashProviders.length > 0) {
      for (const cabin of job.cabins) {
        try {
          const outcome = await searchCashFlights({
            origin: job.origin, destination: job.destination,
            departureDate: pair.departureDate, returnDate: pair.returnDate,
            cabin, adults: 1, currency: CASH_CURRENCY,
          }, {
            source: "observer",
            searchRequestId: searchRequestId ?? undefined,
            allowMeteredFallback: false,
            db,
          })
          searchesRun++
          if (outcome.fromCache) cacheHits++
          else providerCalls += Math.max(1, outcome.callsSpent)   // one free fetch, or metered count
          errors.push(...outcome.warnings.map(w => `cash ${cabin}: ${w}`))
        } catch (err) {
          errors.push(`cash ${cabin} ${pair.departureDate}: ${(err as Error).message}`)
        }
      }
    }

    // Awards: per-provider cache inside the orchestrator; only healthy providers.
    if (plan.awardsThisRun && preflight.usable.length > 0) {
      try {
        const outcome = await searchAwardFlights({
          origin: job.origin, destination: job.destination,
          departureDate: pair.departureDate, returnDate: pair.returnDate,
          searchClass: cabinsToSearchClass(job.cabins), adults: 1, flexDays: 0,
        }, {
          providers: preflight.usable,
          searchRequestId,
          db,
        })
        searchesRun++
        providerCalls += outcome.callsSpent
        cacheHits += outcome.perProvider.filter(p => p.fromCache).length
        errors.push(...outcome.warnings.map(w => `award: ${w}`))
      } catch (err) {
        errors.push(`award ${pair.departureDate}: ${(err as Error).message}`)
      }
    }
  }

  const observationsAdded = countObservations(db, searchRequestIds)
  const durationMs = Date.now() - started

  // ── Status: honest, not optimistic ──────────────────────────────────────
  const authSkips = preflight.skipped.length
  const hardErrors = errors.filter(e => !e.startsWith("SKIPPED_AUTH")).length
  let status: RunStatus
  if (searchesRun === 0 && authSkips > 0) status = "skipped_auth"
  else if (searchesRun === 0) status = "failed"
  else if (hardErrors > 0 || authSkips > 0) status = "partial"
  else status = "success"

  finishRun(db, runId, {
    status, searchesRun, providerCalls, cacheHits, observationsAdded,
    errors, durationMs,
  })

  // Backoff bookkeeping: auth-skips don't count as failures (the provider is
  // known-down; hammering wouldn't help), hard failures do. Award rotation
  // advances only when the run actually did something.
  completeJobRun(db, job.id, {
    failed: status === "failed",
    countsAsRun: searchesRun > 0,
  }, now)

  console.log(
    `OBSERVER RUN ${job.name} ${status}: ${searchesRun} searches, ` +
    `${providerCalls} live calls, ${cacheHits} cache hits, ` +
    `${observationsAdded} observations, ${durationMs}ms`
  )

  return {
    runId, status, plan, searchesRun, providerCalls, cacheHits,
    observationsAdded, errors, durationMs,
    skippedProviders: preflight.skipped.map(s => s.provider),
  }
}
