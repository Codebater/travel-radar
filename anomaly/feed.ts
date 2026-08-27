/**
 * §29-§32 - the extreme deal feed.
 *
 * A read model over decisions that already exist. It performs no searches and
 * makes no judgements of its own: everything shown was decided by the anomaly
 * engine and can be traced back to a stored score breakdown. The feed's whole
 * job is to answer "what should I look at first?" without lying about
 * confidence.
 *
 * Sections are VIEWS of one candidate set rather than separate scores, so the
 * same opportunity can legitimately appear under both BUSINESS and POSITIONING
 * without being counted twice or scored differently in each.
 */

import type { DB } from "../db/index.js"
import { loadAnomalyConfig } from "./config.js"
import { listClusters, type ClusterRow } from "./clustering.js"
import { getCandidate, type StoredCandidate } from "./store.js"

export type FeedSection = "extreme" | "business" | "awards" | "wildcard" | "positioning"

export interface DealCard {
  clusterId: number
  candidateId: number | null
  score: number
  type: "cash" | "award"
  origin: string
  destination: string
  route: string
  destinationGroup: string | null
  cabin: string
  loyaltyProgram: string | null

  earliestDeparture: string
  latestDeparture: string
  /** How many dates in this family - "from X, 10-12 Oct" rather than three rows. */
  dateCount: number
  tripLengthNights: number | null

  price: number | null
  currency: string | null
  points: number | null
  taxesAmount: number | null
  taxesCurrency: string | null

  observedMedian: number | null
  percentBelowMedian: number | null
  sampleSize: number
  baselineConfidence: string

  absoluteTier: string | null
  cpp: number | null
  verificationStatus: string
  sanity: string
  discoveredBy: string
  requiresPositioning: boolean
  positioningPenalty: number | null
  trueTripStartCost: number | null
  isOpenJaw: boolean
  reasons: { code: string; detail: string }[]
  presetsMatched: string[]
  feedback: string | null
}

function toCard(db: DB, cluster: ClusterRow): DealCard | null {
  if (cluster.bestCandidateId === null) return null
  const c = getCandidate(db, cluster.bestCandidateId)
  if (!c) return null

  return {
    clusterId: cluster.id,
    candidateId: c.id,
    score: c.score,
    type: c.type,
    origin: c.origin,
    destination: c.destination,
    route: c.route,
    destinationGroup: c.destinationGroup,
    cabin: c.cabin,
    loyaltyProgram: c.loyaltyProgram,
    earliestDeparture: cluster.earliestDeparture,
    latestDeparture: cluster.latestDeparture,
    dateCount: cluster.memberCount,
    tripLengthNights: c.tripLengthNights,
    price: c.priceAmount,
    currency: c.priceCurrency,
    points: c.points,
    taxesAmount: c.taxesAmount,
    taxesCurrency: c.taxesCurrency,
    observedMedian: c.baseline.median,
    percentBelowMedian: c.baseline.percentBelowMedian,
    sampleSize: c.baseline.count,
    baselineConfidence: c.baseline.confidence,
    absoluteTier: c.absoluteTier,
    cpp: c.cpp?.cpp ?? null,
    verificationStatus: c.verificationStatus,
    sanity: c.sanity,
    discoveredBy: c.discoveredBy,
    requiresPositioning: c.requiresPositioning,
    positioningPenalty: c.positioningPenalty,
    trueTripStartCost: c.trueTripStartCost,
    isOpenJaw: c.isOpenJaw,
    reasons: c.reasons,
    presetsMatched: c.presetsMatched,
    feedback: c.feedback?.verdict ?? null,
  }
}

export interface FeedResult {
  mode: "shadow"
  alertsEnabled: false
  disclaimer: string
  threshold: number
  engineVersion: string
  sections: Record<FeedSection, DealCard[]>
  counts: Record<FeedSection, number>
  generatedAt: string
}

/**
 * Build the feed.
 *
 * EXTREME is the only section with its own bar: it is the "look at this now"
 * list, so it takes the preset matches and the strongest scores rather than
 * everything above the shadow threshold.
 */
export function buildFeed(
  db: DB,
  opts: { limitPerSection?: number; minScore?: number } = {},
): FeedResult {
  const config = loadAnomalyConfig()
  const limit = Math.min(opts.limitPerSection ?? 12, 50)
  const minScore = opts.minScore ?? config.candidateThreshold

  const clusters = listClusters(db, { minScore, limit: 300 })
  const cards = clusters.map(c => toCard(db, c)).filter((c): c is DealCard => c !== null)
    // A suspicious observation never reaches the feed; it stays visible in the
    // candidate table with its diagnostic reason instead.
    .filter(c => c.sanity === "ok")
    // Sorted by the CANDIDATE's current score, not the cluster's stored one.
    // A re-evaluation changes scores without rebuilding clusters, so the stored
    // figure goes stale - and a feed whose top card is not its highest score is
    // worse than useless.
    .sort((a, b) => b.score - a.score)

  const sections: Record<FeedSection, DealCard[]> = {
    extreme: cards
      .filter(c => c.presetsMatched.length > 0 || c.absoluteTier === "wtf" || c.absoluteTier === "extreme")
      .slice(0, limit),
    business: cards.filter(c => c.cabin === "business" || c.cabin === "first").slice(0, limit),
    awards: cards.filter(c => c.type === "award").slice(0, limit),
    wildcard: cards.filter(c => c.destinationGroup === "wildcard" || c.discoveredBy === "WILDCARD").slice(0, limit),
    positioning: cards.filter(c => c.requiresPositioning).slice(0, limit),
  }

  return {
    mode: "shadow",
    alertsEnabled: false,
    disclaimer:
      "EXPERIMENTAL - every figure here is this radar's opinion of its own observations. " +
      "Nothing has been verified unless it says so, and no alert has been sent to anybody.",
    threshold: minScore,
    engineVersion: config.engineVersion,
    sections,
    counts: {
      extreme: sections.extreme.length,
      business: sections.business.length,
      awards: sections.awards.length,
      wildcard: sections.wildcard.length,
      positioning: sections.positioning.length,
    },
    generatedAt: new Date().toISOString(),
  }
}

export interface DealDetail {
  candidate: StoredCandidate
  cluster: ClusterRow | null
  /** Every date in the family, so a reader can pick a different day. */
  siblings: {
    id: number
    departureDate: string
    returnDate: string | null
    price: number | null
    points: number | null
    score: number
    verificationStatus: string
  }[]
  /** What this radar has observed on this route, for context. */
  history: {
    observations: number
    min: number
    median: number
    max: number
    firstAt: string
    lastAt: string
  } | null
  alternatives: {
    cash: { departureDate: string; price: number; currency: string; provider: string; observedAt: string }[]
    award: { departureDate: string; loyaltyProgram: string; points: number; taxes: number | null; provider: string }[]
  }
  warnings: string[]
}

/** §31 - everything behind one card. */
export function dealDetail(db: DB, candidateId: number): DealDetail | null {
  const candidate = getCandidate(db, candidateId)
  if (!candidate) return null

  const cluster = candidate.clusterId
    ? (db.prepare(`SELECT * FROM candidate_clusters WHERE id = ?`).get(candidate.clusterId) as any)
    : null

  const siblings = candidate.clusterId
    ? db.prepare(`
        SELECT id, departure_date departureDate, return_date returnDate,
               price_amount price, points, score, verification_status verificationStatus
        FROM deal_candidates WHERE cluster_id = ? ORDER BY departure_date
      `).all(candidate.clusterId) as any[]
    : []

  const table = candidate.type === "cash" ? "flight_prices" : "award_prices"
  const valueColumn = candidate.type === "cash" ? "price_amount" : "points"
  const history = db.prepare(`
    SELECT COUNT(*) observations, MIN(${valueColumn}) min, MAX(${valueColumn}) max,
           MIN(fetched_at) firstAt, MAX(fetched_at) lastAt
    FROM ${table}
    WHERE origin = ? AND destination = ? AND cabin = ?
  `).get(candidate.origin, candidate.destination, candidate.cabin) as any

  const cashAlternatives = db.prepare(`
    SELECT departure_date departureDate, MIN(price_amount) price, price_currency currency,
           provider, MAX(fetched_at) observedAt
    FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ?
    GROUP BY departure_date ORDER BY price ASC LIMIT 8
  `).all(candidate.origin, candidate.destination, candidate.cabin) as any[]

  const awardAlternatives = db.prepare(`
    SELECT departure_date departureDate, loyalty_program loyaltyProgram,
           MIN(points) points, taxes_amount taxes, provider
    FROM award_prices
    WHERE origin = ? AND destination = ? AND cabin = ?
    GROUP BY loyalty_program ORDER BY points ASC LIMIT 8
  `).all(candidate.origin, candidate.destination, candidate.cabin) as any[]

  // Said plainly rather than implied by a missing badge.
  const warnings: string[] = []
  if (candidate.sanity !== "ok") warnings.push(`Data looks wrong: ${candidate.sanityDetail}`)
  if (candidate.baseline.count < 20) {
    warnings.push(
      `Only ${candidate.baseline.count} prior comparable observations - the percentage below median ` +
      `is itself uncertain.`,
    )
  }
  if (candidate.verificationStatus === "unverified") {
    warnings.push("This price came from the free discovery provider and has not been paid to be confirmed.")
  }
  if (candidate.requiresPositioning) {
    warnings.push(
      "This trip does not start from a home airport. The true start cost includes getting there, " +
      "and the separate ticket is your risk if anything slips.",
    )
  }
  if (candidate.isOpenJaw) {
    warnings.push("Open jaw: this returns to a different airport than it departs from.")
  }
  if (candidate.cpp?.cpp == null && candidate.type === "award") {
    warnings.push("No comparable cash fare has been observed, so there is no cents-per-point figure.")
  }

  return {
    candidate,
    cluster: cluster ? {
      id: cluster.id, clusterKey: cluster.cluster_key, type: cluster.type,
      origin: cluster.origin, destination: cluster.destination,
      destinationGroup: cluster.destination_group, route: cluster.route,
      cabin: cluster.cabin, loyaltyProgram: cluster.loyalty_program,
      earliestDeparture: cluster.earliest_departure, latestDeparture: cluster.latest_departure,
      memberCount: cluster.member_count, bestCandidateId: cluster.best_candidate_id,
      bestScore: cluster.best_score, bestPrice: cluster.best_price,
      bestCurrency: cluster.best_currency, bestPoints: cluster.best_points,
      discoveredBy: cluster.discovered_by,
    } : null,
    siblings,
    history: history?.observations > 0 ? {
      observations: history.observations,
      min: history.min,
      median: candidate.baseline.median,
      max: history.max,
      firstAt: history.firstAt,
      lastAt: history.lastAt,
    } : null,
    alternatives: { cash: cashAlternatives, award: awardAlternatives },
    warnings,
  }
}

export interface AnywhereQuery {
  origins: string[]
  withinMonths: number
  maxPrice: number | null
  currency: string
  cabin: string | null
  tripLengthNights: number | null
  minScore: number
  limit: number
}

/**
 * §11/§32 - TAKE ME ANYWHERE.
 *
 * Answered entirely from stored discovery data. It deliberately does NOT run
 * live searches: a synchronous fan-out across every wildcard destination is
 * exactly the brute force the whole engine is designed to avoid, and it would
 * put an unbounded provider bill behind an HTTP request.
 */
export function takeMeAnywhere(db: DB, query: AnywhereQuery): {
  query: AnywhereQuery
  results: DealCard[]
  note: string
} {
  const horizon = new Date(Date.now() + query.withinMonths * 30 * 86_400_000)
    .toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const clusters = listClusters(db, { minScore: query.minScore, limit: 300 })
  let cards = clusters.map(c => toCard(db, c)).filter((c): c is DealCard => c !== null)
    .filter(c => c.sanity === "ok")
    .sort((a, b) => b.score - a.score)
    .filter(c => query.origins.length === 0 || query.origins.includes(c.origin))
    .filter(c => c.earliestDeparture >= today && c.earliestDeparture <= horizon)

  if (query.cabin) cards = cards.filter(c => c.cabin === query.cabin)
  if (query.tripLengthNights !== null) {
    cards = cards.filter(c => c.tripLengthNights === null ||
      Math.abs(c.tripLengthNights - query.tripLengthNights!) <= 2)
  }
  if (query.maxPrice !== null) {
    cards = cards.filter(c => {
      // A positioning trip is judged on what it really costs to begin, not on
      // the headline fare - that is the entire point of the true start cost.
      const effective = c.trueTripStartCost ?? c.price
      if (c.type === "award") return true
      return effective !== null && effective <= query.maxPrice!
    })
  }

  return {
    query,
    results: cards.slice(0, query.limit),
    note:
      "Answered from stored discovery data, not by searching live: fanning out across every " +
      "wildcard destination on request is the brute force this engine exists to avoid.",
  }
}
