/**
 * Read side of stay_candidates — the CLI's and the deals page's one source.
 * Read-only over decisions that already exist: nothing here runs a search,
 * spends budget, or re-scores anything.
 */

import type { DB } from "../db/index.js"

export interface StayCandidateRow {
  id: number
  sourceId: number
  opportunityKey: string
  propertyId: string
  propertyName: string
  destinationGroup: string
  checkIn: string
  checkOut: string
  nights: number
  roomName: string | null
  roomClass: string | null
  board: string
  boardSource: string
  sourceClass: string
  rateSource: string | null
  provider: string
  verificationLevel: string
  nightlyAmount: number
  stayTotal: number | null
  priceCurrency: string
  taxesFees: string
  sampleSize: number
  observedMedian: number | null
  percentile: number | null
  percentBelowMedian: number | null
  baselineConfidence: string
  baselineScope: string
  absoluteTier: string | null
  absoluteRulePath: string
  confirmationState: string
  evidence: Record<string, unknown>
  relativeScore: number | null
  absoluteValueScore: number | null
  evidenceScore: number | null
  actionabilityScore: number | null
  verificationStatus: string
  verificationGateReason: string | null
  score: number
  scoreBreakdown: Record<string, unknown>
  reasons: string[]
  status: string
  observedAt: string
  evaluatedAt: string
}

export function listStayCandidates(
  db: DB,
  opts: { minScore?: number; limit?: number; status?: string; propertyId?: string } = {},
): StayCandidateRow[] {
  const rows = db.prepare(`
    SELECT c.*, p.name AS property_name, p.destination_group AS dg
    FROM stay_candidates c
    JOIN stay_properties p ON p.id = c.property_id
    WHERE c.score >= @minScore
      AND (@status IS NULL OR c.status = @status)
      AND (@propertyId IS NULL OR c.property_id = @propertyId)
    ORDER BY c.score DESC, c.id ASC
    LIMIT @limit
  `).all({
    minScore: opts.minScore ?? 0,
    status: opts.status ?? null,
    propertyId: opts.propertyId ?? null,
    limit: opts.limit ?? 25,
  }) as Record<string, unknown>[]
  return rows.map(hydrate)
}

export function getStayCandidate(db: DB, id: number): StayCandidateRow | null {
  const row = db.prepare(`
    SELECT c.*, p.name AS property_name, p.destination_group AS dg
    FROM stay_candidates c JOIN stay_properties p ON p.id = c.property_id
    WHERE c.id = ?
  `).get(id) as Record<string, unknown> | undefined
  return row ? hydrate(row) : null
}

export interface StayCandidateTotals {
  decisions: number
  candidates: number
  belowThreshold: number
  suspicious: number
  metaOnly: number
  retailConfirmed: number
  retail: number
  topScore: number | null
}

export function stayCandidateTotals(db: DB): StayCandidateTotals {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  const top = db.prepare("SELECT MAX(score) AS s FROM stay_candidates WHERE status != 'suspicious'").get() as { s: number | null }
  return {
    decisions: one("SELECT COUNT(*) AS n FROM stay_candidates"),
    candidates: one("SELECT COUNT(*) AS n FROM stay_candidates WHERE status = 'candidate'"),
    belowThreshold: one("SELECT COUNT(*) AS n FROM stay_candidates WHERE status = 'below_threshold'"),
    suspicious: one("SELECT COUNT(*) AS n FROM stay_candidates WHERE status = 'suspicious'"),
    metaOnly: one("SELECT COUNT(*) AS n FROM stay_candidates WHERE confirmation_state = 'meta_only'"),
    retailConfirmed: one("SELECT COUNT(*) AS n FROM stay_candidates WHERE confirmation_state = 'retail_confirmed'"),
    retail: one("SELECT COUNT(*) AS n FROM stay_candidates WHERE confirmation_state = 'retail'"),
    topScore: top.s,
  }
}

function hydrate(r: Record<string, unknown>): StayCandidateRow {
  return {
    id: r.id as number,
    sourceId: r.source_id as number,
    opportunityKey: r.opportunity_key as string,
    propertyId: r.property_id as string,
    propertyName: r.property_name as string,
    destinationGroup: r.dg as string,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    nights: r.nights as number,
    roomName: (r.room_name as string) ?? null,
    roomClass: (r.room_class as string) ?? null,
    board: r.board as string,
    boardSource: r.board_source as string,
    sourceClass: r.source_class as string,
    rateSource: (r.rate_source as string) ?? null,
    provider: r.provider as string,
    verificationLevel: r.verification_level as string,
    nightlyAmount: r.nightly_amount as number,
    stayTotal: (r.stay_total as number) ?? null,
    priceCurrency: r.price_currency as string,
    taxesFees: r.taxes_fees as string,
    sampleSize: r.sample_size as number,
    observedMedian: (r.observed_median as number) ?? null,
    percentile: (r.percentile as number) ?? null,
    percentBelowMedian: (r.percent_below_median as number) ?? null,
    baselineConfidence: r.baseline_confidence as string,
    baselineScope: r.baseline_scope as string,
    absoluteTier: (r.absolute_tier as string) ?? null,
    absoluteRulePath: r.absolute_rule_path as string,
    confirmationState: r.confirmation_state as string,
    evidence: JSON.parse((r.evidence as string) ?? "{}") as Record<string, unknown>,
    relativeScore: (r.relative_score as number) ?? null,
    absoluteValueScore: (r.absolute_value_score as number) ?? null,
    evidenceScore: (r.evidence_score as number) ?? null,
    actionabilityScore: (r.actionability_score as number) ?? null,
    verificationStatus: (r.verification_status as string) ?? "unverified",
    verificationGateReason: (r.verification_gate_reason as string) ?? null,
    score: r.score as number,
    scoreBreakdown: JSON.parse((r.score_breakdown as string) ?? "{}") as Record<string, unknown>,
    reasons: JSON.parse((r.reasons as string) ?? "[]") as string[],
    status: r.status as string,
    observedAt: r.observed_at as string,
    evaluatedAt: r.evaluated_at as string,
  }
}
