/**
 * Date sampling — broad, cheap, deterministic.
 *
 * We eventually want extreme flexible-date sweeps, but Phase 4 explicitly does
 * NOT brute-force 180 dates. Instead: a fixed grid of departure dates across
 * the horizon (every `stepDays`, starting `firstDepartureOffsetDays` out),
 * with trip lengths rotated across the grid. Each run searches only
 * `datesPerRun` pairs, and successive runs rotate through the grid — so the
 * whole horizon is covered over a few runs while any single run stays small.
 *
 * Deterministic on (anchor date, runIndex): tests can pin it, and reruns of
 * the same run index sample the same dates (which makes cache hits real).
 */

import type { DatePair, DateStrategy, ObservationJob, RunPlan } from "./types.js"

export const DEFAULT_DATE_STRATEGY: DateStrategy = {
  horizonDays: 180,
  firstDepartureOffsetDays: 21,
  stepDays: 14,
  tripLengths: [7, 10, 14, 21],
  datesPerRun: 4,
  awardEveryNRuns: 2,
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** The full departure grid for a strategy, anchored to `now`. */
export function departureGrid(strategy: DateStrategy, now: Date = new Date()): string[] {
  const out: string[] = []
  const step = Math.max(1, strategy.stepDays)
  for (let offset = strategy.firstDepartureOffsetDays; offset <= strategy.horizonDays; offset += step) {
    out.push(iso(addDays(now, offset)))
  }
  return out
}

/**
 * The date-pairs one run samples: `datesPerRun` departures picked from the
 * grid by rotating with the run index, each paired with a trip length rotated
 * across the grid position. Different runs → different slice of the grid;
 * grid exhausted → wraps around (fresh dates, because the anchor moved).
 */
export function sampleDatePairs(
  strategy: DateStrategy,
  runIndex: number,
  now: Date = new Date(),
): DatePair[] {
  const grid = departureGrid(strategy, now)
  if (grid.length === 0) return []

  const per = Math.max(1, Math.min(strategy.datesPerRun, grid.length))
  const lengths = strategy.tripLengths.length ? strategy.tripLengths : [7]
  const start = (runIndex * per) % grid.length

  const pairs: DatePair[] = []
  for (let i = 0; i < per; i++) {
    const gridIdx = (start + i) % grid.length
    const departure = grid[gridIdx]!
    const tripLength = lengths[(gridIdx + runIndex) % lengths.length]!
    pairs.push({
      departureDate: departure,
      returnDate: iso(addDays(new Date(departure + "T00:00:00Z"), tripLength)),
      tripLength,
    })
  }
  return pairs
}

/**
 * Everything a run will do, computed WITHOUT touching any provider. The
 * expected-calls figures assume a cold cache — the ceiling, not the average.
 * Used by dry-run, the budget projection and the executor itself.
 */
export function planRun(job: ObservationJob, runIndex = job.runsCompleted, now: Date = new Date()): RunPlan {
  const datePairs = sampleDatePairs(job.dateStrategy, runIndex, now)
  const awardsThisRun =
    job.awardProviders.length > 0 &&
    runIndex % Math.max(1, job.dateStrategy.awardEveryNRuns) === 0

  const cashSearches = job.cashProviders.length > 0 ? datePairs.length * job.cabins.length : 0
  const awardSearches = awardsThisRun ? datePairs.length : 0

  // Award search class: economy+business → one "both" Roame search (2 jobs).
  const roameJobsPerSearch = job.cabins.length >= 2 ? 2 : 1

  return {
    job,
    datePairs,
    cashSearches,
    awardSearches,
    awardsThisRun,
    expected: {
      fastFlights: job.cashProviders.includes("fast_flights") ? cashSearches : 0,
      roameJobs: job.awardProviders.includes("roame") ? awardSearches * roameJobsPerSearch : 0,
      atfCalls: job.awardProviders.includes("atf") ? awardSearches * 5 : 0,
      serpapi: 0,   // scheduled observation NEVER spends SerpAPI — enforced in the engine
    },
  }
}

/** Cabins → the award search class Roame understands. */
export function cabinsToSearchClass(cabins: string[]): "ECON" | "PREM" | "both" {
  const hasEcon = cabins.includes("economy") || cabins.includes("premium_economy")
  const hasPrem = cabins.includes("business") || cabins.includes("first")
  if (hasEcon && hasPrem) return "both"
  return hasPrem ? "PREM" : "ECON"
}
