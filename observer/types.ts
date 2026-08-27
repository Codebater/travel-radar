/**
 * Observer — scheduled baseline observation collection.
 *
 * This is NOT the deal hunter. Its only job is to accumulate price history
 * ("observed by this radar") cheaply: cache first, free discovery next, and
 * never a metered call on a schedule.
 */

import type { CabinClass } from "../providers/cash-flights/types.js"

export interface DateStrategy {
  /** How far ahead departures are sampled. */
  horizonDays: number
  /** Earliest sampled departure, days from now (booking horizon). */
  firstDepartureOffsetDays: number
  /** Grid spacing between sampled departure dates. */
  stepDays: number
  /** Trip lengths rotated across the sampled departures. */
  tripLengths: number[]
  /** How many date-pairs one run actually searches (the rest of the grid is
   *  covered by later runs via rotation — broad coverage, cheap runs). */
  datesPerRun: number
  /** Award providers run on every Nth run (cash runs every time). */
  awardEveryNRuns: number
  /**
   * Which cash trip types to observe.
   *
   * "return" is what a traveller actually buys on these routes. "oneway" is
   * collected because every award source we have prices ONE direction, and CPP
   * compares an award against a cash fare of the SAME trip type — without a
   * one-way cash baseline the CPP component (20% of the award score) is
   * dropped for every award the observer collects. Both are free
   * (fast_flights), so the cost is a few seconds per run, not quota.
   */
  cashTripTypes?: ("return" | "oneway")[]
}

export interface ObservationJob {
  id: number
  name: string
  origin: string
  destination: string
  cabins: CabinClass[]
  cashProviders: string[]
  awardProviders: string[]
  priority: number
  frequencyHours: number
  jitterMinutes: number
  dateStrategy: DateStrategy
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  nextRunAt: string | null
  consecutiveFailures: number
  runsCompleted: number
}

export type RunStatus =
  | "running" | "success" | "partial" | "failed"
  | "skipped_auth" | "skipped_budget" | "dry-run"

export interface ObservationRun {
  id: number
  jobId: number
  startedAt: string
  completedAt: string | null
  status: RunStatus
  trigger: "schedule" | "manual" | "dry-run"
  searchesRun: number
  providerCalls: number
  cacheHits: number
  observationsAdded: number
  errors: string[]
  durationMs: number | null
}

export interface DatePair {
  departureDate: string
  returnDate: string
  tripLength: number
}

/** What one job execution (or dry-run) is going to do / did. */
export interface RunPlan {
  job: ObservationJob
  datePairs: DatePair[]
  cashSearches: number
  awardSearches: number
  awardsThisRun: boolean
  /** Expected LIVE calls assuming cold cache — the conservative ceiling. */
  expected: { fastFlights: number; roameJobs: number; atfCalls: number; serpapi: 0 }
}
