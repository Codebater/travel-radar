/**
 * Persistence for shadow decisions and human feedback.
 *
 * Re-evaluating an observation UPDATES its decision rather than appending a
 * second one (UNIQUE on source_table+source_id), so a backfill can be re-run
 * as often as the weights change without inflating the candidate count - and
 * any feedback already attached to that decision stays attached.
 */

import type { DB } from "../db/index.js"
import { nowIso } from "../db/index.js"
import type { DealCandidate, FeedbackVerdict } from "./types.js"

export interface StoredCandidate extends Omit<DealCandidate, "baseline" | "scoreBreakdown"> {
  id: number
  createdAt: string
  baseline: DealCandidate["baseline"]
  scoreBreakdown: DealCandidate["scoreBreakdown"]
  feedback: { verdict: FeedbackVerdict; note: string | null; createdAt: string } | null
}

function parse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

/** Insert or refresh the decision for one observation. Returns its row id. */
export function saveCandidate(db: DB, c: DealCandidate): number {
  const b = c.baseline
  const info = db.prepare(`
    INSERT INTO deal_candidates (
      source_table, source_id, observed_at, as_of, evaluated_at,
      type, origin, destination, route, departure_date, return_date, trip_type,
      cabin, airline, stops, itinerary_hash,
      loyalty_program, price_amount, price_currency, points, taxes_amount, taxes_currency,
      baseline_key, baseline_scope, observed_median, observed_minimum, observed_maximum,
      percent_below_median, percentile, sample_size, baseline_confidence,
      baseline_first_at, baseline_last_at, baseline_age_days,
      cpp, cpp_basis, cpp_confidence, cash_provenance, award_provenance, program_comparison,
      provider, provider_confidence, verification_level,
      score, score_breakdown, weights_version, engine_version, reasons, features,
      presets_matched, threshold, mode, status, notified, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, 'shadow', ?, 0, ?
    )
    ON CONFLICT(source_table, source_id) DO UPDATE SET
      as_of = excluded.as_of, evaluated_at = excluded.evaluated_at,
      baseline_key = excluded.baseline_key, baseline_scope = excluded.baseline_scope,
      observed_median = excluded.observed_median, observed_minimum = excluded.observed_minimum,
      observed_maximum = excluded.observed_maximum,
      percent_below_median = excluded.percent_below_median, percentile = excluded.percentile,
      sample_size = excluded.sample_size, baseline_confidence = excluded.baseline_confidence,
      baseline_first_at = excluded.baseline_first_at, baseline_last_at = excluded.baseline_last_at,
      baseline_age_days = excluded.baseline_age_days,
      cpp = excluded.cpp, cpp_basis = excluded.cpp_basis, cpp_confidence = excluded.cpp_confidence,
      cash_provenance = excluded.cash_provenance, award_provenance = excluded.award_provenance,
      program_comparison = excluded.program_comparison,
      score = excluded.score, score_breakdown = excluded.score_breakdown,
      weights_version = excluded.weights_version, engine_version = excluded.engine_version,
      reasons = excluded.reasons, features = excluded.features,
      presets_matched = excluded.presets_matched, threshold = excluded.threshold,
      status = excluded.status
  `).run(
    c.sourceTable, c.sourceId, c.observedAt, c.asOf, c.evaluatedAt,
    c.type, c.origin, c.destination, c.route, c.departureDate, c.returnDate, c.tripType,
    c.cabin, c.airline, c.stops, c.itineraryHash,
    c.loyaltyProgram, c.priceAmount, c.priceCurrency, c.points, c.taxesAmount, c.taxesCurrency,
    b.key, b.scope, b.median, b.min, b.max,
    b.percentBelowMedian, b.percentile, b.count, b.confidence,
    b.firstAt, b.lastAt, b.ageDays,
    c.cpp?.cpp ?? null, c.cpp?.basis ?? null, c.cpp?.confidence ?? null,
    c.cpp ? JSON.stringify(c.cpp.cashProvenance) : null,
    JSON.stringify({ provider: c.provider, verificationLevel: c.verificationLevel, providerConfidence: c.providerConfidence }),
    c.programComparison ? JSON.stringify(c.programComparison) : null,
    c.provider, c.providerConfidence, c.verificationLevel,
    c.score, JSON.stringify(c.scoreBreakdown), c.scoreBreakdown.weightsVersion, c.engineVersion,
    JSON.stringify(c.reasons), JSON.stringify(c.features),
    JSON.stringify(c.presetsMatched), c.threshold, c.status, nowIso(),
  )
  // NOT info.lastInsertRowid: SQLite leaves last_insert_rowid() untouched when
  // the upsert takes the UPDATE branch, so it would hand back a stale id from
  // an earlier insert. The unique key is the only reliable lookup.
  void info
  const row = db.prepare(
    `SELECT id FROM deal_candidates WHERE source_table = ? AND source_id = ?`,
  ).get(c.sourceTable, c.sourceId) as { id: number }
  return row.id
}

export interface CandidateFilter {
  minScore?: number
  status?: "candidate" | "below-threshold"
  type?: "cash" | "award"
  route?: string
  since?: string
  limit?: number
  /**
   * Collapse repeat observations of the SAME offer (default true).
   *
   * The observer re-searches a route every few days, so one Etihad fare at
   * 12,800 points on 2 September is a fresh row every time it is still there.
   * Every one of those is a legitimate observation and a legitimate decision,
   * but a reader wants the offer once, not six times. Storage keeps them all;
   * only the listing collapses them, keeping the highest-scoring row.
   */
  collapse?: boolean
}

export function listCandidates(db: DB, filter: CandidateFilter = {}): StoredCandidate[] {
  const where: string[] = []
  const params: any[] = []
  if (filter.minScore !== undefined) { where.push("c.score >= ?"); params.push(filter.minScore) }
  if (filter.status) { where.push("c.status = ?"); params.push(filter.status) }
  if (filter.type) { where.push("c.type = ?"); params.push(filter.type) }
  if (filter.route) { where.push("c.route = ?"); params.push(filter.route) }
  if (filter.since) { where.push("c.observed_at >= ?"); params.push(filter.since) }
  const limit = Math.min(filter.limit ?? 50, 500)
  const collapse = filter.collapse !== false

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT c.*,
             f.verdict fb_verdict, f.note fb_note, f.created_at fb_at,
             ROW_NUMBER() OVER (
               PARTITION BY c.type, c.route, c.cabin, COALESCE(c.loyalty_program, ''),
                            c.departure_date, COALESCE(c.return_date, ''),
                            COALESCE(c.points, c.price_amount),
                            -- Currency belongs in the key: 450 EUR and 450 USD
                            -- are different offers, and without this one of
                            -- them silently disappears from the list.
                            COALESCE(c.price_currency, c.taxes_currency, '')
               ORDER BY c.score DESC, c.observed_at DESC, c.id DESC
             ) offer_rank
      FROM deal_candidates c
      LEFT JOIN (
        SELECT candidate_id, verdict, note, created_at,
               ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) rn
        FROM deal_feedback
      ) f ON f.candidate_id = c.id AND f.rn = 1
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    )
    WHERE ${collapse ? "offer_rank = 1" : "1 = 1"}
    ORDER BY score DESC, observed_at DESC
    LIMIT ?
  `).all(...params, limit) as any[]

  return rows.map(rowToCandidate)
}

export function getCandidate(db: DB, id: number): StoredCandidate | null {
  const row = db.prepare(`
    SELECT c.*, f.verdict fb_verdict, f.note fb_note, f.created_at fb_at
    FROM deal_candidates c
    LEFT JOIN (
      SELECT candidate_id, verdict, note, created_at,
             ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) rn
      FROM deal_feedback
    ) f ON f.candidate_id = c.id AND f.rn = 1
    WHERE c.id = ?
  `).get(id) as any
  return row ? rowToCandidate(row) : null
}

function rowToCandidate(r: any): StoredCandidate {
  return {
    id: r.id,
    sourceTable: r.source_table,
    sourceId: r.source_id,
    observedAt: r.observed_at,
    asOf: r.as_of,
    evaluatedAt: r.evaluated_at,
    type: r.type,
    origin: r.origin,
    destination: r.destination,
    route: r.route,
    departureDate: r.departure_date,
    returnDate: r.return_date,
    tripType: r.trip_type,
    cabin: r.cabin,
    airline: r.airline,
    stops: r.stops,
    itineraryHash: r.itinerary_hash,
    loyaltyProgram: r.loyalty_program,
    priceAmount: r.price_amount,
    priceCurrency: r.price_currency,
    points: r.points,
    taxesAmount: r.taxes_amount,
    taxesCurrency: r.taxes_currency,
    baseline: {
      key: r.baseline_key,
      scope: r.baseline_scope,
      count: r.sample_size,
      min: r.observed_minimum,
      max: r.observed_maximum,
      median: r.observed_median,
      percentile: r.percentile,
      percentBelowMedian: r.percent_below_median,
      differenceFromMinimum: r.observed_minimum === null ? 0
        : Math.round(((r.type === "award" ? r.points : r.price_amount) - r.observed_minimum) * 100) / 100,
      firstAt: r.baseline_first_at,
      lastAt: r.baseline_last_at,
      ageDays: r.baseline_age_days,
      confidence: r.baseline_confidence,
      confidenceValue: 0,
      medianTaxes: null,
      taxesCurrency: null,
      isNewObservedLow: (r.type === "award" ? r.points : r.price_amount) < r.observed_minimum,
    },
    cpp: r.cpp === null ? null : {
      cpp: r.cpp,
      basis: r.cpp_basis,
      confidence: r.cpp_confidence,
      cashProvenance: parse(r.cash_provenance, {
        provider: null, verificationLevel: null, samples: 0,
        medianPrice: null, currency: null, ageDays: null,
      }),
    },
    programComparison: parse(r.program_comparison, null as any),
    provider: r.provider,
    providerConfidence: r.provider_confidence,
    verificationLevel: r.verification_level,
    score: r.score,
    scoreBreakdown: parse(r.score_breakdown, { score: r.score, components: {}, weightsVersion: r.weights_version, effectiveWeights: {} }),
    reasons: parse(r.reasons, []),
    features: parse(r.features, { travelMonth: 0, departureWeekday: 0, tripLengthNights: null, daysUntilDeparture: 0 }),
    presetsMatched: parse(r.presets_matched, []),
    threshold: r.threshold,
    status: r.status,
    engineVersion: r.engine_version,
    createdAt: r.created_at,
    feedback: r.fb_verdict ? { verdict: r.fb_verdict, note: r.fb_note, createdAt: r.fb_at } : null,
  }
}

// ─── §W Feedback ─────────────────────────────────────────────────────────────

/**
 * Record a human verdict on a candidate. Append-only: changing your mind later
 * is itself data, and the report reads the most recent verdict per candidate.
 * Nothing here trains anything - Phase 5 only wants algorithm output next to
 * human judgment.
 */
export function recordFeedback(
  db: DB,
  candidateId: number,
  verdict: FeedbackVerdict,
  opts: { note?: string | null; source?: "ui" | "cli" } = {},
): number {
  const exists = db.prepare(`SELECT 1 FROM deal_candidates WHERE id = ?`).get(candidateId)
  if (!exists) throw new Error(`unknown candidate ${candidateId}`)
  const info = db.prepare(`
    INSERT INTO deal_feedback (candidate_id, verdict, note, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(candidateId, verdict, opts.note?.slice(0, 500) ?? null, opts.source ?? "ui", nowIso())
  // `status` stays the ENGINE's classification. Whether a human has looked at a
  // candidate is answered by the presence of feedback, so a re-evaluation that
  // rewrites the row cannot silently erase the fact that it was reviewed.
  return Number(info.lastInsertRowid)
}

// ─── Evaluation cursor ───────────────────────────────────────────────────────

export function readState(db: DB, key: string): string | null {
  const r = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as { value: string } | undefined
  return r?.value ?? null
}

export function writeState(db: DB, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso())
}
