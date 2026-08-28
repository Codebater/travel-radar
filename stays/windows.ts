/**
 * Actionability and opportunity windows.
 *
 * ACTIONABILITY answers: could a person actually take this trip? An isolated
 * cheap check-in, a 2–3-day dip, and a sustained week of cheap check-ins are
 * different facts. Persistence is measured from OBSERVATIONS (neighbouring
 * check-ins at comparable prices) plus the provider calendar — and it must
 * never rescue an ordinary price: without a notable relative or absolute
 * result, the component scores a REAL ZERO.
 *
 * Timing semantics: actionability — like cross-source evidence, and unlike
 * baselines — uses CURRENT knowledge. A neighbour priced after this
 * observation still describes the same future stay dates; re-evaluation is
 * exactly how later discoveries upgrade an opportunity's usability. Only
 * baselines are strictly as-of, because only they make statistical claims.
 *
 * OPPORTUNITY WINDOWS are presentation families: neighbouring cheap
 * check-ins for one product become ONE row a human reads, while every
 * underlying candidate and observation stays individually stored and
 * judgeable. Rebuilt wholesale, flight-cluster style.
 */

import { nowIso, type DB } from "../db/index.js"
import type { StayAnomalyConfig } from "./config.js"

export type Persistence = "isolated" | "short" | "sustained"

export interface ActionabilityResult {
  persistence: Persistence
  /** 0..1 before the notable-price gate. */
  rawValue: number
  /** What actually enters the score (0 when the gate zeroes it). */
  value: number
  neighborCheckIns: number
  spanDays: number
  calendarSustained: boolean
  gated: boolean
  detail: string
}

/**
 * Persistence of a low price around one observation. Neighbours = distinct
 * check-ins for the SAME product (property, source class, board, currency)
 * within the window, observed at a comparable-or-lower nightly (within the
 * tolerance).
 */
export function assessActionability(
  db: DB,
  observation: {
    propertyId: string
    checkIn: string
    checkOut: string
    nights: number
    sourceClass: string
    board: string
    currency: string
    taxesFees: string
    nightly: number
    fetchedAt: string
  },
  notablePrice: boolean,
  config: StayAnomalyConfig,
): ActionabilityResult {
  const a = config.actionability
  const from = shiftDay(observation.checkIn, -a.neighborWindowDays)
  const to = shiftDay(observation.checkIn, a.neighborWindowDays)
  const maxNightly = observation.nightly * (1 + a.priceTolerancePercent / 100)

  const rows = db.prepare(`
    SELECT DISTINCT check_in FROM stay_rate_observations
    WHERE property_id = ? AND source_class = ? AND board = ? AND price_currency = ?
      AND taxes_fees = ?
      AND sanity = 'ok' AND price_basis = 'nightly_room'
      AND check_in >= ? AND check_in <= ?
      AND price_amount <= ?
  `).all(
    observation.propertyId, observation.sourceClass, observation.board, observation.currency,
    observation.taxesFees, from, to, maxNightly,
  ) as { check_in: string }[]

  const checkIns = rows.map(r => r.check_in).sort()
  const spanDays = checkIns.length > 1
    ? Math.round((Date.parse(checkIns[checkIns.length - 1]) - Date.parse(checkIns[0])) / 86_400_000)
    : 0

  // The provider's own calendar can attest a sustained window even before we
  // have priced every neighbour: a run of cheap days covering the whole stay.
  const calendarSustained = hasSustainedCheapRun(db, observation, a.sustainedSpanDays)

  let persistence: Persistence = "isolated"
  if (checkIns.length >= 3 && spanDays >= a.sustainedSpanDays) persistence = "sustained"
  else if (checkIns.length >= 2) persistence = "short"

  let rawValue = a.values[persistence]
  if (calendarSustained) rawValue = Math.max(rawValue, a.calendarSustainedValue)

  const gated = a.requiresNotablePrice && !notablePrice
  const value = gated ? 0 : rawValue

  return {
    persistence, rawValue, value,
    neighborCheckIns: checkIns.length, spanDays, calendarSustained, gated,
    detail: gated
      ? `persistence ${persistence} (${checkIns.length} check-ins over ${spanDays}d) but the price is ordinary — persistence rescues nothing`
      : `${persistence}: ${checkIns.length} comparable check-in(s) over ${spanDays}d` +
        (calendarSustained ? " + calendar shows a sustained cheap run" : ""),
  }
}

function hasSustainedCheapRun(
  db: DB,
  observation: { propertyId: string; checkIn: string; nights: number; fetchedAt: string },
  minRun: number,
): boolean {
  const from = shiftDay(observation.checkIn, -2)
  const to = shiftDay(observation.checkIn, observation.nights + 2)
  const rows = db.prepare(`
    SELECT o.stay_date FROM stay_calendar_observations o
    WHERE o.property_id = ? AND o.day_class = 'cheap'
      AND o.stay_date >= ? AND o.stay_date < ?
      AND o.id = (
        SELECT MAX(i.id) FROM stay_calendar_observations i
        WHERE i.property_id = o.property_id AND i.stay_date = o.stay_date
      )
    ORDER BY o.stay_date
  `).all(observation.propertyId, from, to) as { stay_date: string }[]

  let run = 0
  let best = 0
  let prev: string | null = null
  for (const { stay_date } of rows) {
    run = prev !== null && Date.parse(stay_date) - Date.parse(prev) === 86_400_000 ? run + 1 : 1
    best = Math.max(best, run)
    prev = stay_date
  }
  return best >= minRun
}

// ─── Windows (presentation) ─────────────────────────────────────────────────

export interface StayWindowRow {
  id: number
  windowKey: string
  propertyId: string
  sourceClass: string
  board: string
  currency: string
  firstCheckIn: string
  lastCheckIn: string
  distinctCheckIns: number
  spanDays: number
  nightsMin: number
  nightsMax: number
  persistence: Persistence
  memberCount: number
  bestCandidateId: number | null
  bestScore: number
  bestNightly: number
  cheapestNightly: number | null
  cheapestCandidateId: number | null
  evidence: Record<string, unknown>
}

export interface RebuildWindowsResult {
  windows: number
  candidatesGrouped: number
}

/**
 * Group candidates into windows: same product family, check-ins chainable
 * with gaps <= 3 days. Wholesale rebuild — window ids are presentation-only
 * and never load-bearing (the flight radar's cluster-churn lesson).
 */
export function rebuildStayWindows(db: DB, opts: { minScore?: number } = {}): RebuildWindowsResult {
  const minScore = opts.minScore ?? 25
  const candidates = db.prepare(`
    SELECT id, property_id, source_class, board, price_currency, check_in, nights,
           nightly_amount, score
    FROM stay_candidates
    WHERE status != 'suspicious' AND score >= ?
    ORDER BY property_id, source_class, board, price_currency, check_in ASC
  `).all(minScore) as {
    id: number; property_id: string; source_class: string; board: string
    price_currency: string; check_in: string; nights: number
    nightly_amount: number; score: number
  }[]

  interface Group { key: string; members: typeof candidates }
  const groups: Group[] = []
  let current: Group | null = null
  for (const c of candidates) {
    const familyKey = `${c.property_id}|${c.source_class}|${c.board}|${c.price_currency}`
    const chainable = current !== null
      && current.key === familyKey
      && Date.parse(c.check_in) - Date.parse(current.members[current.members.length - 1].check_in) <= 3 * 86_400_000
    if (chainable) {
      current!.members.push(c)
    } else {
      current = { key: familyKey, members: [c] }
      groups.push(current)
    }
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM stay_opportunity_windows").run()
    const insert = db.prepare(`
      INSERT INTO stay_opportunity_windows (
        window_key, property_id, source_class, board, currency,
        first_check_in, last_check_in, distinct_check_ins, span_days,
        nights_min, nights_max, persistence, member_count,
        best_candidate_id, best_score, best_nightly,
        cheapest_nightly, cheapest_candidate_id, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const g of groups) {
      const members = g.members
      const checkIns = [...new Set(members.map(m => m.check_in))].sort()
      const spanDays = checkIns.length > 1
        ? Math.round((Date.parse(checkIns[checkIns.length - 1]) - Date.parse(checkIns[0])) / 86_400_000)
        : 0
      const persistence: Persistence =
        checkIns.length >= 3 && spanDays >= 5 ? "sustained" : checkIns.length >= 2 ? "short" : "isolated"
      const best = members.reduce((a, b) => (a.score >= b.score ? a : b))
      const cheapest = members.reduce((a, b) => (a.nightly_amount <= b.nightly_amount ? a : b))
      insert.run(
        `${g.key}|${checkIns[0]}`,
        members[0].property_id, members[0].source_class, members[0].board, members[0].price_currency,
        checkIns[0], checkIns[checkIns.length - 1], checkIns.length, spanDays,
        Math.min(...members.map(m => m.nights)), Math.max(...members.map(m => m.nights)),
        persistence, members.length,
        best.id, best.score, best.nightly_amount,
        cheapest.nightly_amount, cheapest.id,
        JSON.stringify({
          checkIns,
          nightlyRange: [cheapest.nightly_amount, Math.max(...members.map(m => m.nightly_amount))],
          persistenceBasis: `${checkIns.length} distinct check-ins over ${spanDays} days`,
        }),
        nowIso(),
      )
    }
  })
  tx()
  return { windows: groups.length, candidatesGrouped: candidates.length }
}

export function listStayWindows(db: DB, opts: { limit?: number } = {}): StayWindowRow[] {
  const rows = db.prepare(`
    SELECT * FROM stay_opportunity_windows ORDER BY best_score DESC LIMIT ?
  `).all(opts.limit ?? 20) as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as number,
    windowKey: r.window_key as string,
    propertyId: r.property_id as string,
    sourceClass: r.source_class as string,
    board: r.board as string,
    currency: r.currency as string,
    firstCheckIn: r.first_check_in as string,
    lastCheckIn: r.last_check_in as string,
    distinctCheckIns: r.distinct_check_ins as number,
    spanDays: r.span_days as number,
    nightsMin: r.nights_min as number,
    nightsMax: r.nights_max as number,
    persistence: r.persistence as Persistence,
    memberCount: r.member_count as number,
    bestCandidateId: (r.best_candidate_id as number) ?? null,
    bestScore: r.best_score as number,
    bestNightly: r.best_nightly as number,
    cheapestNightly: (r.cheapest_nightly as number) ?? null,
    cheapestCandidateId: (r.cheapest_candidate_id as number) ?? null,
    evidence: JSON.parse((r.evidence as string) ?? "{}") as Record<string, unknown>,
  }))
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
