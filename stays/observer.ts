/**
 * The stay observation run: plan → observe (Xotelo) → trigger → confirm
 * (Agoda) → close the run. One bounded pass over the Active Observation Set.
 *
 * Failure discipline, in order of importance:
 *   - a provider failure is a counted line item, never a crash: every
 *     provider call goes through the never-throw wrappers, and the whole
 *     per-item body is guarded so one poisoned property cannot end the run;
 *   - the run row ALWAYS closes (try/finally) — the flight engine's
 *     hard-won lesson about runs stuck 'running' forever;
 *   - transport failures feed the circuit breaker; semantic errors and empty
 *     results are tracked separately and never trip it;
 *   - the confirmation tier is optional by construction: no Agoda provider,
 *     no Agoda ref, open breaker, or exhausted budget all degrade to a
 *     recorded skip. The radar functions Xotelo-only.
 */

import type { DB } from "../db/index.js"
import { readState, writeState } from "../anomaly/store.js"
import {
  getStayProvider,
  runStayCalendarFetch,
  runStayRateSearch,
} from "../providers/stays/index.js"
import { XOTELO_PROVIDER } from "../providers/stays/xotelo.js"
import { AGODA_PROVIDER } from "../providers/stays/agoda.js"
import type { StayProvider } from "../providers/stays/types.js"
import {
  newStayRunBudget,
  noteScopeReduced,
  reserveConfirmationCall,
  reserveObservationCall,
  refundObservationCall,
  breakerState,
  TransportFailureCounter,
  type StayRunBudget,
} from "./budget.js"
import type { StaysConfig } from "./config.js"
import {
  acquireStayLease,
  completeStayRun,
  heartbeatStayLease,
  newStayHolderId,
  newStayRunCounters,
  releaseStayLease,
  reapStaleStayRuns,
  tryStartStayRun,
  type StayRunCounters,
} from "./lease.js"
import { listStayProperties, type StoredStayProperty } from "./registry.js"
import { planStayRun, type StayRunPlan } from "./sampling.js"
import { gatherTargetedSamples } from "./targeting.js"
import { runVerificationPass, type VerificationPassResult } from "./verification.js"
import { SERPAPI_HOTELS_PROVIDER } from "../providers/stays/serpapi-hotels.js"
import {
  calendarSupported,
  recordCalendarFailure,
  recordCalendarObservations,
  recordCalendarSuccess,
  recordConfirmationTrigger,
  recordEmptyRatesResult,
  recordRateObservations,
  recordRawResponse,
  recordStaySearchRequest,
  resolveConfirmationTrigger,
} from "./store.js"
import { evaluateConfirmationTrigger } from "./trigger.js"
import { evaluateStayObservations } from "./engine.js"

const RUN_INDEX_KEY = "stays.observer.runIndex"

export function currentRunIndex(db: DB): number {
  return Number(readState(db, RUN_INDEX_KEY) ?? "0")
}

export interface StayRunOptions {
  db: DB
  config: StaysConfig
  trigger: "cli" | "schedule"
  /** Lower (never raise) the observation request ceiling for this run. */
  limit?: number
  /** Restrict to named properties (still active-set members). */
  propertyIds?: string[]
  /** Injectable pacing for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

export interface StayRunResult {
  ok: boolean
  runId: number | null
  status: "success" | "partial" | "failed" | "not-started"
  detail: string
  counters: StayRunCounters
  verification: VerificationPassResult | null
}

/** Plan only — provably zero external calls (nothing here can even reach a provider). */
export function dryRunStayObservation(
  db: DB, config: StaysConfig, opts: { limit?: number; propertyIds?: string[] } = {},
): { plan: StayRunPlan; observable: number; skippedNoRef: string[] } {
  const runIndex = currentRunIndex(db)
  const { observable, skippedNoRef } = selectProperties(db, opts.propertyIds)
  const effective = effectiveConfig(config, opts.limit)
  const plan = planStayRun(observable, effective, runIndex, new Date(), {
    calendarSupported: p => calendarSupported(db, p.id, XOTELO_PROVIDER),
    targeted: gatherTargetedSamples(db, observable, effective, new Date()),
  })
  return { plan, observable: observable.length, skippedNoRef }
}

export async function runStayObservation(options: StayRunOptions): Promise<StayRunResult> {
  const { db, config } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = options.now ?? (() => new Date())
  const counters = newStayRunCounters()
  const started = Date.now()

  const holder = newStayHolderId()
  if (!acquireStayLease(db, holder, config.scheduler.leaseTtlSeconds, now())) {
    return { ok: false, runId: null, status: "not-started", detail: "lease held by another scheduler", counters, verification: null }
  }

  let runId: number | null = null
  let verification: VerificationPassResult | null = null
  try {
    reapStaleStayRuns(db, config.scheduler.staleRunMinutes, now())
    const runIndex = currentRunIndex(db)
    runId = tryStartStayRun(db, runIndex, options.trigger)
    if (runId === null) {
      return { ok: false, runId: null, status: "not-started", detail: "a run is already in progress", counters, verification: null }
    }

    const { observable, skippedNoRef } = selectProperties(db, options.propertyIds)
    for (const id of skippedNoRef) counters.scopeReduced.push(`no xotelo ref: ${id}`)
    const effective = effectiveConfig(config, options.limit)
    const plan = planStayRun(observable, effective, runIndex, now(), {
      calendarSupported: p => calendarSupported(db, p.id, XOTELO_PROVIDER),
      targeted: gatherTargetedSamples(db, observable, effective, now()),
    })
    counters.propertiesPlanned = new Set(plan.items.map(i => i.property.id)).size
    counters.scopeReduced.push(...plan.scopeReduced)

    const budget = newStayRunBudget(
      effective.observation.maxRequestsPerRun,
      config.budgets.maxConfirmationsPerRun,
    )
    const failures = new TransportFailureCounter()
    const xotelo = getStayProvider(XOTELO_PROVIDER)
    const agoda = getStayProvider(AGODA_PROVIDER)

    if (!xotelo) {
      counters.errors.push("xotelo provider not registered — nothing to observe")
    } else {
      await observePlan(db, config, plan, budget, counters, failures, xotelo, agoda ?? null, sleep, now, runId, holder)
    }

    counters.scopeReduced.push(...budget.scopeReduced)
    writeState(db, RUN_INDEX_KEY, String(runIndex + 1))

    // After observing: judge everything new, then let the verification gate
    // decide whether any near-threshold opportunity deserves a paid answer.
    // Both are guarded — a judging or verification bug degrades the run, it
    // does not kill the scheduler.
    try {
      evaluateStayObservations({ db, config })
      verification = await runVerificationPass({
        db, config,
        provider: getStayProvider(SERPAPI_HOTELS_PROVIDER) ?? null,
        sleep, now,
      })
      for (const d of verification.details.slice(0, 10)) {
        counters.scopeReduced.push(`verification: ${d}`)
      }
    } catch (err) {
      counters.errors.push(`evaluate/verify: ${(err as Error).message}`)
    }

    const status: "success" | "partial" | "failed" =
      counters.ratesCalls + counters.calendarCalls === 0 && plan.items.length > 0 ? "failed"
        : counters.errors.length > 0 || counters.transportFailures > 0 ? "partial"
          : "success"
    completeStayRun(db, runId, status, counters, Date.now() - started)
    return { ok: status !== "failed", runId, status, detail: `run #${runId} ${status}`, counters, verification }
  } catch (err) {
    // A bug in the engine itself: close the run honestly rather than leaving
    // it 'running' to wedge every later run.
    counters.errors.push(`engine error: ${(err as Error).message}`)
    if (runId !== null) completeStayRun(db, runId, "failed", counters, Date.now() - started)
    return { ok: false, runId, status: "failed", detail: (err as Error).message, counters, verification }
  } finally {
    releaseStayLease(db, holder)
  }
}

async function observePlan(
  db: DB,
  config: StaysConfig,
  plan: StayRunPlan,
  budget: StayRunBudget,
  counters: StayRunCounters,
  failures: TransportFailureCounter,
  xotelo: StayProvider,
  agoda: StayProvider | null,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
  runId: number,
  holder: string,
): Promise<void> {
  let firstCall = true
  for (const item of plan.items) {
    const beat = heartbeatStayLease(db, holder, now())
    if (!beat.ok) { counters.errors.push("lease lost mid-run — stopping"); return }
    if (beat.stopRequested) { counters.scopeReduced.push("stop requested — run cut short"); return }

    const xoteloBreaker = breakerState(db, XOTELO_PROVIDER, now())
    if (xoteloBreaker.open) {
      noteScopeReduced(budget, `xotelo breaker open until ${xoteloBreaker.until} (${xoteloBreaker.reason})`)
      return
    }

    try {
      // ── Rates (discovery tier) ────────────────────────────────────────────
      if (!reserveObservationCall(budget)) {
        noteScopeReduced(budget, `observation ceiling (${budget.observationCeiling}) reached with items left`)
        return
      }
      if (!firstCall) await sleep(config.observation.politeDelayMs)
      firstCall = false

      const ref = item.property.refs[XOTELO_PROVIDER]
      const result = await runStayRateSearch(xotelo, {
        propertyId: item.property.id, providerRef: ref,
        checkIn: item.checkIn, checkOut: item.checkOut,
        adults: config.observation.adults, children: config.observation.children,
        currency: config.observation.currency,
      }, { captureRaw: true })

      if (result.callsSpent === 0) refundObservationCall(budget)
      else counters.ratesCalls++

      if (result.ok) {
        failures.recordSuccess(XOTELO_PROVIDER)
        const requestId = recordStaySearchRequest(db, {
          propertyId: item.property.id, kind: "rates",
          checkIn: item.checkIn, checkOut: item.checkOut,
          adults: config.observation.adults, children: config.observation.children,
          currency: config.observation.currency, source: "observer",
        })
        if (result.raw !== undefined) {
          recordRawResponse(db, {
            provider: xotelo.name, kind: "rates", propertyId: item.property.id,
            searchRequestId: requestId, payload: result.raw,
          }, config.budgets.rawRetention)
        }
        const summary = recordRateObservations(db, item.property, requestId, result.rates, config.sanity)
        counters.observationsAdded += summary.inserted

        // ── Trigger → confirmation (money-adjacent last) ────────────────────
        if (counters.triggersFired < config.trigger.maxTriggersPerRun) {
          const verdict = evaluateConfirmationTrigger(
            db, item.property, item, result.rates, requestId, config.trigger)
          if (verdict.triggered && verdict.evidence) {
            counters.triggersFired++
            const triggerId = recordConfirmationTrigger(db, {
              propertyId: item.property.id, runId,
              checkIn: item.checkIn, checkOut: item.checkOut,
              reason: verdict.evidence.reason,
              evidence: { detail: verdict.evidence.detail, ...verdict.evidence.numbers },
            })
            await confirmTrigger(db, config, item, triggerId, budget, counters, failures, agoda, sleep, now)
          }
        }
      } else if (result.reason === "no-results") {
        // Semantic: transport worked, the API had nothing (or said no).
        counters.semanticErrors++
        if (/no priced OTA rates|no result/i.test(result.error ?? "")) {
          counters.emptyResults++
          const streak = recordEmptyRatesResult(db, item.property.id, XOTELO_PROVIDER)
          if (streak >= config.budgets.emptyStreakSuspect) {
            counters.errors.push(
              `${item.property.id}: ${streak} consecutive empty rates answers — ref may be wrong or unlisted`)
          }
        }
      } else {
        counters.transportFailures++
        counters.errors.push(`${item.property.id} rates: ${result.reason}: ${result.error}`)
        const tripped = failures.recordFailure(db, XOTELO_PROVIDER, config.budgets, result.error ?? result.reason ?? "?")
        if (tripped) {
          noteScopeReduced(budget, `xotelo breaker tripped until ${tripped}`)
          return
        }
      }

      // ── Calendar ──────────────────────────────────────────────────────────
      if (item.wantCalendar) {
        if (!reserveObservationCall(budget)) {
          noteScopeReduced(budget, `observation ceiling (${budget.observationCeiling}) reached before calendar`)
          return
        }
        await sleep(config.observation.politeDelayMs)
        const cal = await runStayCalendarFetch(xotelo, {
          propertyId: item.property.id, providerRef: ref,
          horizonDays: config.observation.calendarHorizonDays,
        }, { captureRaw: true })
        if (cal.callsSpent === 0) refundObservationCall(budget)
        else counters.calendarCalls++

        if (cal.ok) {
          failures.recordSuccess(XOTELO_PROVIDER)
          recordCalendarSuccess(db, item.property.id, XOTELO_PROVIDER)
          const requestId = recordStaySearchRequest(db, {
            propertyId: item.property.id, kind: "calendar",
            currency: config.observation.currency, source: "observer",
          })
          if (cal.raw !== undefined) {
            recordRawResponse(db, {
              provider: xotelo.name, kind: "calendar", propertyId: item.property.id,
              searchRequestId: requestId, payload: cal.raw,
            }, config.budgets.rawRetention)
          }
          counters.calendarDaysAdded += recordCalendarObservations(
            db, item.property, xotelo.name, ref, requestId, cal.days)
        } else if (cal.reason === "no-results") {
          counters.semanticErrors++
          const nowUnsupported = recordCalendarFailure(
            db, item.property.id, XOTELO_PROVIDER, config.budgets.calendarUnsupportedAfter)
          if (nowUnsupported) {
            counters.scopeReduced.push(`calendar marked unsupported for ${item.property.id}`)
          }
        } else {
          counters.transportFailures++
          counters.errors.push(`${item.property.id} calendar: ${cal.reason}: ${cal.error}`)
          const tripped = failures.recordFailure(db, XOTELO_PROVIDER, config.budgets, cal.error ?? "?")
          if (tripped) {
            noteScopeReduced(budget, `xotelo breaker tripped until ${tripped}`)
            return
          }
        }
      }
    } catch (err) {
      // Belt over suspenders: nothing in the item body should throw, but one
      // poisoned property must cost exactly one item, never the run.
      counters.errors.push(`${item.property.id}: unexpected: ${(err as Error).message}`)
    }
  }
}

async function confirmTrigger(
  db: DB,
  config: StaysConfig,
  item: { property: StoredStayProperty; checkIn: string; checkOut: string },
  triggerId: number,
  budget: StayRunBudget,
  counters: StayRunCounters,
  failures: TransportFailureCounter,
  agoda: StayProvider | null,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
): Promise<void> {
  if (!agoda) { resolveConfirmationTrigger(db, triggerId, "skipped_unconfigured"); return }
  if (!agoda.isConfigured()) { resolveConfirmationTrigger(db, triggerId, "skipped_unconfigured"); return }

  const ref = item.property.refs[AGODA_PROVIDER]
  if (!ref) { resolveConfirmationTrigger(db, triggerId, "skipped_no_ref"); return }

  const breaker = breakerState(db, AGODA_PROVIDER, now())
  if (breaker.open) { resolveConfirmationTrigger(db, triggerId, "skipped_breaker"); return }

  const reservation = reserveConfirmationCall(db, budget, config.budgets, now())
  if (!reservation.ok) {
    noteScopeReduced(budget, reservation.reason ?? "confirmation budget exhausted")
    resolveConfirmationTrigger(db, triggerId, "skipped_budget")
    return
  }

  await sleep(config.budgets.confirmationDelayMs)
  counters.confirmationCalls++
  const result = await runStayRateSearch(agoda, {
    propertyId: item.property.id, providerRef: ref,
    checkIn: item.checkIn, checkOut: item.checkOut,
    adults: config.observation.adults, children: config.observation.children,
    currency: config.observation.currency,
  }, { captureRaw: true })

  if (result.ok) {
    failures.recordSuccess(AGODA_PROVIDER)
    const requestId = recordStaySearchRequest(db, {
      propertyId: item.property.id, kind: "rates",
      checkIn: item.checkIn, checkOut: item.checkOut,
      adults: config.observation.adults, children: config.observation.children,
      currency: config.observation.currency, source: "observer",
    })
    if (result.raw !== undefined) {
      recordRawResponse(db, {
        provider: agoda.name, kind: "rates", propertyId: item.property.id,
        searchRequestId: requestId, payload: result.raw,
      }, config.budgets.rawRetention)
    }
    const summary = recordRateObservations(db, item.property, requestId, result.rates, config.sanity)
    counters.observationsAdded += summary.inserted
    counters.confirmationsRecorded++
    resolveConfirmationTrigger(db, triggerId, "confirmed", requestId)
  } else if (result.reason === "no-results") {
    counters.semanticErrors++
    resolveConfirmationTrigger(db, triggerId, "no_rates")
  } else {
    counters.transportFailures++
    counters.errors.push(`${item.property.id} confirmation: ${result.reason}: ${result.error}`)
    failures.recordFailure(db, AGODA_PROVIDER, config.budgets, result.error ?? result.reason ?? "?")
    resolveConfirmationTrigger(db, triggerId, "failed")
    // Deliberately NO retry of any kind: one trigger, at most one request.
  }
}

// ─── Scheduler loop (start/stop) ────────────────────────────────────────────

const NEXT_RUN_KEY = "stays.observer.nextRunAt"

/**
 * The long-running loop: one bounded observation run every frequencyHours,
 * heartbeating its own lease between runs. Deliberately simpler than the
 * flight scheduler — one job kind, one cadence — but with the same exits:
 * SIGINT/SIGTERM, a stop request in the database, or a lost lease.
 */
export async function startStayScheduler(options: {
  db: DB
  config: StaysConfig
  sleep?: (ms: number) => Promise<void>
  maxTicks?: number             // tests bound the loop; production runs unbounded
}): Promise<string> {
  const { db, config } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const holder = newStayHolderId()

  if (!acquireStayLease(db, holder, config.scheduler.leaseTtlSeconds)) {
    return "lease held by another scheduler — not starting"
  }

  let stopping = false
  const onSignal = () => { stopping = true }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  let ticks = 0
  try {
    while (!stopping) {
      if (options.maxTicks !== undefined && ticks >= options.maxTicks) break
      ticks++
      const beat = heartbeatStayLease(db, holder)
      if (!beat.ok) return "lease lost — stopping"
      if (beat.stopRequested) return "stop requested — stopping"

      const due = readState(db, NEXT_RUN_KEY)
      if (!due || Date.parse(due) <= Date.now()) {
        // Release around the run: runStayObservation manages its own lease
        // acquisition so a manual `stays:run` and the loop share one guard.
        releaseStayLease(db, holder)
        await runStayObservation({ db, config, trigger: "schedule" })
        if (!acquireStayLease(db, holder, config.scheduler.leaseTtlSeconds)) {
          return "lease taken during run — stopping"
        }
        writeState(db, NEXT_RUN_KEY,
          new Date(Date.now() + config.scheduler.frequencyHours * 3600_000).toISOString())
      }
      await sleep(config.scheduler.tickSeconds * 1000)
    }
    return `stopped after ${ticks} ticks`
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    releaseStayLease(db, holder)
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function selectProperties(db: DB, propertyIds?: string[]): {
  observable: StoredStayProperty[]
  skippedNoRef: string[]
} {
  const active = listStayProperties(db, { activeOnly: true })
  const pool = propertyIds ? active.filter(p => propertyIds.includes(p.id)) : active
  return {
    observable: pool.filter(p => p.refs[XOTELO_PROVIDER]),
    skippedNoRef: pool.filter(p => !p.refs[XOTELO_PROVIDER]).map(p => p.id),
  }
}

/** --limit may lower the observation ceiling, never raise it. */
function effectiveConfig(config: StaysConfig, limit?: number): StaysConfig {
  if (limit === undefined || !Number.isFinite(limit)) return config
  const capped = Math.max(1, Math.min(config.observation.maxRequestsPerRun, Math.floor(limit)))
  return { ...config, observation: { ...config.observation, maxRequestsPerRun: capped } }
}

export function nextScheduledRunAt(db: DB): string | null {
  return readState(db, NEXT_RUN_KEY)
}
