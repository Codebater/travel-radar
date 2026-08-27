/**
 * §15/§35 - what a discovery cycle may spend, and the pool it may spend from.
 *
 * Two separate mechanisms, because they fail differently:
 *
 *   PER-RUN CEILINGS  stop one cycle from running away. Exceeding them makes
 *                     a run reduce its scope, never overrun.
 *   MONTHLY POOLS     stop the month from running away. SerpAPI's budget is
 *                     split so the operator's manual reserve is unreachable
 *                     from any automated path — not "discouraged", unreachable.
 */

import type { DB } from "../db/index.js"
import { getDb } from "../db/index.js"
import { readUsage } from "../db/repositories.js"
import { serpApiBudget } from "../cache/policy.js"
import { loadDiscoveryConfig, type DiscoveryConfig } from "./config.js"
import { listDiscoveryJobs } from "./store.js"
import { planStage1, routesFor } from "./sampling.js"
import type { DiscoveryJob, DiscoveryPlan } from "./types.js"

/**
 * The SerpAPI calls DISCOVERY may still spend this month.
 *
 * Three nested limits, narrowest wins:
 *   monthly budget  -> the plan's ceiling
 *   minus reserve   -> the automation ceiling (already enforced in Phase 2)
 *   times share     -> the discovery pool, so interactive verification keeps
 *                      headroom even in a month discovery finds a lot
 */
export function discoveryVerificationPool(
  db: DB = getDb(),
  config: DiscoveryConfig = loadDiscoveryConfig(),
): {
  monthlyBudget: number
  manualReserve: number
  automationCeiling: number
  discoveryCeiling: number
  used: number
  remaining: number
} {
  const serp = serpApiBudget()
  const usage = readUsage(db, "serpapi")
  const discoveryCeiling = Math.floor(serp.automationCeiling * config.verification.pools.automatedShare)
  // `attempted` is the conservative counter: a failed call still consumed the
  // month's allowance, so it must not be reclaimed here.
  const used = usage.attempted
  return {
    monthlyBudget: serp.monthlyBudget,
    manualReserve: serp.reserveCalls,
    automationCeiling: serp.automationCeiling,
    discoveryCeiling,
    used,
    remaining: Math.max(0, discoveryCeiling - used),
  }
}

export interface RunBudgetState {
  freeCalls: number
  awardCalls: number
  meteredCalls: number
  startedAt: number
  scopeReduced: string[]
}

export function newRunBudget(): RunBudgetState {
  return { freeCalls: 0, awardCalls: 0, meteredCalls: 0, startedAt: Date.now(), scopeReduced: [] }
}

/**
 * May the run spend one more call of this class? Every refusal is recorded on
 * the run, so a small cycle is never mistaken for a quiet market.
 */
export function canSpend(
  state: RunBudgetState,
  job: DiscoveryJob,
  kind: "free" | "award" | "metered",
): boolean {
  const b = job.budget
  if (Date.now() - state.startedAt > b.maxRuntimeMs) {
    note(state, `runtime ceiling ${Math.round(b.maxRuntimeMs / 60_000)}min reached`)
    return false
  }
  if (kind === "free" && state.freeCalls >= b.maxFreeCallsPerRun) {
    note(state, `free-call ceiling ${b.maxFreeCallsPerRun} reached`)
    return false
  }
  if (kind === "award" && state.awardCalls >= b.maxAwardCallsPerRun) {
    note(state, `award-call ceiling ${b.maxAwardCallsPerRun} reached`)
    return false
  }
  if (kind === "metered" && state.meteredCalls >= b.maxMeteredCallsPerRun) {
    note(state, `metered-call ceiling ${b.maxMeteredCallsPerRun} reached`)
    return false
  }
  return true
}

export function spend(state: RunBudgetState, kind: "free" | "award" | "metered", count = 1): void {
  if (kind === "free") state.freeCalls += count
  else if (kind === "award") state.awardCalls += count
  else state.meteredCalls += count
}

export function note(state: RunBudgetState, reason: string): void {
  if (!state.scopeReduced.includes(reason)) state.scopeReduced.push(reason)
}

export interface DiscoveryProjection {
  jobs: {
    name: string
    routes: number
    stage1Searches: number
    runsPerMonth: number
    monthlyFreeCalls: number
  }[]
  totals: {
    monthlyFreeCalls: number
    monthlyAwardCallsMax: number
    /** What the per-run ceilings would ALLOW if every run verified its maximum. */
    monthlyMeteredCallsMax: number
    /** What can actually be spent, once the monthly pool is applied. */
    monthlyMeteredCallsEffective: number
  }
  serpapi: ReturnType<typeof discoveryVerificationPool>
  /** Configuration errors that should stop the schedule. */
  conflicts: string[]
  /** True facts worth knowing that are not errors. */
  warnings: string[]
  ok: boolean
}

const HOURS_PER_MONTH = 30 * 24

/**
 * What a month of the configured discovery schedule would cost, assuming a
 * cold cache every time — the ceiling, not the average. Used by dry-run and by
 * the scheduler's refusal to start an over-budget plan.
 */
export function projectDiscoveryBudget(
  db: DB = getDb(),
  config: DiscoveryConfig = loadDiscoveryConfig(),
  now: Date = new Date(),
): DiscoveryProjection {
  const jobs = listDiscoveryJobs(db, { enabledOnly: true })
  const rows: DiscoveryProjection["jobs"] = []
  let monthlyFree = 0
  let monthlyAward = 0
  let monthlyMetered = 0

  for (const job of jobs) {
    const routes = routesFor(job, config).length
    const stage1 = planStage1(job, 0, config, now).length
    const runsPerMonth = HOURS_PER_MONTH / Math.max(1, job.frequencyHours)
    // Stage 2 is bounded by its own per-run window cap, so the pessimistic
    // per-run cost is stage 1 plus that cap's worth of dense searches.
    const stage2Max = config.sampling.stage2.maxWindowsPerRun *
      Math.ceil(config.sampling.stage2.windowDays / config.sampling.stage2.stepDays) *
      config.sampling.stage2.extraTripLengths
    const perRunFree = Math.min(stage1 + stage2Max, job.budget.maxFreeCallsPerRun)

    monthlyFree += perRunFree * runsPerMonth
    monthlyAward += job.budget.maxAwardCallsPerRun * runsPerMonth
    monthlyMetered += job.budget.maxMeteredCallsPerRun * runsPerMonth

    rows.push({
      name: job.name,
      routes,
      stage1Searches: stage1,
      runsPerMonth: Math.round(runsPerMonth * 10) / 10,
      monthlyFreeCalls: Math.ceil(perRunFree * runsPerMonth),
    })
  }

  const serpapi = discoveryVerificationPool(db, config)
  const conflicts: string[] = []
  const warnings: string[] = []

  // The per-run ceiling times runs-per-month is what the schedule could ASK
  // for; the monthly pool is what it can actually get, and that pool is
  // enforced call by call at runtime. So exceeding it is not a configuration
  // error to refuse over - it is a fact about when verification stops for the
  // month, which is worth saying plainly and not worth blocking on.
  if (monthlyMetered > serpapi.discoveryCeiling) {
    warnings.push(
      `verification would stop partway through the month: the schedule could request up to ` +
      `${Math.ceil(monthlyMetered)} SerpAPI confirmations but the discovery pool is ` +
      `${serpapi.discoveryCeiling} (of ${serpapi.automationCeiling} automation calls; ` +
      `${serpapi.manualReserve} stay reserved for manual use and are never reachable from here)`,
    )
  }

  return {
    jobs: rows,
    totals: {
      monthlyFreeCalls: Math.ceil(monthlyFree),
      monthlyAwardCallsMax: Math.ceil(monthlyAward),
      monthlyMeteredCallsMax: Math.ceil(monthlyMetered),
      monthlyMeteredCallsEffective: Math.min(Math.ceil(monthlyMetered), serpapi.discoveryCeiling),
    },
    serpapi,
    conflicts,
    warnings,
    ok: conflicts.length === 0,
  }
}

/** Ceiling figures for one planned run, for dry-run output. */
export function estimatePlan(plan: DiscoveryPlan): {
  freeCalls: number; awardCalls: number; meteredCalls: number
} {
  return plan.expected
}
