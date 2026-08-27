/**
 * §X - false-positive analysis.
 *
 * The shadow period only pays off if we can ask, afterwards, WHICH parts of the
 * algorithm were wrong. So every query here joins decisions to human verdicts:
 *
 *   - how many candidates were produced, and how many were judged
 *   - which reason codes ride along with BAD_SIGNAL
 *   - which routes flood the list
 *
 * Nothing here tunes anything. Weight changes stay a human decision made with
 * this report in hand (§X: "Do not automatically tune weights yet").
 */

import type { DB } from "../db/index.js"

export interface ReasonCorrelation {
  code: string
  candidates: number
  judged: number
  good: number
  normal: number
  bad: number
  /** Share of JUDGED candidates carrying this code that were called a bad
   *  signal. Null until somebody has actually judged some. */
  badSignalRate: number | null
}

export interface RouteVolume {
  route: string
  cabin: string
  type: string
  candidates: number
  observations: number
  /** Candidates per 100 observations - "is this route flooding the list?" */
  candidateRate: number
  averageScore: number
  maxScore: number
}

export interface AnomalyReport {
  generatedAt: string
  totals: {
    decisions: number
    candidates: number
    belowThreshold: number
    cash: number
    award: number
    withFeedback: number
    threshold: number | null
  }
  verdicts: { GOOD_DEAL: number; NORMAL: number; BAD_SIGNAL: number; WOULD_BOOK: number }
  presets: { preset: string; candidates: number }[]
  reasonCorrelation: ReasonCorrelation[]
  routeVolume: RouteVolume[]
  scoreBuckets: { bucket: string; count: number; judgedBad: number }[]
  confidenceMix: { confidence: string; candidates: number; averageScore: number }[]
  note: string
}

export function buildReport(db: DB, opts: { since?: string } = {}): AnomalyReport {
  const since = opts.since ?? "1970-01-01T00:00:00.000Z"

  const totals = db.prepare(`
    SELECT
      COUNT(*) decisions,
      SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) candidates,
      SUM(CASE WHEN status = 'below-threshold' THEN 1 ELSE 0 END) belowThreshold,
      SUM(CASE WHEN type = 'cash' THEN 1 ELSE 0 END) cash,
      SUM(CASE WHEN type = 'award' THEN 1 ELSE 0 END) award,
      MAX(threshold) threshold
    FROM deal_candidates WHERE observed_at >= ?
  `).get(since) as any

  const withFeedback = (db.prepare(`
    SELECT COUNT(DISTINCT candidate_id) c FROM deal_feedback
    WHERE candidate_id IN (SELECT id FROM deal_candidates WHERE observed_at >= ?)
  `).get(since) as any).c as number

  // Latest verdict per candidate - changing your mind should not double-count.
  // ROW_NUMBER, not MAX(created_at || '#' || id): concatenating the id makes
  // it a STRING comparison, where '#9' sorts after '#10', so two verdicts
  // written in the same millisecond resolved to the wrong one.
  const latestVerdict = `
    SELECT candidate_id, verdict FROM (
      SELECT candidate_id, verdict,
             ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) rn
      FROM deal_feedback
    ) WHERE rn = 1
  `

  const verdictRows = db.prepare(`
    SELECT v.verdict, COUNT(*) c
    FROM (${latestVerdict}) v
    JOIN deal_candidates c ON c.id = v.candidate_id
    WHERE c.observed_at >= ?
    GROUP BY v.verdict
  `).all(since) as { verdict: string; c: number }[]

  const verdicts = { GOOD_DEAL: 0, NORMAL: 0, BAD_SIGNAL: 0, WOULD_BOOK: 0 }
  for (const r of verdictRows) {
    if (r.verdict in verdicts) verdicts[r.verdict as keyof typeof verdicts] = r.c
  }

  const presets = db.prepare(`
    SELECT json_each.value preset, COUNT(*) candidates
    FROM deal_candidates, json_each(deal_candidates.presets_matched)
    WHERE deal_candidates.observed_at >= ? AND deal_candidates.status = 'candidate'
    GROUP BY preset ORDER BY candidates DESC
  `).all(since) as { preset: string; candidates: number }[]

  const reasonRows = db.prepare(`
    SELECT json_extract(json_each.value, '$.code') code,
           COUNT(*) candidates,
           SUM(CASE WHEN v.verdict IS NOT NULL THEN 1 ELSE 0 END) judged,
           SUM(CASE WHEN v.verdict IN ('GOOD_DEAL', 'WOULD_BOOK') THEN 1 ELSE 0 END) good,
           SUM(CASE WHEN v.verdict = 'NORMAL' THEN 1 ELSE 0 END) normal,
           SUM(CASE WHEN v.verdict = 'BAD_SIGNAL' THEN 1 ELSE 0 END) bad
    FROM deal_candidates
    JOIN json_each(deal_candidates.reasons)
    LEFT JOIN (${latestVerdict}) v ON v.candidate_id = deal_candidates.id
    WHERE deal_candidates.observed_at >= ? AND deal_candidates.status = 'candidate'
    GROUP BY code ORDER BY candidates DESC
  `).all(since) as any[]

  const reasonCorrelation: ReasonCorrelation[] = reasonRows.map(r => ({
    code: r.code,
    candidates: r.candidates,
    judged: r.judged,
    good: r.good,
    normal: r.normal,
    bad: r.bad,
    badSignalRate: r.judged > 0 ? Math.round((r.bad / r.judged) * 1000) / 10 : null,
  }))

  const routeVolume = db.prepare(`
    SELECT c.route, c.cabin, c.type,
           COUNT(*) candidates,
           ROUND(AVG(c.score), 1) averageScore,
           MAX(c.score) maxScore
    FROM deal_candidates c
    WHERE c.observed_at >= ? AND c.status = 'candidate'
    GROUP BY c.route, c.cabin, c.type
    ORDER BY candidates DESC
  `).all(since) as any[]

  // Observation counts come from the source tables so "candidate rate" is
  // candidates per observation, not candidates per candidate.
  const observationsFor = (route: string, cabin: string, type: string): number => {
    const [origin, destination] = route.split("-")
    const table = type === "cash" ? "flight_prices" : "award_prices"
    return (db.prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE origin = ? AND destination = ? AND cabin = ? AND fetched_at >= ?`,
    ).get(origin, destination, cabin, since) as any).c
  }

  const scoreBuckets = db.prepare(`
    SELECT CASE
             WHEN score >= 90 THEN '90-100'
             WHEN score >= 80 THEN '80-89'
             WHEN score >= 70 THEN '70-79'
             WHEN score >= 60 THEN '60-69'
             ELSE '<60' END bucket,
           COUNT(*) count,
           SUM(CASE WHEN v.verdict = 'BAD_SIGNAL' THEN 1 ELSE 0 END) judgedBad,
           MIN(score) sortKey
    FROM deal_candidates
    LEFT JOIN (${latestVerdict}) v ON v.candidate_id = deal_candidates.id
    WHERE observed_at >= ?
    -- Ordered by score, not by the label: sorting the text put '<60' on top.
    GROUP BY bucket ORDER BY sortKey DESC
  `).all(since) as any[]

  const confidenceMix = db.prepare(`
    SELECT baseline_confidence confidence, COUNT(*) candidates, ROUND(AVG(score), 1) averageScore
    FROM deal_candidates WHERE observed_at >= ? AND status = 'candidate'
    GROUP BY baseline_confidence ORDER BY candidates DESC
  `).all(since) as any[]

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      decisions: totals.decisions ?? 0,
      candidates: totals.candidates ?? 0,
      belowThreshold: totals.belowThreshold ?? 0,
      cash: totals.cash ?? 0,
      award: totals.award ?? 0,
      withFeedback,
      threshold: totals.threshold ?? null,
    },
    verdicts,
    presets,
    reasonCorrelation,
    routeVolume: routeVolume.map(r => {
      const observations = observationsFor(r.route, r.cabin, r.type)
      return {
        route: r.route, cabin: r.cabin, type: r.type,
        candidates: r.candidates,
        observations,
        candidateRate: observations > 0 ? Math.round((r.candidates / observations) * 1000) / 10 : 0,
        averageScore: r.averageScore,
        maxScore: r.maxScore,
      }
    }),
    scoreBuckets,
    confidenceMix,
    note: "SHADOW MODE - these are the engine's own opinions measured against human verdicts. No alerts were sent, and no weights were tuned automatically.",
  }
}
