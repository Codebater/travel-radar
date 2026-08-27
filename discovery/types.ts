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
  /** §20 the one-way legs collected purely so open jaws can be assembled. */
  openJawLegSearches: number
  openJawCandidates: number
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
  /** §4 the one-way legs this run will collect so open jaws can be assembled. */
  openJawLegs: SampleTarget[]
  /** Ceiling assuming every stage-2 window triggers — the pessimistic case. */
  estimatedStage2Max: number
  expected: {
    freeCalls: number
    awardCalls: number
    meteredCalls: number
    /** §5 the incremental free-search cost of open-jaw support, stated separately. */
    openJawLegCalls: number
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

/**
 * §2/§3 - one leg of an open jaw, as its own observation.
 *
 * Deliberately not flattened into the pair. An open jaw is TWO tickets bought
 * from possibly two sellers at two moments, and every one of those facts
 * matters to somebody deciding whether to book it. Collapsing them into a
 * single price with a single provider would be a quiet lie.
 */
export interface OpenJawLeg {
  /** The flight_prices row this leg IS. Provenance is a join, never a copy. */
  priceId: number
  origin: string
  destination: string
  departureDate: string
  departureTime: string | null
  price: number
  currency: string
  provider: string
  providerConfidence: string
  verificationLevel: string
  airline: string | null
  stops: number | null
  durationMinutes: number | null
  baggage: string | null
  itineraryHash: string
  observedAt: string
  cabin: string
}

/** §6 - the ordinary round trip an open jaw is measured against, with its row. */
export interface OpenJawComparator {
  priceId: number
  price: number
  currency: string
  origin: string
  destination: string
  departureDate: string
  returnDate: string
  nights: number
  provider: string
  observedAt: string
}

/** §8 - a trip that does not fly in and out of the same pair of airports. */
export interface OpenJawOption {
  /** False for a combination that was evaluated and rejected. */
  qualifies: boolean
  /** When the combination became knowable: the later of the two legs. */
  asOf: string
  outbound: OpenJawLeg
  inbound: OpenJawLeg
  /** §8 the configured pairing this came from, and how useful a trip it is. */
  destinationPair: {
    group: string | null
    arrive: string
    depart: string
    usefulness: number
    transfer: { mode: string; hours: number; typicalCost: Record<string, number> } | null
    note: string | null
  }
  /** The two fares, and nothing else. §2 requires this figure to stay pure. */
  totalPrice: number
  /** §7 what getting between the cities and home from the wrong airport costs. */
  transferCost: number
  destinationTransferCost: number
  homeTransferCost: number
  homeTransfer: { mode: string; hours: number } | null
  /** totalPrice + transferCost - what the trip really costs to fly. */
  trueTripCost: number
  currency: string
  cabin: string
  tripLengthNights: number
  comparator: OpenJawComparator | null
  /** The comparator's price, or null - never a zero standing in for "unknown". */
  comparableRoundTrip: number | null
  saving: number | null
  savingPercent: number | null
  /** The saving once the transfers are paid for. Can be negative. */
  netSaving: number | null
  netSavingPercent: number | null
  /** 0..1, higher is worse. Applied as a penalty, never as a component. */
  friction: number
  frictionReasons: string[]
  mixedProvider: boolean
  legAgeSpreadDays: number
  convenience: number
  convenienceDetail: string
  note: string
}
