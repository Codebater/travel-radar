/**
 * §27/§28 - one opportunity, not fifteen rows.
 *
 * Flexible-date discovery is a duplicate factory by design: it samples five
 * consecutive days precisely because the cheap day is not known in advance, and
 * it usually finds that four of them are cheap. A feed that lists
 *
 *   VIE-BKK 10 Oct EUR 410
 *   VIE-BKK 11 Oct EUR 415
 *   VIE-BKK 12 Oct EUR 409
 *
 * teaches the reader to scroll past it. A feed that lists
 *
 *   VIE-BKK from EUR 409, 10-12 Oct
 *
 * is the same information and can actually be read.
 *
 * Clustering is a PRESENTATION layer, deliberately: every candidate stays
 * individually stored, individually scored and individually judgeable. The
 * cluster records which of them is the best and how wide the family is, so one
 * verdict can cover the family without the underlying decisions being merged
 * or lost.
 */

import type { DB } from "../db/index.js"
import { nowIso } from "../db/index.js"

export interface ClusterConfig {
  /** Departures this many days apart may belong to one family. */
  dateWindowDays: number
  /** Prices within this fraction of the best are "the same deal". */
  priceTolerance: number
  /** Points within this fraction of the best are "the same deal". */
  pointsTolerance: number
}

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  dateWindowDays: 3,
  priceTolerance: 0.08,
  pointsTolerance: 0.08,
}

export interface ClusterRow {
  id: number
  clusterKey: string
  type: "cash" | "award"
  origin: string
  destination: string
  destinationGroup: string | null
  route: string
  cabin: string
  loyaltyProgram: string | null
  earliestDeparture: string
  latestDeparture: string
  memberCount: number
  bestCandidateId: number | null
  bestScore: number
  bestPrice: number | null
  bestCurrency: string | null
  bestPoints: number | null
  discoveredBy: string | null
  /**
   * Whether this family IS an open jaw - which is not the same question as
   * which method paid for it. The open-jaw stage spends its calls on ordinary
   * one-way LEGS, and those legs are labelled OPEN_JAW so §20 can tell whether
   * collecting them was worth it. A single one-way fare is still not an open
   * jaw, and filtering on the label put the legs in the section meant for the
   * pairs - where they outnumbered and outscored them.
   */
  isOpenJaw: boolean
}

interface CandidateRow {
  id: number
  type: "cash" | "award"
  origin: string
  destination: string
  route: string
  cabin: string
  loyalty_program: string | null
  destination_group: string | null
  departure_date: string
  price_amount: number | null
  price_currency: string | null
  points: number | null
  score: number
  discovered_by: string
  is_open_jaw: number
  requires_positioning: number
}

/**
 * The identity of a family. Trip STYLE is part of it: an open jaw and a plain
 * return to the same city on the same day are different products, and a
 * positioning departure is a different trip from a home one even at the same
 * price.
 */
function clusterKeyFor(row: CandidateRow, anchorDate: string, anchorValue: number): string {
  const style = `${row.is_open_jaw ? "oj" : "rt"}${row.requires_positioning ? "+pos" : ""}`
  const bucket = Math.round(anchorValue)
  return [
    row.type, row.route, row.cabin, row.loyalty_program ?? "-",
    // Currency is identity, exactly as it is in the grouping itself: 410 EUR
    // and 410 USD are two families, and without this they collided on one key,
    // where the upsert silently overwrote one with the other.
    row.price_currency ?? "-",
    style, anchorDate, bucket,
  ].join("|")
}

function daysApart(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000),
  )
}

export interface ClusteringResult {
  clusters: number
  candidatesClustered: number
  largestCluster: number
}

/**
 * Group candidates into families and record the best of each.
 *
 * Greedy by score: the strongest candidate seeds a family and absorbs the
 * nearby ones. That makes the representative the best member by construction,
 * which is the one thing a reader of the feed actually needs to be true.
 */
export function rebuildClusters(
  db: DB,
  opts: { since?: string; minScore?: number; config?: ClusterConfig } = {},
): ClusteringResult {
  const config = opts.config ?? DEFAULT_CLUSTER_CONFIG
  const since = opts.since ?? "1970-01-01T00:00:00.000Z"
  const minScore = opts.minScore ?? 0

  const rows = db.prepare(`
    SELECT id, type, origin, destination, route, cabin, loyalty_program, destination_group,
           departure_date, price_amount, price_currency, points, score, discovered_by,
           is_open_jaw, requires_positioning
    FROM deal_candidates
    WHERE observed_at >= ? AND score >= ? AND sanity = 'ok'
    ORDER BY score DESC, id ASC
  `).all(since, minScore) as CandidateRow[]

  const assigned = new Map<number, number>()   // candidate id -> cluster index
  const families: { seed: CandidateRow; members: CandidateRow[] }[] = []

  for (const row of rows) {
    if (assigned.has(row.id)) continue
    const value = row.type === "cash" ? (row.price_amount ?? 0) : (row.points ?? 0)
    if (value <= 0) continue

    const family = { seed: row, members: [row] }
    assigned.set(row.id, families.length)

    for (const other of rows) {
      if (assigned.has(other.id)) continue
      if (other.type !== row.type) continue
      if (other.route !== row.route || other.cabin !== row.cabin) continue
      if ((other.loyalty_program ?? null) !== (row.loyalty_program ?? null)) continue
      if (other.is_open_jaw !== row.is_open_jaw) continue
      if (other.requires_positioning !== row.requires_positioning) continue
      if (daysApart(other.departure_date, row.departure_date) > config.dateWindowDays) continue
      // Currency is identity, not decoration: 410 EUR and 410 USD are not the
      // same deal seen twice.
      if (other.type === "cash" && other.price_currency !== row.price_currency) continue

      const otherValue = other.type === "cash" ? (other.price_amount ?? 0) : (other.points ?? 0)
      if (otherValue <= 0) continue
      const tolerance = row.type === "cash" ? config.priceTolerance : config.pointsTolerance
      if (Math.abs(otherValue - value) / value > tolerance) continue

      family.members.push(other)
      assigned.set(other.id, families.length)
    }
    families.push(family)
  }

  const now = nowIso()
  const tx = db.transaction(() => {
    // Rebuilt wholesale rather than patched: a candidate's score can change on
    // re-evaluation, which can change which member should represent a family,
    // and incremental patching of that is far more error-prone than redoing it.
    //
    // EVERY reference is cleared, not just those inside the `since` window.
    // candidate_clusters is about to be emptied, and a row outside the window
    // still pointing at a deleted cluster is a foreign-key violation that
    // aborts the whole rebuild.
    db.prepare(`UPDATE deal_candidates SET cluster_id = NULL`).run()
    db.prepare(`DELETE FROM candidate_clusters`).run()

    for (const family of families) {
      const departures = family.members.map(m => m.departure_date).sort()
      const seed = family.seed
      const key = clusterKeyFor(
        seed, departures[0]!,
        seed.type === "cash" ? (seed.price_amount ?? 0) : (seed.points ?? 0),
      )
      const info = db.prepare(`
        INSERT INTO candidate_clusters (
          cluster_key, type, origin, destination, destination_group, route, cabin,
          loyalty_program, earliest_departure, latest_departure, member_count,
          best_candidate_id, best_score, best_price, best_currency, best_points,
          discovered_by, is_open_jaw, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cluster_key) DO UPDATE SET
          member_count = excluded.member_count, best_candidate_id = excluded.best_candidate_id,
          best_score = excluded.best_score, best_price = excluded.best_price,
          best_points = excluded.best_points, latest_departure = excluded.latest_departure,
          earliest_departure = excluded.earliest_departure,
          is_open_jaw = excluded.is_open_jaw, updated_at = excluded.updated_at
      `).run(
        key, seed.type, seed.origin, seed.destination, seed.destination_group, seed.route,
        seed.cabin, seed.loyalty_program, departures[0], departures[departures.length - 1],
        family.members.length, seed.id, seed.score, seed.price_amount, seed.price_currency,
        // Every member shares the seed's trip style - the grouping refuses to
        // mix them - so the seed's flag describes the whole family.
        seed.points, seed.discovered_by, seed.is_open_jaw, now, now,
      )
      // NOT lastInsertRowid: SQLite leaves it untouched when an upsert takes
      // the UPDATE branch, so it hands back a stale id from an earlier insert
      // and the members get filed into somebody else's family.
      void info
      const clusterId = (db.prepare(
        `SELECT id FROM candidate_clusters WHERE cluster_key = ?`,
      ).get(key) as { id: number }).id

      const update = db.prepare(`UPDATE deal_candidates SET cluster_id = ? WHERE id = ?`)
      for (const member of family.members) update.run(clusterId, member.id)
    }
  })
  tx()

  return {
    clusters: families.length,
    candidatesClustered: assigned.size,
    largestCluster: families.reduce((max, f) => Math.max(max, f.members.length), 0),
  }
}

export function listClusters(
  db: DB,
  opts: {
    minScore?: number
    type?: "cash" | "award"
    limit?: number
    discoveredBy?: string
    isOpenJaw?: boolean
  } = {},
): ClusterRow[] {
  const where: string[] = []
  const params: any[] = []
  if (opts.minScore !== undefined) { where.push("best_score >= ?"); params.push(opts.minScore) }
  if (opts.type) { where.push("type = ?"); params.push(opts.type) }
  if (opts.discoveredBy) { where.push("discovered_by = ?"); params.push(opts.discoveredBy) }
  if (opts.isOpenJaw !== undefined) { where.push("is_open_jaw = ?"); params.push(opts.isOpenJaw ? 1 : 0) }
  const limit = Math.min(opts.limit ?? 50, 300)

  return (db.prepare(`
    SELECT * FROM candidate_clusters
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY best_score DESC LIMIT ?
  `).all(...params, limit) as any[]).map(r => ({
    id: r.id,
    clusterKey: r.cluster_key,
    type: r.type,
    origin: r.origin,
    destination: r.destination,
    destinationGroup: r.destination_group,
    route: r.route,
    cabin: r.cabin,
    loyaltyProgram: r.loyalty_program,
    earliestDeparture: r.earliest_departure,
    latestDeparture: r.latest_departure,
    memberCount: r.member_count,
    bestCandidateId: r.best_candidate_id,
    bestScore: r.best_score,
    bestPrice: r.best_price,
    bestCurrency: r.best_currency,
    bestPoints: r.best_points,
    discoveredBy: r.discovered_by,
    isOpenJaw: Boolean(r.is_open_jaw),
  }))
}
