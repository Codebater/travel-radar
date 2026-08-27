/**
 * Baselines — "what has this radar seen before?"
 *
 * §Y NO LOOK-AHEAD. A baseline is always built from observations recorded
 * STRICTLY BEFORE the observation being judged. That matters twice over:
 *
 *   - historical recomputation must not grade a March price against April's
 *     data, or every backfill result is meaningless;
 *   - even live, siblings from the SAME fetch are excluded, so "cheap" means
 *     cheap against history, not merely the cheapest row in today's search.
 *
 * Baselines are per comparability key (§L). When the strict key is too thin the
 * soft dimensions are relaxed in configured order and the scope is recorded, so
 * a reader can always see how wide the comparison had to be drawn.
 */

import type { DB } from "../db/index.js"
import type { AnomalyConfig } from "./config.js"
import { confidenceFor } from "./config.js"
import { keyToString, tripLengthBucket, directnessOf, nightsBetween } from "./comparability.js"
import type { BaselineStats, ComparabilityKey } from "./types.js"

interface BaselineRow {
  value: number
  taxes: number | null
  taxesCurrency: string | null
  departureDate: string
  returnDate: string | null
  stops: number | null
  fetchedAt: string
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
}

/**
 * Candidate observations for a cash baseline: the hard dimensions and the
 * currency are enforced in SQL, the soft ones in `statsFor` — filtering trip
 * length in SQL would mean recomputing buckets in two places.
 */
export function cashBaselineRows(
  db: DB,
  key: ComparabilityKey,
  asOf: string,
  config: AnomalyConfig,
  currency: string,
  excludeId?: number,
): BaselineRow[] {
  const since = new Date(Date.parse(asOf) - config.baseline.lookbackDays * 86_400_000).toISOString()
  const rows = db.prepare(`
    SELECT id, price_amount value, taxes_amount taxes, taxes_currency taxesCurrency,
           departure_date departureDate, return_date returnDate, stops, fetched_at fetchedAt
    FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
      AND (return_date IS NULL) = ?
      AND fetched_at < ? AND fetched_at >= ?
  `).all(
    key.origin, key.destination, key.cabin, currency,
    key.tripType === "oneway" ? 1 : 0,
    asOf, since,
  ) as (BaselineRow & { id: number })[]
  return excludeId === undefined ? rows : rows.filter(r => r.id !== excludeId)
}

/** Same idea for awards, with the loyalty program as a HARD dimension: one
 *  program's points are not comparable with another's. */
export function awardBaselineRows(
  db: DB,
  key: ComparabilityKey,
  asOf: string,
  config: AnomalyConfig,
  excludeId?: number,
): BaselineRow[] {
  const since = new Date(Date.parse(asOf) - config.baseline.lookbackDays * 86_400_000).toISOString()
  const rows = db.prepare(`
    SELECT id, points value, taxes_amount taxes, taxes_currency taxesCurrency,
           departure_date departureDate, return_date returnDate, stops, fetched_at fetchedAt
    FROM award_prices
    WHERE origin = ? AND destination = ? AND cabin = ? AND loyalty_program = ?
      AND (return_date IS NULL) = ?
      AND fetched_at < ? AND fetched_at >= ?
  `).all(
    key.origin, key.destination, key.cabin, key.loyaltyProgram ?? "",
    key.tripType === "oneway" ? 1 : 0,
    asOf, since,
  ) as (BaselineRow & { id: number })[]
  return excludeId === undefined ? rows : rows.filter(r => r.id !== excludeId)
}

function matchesSoftDimensions(
  row: BaselineRow,
  key: ComparabilityKey,
  dropped: string[],
  config: AnomalyConfig,
): boolean {
  if (!dropped.includes("tripLength")) {
    const bucket = tripLengthBucket(nightsBetween(row.departureDate, row.returnDate), config)
    if (bucket !== key.tripLengthBucket) return false
  }
  if (!dropped.includes("directness")) {
    if (directnessOf(row.stops) !== key.directness) return false
  }
  return true
}

/**
 * Build the tightest usable baseline: try the strict key, then relax one soft
 * dimension at a time until the sample reaches `minSamplesToEmit`. Returns null
 * only when even the fully relaxed set is empty.
 */
export function buildBaseline(
  rows: BaselineRow[],
  key: ComparabilityKey,
  currentValue: number,
  asOf: string,
  config: AnomalyConfig,
): BaselineStats | null {
  const relaxations: string[][] = [[]]
  const order = config.baseline.relaxationOrder
  for (let i = 1; i <= order.length; i++) relaxations.push(order.slice(0, i))

  let chosen: { rows: BaselineRow[]; dropped: string[] } | null = null
  for (const dropped of relaxations) {
    const subset = rows.filter(r => matchesSoftDimensions(r, key, dropped, config))
    if (!chosen || subset.length > chosen.rows.length) chosen = { rows: subset, dropped }
    if (subset.length >= config.minSamplesToEmit) { chosen = { rows: subset, dropped }; break }
  }
  if (!chosen || chosen.rows.length === 0) return null

  const values = chosen.rows.map(r => r.value).sort((a, b) => a - b)
  const med = median(values)
  const min = values[0]!
  const max = values[values.length - 1]!
  const below = values.filter(v => v < currentValue).length
  const times = chosen.rows.map(r => r.fetchedAt).sort()
  const firstAt = times[0]!
  const lastAt = times[times.length - 1]!

  // Surcharges are only comparable inside one currency — the most common
  // currency in the sample wins, and mixed-currency rows are ignored rather
  // than blended into a meaningless number.
  const taxRows = chosen.rows.filter(r => r.taxes !== null && r.taxesCurrency)
  let medianTaxes: number | null = null
  let taxesCurrency: string | null = null
  if (taxRows.length > 0) {
    const counts = new Map<string, number>()
    for (const r of taxRows) counts.set(r.taxesCurrency!, (counts.get(r.taxesCurrency!) ?? 0) + 1)
    taxesCurrency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    const taxValues = taxRows.filter(r => r.taxesCurrency === taxesCurrency)
      .map(r => r.taxes!).sort((a, b) => a - b)
    medianTaxes = median(taxValues)
  }

  const tier = confidenceFor(chosen.rows.length, config)
  return {
    key: keyToString(key, chosen.dropped),
    scope: chosen.dropped.length === 0 ? "strict" : `relaxed:${chosen.dropped.join("+")}`,
    count: chosen.rows.length,
    min, max,
    median: Math.round(med * 100) / 100,
    percentile: Math.round((below / chosen.rows.length) * 1000) / 10,
    percentBelowMedian: med > 0 ? Math.round(((med - currentValue) / med) * 1000) / 10 : 0,
    differenceFromMinimum: Math.round((currentValue - min) * 100) / 100,
    firstAt, lastAt,
    // "Age" is how stale the FRESHEST baseline observation is — a wide span of
    // old prices is not a current baseline.
    ageDays: Math.round(daysBetween(lastAt, asOf) * 10) / 10,
    confidence: tier.label,
    confidenceValue: tier.value,
    medianTaxes,
    taxesCurrency,
    isNewObservedLow: currentValue < min,
  }
}
