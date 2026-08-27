/**
 * The discovery engine: one cycle of sparse -> dense -> confirm.
 *
 * Cost discipline, in the order the engine applies it:
 *   1. Stage 1 and 2 use the FREE provider only. `allowMeteredFallback: false`
 *      is passed on every search, so no amount of enthusiasm can turn a broad
 *      scan into a SerpAPI bill.
 *   2. Award providers are never swept across a horizon. They are pointed at a
 *      window that cash discovery already found interesting (§16).
 *   3. A metered verification requires a candidate to pass an explicit gate AND
 *      the discovery pool to have room, and can never touch the manual reserve.
 *   4. Every ceiling reduces scope rather than being exceeded, and every
 *      reduction is recorded on the run so a small cycle is never mistaken for
 *      a quiet market.
 */

import { getDb, type DB } from "../db/index.js"
import { recordSearchRequest } from "../db/repositories.js"
import { searchCashFlights } from "../providers/cash-flights/index.js"
import { searchAwardFlights, getAwardProviders } from "../providers/award-flights/index.js"
import { evaluateNewObservations } from "../anomaly/engine.js"
import { rebuildClusters } from "../anomaly/clustering.js"
import { loadAnomalyConfig } from "../anomaly/config.js"
import { loadDiscoveryConfig, type DiscoveryConfig } from "./config.js"
import {
  planStage1, planStage2, selectStage2Windows, routesFor, type SparseObservation,
} from "./sampling.js"
import {
  tryStartDiscoveryRun, finishDiscoveryRun, completeDiscoveryRun,
  type DiscoveryRunResult,
} from "./store.js"
import { canSpend, spend, note, newRunBudget, type RunBudgetState } from "./budget.js"
import { maybeVerify } from "./verification.js"
import type { DiscoveryJob, DiscoveryPlan, DiscoveryRun, SampleTarget } from "./types.js"

const CASH_CURRENCY = process.env.CASH_CURRENCY || "USD"

export interface DiscoveryExecution {
  runId: number | null
  result: DiscoveryRunResult
  plan: DiscoveryPlan
}

/** What a run would do, without touching a provider. Drives dry-run. */
export function planDiscoveryRun(
  job: DiscoveryJob,
  runIndex = job.runsCompleted,
  config: DiscoveryConfig = loadDiscoveryConfig(),
  now: Date = new Date(),
): DiscoveryPlan {
  const routes = routesFor(job, config)
  let stage1 = planStage1(job, runIndex, config, now)
  let scopeReduced: string | null = null

  // The plan is trimmed to the budget BEFORE anything is searched, so a
  // dry-run shows the real shape of the run rather than an intention.
  if (stage1.length > job.budget.maxFreeCallsPerRun) {
    const kept = job.budget.maxFreeCallsPerRun
    scopeReduced = `stage 1 trimmed from ${stage1.length} to ${kept} searches by the free-call ceiling`
    stage1 = stage1.slice(0, kept)
  }

  const s2 = config.sampling.stage2
  const perWindow = Math.ceil(s2.windowDays / s2.stepDays) * s2.extraTripLengths
  const estimatedStage2Max = s2.maxWindowsPerRun * perWindow

  return {
    job,
    routes,
    stage1,
    estimatedStage2Max,
    expected: {
      freeCalls: Math.min(stage1.length + estimatedStage2Max, job.budget.maxFreeCallsPerRun),
      awardCalls: job.budget.maxAwardCallsPerRun,
      meteredCalls: job.budget.maxMeteredCallsPerRun,
    },
    scopeReduced,
  }
}

/**
 * Run `limit` tasks at a time. Deliberately tiny: these tasks are wall-clock
 * bound (a Python subprocess, a long HTTP poll) rather than CPU bound, so a
 * little parallelism helps and a lot only invites rate limiting — and the NAS
 * this will move to has two cores.
 */
async function inBatches<T, R>(
  items: T[], limit: number, worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  const size = Math.max(1, limit)
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(worker)))
  }
  return results
}

interface SearchOutcome {
  target: SampleTarget
  cheapest: number | null
  currency: string
  fromCache: boolean
  callsSpent: number
  error: string | null
}

/** One cash search, recorded with its discovery provenance. */
async function runCashSearch(
  db: DB, target: SampleTarget, runId: number | null, method: string, errors: string[],
): Promise<SearchOutcome> {
  let searchRequestId: number | null = null
  try {
    searchRequestId = recordSearchRequest(db, {
      origin: target.route.origin, destination: target.route.destination,
      departureDate: target.departureDate, returnDate: target.returnDate,
      cabin: target.cabin, adults: 1, currency: CASH_CURRENCY,
    }, "discovery", {
      discoveryMethod: method,
      discoveryRunId: runId,
      discoveryStage: target.stage,
    })
  } catch (err) {
    errors.push(`search request: ${(err as Error).message}`)
  }

  try {
    const outcome = await searchCashFlights({
      origin: target.route.origin, destination: target.route.destination,
      departureDate: target.departureDate, returnDate: target.returnDate,
      cabin: target.cabin, adults: 1, currency: CASH_CURRENCY,
    }, {
      source: "discovery",
      searchRequestId: searchRequestId ?? undefined,
      // Non-negotiable for a broad scan: a metered fallback here would turn
      // one enthusiastic cycle into a month's SerpAPI budget.
      allowMeteredFallback: false,
      db,
    })

    const cheapest = outcome.flights.length > 0
      ? Math.min(...outcome.flights.map(f => f.price.amount))
      : null
    return {
      target, cheapest, currency: CASH_CURRENCY,
      fromCache: outcome.fromCache,
      callsSpent: outcome.fromCache ? 0 : Math.max(1, outcome.callsSpent),
      error: null,
    }
  } catch (err) {
    return {
      target, cheapest: null, currency: CASH_CURRENCY, fromCache: false, callsSpent: 0,
      error: (err as Error).message,
    }
  }
}

/**
 * Execute one discovery cycle.
 *
 * `method` labels every search this run performs, so the candidates it produces
 * carry the discovery method that found them rather than a later guess.
 */
export async function executeDiscoveryJob(
  job: DiscoveryJob,
  options: {
    db?: DB
    trigger?: DiscoveryRun["trigger"]
    now?: Date
    config?: DiscoveryConfig
    /** Cooperative abort, checked between stages. */
    shouldContinue?: () => boolean
    /** Skip the award and verification stages (used by the stress test). */
    cashOnly?: boolean
  } = {},
): Promise<DiscoveryExecution> {
  const db = options.db ?? getDb()
  const config = options.config ?? loadDiscoveryConfig()
  const trigger = options.trigger ?? "schedule"
  const now = options.now ?? new Date()
  const started = Date.now()
  const errors: string[] = []
  const budget: RunBudgetState = newRunBudget()

  const plan = planDiscoveryRun(job, job.runsCompleted, config, now)
  if (plan.scopeReduced) note(budget, plan.scopeReduced)

  // Parenthesised deliberately: `a ?? 1 > 1` parses as `a ?? (1 > 1)`, which
  // made every job report WILDCARD regardless of its group - and the whole
  // point of recording the method is to learn which ones earn their calls.
  const groupPriority = config.destinationGroups[job.destinationGroup]?.priority ?? 1
  const method = job.originGroup === "positioning"
    ? "POSITIONING"
    : groupPriority > 1
      ? "WILDCARD"
      : "FLEXIBLE_DATE"

  const runId = tryStartDiscoveryRun(
    db, job.id, trigger, trigger === "schedule" ? job.nextRunAt : null,
  )
  if (runId === null) {
    const result: DiscoveryRunResult = emptyResult()
    result.status = "failed"
    result.errors = [`discovery job ${job.name} already has a run in progress`]
    return { runId: null, result, plan }
  }

  const result = emptyResult()
  result.routesSampled = plan.routes.length

  // ── Stage 1: sparse scan, free provider only ─────────────────────────────
  const stage1Targets = plan.stage1.filter(() => canSpend(budget, job, "free"))
  const sparseOutcomes = await inBatches(
    stage1Targets,
    config.concurrency.maxConcurrentFreeSearches,
    async target => {
      if (!canSpend(budget, job, "free")) return null
      const outcome = await runCashSearch(db, target, runId, method, errors)
      if (!outcome.fromCache) spend(budget, "free", outcome.callsSpent)
      return outcome
    },
  )

  const sparse: SparseObservation[] = []
  for (const outcome of sparseOutcomes) {
    if (!outcome) continue
    result.stage1Searches++
    result.datePairsSampled++
    if (outcome.fromCache) result.cacheHits++
    else result.freeCalls += outcome.callsSpent
    if (outcome.error) errors.push(`stage1 ${outcome.target.route.origin}-${outcome.target.route.destination}: ${outcome.error}`)
    if (outcome.cheapest !== null) {
      sparse.push({
        route: outcome.target.route,
        departureDate: outcome.target.departureDate,
        cabin: outcome.target.cabin,
        tripLengthNights: outcome.target.tripLengthNights ?? 0,
        price: outcome.cheapest,
        currency: outcome.currency,
      })
    }
  }

  // ── Stage 2: resolve only where stage 1 found something ──────────────────
  const windows = options.shouldContinue && !options.shouldContinue()
    ? []
    : selectStage2Windows(sparse, config)

  for (const window of windows) {
    if (!canSpend(budget, job, "free")) break
    if (options.shouldContinue && !options.shouldContinue()) {
      errors.push("aborted: scheduler asked the run to stop")
      break
    }
    const targets = planStage2(window.observation, job, config)
    const outcomes = await inBatches(
      targets, config.concurrency.maxConcurrentFreeSearches,
      async target => {
        if (!canSpend(budget, job, "free")) return null
        const outcome = await runCashSearch(db, target, runId, method, errors)
        if (!outcome.fromCache) spend(budget, "free", outcome.callsSpent)
        return outcome
      },
    )
    for (const outcome of outcomes) {
      if (!outcome) continue
      result.stage2Searches++
      result.datePairsSampled++
      if (outcome.fromCache) result.cacheHits++
      else result.freeCalls += outcome.callsSpent
    }
  }

  // ── Evaluate what was collected, so stage 3 has scores to gate on ────────
  const anomalyConfig = loadAnomalyConfig()
  let evaluation = evaluateNewObservations({ db, config: anomalyConfig, quiet: true })
  result.candidatesProduced = evaluation.candidates

  // ── Stage 3a: award expansion on promising windows only (§16) ────────────
  if (!options.cashOnly && job.tripLengths.length > 0) {
    const promising = db.prepare(`
      SELECT DISTINCT origin, destination, departure_date, return_date
      FROM deal_candidates
      WHERE discovery_run_id = ? AND type = 'cash' AND sanity = 'ok' AND score >= ?
      ORDER BY score DESC LIMIT ?
    `).all(
      runId, config.sampling.stage3.awardExpansionMinScore,
      config.sampling.stage3.maxAwardWindowsPerRun,
    ) as { origin: string; destination: string; departure_date: string; return_date: string | null }[]

    const usableAward = await usableAwardProviders()
    for (const window of promising) {
      if (usableAward.length === 0) break
      if (!canSpend(budget, job, "award")) break
      try {
        const searchRequestId = recordSearchRequest(db, {
          origin: window.origin, destination: window.destination,
          departureDate: window.departure_date, returnDate: null,
          cabin: "both", adults: 1, currency: CASH_CURRENCY,
        }, "discovery", { discoveryMethod: method, discoveryRunId: runId, discoveryStage: 3 })

        const outcome = await searchAwardFlights({
          origin: window.origin, destination: window.destination,
          departureDate: window.departure_date, returnDate: null,
          searchClass: "both", adults: 1, flexDays: 0,
        }, { providers: usableAward, searchRequestId, db })

        result.awardSearches++
        result.awardCalls += outcome.callsSpent
        spend(budget, "award", Math.max(1, outcome.callsSpent))
        errors.push(...outcome.warnings.map(w => `award: ${w}`))
      } catch (err) {
        errors.push(`award ${window.origin}-${window.destination}: ${(err as Error).message}`)
      }
    }
    if (result.awardSearches > 0) {
      evaluation = evaluateNewObservations({ db, config: anomalyConfig, quiet: true })
      result.candidatesProduced += evaluation.candidates
    }
  }

  // ── Stage 3b: metered verification, gated twice (§14/§15) ────────────────
  if (!options.cashOnly) {
    const verification = await maybeVerify(db, runId, job, budget, config)
    result.verificationCalls = verification.calls
    result.meteredCalls = verification.calls
    errors.push(...verification.errors)
  }

  // ── Present the result as families rather than rows (§27) ────────────────
  try {
    rebuildClusters(db, { minScore: 0 })
  } catch (err) {
    errors.push(`clustering: ${(err as Error).message}`)
  }

  result.observationsAdded = countObservations(db, runId)
  result.scopeReduced = budget.scopeReduced.length ? budget.scopeReduced.join("; ") : null
  result.errors = errors
  result.durationMs = Date.now() - started
  result.status = result.stage1Searches === 0
    ? (budget.scopeReduced.length ? "skipped_budget" : "failed")
    : errors.filter(e => !e.startsWith("award:")).length > 0 ? "partial" : "success"

  finishDiscoveryRun(db, runId, result)
  completeDiscoveryRun(db, job.id, {
    failed: result.status === "failed",
    countsAsRun: result.stage1Searches > 0,
  }, now)

  console.log(
    `DISCOVERY RUN ${job.name} ${result.status}: ${result.routesSampled} routes, ` +
    `${result.stage1Searches}+${result.stage2Searches} searches, ${result.freeCalls} free calls, ` +
    `${result.awardCalls} award, ${result.meteredCalls} metered, ${result.cacheHits} cached, ` +
    `${result.observationsAdded} observations, ${result.candidatesProduced} candidates, ` +
    `${result.durationMs}ms`,
  )

  return { runId, result, plan }
}

async function usableAwardProviders(): Promise<string[]> {
  const usable: string[] = []
  for (const provider of getAwardProviders()) {
    try {
      const health = await provider.health()
      if (health.status === "ok") usable.push(provider.name)
    } catch { /* an unhealthy provider is simply not used */ }
  }
  return usable
}

function countObservations(db: DB, runId: number): number {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM flight_prices WHERE search_request_id IN
        (SELECT id FROM search_requests WHERE discovery_run_id = ?)) cash,
      (SELECT COUNT(*) FROM award_prices WHERE search_request_id IN
        (SELECT id FROM search_requests WHERE discovery_run_id = ?)) award
  `).get(runId, runId) as { cash: number; award: number }
  return row.cash + row.award
}

function emptyResult(): DiscoveryRunResult {
  return {
    status: "running",
    routesSampled: 0, datePairsSampled: 0,
    stage1Searches: 0, stage2Searches: 0, awardSearches: 0,
    cacheHits: 0, freeCalls: 0, awardCalls: 0, meteredCalls: 0, verificationCalls: 0,
    observationsAdded: 0, candidatesProduced: 0,
    scopeReduced: null, errors: [], durationMs: 0,
  }
}
