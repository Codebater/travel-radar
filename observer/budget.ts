/**
 * Monthly quota projection for the observer.
 *
 * Before any schedule is enabled, we compute what a month of it would cost per
 * provider, compare against each provider's budget, and REFUSE to start when a
 * budget would be exceeded. Estimates assume a cold cache on every run — the
 * conservative ceiling; real usage is lower because repeated grid positions
 * hit the cache.
 */

import type { DB } from "../db/index.js"
import { getDb } from "../db/index.js"
import { readUsage } from "../db/repositories.js"
import { serpApiBudget } from "../cache/policy.js"
import { listJobs } from "./store.js"
import { planRun } from "./sampling.js"
import type { ObservationJob } from "./types.js"

const HOURS_PER_MONTH = 30 * 24

export interface ProviderProjection {
  provider: string
  monthlyCalls: number
  budget: number | null          // null = unmetered
  budgetSource: string
  withinBudget: boolean
  note: string
}

export interface BudgetProjection {
  jobs: { name: string; runsPerMonth: number; cashPerRun: number; awardPerRun: number }[]
  providers: ProviderProjection[]
  ok: boolean
  conflicts: string[]
}

/** Average expected calls per run for a job (awards only run every Nth run). */
function perRunAverages(job: ObservationJob) {
  const plan = planRun(job, 0)
  const awardDivisor = Math.max(1, job.dateStrategy.awardEveryNRuns)
  // plan with runIndex 0 includes awards; average them across the cycle.
  return {
    fastFlights: plan.expected.fastFlights,
    roameJobs: plan.expected.roameJobs / awardDivisor,
    atfCalls: plan.expected.atfCalls / awardDivisor,
  }
}

export function projectMonthlyBudget(db: DB = getDb()): BudgetProjection {
  const jobs = listJobs(db, { enabledOnly: true })
  const totals = { fastFlights: 0, roameJobs: 0, atfCalls: 0 }
  const jobRows: BudgetProjection["jobs"] = []

  for (const job of jobs) {
    const runsPerMonth = HOURS_PER_MONTH / Math.max(1, job.frequencyHours)
    const avg = perRunAverages(job)
    totals.fastFlights += avg.fastFlights * runsPerMonth
    totals.roameJobs += avg.roameJobs * runsPerMonth
    totals.atfCalls += avg.atfCalls * runsPerMonth
    jobRows.push({
      name: job.name,
      runsPerMonth: Math.round(runsPerMonth * 10) / 10,
      cashPerRun: avg.fastFlights,
      awardPerRun: Math.round((avg.roameJobs + avg.atfCalls) * 10) / 10,
    })
  }

  // ATF budget: the limit ATF itself reported when known, else its documented 150.
  const atfUsage = readUsage(db, "atf")
  const atfLimit = atfUsage.reportedLimit ?? 150
  const atfAlreadyUsed = atfUsage.attempted

  const serp = serpApiBudget()

  const providers: ProviderProjection[] = [
    {
      provider: "fast_flights",
      monthlyCalls: Math.ceil(totals.fastFlights),
      budget: null, budgetSource: "free, unmetered",
      withinBudget: true,
      note: "free Google Flights discovery; each call ~1s",
    },
    {
      provider: "roame",
      monthlyCalls: Math.ceil(totals.roameJobs),
      budget: null, budgetSource: "no documented quota",
      withinBudget: true,
      note: "search jobs, not billable calls; kept modest to stay polite",
    },
    {
      provider: "atf",
      monthlyCalls: Math.ceil(totals.atfCalls),
      budget: atfLimit, budgetSource: atfUsage.reportedLimit ? "ATF-reported" : "documented default",
      withinBudget: atfAlreadyUsed + totals.atfCalls <= atfLimit,
      note: totals.atfCalls === 0
        ? "excluded from schedules by design (5 calls/search) — manual validation only"
        : `${atfAlreadyUsed} already used this month`,
    },
    {
      provider: "serpapi",
      monthlyCalls: 0,
      budget: serp.monthlyBudget, budgetSource: "SERPAPI_MONTHLY_BUDGET",
      withinBudget: true,
      note: "scheduled observation never calls SerpAPI; reserved for explicit verification",
    },
    {
      provider: "awardwallet",
      monthlyCalls: 0,
      budget: null, budgetSource: "n/a",
      withinBudget: true,
      note: "observer does not touch balances; the 12h snapshot cache serves searches",
    },
  ]

  const conflicts = providers
    .filter(p => !p.withinBudget)
    .map(p => `${p.provider}: projected ${p.monthlyCalls} calls/month exceeds budget ${p.budget}`)

  return { jobs: jobRows, providers, ok: conflicts.length === 0, conflicts }
}
