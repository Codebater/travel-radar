/**
 * BUILD YOURSELF vs BUY PACKAGE — the package tier's whole point.
 *
 * A package offer is a competing CONSTRUCTION for the same vacation, judged
 * against the Trip Composer's synthetic build. The verdict is quantified only
 * when comparability is strong enough, and the asymmetry of unknown costs is
 * respected in both directions:
 *
 *   - the synthetic side's unknown costs (Maldives transfers, unpriced hotel
 *     taxes) can only make DIY MORE expensive. A package that already beats
 *     the known DIY total therefore wins with its margin as a FLOOR — but a
 *     DIY total that merely appears cheaper, while the package includes what
 *     DIY has not priced, may never be declared the winner.
 *
 * Verdicts:
 *   BUY_PACKAGE / BUILD_YOURSELF     decisive, same currency, strong match
 *   ROUGH_CONTEXT_ONLY               numbers shown, no decision (destination
 *                                    context, differing nights, noise margin)
 *   INSUFFICIENT_COMPARABILITY       a structural gap: currency mismatch,
 *                                    mixed-currency DIY total, miles on the
 *                                    trip, or NOT_COMPARABLE products
 *   UNKNOWN_COSTS_PREVENT_VERDICT    DIY appears cheaper but has unknown
 *                                    costs the package includes — the known
 *                                    difference is shown, the blocker named
 */

import { type DB } from "../db/index.js"
import { listTrips, type StoredTrip } from "../trips/store.js"
import { loadPackagesConfig } from "./config.js"
import {
  assessComparability,
  hasNightsRelaxation,
  type ComparabilityAssessment,
} from "./comparability.js"
import {
  latestPackageObservations,
  recordPackageComparison,
  type StoredPackageObservation,
} from "./store.js"

export type PackageVerdict =
  | "BUILD_YOURSELF"
  | "BUY_PACKAGE"
  | "ROUGH_CONTEXT_ONLY"
  | "INSUFFICIENT_COMPARABILITY"
  | "UNKNOWN_COSTS_PREVENT_VERDICT"

export interface CompetitionOutcome {
  verdict: PackageVerdict
  verdictReasons: string[]
  syntheticTotal: number | null
  syntheticCurrency: string | null
  packageTotal: number
  packageCurrency: string
  knownDifference: number | null
  knownDifferencePct: number | null
  winner: "diy" | "package" | null
}

/**
 * Does the package include something the trip lists as an unknown cost?
 * Matched on the unknown's own wording — an unknown the package also lacks
 * stays symmetric and does not block a verdict.
 */
export function packageCoversUnknown(unknown: string, pkg: StoredPackageObservation): boolean {
  const u = unknown.toLowerCase()
  if (/transfer/.test(u) && pkg.transfer === "included") return true
  if (/tax|fee/.test(u) && pkg.taxesFees === "included") return true
  if (/baggage|luggage/.test(u) && pkg.baggage === "included") return true
  return false
}

export function judgeCompetition(
  trip: StoredTrip, pkg: StoredPackageObservation, assessment: ComparabilityAssessment,
): CompetitionOutcome {
  const cfg = loadPackagesConfig().competition
  const reasons: string[] = []
  const base = {
    syntheticTotal: trip.cashTotal?.amount ?? null,
    syntheticCurrency: trip.cashTotal?.currency ?? null,
    packageTotal: pkg.totalPrice,
    packageCurrency: pkg.currency,
    knownDifference: null as number | null,
    knownDifferencePct: null as number | null,
    winner: null as "diy" | "package" | null,
  }
  const outcome = (verdict: PackageVerdict): CompetitionOutcome =>
    ({ verdict, verdictReasons: reasons, ...base })

  if (assessment.level === "NOT_COMPARABLE") {
    reasons.push("products are not comparable", ...assessment.reasons)
    return outcome("INSUFFICIENT_COMPARABILITY")
  }
  if (assessment.level === "DESTINATION_LEVEL_ONLY") {
    reasons.push("destination-level context only — no per-trip verdict", ...assessment.reasons)
    return outcome("ROUGH_CONTEXT_ONLY")
  }

  // EXACT_MATCH or CLOSE_MATCH from here.

  if (hasNightsRelaxation(assessment)) {
    reasons.push("MONETARY_VERDICT_REQUIRES_EQUAL_NIGHTS: a shorter/longer package is a different product; totals shown for context only")
    return outcome("ROUGH_CONTEXT_ONLY")
  }
  if (trip.milesComponents.length > 0) {
    reasons.push("SYNTHETIC_USES_MILES: a cash package total cannot price an award construction — no monetary comparison")
    return outcome("INSUFFICIENT_COMPARABILITY")
  }
  if (base.syntheticTotal === null || base.syntheticCurrency === null) {
    reasons.push("SYNTHETIC_CASH_TOTAL_UNAVAILABLE: the trip's cash components do not share one currency")
    return outcome("INSUFFICIENT_COMPARABILITY")
  }
  if (base.syntheticCurrency !== base.packageCurrency) {
    reasons.push(
      `CURRENCY_MISMATCH: DIY known total is ${base.syntheticCurrency}, package is ${base.packageCurrency} — `
      + "currencies are never converted, so no monetary savings claim is possible",
    )
    if (trip.unknownCosts.length > 0) {
      reasons.push(`DIY side also carries unknown costs: ${trip.unknownCosts.join("; ")}`)
    }
    return outcome("INSUFFICIENT_COMPARABILITY")
  }

  // Same currency: the known difference is honest arithmetic.
  const difference = base.syntheticTotal - base.packageTotal
  const pct = Math.abs(difference) / base.syntheticTotal * 100
  base.knownDifference = Math.round(difference * 100) / 100
  base.knownDifferencePct = Math.round(pct * 10) / 10

  const covered = trip.unknownCosts.filter(u => packageCoversUnknown(u, pkg))
  const uncovered = trip.unknownCosts.filter(u => !packageCoversUnknown(u, pkg))

  if (difference > 0) {
    // Package beats the KNOWN DIY total. DIY unknowns could only widen this.
    if (covered.length > 0 || uncovered.length > 0) {
      reasons.push("SYNTHETIC_UNKNOWNS_ONLY_STRENGTHEN: DIY unknown costs could only widen the package's margin — the known difference is a floor")
    }
    if (pct < cfg.minDecisiveDifferencePct) {
      reasons.push(`DIFFERENCE_WITHIN_NOISE: package leads by ${base.knownDifferencePct}% (< ${cfg.minDecisiveDifferencePct}% decisive threshold)`)
      return outcome("ROUGH_CONTEXT_ONLY")
    }
    base.winner = "package"
    reasons.push(
      `package is ${base.packageCurrency} ${Math.abs(base.knownDifference)} (${base.knownDifferencePct}%) cheaper than the known DIY total`,
      `comparability ${assessment.level}`,
    )
    return outcome("BUY_PACKAGE")
  }

  // DIY appears cheaper on knowns.
  if (covered.length > 0) {
    reasons.push(
      "DIY appears cheaper on known costs, but the package includes what DIY has not priced: "
      + covered.join("; "),
      `known difference (DIY − package): ${base.packageCurrency} ${base.knownDifference} — NOT a final saving`,
      "blocker: price the covered unknowns (or verify they are immaterial) before a BUILD_YOURSELF claim",
    )
    return outcome("UNKNOWN_COSTS_PREVENT_VERDICT")
  }
  if (pct < cfg.minDecisiveDifferencePct) {
    reasons.push(`DIFFERENCE_WITHIN_NOISE: DIY leads by ${base.knownDifferencePct}% (< ${cfg.minDecisiveDifferencePct}% decisive threshold)`)
    return outcome("ROUGH_CONTEXT_ONLY")
  }
  base.winner = "diy"
  reasons.push(
    `DIY build is ${base.packageCurrency} ${Math.abs(base.knownDifference!)} (${base.knownDifferencePct}%) cheaper than the package`,
    `comparability ${assessment.level}`,
  )
  if (uncovered.length > 0) {
    reasons.push(`symmetric unknowns remain on the DIY side (not covered by the package either): ${uncovered.join("; ")}`)
  }
  return outcome("BUILD_YOURSELF")
}

export interface CompetitionSummary {
  tripsExamined: number
  packagesExamined: number
  pairsEvaluated: number
  comparisonsStored: number
  byVerdict: Record<string, number>
  stalePackagesSkipped: number
}

/**
 * Evaluate every stored interesting trip against the latest fresh package
 * observations for its property (hotel-specific) and destination (context).
 * Appends comparison rows; never mutates trips or observations.
 */
export function runCompetition(db: DB, opts: { minTripScore?: number; now?: Date } = {}): CompetitionSummary {
  // Same injectable-clock pattern as runMarket: two same-millisecond runs
  // must never share a compute_batch, or their rows merge into one "current"
  // set. Default behavior is unchanged.
  const computeBatch = (opts.now ?? new Date()).toISOString()
  const cfg = loadPackagesConfig().competition
  const trips = listTrips(db, { minScore: opts.minTripScore ?? 0, limit: 500, status: "interesting" })
  const fresh = latestPackageObservations(db, { maxAgeDays: cfg.maxPackageAgeDays })
  const all = latestPackageObservations(db, {})
  const stalePackagesSkipped = all.length - fresh.length

  const summary: CompetitionSummary = {
    tripsExamined: trips.length,
    packagesExamined: fresh.length,
    pairsEvaluated: 0,
    comparisonsStored: 0,
    byVerdict: {},
    stalePackagesSkipped,
  }

  for (const trip of trips) {
    // Pairing SCOPE (distinct from comparability): only packages that share
    // the hard dimensions and sit near the trip's check-in are candidate
    // alternatives. Everything else is seasonal curve or a different product
    // class — it stays in history and baselines, but no comparison row is
    // minted for it, so the audit trail records judgements, not noise.
    const candidates = fresh.filter(p =>
      (p.propertyId === trip.propertyId
        || (p.destinationAirport !== null && p.destinationAirport === trip.destinationAirport))
      && p.origin === trip.origin
      && p.board === trip.board
      && p.cabin === (trip.cabin ?? "unknown")
      && p.adults === trip.adults && p.children === 0
      && Math.abs(Date.parse(p.checkIn) - Date.parse(trip.checkIn)) / 86_400_000 <= cfg.maxCheckInDistanceDays)
    for (const pkg of candidates) {
      summary.pairsEvaluated++
      const assessment = assessComparability(trip, pkg)
      const result = judgeCompetition(trip, pkg, assessment)
      recordPackageComparison(db, {
        tripId: trip.id,
        tripKey: trip.tripKey,
        packageObservationId: pkg.id,
        packageKey: pkg.packageKey,
        comparability: assessment.level,
        comparabilityReasons: assessment.reasons,
        verdict: result.verdict,
        verdictReasons: result.verdictReasons,
        syntheticTotal: result.syntheticTotal,
        syntheticCurrency: result.syntheticCurrency,
        packageTotal: result.packageTotal,
        packageCurrency: result.packageCurrency,
        knownDifference: result.knownDifference,
        knownDifferencePct: result.knownDifferencePct,
        winner: result.winner,
      }, computeBatch)
      summary.comparisonsStored++
      summary.byVerdict[result.verdict] = (summary.byVerdict[result.verdict] ?? 0) + 1
    }
  }
  return summary
}
