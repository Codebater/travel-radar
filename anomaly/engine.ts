/**
 * §I - the shadow anomaly engine.
 *
 * It reads observations, decides what it THINKS is exceptional, and writes that
 * decision down. It does not notify. There is no transport in this package and
 * no call site that could reach one: `notified` is written 0, always, and the
 * only outputs are database rows.
 *
 * The engine is pure database work - it never calls a provider, so evaluating a
 * year of history costs nothing and cannot spend API budget.
 *
 * Two invariants:
 *   §Y  a decision about an observation from time T uses ONLY observations
 *       recorded before T. Live evaluation and historical recomputation take
 *       the identical code path, so a backfill result means what it says.
 *   §K  a thin baseline cannot produce a confident candidate. Below
 *       `minSamplesToEmit` no decision is recorded at all - "we do not know"
 *       is an answer, and inventing a percentile from three prices is not.
 */

import { getDb, type DB } from "../db/index.js"
import { loadAnomalyConfig, type AnomalyConfig } from "./config.js"
import { buildComparabilityKey, featuresFor } from "./comparability.js"
import { cashBaselineRows, awardBaselineRows, buildBaseline } from "./baseline.js"
import { computeCpp } from "./cpp.js"
import { scoreCash, scoreAward, reasonsFor, matchPresets } from "./scoring.js"
import { compareProgramsForItinerary } from "./programs.js"
import { saveCandidate, readState, writeState } from "./store.js"
import type { DealCandidate } from "./types.js"

const CURSOR_CASH = "anomaly.cursor.flight_prices"
const CURSOR_AWARD = "anomaly.cursor.award_prices"

export interface EvaluationSummary {
  evaluated: number
  candidates: number
  belowThreshold: number
  skippedThinBaseline: number
  skippedNoBaseline: number
  byType: { cash: number; award: number }
  topScore: number | null
  durationMs: number
}

function emptySummary(): EvaluationSummary {
  return {
    evaluated: 0, candidates: 0, belowThreshold: 0,
    skippedThinBaseline: 0, skippedNoBaseline: 0,
    byType: { cash: 0, award: 0 }, topScore: null, durationMs: 0,
  }
}

interface CashObservation {
  id: number
  itinerary_hash: string
  origin: string
  destination: string
  departure_date: string
  return_date: string | null
  cabin: string
  airline: string | null
  stops: number | null
  price_amount: number
  price_currency: string
  provider: string
  verification_level: string
  provider_confidence: string
  fetched_at: string
}

interface AwardObservation {
  id: number
  itinerary_hash: string
  origin: string
  destination: string
  departure_date: string
  return_date: string | null
  cabin: string
  airline: string | null
  stops: number | null
  loyalty_program: string
  points: number
  taxes_amount: number | null
  taxes_currency: string | null
  provider: string
  verification_level: string
  provider_confidence: string
  fetched_at: string
}

/** Decide about one cash observation. Returns null when we cannot say anything. */
export function evaluateCashObservation(
  db: DB, row: CashObservation, config: AnomalyConfig,
): DealCandidate | { skipped: "no-baseline" | "thin-baseline" } {
  const key = buildComparabilityKey({
    origin: row.origin, destination: row.destination, cabin: row.cabin,
    departureDate: row.departure_date, returnDate: row.return_date, stops: row.stops,
  }, config)

  // §Y the observation's own timestamp is the cut-off, not "now".
  const asOf = row.fetched_at
  const rows = cashBaselineRows(db, key, asOf, config, row.price_currency, row.id)
  const baseline = buildBaseline(rows, key, row.price_amount, asOf, config)
  if (!baseline) return { skipped: "no-baseline" }
  if (baseline.count < config.minSamplesToEmit) return { skipped: "thin-baseline" }

  const breakdown = scoreCash({
    price: row.price_amount, currency: row.price_currency, stops: row.stops,
    providerConfidence: row.provider_confidence, verificationLevel: row.verification_level,
    baseline,
  }, config)

  const reasons = reasonsFor({
    type: "cash", cabin: row.cabin, stops: row.stops, baseline,
    verificationLevel: row.verification_level, config,
  })

  return {
    sourceTable: "flight_prices",
    sourceId: row.id,
    observedAt: row.fetched_at,
    asOf,
    evaluatedAt: new Date().toISOString(),
    type: "cash",
    origin: row.origin,
    destination: row.destination,
    route: `${row.origin}-${row.destination}`,
    departureDate: row.departure_date,
    returnDate: row.return_date,
    tripType: key.tripType,
    cabin: row.cabin,
    airline: row.airline,
    stops: row.stops,
    itineraryHash: row.itinerary_hash,
    loyaltyProgram: null,
    priceAmount: row.price_amount,
    priceCurrency: row.price_currency,
    points: null,
    taxesAmount: null,
    taxesCurrency: null,
    baseline,
    cpp: null,
    programComparison: null,
    provider: row.provider,
    providerConfidence: row.provider_confidence,
    verificationLevel: row.verification_level,
    score: breakdown.score,
    scoreBreakdown: breakdown,
    reasons,
    features: featuresFor({
      departureDate: row.departure_date, returnDate: row.return_date, observedAt: row.fetched_at,
    }),
    presetsMatched: matchPresets({ type: "cash", score: breakdown.score, baseline, config }),
    threshold: config.candidateThreshold,
    status: breakdown.score >= config.candidateThreshold ? "candidate" : "below-threshold",
    engineVersion: config.engineVersion,
  }
}

/** Decide about one award observation (route + cabin + PROGRAM, §N). */
export function evaluateAwardObservation(
  db: DB, row: AwardObservation, config: AnomalyConfig,
): DealCandidate | { skipped: "no-baseline" | "thin-baseline" } {
  const key = buildComparabilityKey({
    origin: row.origin, destination: row.destination, cabin: row.cabin,
    departureDate: row.departure_date, returnDate: row.return_date, stops: row.stops,
    loyaltyProgram: row.loyalty_program,
  }, config)

  const asOf = row.fetched_at
  const rows = awardBaselineRows(db, key, asOf, config, row.id)
  const baseline = buildBaseline(rows, key, row.points, asOf, config)
  if (!baseline) return { skipped: "no-baseline" }
  if (baseline.count < config.minSamplesToEmit) return { skipped: "thin-baseline" }

  // §O/§P points and surcharge stay separate; CPP carries its own provenance.
  const cpp = computeCpp(db, {
    key, departureDate: row.departure_date, points: row.points,
    taxesAmount: row.taxes_amount, taxesCurrency: row.taxes_currency, asOf,
  }, config)

  const breakdown = scoreAward({
    points: row.points, taxesAmount: row.taxes_amount, taxesCurrency: row.taxes_currency,
    cabin: row.cabin, stops: row.stops,
    providerConfidence: row.provider_confidence, verificationLevel: row.verification_level,
    baseline, cpp,
  }, config)

  const reasons = reasonsFor({
    type: "award", cabin: row.cabin, stops: row.stops, baseline,
    verificationLevel: row.verification_level, cpp, taxesAmount: row.taxes_amount, config,
  })

  // §Q only worth computing for decisions somebody may actually look at.
  const programComparison = breakdown.score >= config.candidateThreshold
    ? compareProgramsForItinerary(db, row.itinerary_hash, asOf, config)
    : null

  return {
    sourceTable: "award_prices",
    sourceId: row.id,
    observedAt: row.fetched_at,
    asOf,
    evaluatedAt: new Date().toISOString(),
    type: "award",
    origin: row.origin,
    destination: row.destination,
    route: `${row.origin}-${row.destination}`,
    departureDate: row.departure_date,
    returnDate: row.return_date,
    tripType: key.tripType,
    cabin: row.cabin,
    airline: row.airline,
    stops: row.stops,
    itineraryHash: row.itinerary_hash,
    loyaltyProgram: row.loyalty_program,
    priceAmount: null,
    priceCurrency: null,
    points: row.points,
    taxesAmount: row.taxes_amount,
    taxesCurrency: row.taxes_currency,
    baseline,
    cpp,
    programComparison,
    provider: row.provider,
    providerConfidence: row.provider_confidence,
    verificationLevel: row.verification_level,
    score: breakdown.score,
    scoreBreakdown: breakdown,
    reasons,
    features: featuresFor({
      departureDate: row.departure_date, returnDate: row.return_date, observedAt: row.fetched_at,
    }),
    presetsMatched: matchPresets({ type: "award", score: breakdown.score, baseline, cpp, config }),
    threshold: config.candidateThreshold,
    status: breakdown.score >= config.candidateThreshold ? "candidate" : "below-threshold",
    engineVersion: config.engineVersion,
  }
}

function record(db: DB, decision: DealCandidate, config: AnomalyConfig, summary: EvaluationSummary): void {
  summary.evaluated++
  summary.byType[decision.type]++
  if (decision.status === "candidate") summary.candidates++
  else summary.belowThreshold++
  if (summary.topScore === null || decision.score > summary.topScore) summary.topScore = decision.score
  if (decision.status === "candidate" || config.storeBelowThreshold) {
    saveCandidate(db, decision)
  }
}

export interface EvaluateOptions {
  db?: DB
  config?: AnomalyConfig
  /** Ignore the cursor and re-evaluate everything from the start (§Y backfill). */
  fromScratch?: boolean
  /** Cap the work per invocation so a scheduler tick stays short. */
  limit?: number
  /** Only observations at/after this timestamp. */
  since?: string
  quiet?: boolean
}

/**
 * Evaluate observations that have not been judged yet, newest work last so the
 * cursor advances monotonically. Safe to call on every scheduler tick: it is
 * database-only and does nothing when there is nothing new.
 */
export function evaluateNewObservations(options: EvaluateOptions = {}): EvaluationSummary {
  const db = options.db ?? getDb()
  const config = options.config ?? loadAnomalyConfig()
  const started = Date.now()
  const summary = emptySummary()
  const limit = options.limit ?? 5000

  const cashCursor = options.fromScratch ? 0 : Number(readState(db, CURSOR_CASH) ?? 0)
  const awardCursor = options.fromScratch ? 0 : Number(readState(db, CURSOR_AWARD) ?? 0)

  const cashRows = db.prepare(`
    SELECT * FROM flight_prices
    WHERE id > ? ${options.since ? "AND fetched_at >= ?" : ""}
    ORDER BY id ASC LIMIT ?
  `).all(...(options.since ? [cashCursor, options.since, limit] : [cashCursor, limit])) as CashObservation[]

  for (const row of cashRows) {
    const decision = evaluateCashObservation(db, row, config)
    if ("skipped" in decision) {
      if (decision.skipped === "thin-baseline") summary.skippedThinBaseline++
      else summary.skippedNoBaseline++
    } else {
      record(db, decision, config, summary)
    }
  }
  if (cashRows.length > 0) writeState(db, CURSOR_CASH, String(cashRows[cashRows.length - 1]!.id))

  const awardRows = db.prepare(`
    SELECT * FROM award_prices
    WHERE id > ? ${options.since ? "AND fetched_at >= ?" : ""}
    ORDER BY id ASC LIMIT ?
  `).all(...(options.since ? [awardCursor, options.since, limit] : [awardCursor, limit])) as AwardObservation[]

  for (const row of awardRows) {
    const decision = evaluateAwardObservation(db, row, config)
    if ("skipped" in decision) {
      if (decision.skipped === "thin-baseline") summary.skippedThinBaseline++
      else summary.skippedNoBaseline++
    } else {
      record(db, decision, config, summary)
    }
  }
  if (awardRows.length > 0) writeState(db, CURSOR_AWARD, String(awardRows[awardRows.length - 1]!.id))

  summary.durationMs = Date.now() - started
  if (!options.quiet && summary.evaluated > 0) {
    console.log(
      `ANOMALY (shadow, no alerts): evaluated ${summary.evaluated} observations, ` +
      `${summary.candidates} candidates >= ${config.candidateThreshold}, ` +
      `${summary.skippedThinBaseline} skipped for a thin baseline, ${summary.durationMs}ms`,
    )
  }
  return summary
}

/**
 * §Y historical recomputation. Identical logic, applied to everything already
 * stored - each observation still judged only against its own past. Use after
 * changing weights, to see what the new configuration WOULD have said.
 */
export function recomputeHistory(options: EvaluateOptions = {}): EvaluationSummary {
  return evaluateNewObservations({ ...options, fromScratch: true, limit: options.limit ?? 100_000 })
}
