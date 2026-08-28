/**
 * Package-relative baselines — history, with the maturity trap named in
 * config/packages.json closed: one calendar response contains MANY dates but
 * is ONE observation of the seasonal curve. A baseline for a travel date
 * exists only once that date has been re-observed across enough DISTINCT
 * fetch days; until then the honest answer is "no baseline", never a median
 * over a single snapshot.
 *
 * Two different questions, kept apart on purpose:
 *   packageBaseline    — "is today's quote low for THIS product?" (history,
 *                        strict as-of: fetched_at < asOf, sibling requests
 *                        excluded by id)
 *   seasonalPosition   — "is this DATE cheap within its own curve?" (one
 *                        snapshot, cross-date; a curve position, not history)
 */

import { type DB } from "../db/index.js"
import { loadPackagesConfig } from "./config.js"

export interface PackageBaseline {
  packageKey: string
  median: number
  samples: number
  distinctFetchDays: number
  newestFetchedAt: string
  mature: true
}

export interface PackageBaselineRefusal {
  packageKey: string
  mature: false
  reason: string
  samples: number
  distinctFetchDays: number
}

/**
 * Baseline for one package product (one package_key, which pins provider,
 * hotel, origin, date family, nights bucket, board, cabin, occupancy and
 * currency — every hard dimension). As-of discipline: only rows fetched
 * strictly BEFORE asOf participate, and rows from the excluded search request
 * (the one being judged) never join their own baseline.
 */
export function packageBaseline(
  db: DB,
  key: string,
  asOf: string,
  excludeSearchRequestId: number | null = null,
): PackageBaseline | PackageBaselineRefusal {
  const cfg = loadPackagesConfig().baselines
  const rows = db.prepare(`
    SELECT total_price, fetched_at, search_request_id
    FROM package_offer_observations
    WHERE package_key = ?
      AND fetched_at < ?
      AND sanity = 'ok'
      AND (@excluded IS NULL OR search_request_id IS NULL OR search_request_id != @excluded)
    ORDER BY fetched_at
  `).all(key, asOf, { excluded: excludeSearchRequestId }) as
    { total_price: number; fetched_at: string; search_request_id: number | null }[]

  const fetchDays = new Set(rows.map(r => r.fetched_at.slice(0, 10)))
  const refuse = (reason: string): PackageBaselineRefusal => ({
    packageKey: key, mature: false, reason, samples: rows.length, distinctFetchDays: fetchDays.size,
  })

  if (rows.length < cfg.minObservations) {
    return refuse(`only ${rows.length}/${cfg.minObservations} observations before as-of`)
  }
  if (fetchDays.size < cfg.minDistinctFetchDays) {
    return refuse(
      `only ${fetchDays.size}/${cfg.minDistinctFetchDays} distinct fetch days — `
      + `many dates in one response are one curve snapshot, not history`,
    )
  }

  const prices = rows.map(r => r.total_price).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2
  return {
    packageKey: key,
    median,
    samples: rows.length,
    distinctFetchDays: fetchDays.size,
    newestFetchedAt: rows[rows.length - 1].fetched_at,
    mature: true,
  }
}

export interface SeasonalPosition {
  /** 0 = cheapest date in the snapshot, 1 = priciest. */
  percentile: number
  snapshotDates: number
  searchRequestId: number
  note: "curve_position_not_history"
}

/**
 * Where one check-in date sits inside its OWN calendar snapshot (same search
 * request, cross-date). Deliberately labelled: this is a curve position and
 * must never be presented as a baseline judgement.
 */
export function seasonalPosition(
  db: DB, searchRequestId: number, checkIn: string,
): SeasonalPosition | null {
  const rows = db.prepare(`
    SELECT check_in, MIN(total_price) price
    FROM package_offer_observations
    WHERE search_request_id = ?
    GROUP BY check_in
  `).all(searchRequestId) as { check_in: string; price: number }[]
  if (rows.length < 2) return null
  const target = rows.find(r => r.check_in === checkIn)
  if (!target) return null
  const below = rows.filter(r => r.price < target.price).length
  return {
    percentile: below / (rows.length - 1),
    snapshotDates: rows.length,
    searchRequestId,
    note: "curve_position_not_history",
  }
}
