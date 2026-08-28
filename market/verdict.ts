/**
 * The market verdict: BUILD_YOURSELF vs BUY_PACKAGE, decided like a sceptic.
 *
 * A monetary winner requires, all at once:
 *   - a compatible comparison currency (native, or through fresh stored FX),
 *   - sufficient product comparability (EXACT/CLOSE, nights equal),
 *   - no material unresolved cost asymmetry ON THE LEADING SIDE — a leader
 *     whose own total is missing a material cost (transfer, hotel taxes) has
 *     an understated total and may not be declared the winner; the honest
 *     output is a BOUNDED statement ("DIY is currently €X lower BEFORE the
 *     unknown transfer"). Unknowns on the TRAILING side can only widen the
 *     leader's margin, so they annotate the verdict instead of blocking it.
 *
 * Everything is stored append-only with a compute_batch stamp; current views
 * read only the newest batch, so superseded rows can never pollute a ranking.
 */

import { nowIso, type DB } from "../db/index.js"
import { assessComparability, hasNightsRelaxation, type ComparabilityAssessment } from "../packages/comparability.js"
import { loadPackagesConfig } from "../packages/config.js"
import {
  latestPackageObservations,
  recordPackageComparison,
  type StoredPackageObservation,
} from "../packages/store.js"
import { stayDateFamily } from "../stays/identity.js"
import { listTrips, type StoredTrip } from "../trips/store.js"
import { loadMarketConfig } from "./config.js"
import {
  buildDiyLedger,
  buildPackageLedger,
  comparisonTotalFor,
  diyConstructionLabel,
  isComparisonRefusal,
  itemFor,
  packageConstructionLabel,
  unknownCategories,
  type ComparisonTotal,
  type CostLedger,
  type LedgerCategory,
} from "./ledger.js"

export type MarketConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT"
export type MarketVerdictKind =
  | "BUILD_YOURSELF"
  | "BUY_PACKAGE"
  | "TOO_CLOSE_TO_CALL"
  | "INSUFFICIENT_COMPARABILITY"

export interface MarketDecision {
  comparability: ComparabilityAssessment["level"]
  confidence: MarketConfidence
  verdict: MarketVerdictKind
  winner: "diy" | "package" | null
  reasons: string[]
  comparisonCurrency: string
  diyKnownTotal: number | null
  packageTotal: number | null
  absoluteDifference: number | null
  percentDifference: number | null
  fxObservationIds: number[]
}

export function marketSlotKey(input: {
  origin: string; propertyId: string | null; checkIn: string; nights: number
  board: string; cabin: string; adults: number; comparisonCurrency: string
}): string {
  return [
    input.origin,
    input.propertyId ?? "unmapped",
    stayDateFamily(input.checkIn),
    `${input.nights}n`,
    input.board,
    input.cabin,
    `${input.adults}a`,
    input.comparisonCurrency,
  ].join("|")
}

/** Material categories UNKNOWN on `side` while the other side has them INCLUDED or KNOWN. */
function coveredAsymmetries(side: CostLedger, other: CostLedger, categories: string[]): LedgerCategory[] {
  const result: LedgerCategory[] = []
  for (const category of categories as LedgerCategory[]) {
    const mine = itemFor(side, category)
    const theirs = itemFor(other, category)
    if (mine?.status === "UNKNOWN" && (theirs?.status === "INCLUDED" || theirs?.status === "KNOWN")) {
      result.push(category)
    }
  }
  return result
}

/** Material categories UNKNOWN on `side` at all (the leading-side blocker). */
function materialUnknowns(side: CostLedger, categories: string[]): LedgerCategory[] {
  return (categories as LedgerCategory[]).filter(c => itemFor(side, c)?.status === "UNKNOWN")
}

export function decideMarketVerdict(input: {
  db: DB
  trip: StoredTrip
  pkg: StoredPackageObservation
  assessment: ComparabilityAssessment
  now?: Date
}): MarketDecision {
  const { db, trip, pkg, assessment } = input
  const now = input.now ?? new Date()
  const market = loadMarketConfig()
  const ccy = market.comparisonCurrency
  const reasons: string[] = []

  const diyLedger = buildDiyLedger(trip)
  const pkgLedger = buildPackageLedger(pkg)
  const diyTotal = comparisonTotalFor(db, diyLedger, ccy, now)
  const pkgTotal = comparisonTotalFor(db, pkgLedger, ccy, now)

  const base: Omit<MarketDecision, "confidence" | "verdict" | "winner"> = {
    comparability: assessment.level,
    reasons,
    comparisonCurrency: ccy,
    diyKnownTotal: isComparisonRefusal(diyTotal) ? null : diyTotal.total,
    packageTotal: isComparisonRefusal(pkgTotal) ? null : pkgTotal.total,
    absoluteDifference: null,
    percentDifference: null,
    fxObservationIds: [
      ...(isComparisonRefusal(diyTotal) ? [] : diyTotal.fxObservationIds),
      ...(isComparisonRefusal(pkgTotal) ? [] : pkgTotal.fxObservationIds),
    ],
  }
  const insufficient = (why: string[]): MarketDecision => {
    reasons.push(...why)
    return { ...base, confidence: "INSUFFICIENT", verdict: "INSUFFICIENT_COMPARABILITY", winner: null }
  }

  // ── Gate 1: product comparability ─────────────────────────────────────────
  if (assessment.level === "NOT_COMPARABLE") {
    return insufficient(["products are not comparable", ...assessment.reasons])
  }
  if (assessment.level === "DESTINATION_LEVEL_ONLY") {
    reasons.push("destination-level context only — totals shown, no per-trip winner", ...assessment.reasons)
    return { ...base, confidence: "LOW", verdict: "INSUFFICIENT_COMPARABILITY", winner: null }
  }
  if (hasNightsRelaxation(assessment)) {
    reasons.push("MONETARY_VERDICT_REQUIRES_EQUAL_NIGHTS: a shorter/longer package is a different product")
    return { ...base, confidence: "LOW", verdict: "INSUFFICIENT_COMPARABILITY", winner: null }
  }
  if (trip.milesComponents.length > 0) {
    return insufficient(["SYNTHETIC_USES_MILES: a cash package total cannot price an award construction — cash and miles stay separate"])
  }

  // ── Gate 2: one comparison currency, through stored fresh FX only ─────────
  if (isComparisonRefusal(diyTotal)) {
    return insufficient([`DIY total not computable in ${ccy}: ${diyTotal.refusal}`])
  }
  if (isComparisonRefusal(pkgTotal)) {
    return insufficient([`package total not computable in ${ccy}: ${pkgTotal.refusal}`])
  }
  if ((diyTotal as ComparisonTotal).fxObservationIds.length > 0) {
    reasons.push(`FX_APPLIED: DIY components converted to ${ccy} via stored observation(s) ${(diyTotal as ComparisonTotal).fxObservationIds.join(",")} — native amounts preserved in the ledger`)
  }

  const diy = (diyTotal as ComparisonTotal).total
  const pack = (pkgTotal as ComparisonTotal).total
  const difference = Math.round((diy - pack) * 100) / 100
  base.absoluteDifference = difference
  base.percentDifference = diy !== 0 ? Math.round(Math.abs(difference) / diy * 1000) / 10 : null

  const leaderLedger = difference < 0 ? diyLedger : pkgLedger      // lower total leads
  const trailerLedger = difference < 0 ? pkgLedger : diyLedger
  const leaderName = difference < 0 ? "DIY" : "package"

  // ── Gate 3: no material unresolved cost asymmetry on the LEADING side ─────
  const leaderUnknowns = materialUnknowns(leaderLedger, market.confidence.materialCategories)
  if (difference !== 0 && leaderUnknowns.length > 0) {
    const covered = coveredAsymmetries(leaderLedger, trailerLedger, market.confidence.materialCategories)
    reasons.push(
      `${leaderName} is currently ${ccy} ${Math.abs(difference)} lower BEFORE the unknown ${leaderUnknowns.join(" + ")} — NOT a saving`,
      covered.length > 0
        ? `the other side already includes: ${covered.join(", ")} — the gap must survive pricing them before a winner exists`
        : `the unknown ${leaderUnknowns.join("/")} must be priced (or shown immaterial) before a winner exists`,
      "recomputes automatically once the unknown cost becomes a KNOWN ledger line",
    )
    return { ...base, confidence: "LOW", verdict: "INSUFFICIENT_COMPARABILITY", winner: null }
  }

  // Trailing-side unknowns only widen the leader's margin — annotate.
  const trailerUnknowns = materialUnknowns(trailerLedger, market.confidence.materialCategories)
  if (trailerUnknowns.length > 0) {
    reasons.push(`${leaderName === "DIY" ? "package" : "DIY"}-side unknown ${trailerUnknowns.join("/")} could only widen the margin — the difference is a floor`)
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  let confidence: MarketConfidence = assessment.level === "EXACT_MATCH" ? "HIGH" : "MEDIUM"
  const softAsym = coveredAsymmetries(diyLedger, pkgLedger, market.confidence.softCategories)
  if (softAsym.length > 0 && confidence === "HIGH") {
    confidence = "MEDIUM"
    reasons.push(`soft asymmetry (${softAsym.join(", ")}): package includes what DIY has not tracked — confidence capped at MEDIUM`)
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  if (base.percentDifference !== null && base.percentDifference < market.confidence.tooCloseToCallPct) {
    reasons.push(`gap ${base.percentDifference}% is inside the ${market.confidence.tooCloseToCallPct}% noise band of two moving quote streams`)
    return { ...base, confidence, verdict: "TOO_CLOSE_TO_CALL", winner: null }
  }
  if (difference > 0) {
    reasons.push(`package is ${ccy} ${Math.abs(difference)} (${base.percentDifference}%) cheaper than the DIY known total`, `comparability ${assessment.level}, confidence ${confidence}`)
    return { ...base, confidence, verdict: "BUY_PACKAGE", winner: "package" }
  }
  reasons.push(`DIY build is ${ccy} ${Math.abs(difference)} (${base.percentDifference}%) cheaper than the package`, `comparability ${assessment.level}, confidence ${confidence}`)
  return { ...base, confidence, verdict: "BUILD_YOURSELF", winner: "diy" }
}

// ── The market run ───────────────────────────────────────────────────────────

export interface MarketRunSummary {
  computeBatch: string
  tripsExamined: number
  packageVariantsExamined: number
  pairsEvaluated: number
  verdictsStored: number
  byVerdict: Record<string, number>
  byConfidence: Record<string, number>
  marketObservationsStored: number
}

export function runMarket(db: DB, opts: { minTripScore?: number; now?: Date } = {}): MarketRunSummary {
  const now = opts.now ?? new Date()
  const packagesCfg = loadPackagesConfig()
  const market = loadMarketConfig()
  // The batch is stamped from the run's OWN clock (`now` is already the
  // authority for everything else in this run). Stamping a second wall-clock
  // reading here let two same-millisecond runs share one compute_batch and
  // merge into a single "current" set — breaking batch supersession.
  const computeBatch = now.toISOString()

  const trips = listTrips(db, { minScore: opts.minTripScore ?? 0, limit: 500, status: "interesting" })
  const variants = latestPackageObservations(db, { maxAgeDays: packagesCfg.competition.maxPackageAgeDays })

  const summary: MarketRunSummary = {
    computeBatch,
    tripsExamined: trips.length,
    packageVariantsExamined: variants.length,
    pairsEvaluated: 0,
    verdictsStored: 0,
    byVerdict: {},
    byConfidence: {},
    marketObservationsStored: 0,
  }

  const insertVerdict = db.prepare(`
    INSERT INTO market_verdicts (
      compute_batch, slot_key, trip_id, trip_key, package_observation_id, package_key,
      comparability, confidence, verdict, winner, reasons,
      comparison_currency, diy_known_total, package_total, absolute_difference, percent_difference,
      diy_ledger, package_ledger, fx_observation_ids, computed_at
    ) VALUES (
      @computeBatch, @slotKey, @tripId, @tripKey, @packageObservationId, @packageKey,
      @comparability, @confidence, @verdict, @winner, @reasons,
      @comparisonCurrency, @diyKnownTotal, @packageTotal, @absoluteDifference, @percentDifference,
      @diyLedger, @packageLedger, @fxObservationIds, @now
    )
  `)
  const insertObservation = db.prepare(`
    INSERT INTO trip_market_observations (
      slot_key, construction, source_table, source_id, known_total_native, native_currency,
      comparison_total, comparison_currency, fx_observation_ids, unknown_categories, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const observed = new Set<string>()
  const recordMarketObservation = (
    slotKey: string, construction: string, sourceTable: string, sourceId: number,
    ledger: CostLedger,
  ): void => {
    const dedupeKey = `${sourceTable}:${sourceId}`
    if (observed.has(dedupeKey)) return
    observed.add(dedupeKey)
    const known = ledger.items.filter(i => i.status === "KNOWN")
    const currencies = new Set(known.map(i => i.nativeCurrency))
    const nativeTotal = currencies.size === 1
      ? Math.round(known.reduce((a, i) => a + i.nativeAmount!, 0) * 100) / 100
      : null
    const comparison = comparisonTotalFor(db, ledger, market.comparisonCurrency, now)
    insertObservation.run(
      slotKey, construction, sourceTable, sourceId,
      nativeTotal, currencies.size === 1 ? [...currencies][0] : null,
      isComparisonRefusal(comparison) ? null : comparison.total,
      market.comparisonCurrency,
      JSON.stringify(isComparisonRefusal(comparison) ? [] : comparison.fxObservationIds),
      JSON.stringify(unknownCategories(ledger)),
      nowIso(),
    )
    summary.marketObservationsStored++
  }

  for (const trip of trips) {
    const slotKey = marketSlotKey({
      origin: trip.origin, propertyId: trip.propertyId, checkIn: trip.checkIn,
      nights: trip.nights, board: trip.board, cabin: trip.cabin ?? "unknown",
      adults: trip.adults, comparisonCurrency: market.comparisonCurrency,
    })
    recordMarketObservation(slotKey, diyConstructionLabel(trip.construction), "trip_opportunities", trip.id, buildDiyLedger(trip))

    const candidates = variants.filter(p =>
      (p.propertyId === trip.propertyId
        || (p.destinationAirport !== null && p.destinationAirport === trip.destinationAirport))
      && p.origin === trip.origin
      && p.board === trip.board
      && p.cabin === (trip.cabin ?? "unknown")
      && p.adults === trip.adults && p.children === 0
      && Math.abs(Date.parse(p.checkIn) - Date.parse(trip.checkIn)) / 86_400_000
        <= packagesCfg.competition.maxCheckInDistanceDays)

    for (const pkg of candidates) {
      summary.pairsEvaluated++
      const assessment = assessComparability(trip, pkg)
      const decision = decideMarketVerdict({ db, trip, pkg, assessment, now })

      insertVerdict.run({
        computeBatch, slotKey,
        tripId: trip.id, tripKey: trip.tripKey,
        packageObservationId: pkg.id, packageKey: pkg.packageKey,
        comparability: assessment.level,
        confidence: decision.confidence,
        verdict: decision.verdict,
        winner: decision.winner,
        reasons: JSON.stringify(decision.reasons),
        comparisonCurrency: decision.comparisonCurrency,
        diyKnownTotal: decision.diyKnownTotal,
        packageTotal: decision.packageTotal,
        absoluteDifference: decision.absoluteDifference,
        percentDifference: decision.percentDifference,
        diyLedger: JSON.stringify(buildDiyLedger(trip)),
        packageLedger: JSON.stringify(buildPackageLedger(pkg)),
        fxObservationIds: JSON.stringify(decision.fxObservationIds),
        now: nowIso(),
      })
      // The 8g comparability audit stays in sync, batch-stamped.
      recordPackageComparison(db, {
        tripId: trip.id, tripKey: trip.tripKey,
        packageObservationId: pkg.id, packageKey: pkg.packageKey,
        comparability: assessment.level,
        comparabilityReasons: assessment.reasons,
        verdict: decision.verdict,
        verdictReasons: decision.reasons,
        syntheticTotal: trip.cashTotal?.amount ?? null,
        syntheticCurrency: trip.cashTotal?.currency ?? null,
        packageTotal: pkg.totalPrice,
        packageCurrency: pkg.currency,
        knownDifference: decision.absoluteDifference,
        knownDifferencePct: decision.percentDifference,
        winner: decision.winner,
      }, computeBatch)

      recordMarketObservation(slotKey, packageConstructionLabel(pkg), "package_offer_observations", pkg.id, buildPackageLedger(pkg))

      summary.verdictsStored++
      summary.byVerdict[decision.verdict] = (summary.byVerdict[decision.verdict] ?? 0) + 1
      summary.byConfidence[decision.confidence] = (summary.byConfidence[decision.confidence] ?? 0) + 1
    }
  }
  return summary
}

// ── Current views (batch-scoped) ─────────────────────────────────────────────

export interface StoredMarketVerdict {
  id: number
  computeBatch: string
  slotKey: string
  tripId: number
  tripKey: string
  packageObservationId: number
  packageKey: string
  comparability: string
  confidence: string
  verdict: string
  winner: string | null
  reasons: string[]
  comparisonCurrency: string
  diyKnownTotal: number | null
  packageTotal: number | null
  absoluteDifference: number | null
  percentDifference: number | null
  fxObservationIds: number[]
  computedAt: string
}

function hydrateVerdict(r: Record<string, unknown>): StoredMarketVerdict {
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    computeBatch: r.compute_batch as string,
    slotKey: r.slot_key as string,
    tripId: r.trip_id as number,
    tripKey: r.trip_key as string,
    packageObservationId: r.package_observation_id as number,
    packageKey: r.package_key as string,
    comparability: r.comparability as string,
    confidence: r.confidence as string,
    verdict: r.verdict as string,
    winner: (r.winner as string) ?? null,
    reasons: parse(r.reasons, []),
    comparisonCurrency: r.comparison_currency as string,
    diyKnownTotal: (r.diy_known_total as number) ?? null,
    packageTotal: (r.package_total as number) ?? null,
    absoluteDifference: (r.absolute_difference as number) ?? null,
    percentDifference: (r.percent_difference as number) ?? null,
    fxObservationIds: parse(r.fx_observation_ids, []),
    computedAt: r.computed_at as string,
  }
}

/** Only the trip's NEWEST compute batch — superseded rows cannot pollute this. */
export function currentMarketVerdictsForTrip(db: DB, tripId: number): StoredMarketVerdict[] {
  const rows = db.prepare(`
    SELECT * FROM market_verdicts
    WHERE trip_id = @tripId
      AND compute_batch = (SELECT MAX(compute_batch) FROM market_verdicts WHERE trip_id = @tripId)
    ORDER BY package_total ASC
  `).all({ tripId }) as Record<string, unknown>[]
  return rows.map(hydrateVerdict)
}

export function marketVerdictTotals(db: DB): { verdicts: number; currentBatch: string | null; byVerdict: Record<string, number> } {
  const batch = (db.prepare("SELECT MAX(compute_batch) b FROM market_verdicts").get() as { b: string | null }).b
  const rows = batch
    ? db.prepare("SELECT verdict, COUNT(*) n FROM market_verdicts WHERE compute_batch = ? GROUP BY verdict").all(batch) as { verdict: string; n: number }[]
    : []
  const byVerdict: Record<string, number> = {}
  for (const r of rows) byVerdict[r.verdict] = r.n
  return { verdicts: rows.reduce((a, r) => a + r.n, 0), currentBatch: batch, byVerdict }
}

/**
 * The verdict that leads a trip's panel: the BEST COMPARABLE class first
 * (EXACT before CLOSE before context), cheapest package within that class —
 * a cheaper but less comparable variant must never outrank a dearer exact
 * one.
 */
export function leadVerdict(verdicts: StoredMarketVerdict[]): StoredMarketVerdict | null {
  if (verdicts.length === 0) return null
  const order: Record<string, number> = {
    EXACT_MATCH: 0, CLOSE_MATCH: 1, DESTINATION_LEVEL_ONLY: 2, NOT_COMPARABLE: 3,
  }
  return [...verdicts].sort((a, b) =>
    (order[a.comparability] ?? 9) - (order[b.comparability] ?? 9)
    || (a.packageTotal ?? Infinity) - (b.packageTotal ?? Infinity))[0]
}
