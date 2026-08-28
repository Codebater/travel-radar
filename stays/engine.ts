/**
 * The stay anomaly engine: judge stored observations, store decisions.
 *
 * Cursor-driven and database-only — it spends nothing, contacts nobody, and
 * notifies nobody. Each rate observation gets at most one decision row,
 * upserted on source_id, so re-evaluation and backfills are idempotent.
 *
 * The decision recipe per observation:
 *   1. sanity gate (suspicious rows get a 'suspicious' decision, score 0 —
 *      stored and visible, never a candidate);
 *   2. baseline against the observation's own strict past (hard dimensions,
 *      recorded relaxation, no look-ahead, sibling exclusion);
 *   3. absolute luxury rules (rulePath discipline);
 *   4. cross-source evidence facts + calendar signal;
 *   5. component assembly (drop-and-renormalise for uncomputable, real zeros
 *      keep weight, no-history capped);
 *   6. human-readable reasons.
 */

import { readState, writeState } from "../anomaly/store.js"
import { nowIso, type DB } from "../db/index.js"
import type { PriceBasis } from "../providers/stays/types.js"
import { assessStayAbsolute } from "./absolute.js"
import { assessCategoryValue } from "./category.js"
import { buildStayBaseline, type StayBaselineStats } from "./baseline.js"
import type { StayAnomalyConfig, StaysConfig } from "./config.js"
import { gatherCalendarSignal, gatherCrossSourceEvidence } from "./evidence.js"
import { stayOpportunityKey } from "./identity.js"
import { nightlyFor, stayTotalFor } from "./normalize.js"
import { getStayProperty, type StoredStayProperty } from "./registry.js"
import { assembleStayScore, type StayScorePart } from "./scoring.js"
import { assessActionability, rebuildStayWindows } from "./windows.js"

const CURSOR_KEY = "stays.anomaly.cursor"

export interface StayEvaluationSummary {
  evaluated: number
  candidates: number
  belowThreshold: number
  suspicious: number
  skippedLeadIn: number
  skippedNoProperty: number
  topScore: number | null
  durationMs: number
}

export interface EvaluateStayOptions {
  db: DB
  config: StaysConfig
  /** Re-judge everything from the beginning (cursor reset). */
  fromScratch?: boolean
  limit?: number
}

interface ObservationRow {
  id: number
  property_id: string
  provider: string
  check_in: string
  check_out: string
  nights: number
  adults: number
  children: number
  room_name: string | null
  room_class: string | null
  board: string
  board_source: string
  refundable: number | null
  rate_source: string | null
  source_class: string
  price_amount: number
  price_currency: string
  price_basis: string
  taxes_fees: string
  verification_level: string
  confidence: string
  sanity: string
  sanity_detail: string | null
  fetched_at: string
  search_request_id: number | null
}

export function evaluateStayObservations(options: EvaluateStayOptions): StayEvaluationSummary {
  const { db, config } = options
  const anomaly = config.anomaly
  const started = Date.now()
  const summary: StayEvaluationSummary = {
    evaluated: 0, candidates: 0, belowThreshold: 0, suspicious: 0,
    skippedLeadIn: 0, skippedNoProperty: 0, topScore: null, durationMs: 0,
  }

  const cursor = options.fromScratch ? 0 : Number(readState(db, CURSOR_KEY) ?? "0")
  const rows = db.prepare(`
    SELECT * FROM stay_rate_observations WHERE id > ? ORDER BY id ASC LIMIT ?
  `).all(cursor, options.limit ?? 5000) as ObservationRow[]

  let lastId = cursor
  for (const row of rows) {
    lastId = row.id
    if (row.price_basis === "lead_in") { summary.skippedLeadIn++; continue }
    const property = getStayProperty(db, row.property_id)
    if (!property) { summary.skippedNoProperty++; continue }

    const decision = judgeObservation(db, row, property, anomaly)
    upsertCandidate(db, row, decision, anomaly)
    summary.evaluated++
    if (decision.status === "suspicious") summary.suspicious++
    else if (decision.status === "candidate") summary.candidates++
    else summary.belowThreshold++
    if (decision.status !== "suspicious") {
      summary.topScore = Math.max(summary.topScore ?? 0, decision.score)
    }
  }

  writeState(db, CURSOR_KEY, String(lastId))

  // Scores changed, so the presentation families over them are stale.
  // Rebuilding here keeps windows honest without a second command to forget.
  rebuildStayWindows(db)

  summary.durationMs = Date.now() - started
  return summary
}

interface StayDecision {
  score: number
  components: Record<string, unknown>
  reasons: string[]
  status: "candidate" | "below_threshold" | "suspicious"
  baseline: StayBaselineStats | null
  absolute: ReturnType<typeof assessStayAbsolute>
  evidence: ReturnType<typeof gatherCrossSourceEvidence>
  calendar: ReturnType<typeof gatherCalendarSignal>
  confirmationState: string
  nightly: number
  stayTotal: number | null
  /** The four concepts, 0..100, null when uncomputable. */
  relativeScore: number | null
  absoluteValueScore: number | null
  evidenceScore: number | null
  actionabilityScore: number | null
}

function judgeObservation(
  db: DB,
  row: ObservationRow,
  property: StoredStayProperty,
  config: StayAnomalyConfig,
): StayDecision {
  const rateShape = {
    priceBasis: row.price_basis as PriceBasis,
    price: { amount: row.price_amount, currency: row.price_currency },
    nights: row.nights,
  }
  const nightly = nightlyFor(rateShape) ?? 0
  const stayTotal = stayTotalFor(rateShape)

  const evidence = gatherCrossSourceEvidence(db, {
    propertyId: row.property_id, checkIn: row.check_in, sourceClass: row.source_class,
    nightly, currency: row.price_currency, fetchedAt: row.fetched_at,
    verificationLevel: row.verification_level,
  }, config)
  const calendar = gatherCalendarSignal(db, {
    propertyId: row.property_id, checkIn: row.check_in, checkOut: row.check_out,
    nights: row.nights, fetchedAt: row.fetched_at,
  }, config)

  // Suspicious rows are judged suspicious, full stop: stored, visible,
  // excluded from candidacy — and they never entered anyone's baseline.
  if (row.sanity !== "ok") {
    return {
      score: 0, components: {}, reasons: ["SUSPICIOUS_DATA"],
      status: "suspicious", baseline: null,
      absolute: { tier: null, score: 0, thresholdUsed: null, rulePath: "none", detail: "not assessed: suspicious data" },
      evidence, calendar, confirmationState: evidence.confirmationState,
      nightly, stayTotal,
      relativeScore: null, absoluteValueScore: null, evidenceScore: null, actionabilityScore: null,
    }
  }

  const baseline = nightly > 0 ? buildStayBaseline(db, {
    propertyId: row.property_id, sourceClass: row.source_class,
    roomClass: row.room_class, board: row.board,
    adults: row.adults, children: row.children,
    currency: row.price_currency, taxesFees: row.taxes_fees, nights: row.nights,
    nightly, asOf: row.fetched_at, searchRequestId: row.search_request_id,
  }, config) : null

  const absolute = assessStayAbsolute({
    nightly, currency: row.price_currency,
    destinationGroup: property.destinationGroup,
    board: row.board, luxuryTier: property.luxuryTier,
    roomClass: row.room_class,
  }, config)

  // ── The four concepts, each 0..1 ─────────────────────────────────────────

  // A. RELATIVE ANOMALY — how abnormal versus the property's own history.
  // Percentile credit is scaled by baseline MATURITY: being the lowest of
  // five observations is a fact about five observations, not the property.
  let relativeRaw: number | null = null
  let relativeDetail = "no baseline"
  if (baseline) {
    const pctBelowCredit = clamp01(baseline.percentBelowMedian / config.fullCreditPercentBelowMedian)
    const percentileCredit =
      clamp01((config.lowPercentileFullCreditAt - baseline.percentile) / config.lowPercentileFullCreditAt)
      * baseline.confidenceValue
    const comp = config.relativeComposition
    relativeRaw = clamp01(pctBelowCredit * comp.percentBelowMedian + percentileCredit * comp.percentile)
    relativeDetail = `${baseline.percentBelowMedian}% below the ${baseline.count}-observation median; ` +
      `${baseline.percentile}th percentile × maturity ${baseline.confidenceValue} (${baseline.confidence})`
  }

  // B. ABSOLUTE VALUE — two sub-axes, best of both:
  //   hard exceptional-price rules (config bars), and
  //   category-relative value (the cross-property cheap tail) where enough
  //   comparable data exists. A stay can be objectively exceptional for its
  //   category even when it is normal for its property. Uncomputable only
  //   when NEITHER axis could run.
  const category = assessCategoryValue(db, {
    propertyId: row.property_id,
    destinationGroup: property.destinationGroup,
    luxuryTier: property.luxuryTier,
    board: row.board, sourceClass: row.source_class,
    taxesFees: row.taxes_fees, currency: row.price_currency,
    nightly, asOf: row.fetched_at, searchRequestId: row.search_request_id,
  }, config)

  let absoluteRaw: number | null = null
  let absoluteDetail = absolute.detail
  if (absolute.rulePath !== "none" && category) {
    absoluteRaw = Math.max(absolute.score, category.credit)
    absoluteDetail = category.credit > absolute.score
      ? `${category.detail}; hard bars: ${absolute.detail}`
      : `${absolute.detail}; category: ${category.detail}`
  } else if (absolute.rulePath !== "none") {
    absoluteRaw = absolute.score
  } else if (category) {
    absoluteRaw = category.credit
    absoluteDetail = category.detail
  }

  // C. EVIDENCE — the trust ladder plus what the other tiers saw.
  const levelValue = config.evidenceValues[row.verification_level as "discovered" | "confirmed" | "verified"] ?? 0.3
  let evidenceRaw = levelValue
  const evidenceNotes: string[] = [row.verification_level]
  if (row.verification_level !== "verified" && row.source_class !== "retail") {
    if (evidence.verifiedExists && evidence.verifiedCorroborates) {
      evidenceRaw = Math.max(evidenceRaw, config.evidenceValues.metaWithVerified)
      evidenceNotes.push("verified corroboration on record")
    } else if (evidence.confirmationState === "retail_confirmed") {
      evidenceRaw = Math.max(evidenceRaw, config.evidenceValues.metaWithRetailConfirmation)
      evidenceNotes.push("retail confirmation on record")
    }
  }

  // D. ACTIONABILITY — can a person actually take this trip? Persistence of
  // the low price across neighbouring check-ins and the calendar, gated so it
  // can never rescue an ordinary price.
  const notablePrice = (relativeRaw ?? 0) >= config.actionability.minNotableRelative
    || (absolute.tier !== null)
  const actionability = assessActionability(db, {
    propertyId: row.property_id, checkIn: row.check_in, checkOut: row.check_out,
    nights: row.nights, sourceClass: row.source_class, board: row.board,
    currency: row.price_currency, taxesFees: row.taxes_fees, nightly, fetchedAt: row.fetched_at,
  }, notablePrice, config)

  const parts: Record<string, StayScorePart> = {
    relative: relativeRaw !== null
      ? { raw: relativeRaw, weight: config.weights.relative, detail: relativeDetail }
      : { raw: null, weight: config.weights.relative, detail: relativeDetail },
    absoluteValue: absoluteRaw !== null
      ? { raw: absoluteRaw, weight: config.weights.absoluteValue, detail: absoluteDetail }
      : { raw: null, weight: config.weights.absoluteValue, detail: absoluteDetail },
    evidence: { raw: evidenceRaw, weight: config.weights.evidence, detail: evidenceNotes.join(" + ") },
    actionability: { raw: actionability.value, weight: config.weights.actionability, detail: actionability.detail },
  }

  const cap = baseline ? undefined : {
    max: config.noHistoryScoreCap,
    detail: `capped at ${config.noHistoryScoreCap}: judged with no baseline behind it — evidence outranks assertion`,
  }
  const assembled = assembleStayScore(parts, config.weightsVersion, cap)

  // ── Reasons ───────────────────────────────────────────────────────────────
  const reasons: string[] = []
  if (baseline) {
    if (baseline.percentBelowMedian >= 10) {
      reasons.push(`PROPERTY_LOW_${Math.round(baseline.percentBelowMedian)}_PERCENT`)
    }
    if (baseline.isNewObservedLow) reasons.push("NEW_OBSERVED_LOW")
    if (baseline.count < 8) reasons.push("THIN_BASELINE")
    if (baseline.stale) reasons.push("STALE_BASELINE")
    if (baseline.scope !== "strict") reasons.push("BASELINE_ANY_LENGTH")
  } else {
    reasons.push("NO_BASELINE")
  }
  if (absolute.tier) {
    reasons.push(row.board === "all_inclusive"
      ? "ALL_INCLUSIVE_UNDER_ABSOLUTE_BAR"
      : `UNDER_ABSOLUTE_BAR_${absolute.tier.toUpperCase()}`)
  }
  if (category && category.credit > 0) reasons.push("CATEGORY_CHEAP_TAIL")
  if (row.source_class === "retail" && row.provider === "agoda") reasons.push("CONFIRMED_BY_AGODA")
  if (row.verification_level === "verified") reasons.push("VERIFIED_BY_GOOGLE")
  if (evidence.confirmationState === "meta_only") reasons.push("META_ONLY")
  if (evidence.confirmationState === "retail_confirmed") reasons.push("RETAIL_CONFIRMATION_ON_RECORD")
  if (evidence.retailSpreadHigh) reasons.push("RETAIL_SPREAD_HIGH")
  if (evidence.verifiedExists && evidence.verifiedCorroborates) reasons.push("VERIFIED_CORROBORATES")
  if (evidence.verifiedSpreadHigh) reasons.push("VERIFIED_SPREAD_HIGH")
  if (evidence.boardConfirmedAllInclusive && row.source_class !== "retail") reasons.push("AI_CONFIRMED_AT_RETAIL")
  if (row.taxes_fees === "included") reasons.push("TAX_INCLUDED")
  if (calendar.flippedToCheap) reasons.push("CALENDAR_FLIP_TO_CHEAP")
  if (actionability.value > 0 && actionability.persistence === "sustained") reasons.push("SUSTAINED_CHEAP_WINDOW")
  if (actionability.value > 0 && actionability.persistence === "isolated") reasons.push("ISOLATED_CHEAP_DATE")
  if (row.board_source === "property_default") reasons.push("BOARD_FROM_PROPERTY_DEFAULT")

  const status = assembled.score >= config.candidateThreshold ? "candidate" : "below_threshold"
  return {
    score: assembled.score,
    components: assembled.components as unknown as Record<string, unknown>,
    reasons, status, baseline, absolute, evidence, calendar,
    confirmationState: evidence.confirmationState,
    nightly, stayTotal,
    relativeScore: relativeRaw !== null ? Math.round(relativeRaw * 1000) / 10 : null,
    absoluteValueScore: absoluteRaw !== null ? Math.round(absoluteRaw * 1000) / 10 : null,
    evidenceScore: Math.round(evidenceRaw * 1000) / 10,
    actionabilityScore: Math.round(actionability.value * 1000) / 10,
  }
}

function upsertCandidate(db: DB, row: ObservationRow, d: StayDecision, config: StayAnomalyConfig): void {
  db.prepare(`
    INSERT INTO stay_candidates (
      source_id, opportunity_key, property_id, observed_at, as_of, evaluated_at,
      check_in, check_out, nights, adults, children,
      room_name, room_class, board, board_source, source_class, rate_source,
      provider, verification_level,
      nightly_amount, stay_total, price_currency, taxes_fees,
      baseline_key, baseline_scope, sample_size, observed_median, observed_minimum,
      percentile, percent_below_median, baseline_first_at, baseline_last_at,
      baseline_age_days, baseline_confidence,
      absolute_tier, absolute_rule_path,
      confirmation_state, evidence,
      relative_score, absolute_value_score, evidence_score, actionability_score,
      score, score_breakdown, reasons, threshold, status, sanity,
      engine_version, weights_version, created_at
    ) VALUES (
      @sourceId, @opportunityKey, @propertyId, @observedAt, @asOf, @evaluatedAt,
      @checkIn, @checkOut, @nights, @adults, @children,
      @roomName, @roomClass, @board, @boardSource, @sourceClass, @rateSource,
      @provider, @verificationLevel,
      @nightlyAmount, @stayTotal, @priceCurrency, @taxesFees,
      @baselineKey, @baselineScope, @sampleSize, @observedMedian, @observedMinimum,
      @percentile, @percentBelowMedian, @baselineFirstAt, @baselineLastAt,
      @baselineAgeDays, @baselineConfidence,
      @absoluteTier, @absoluteRulePath,
      @confirmationState, @evidence,
      @relativeScore, @absoluteValueScore, @evidenceScore, @actionabilityScore,
      @score, @scoreBreakdown, @reasons, @threshold, @status, @sanity,
      @engineVersion, @weightsVersion, @createdAt
    )
    ON CONFLICT(source_id) DO UPDATE SET
      opportunity_key = excluded.opportunity_key,
      as_of = excluded.as_of, evaluated_at = excluded.evaluated_at,
      baseline_key = excluded.baseline_key, baseline_scope = excluded.baseline_scope,
      sample_size = excluded.sample_size, observed_median = excluded.observed_median,
      observed_minimum = excluded.observed_minimum,
      percentile = excluded.percentile, percent_below_median = excluded.percent_below_median,
      baseline_first_at = excluded.baseline_first_at, baseline_last_at = excluded.baseline_last_at,
      baseline_age_days = excluded.baseline_age_days, baseline_confidence = excluded.baseline_confidence,
      absolute_tier = excluded.absolute_tier, absolute_rule_path = excluded.absolute_rule_path,
      confirmation_state = excluded.confirmation_state, evidence = excluded.evidence,
      relative_score = excluded.relative_score, absolute_value_score = excluded.absolute_value_score,
      evidence_score = excluded.evidence_score, actionability_score = excluded.actionability_score,
      score = excluded.score, score_breakdown = excluded.score_breakdown,
      reasons = excluded.reasons, threshold = excluded.threshold, status = excluded.status,
      sanity = excluded.sanity, engine_version = excluded.engine_version,
      weights_version = excluded.weights_version
  `).run({
    sourceId: row.id,
    opportunityKey: stayOpportunityKey({
      propertyId: row.property_id, checkIn: row.check_in, nights: row.nights,
      board: row.board, roomClass: row.room_class, sourceClass: row.source_class,
      currency: row.price_currency,
    }, config.baseline.nightsBuckets),
    propertyId: row.property_id,
    observedAt: row.fetched_at,
    asOf: row.fetched_at,
    evaluatedAt: nowIso(),
    checkIn: row.check_in, checkOut: row.check_out, nights: row.nights,
    adults: row.adults, children: row.children,
    roomName: row.room_name, roomClass: row.room_class,
    board: row.board, boardSource: row.board_source,
    sourceClass: row.source_class, rateSource: row.rate_source,
    provider: row.provider, verificationLevel: row.verification_level,
    nightlyAmount: d.nightly, stayTotal: d.stayTotal,
    priceCurrency: row.price_currency, taxesFees: row.taxes_fees,
    baselineKey: d.baseline?.key ?? null,
    baselineScope: d.baseline?.scope ?? "no-history",
    sampleSize: d.baseline?.count ?? 0,
    observedMedian: d.baseline?.median ?? null,
    observedMinimum: d.baseline?.min ?? null,
    percentile: d.baseline?.percentile ?? null,
    percentBelowMedian: d.baseline?.percentBelowMedian ?? null,
    baselineFirstAt: d.baseline?.firstAt ?? null,
    baselineLastAt: d.baseline?.lastAt ?? null,
    baselineAgeDays: d.baseline?.ageDays ?? null,
    baselineConfidence: d.baseline?.confidence ?? "INSUFFICIENT",
    absoluteTier: d.absolute.tier,
    absoluteRulePath: d.absolute.rulePath,
    confirmationState: d.confirmationState,
    evidence: JSON.stringify({
      crossSource: d.evidence,
      calendar: d.calendar,
    }),
    relativeScore: d.relativeScore,
    absoluteValueScore: d.absoluteValueScore,
    evidenceScore: d.evidenceScore,
    actionabilityScore: d.actionabilityScore,
    score: d.score,
    scoreBreakdown: JSON.stringify(d.components),
    reasons: JSON.stringify(d.reasons),
    threshold: config.candidateThreshold,
    status: d.status,
    sanity: row.sanity,
    engineVersion: config.engineVersion,
    weightsVersion: config.weightsVersion,
    createdAt: nowIso(),
  })
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
