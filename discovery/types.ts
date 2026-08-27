/**
 * Discovery types.
 *
 * The vocabulary that separates discovery from the fixed observer: a job is a
 * SCOPE rather than a route, a run has three stages with different cost
 * classes, and every candidate records the method that found it.
 */

import type { CabinClass } from "../providers/cash-flights/types.js"
import type { OriginGroup } from "./config.js"

/**
 * §20 - how a candidate was found. Recorded so that after a few weeks the
 * question "is the wildcard scan worth its calls?" has an answer instead of an
 * opinion.
 */
export type DiscoveryMethod =
  | "FIXED_OBSERVER"
  | "FLEXIBLE_DATE"
  | "POSITIONING"
  | "OPEN_JAW"
  | "WILDCARD"
  | "TAKE_ME_ANYWHERE"

export interface DiscoveryJob {
  id: number
  name: string
  originGroup: OriginGroup
  destinationGroup: string
  horizonDays: number
  tripLengths: number[]
  cabins: CabinClass[]
  frequencyHours: number
  jitterMinutes: number
  priority: number
  budget: RunBudget
  /** Job-level narrowing, applied on top of the global sampling config. */
  maxDestinations: number | null
  datesPerRoute: number | null
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  nextRunAt: string | null
  consecutiveFailures: number
  runsCompleted: number
}

/** Per-run ceilings. A run reduces its scope rather than exceeding these. */
export interface RunBudget {
  maxFreeCallsPerRun: number
  maxAwardCallsPerRun: number
  maxMeteredCallsPerRun: number
  maxRuntimeMs: number
}

export type DiscoveryRunStatus =
  | "running" | "success" | "partial" | "failed" | "skipped_budget" | "dry-run"

export interface DiscoveryRun {
  id: number
  jobId: number
  startedAt: string
  completedAt: string | null
  scheduledFor: string | null
  status: DiscoveryRunStatus
  trigger: "schedule" | "manual" | "dry-run"
  routesSampled: number
  datePairsSampled: number
  stage1Searches: number
  stage2Searches: number
  awardSearches: number
  cacheHits: number
  freeCalls: number
  awardCalls: number
  meteredCalls: number
  verificationCalls: number
  observationsAdded: number
  candidatesProduced: number
  scopeReduced: string | null
  errors: string[]
  durationMs: number | null
}

/** One (origin, destination) pair the engine may sample. */
export interface RouteTarget {
  origin: string
  destination: string
  destinationGroup: string
  /** Primary origins are searched as themselves; positioning origins carry a cost model. */
  requiresPositioning: boolean
  desirability: number
}

/** One sampled search: a route, a date pair, a cabin. */
export interface SampleTarget {
  route: RouteTarget
  departureDate: string
  returnDate: string | null
  tripLengthNights: number | null
  cabin: CabinClass
  stage: 1 | 2
}

/** What a run intends to do, computed without touching any provider. */
export interface DiscoveryPlan {
  job: DiscoveryJob
  routes: RouteTarget[]
  stage1: SampleTarget[]
  /** Ceiling assuming every stage-2 window triggers — the pessimistic case. */
  estimatedStage2Max: number
  expected: {
    freeCalls: number
    awardCalls: number
    meteredCalls: number
  }
  scopeReduced: string | null
}

/** §3 - what a trip from a positioning airport really costs to begin. */
export interface PositioningAssessment {
  required: boolean
  positioningAirport: string | null
  fromAirport: string | null
  mode: string | null
  /** The main long-haul fare, unchanged. */
  mainFare: number
  positioningCost: number
  overnightCost: number
  /** mainFare + positioningCost + overnightCost. */
  trueTripStartCost: number
  currency: string
  /** "observed" when a real fare backs the positioning leg, "estimated" otherwise. */
  costBasis: "observed" | "estimated" | "ground-fixed"
  transferHours: number
  overnightRequired: boolean
  separateTicket: boolean
  /** 0..1, higher is worse. */
  penalty: number
  penaltyReasons: string[]
  /** The best comparable fare from a primary airport, when one is known. */
  comparableHomeFare: number | null
  savingVsHome: number | null
  savingPercent: number | null
  /** False when the saving does not justify the inconvenience. */
  worthwhile: boolean
  note: string
}

/** §8 - a trip that returns to a different airport than it left from. */
export interface OpenJawOption {
  /** False for a combination that was evaluated and rejected. */
  qualifies: boolean
  outbound: {
    origin: string
    destination: string
    departureDate: string
    price: number
    currency: string
    provider: string
    observedAt: string
  }
  inbound: {
    origin: string
    destination: string
    departureDate: string
    price: number
    currency: string
    provider: string
    observedAt: string
  }
  totalPrice: number
  currency: string
  cabin: string
  tripLengthNights: number
  /** The cheapest same-airport round trip we can compare against. */
  comparableRoundTrip: number | null
  saving: number | null
  savingPercent: number | null
  note: string
}
