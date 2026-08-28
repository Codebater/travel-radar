/**
 * Stay baselines: what has THIS product at THIS property cost before?
 *
 * The flight engine's discipline, re-derived for stays:
 *
 *   NO LOOK-AHEAD    only observations with fetched_at STRICTLY before asOf;
 *                    same-search siblings excluded by search_request_id,
 *                    never by timestamp equality.
 *   HARD DIMENSIONS  property, source_class, room_class, board, occupancy,
 *                    currency, TAX STATUS — never relaxed. A meta quote is
 *                    not a retail room; an all-inclusive rate is not a
 *                    breakfast rate; a 2-adult price is not a 4-adult price;
 *                    and a tax-inclusive number is not a tax-unknown number
 *                    (the 8e fix — mixing them lifted Lily Beach's meta
 *                    median ~13% the day the verified tier arrived). NULL
 *                    room_class is its own class (the meta property-level
 *                    quote), matched NULL-to-NULL, never wildcarded.
 *   SOFT DIMENSION   the stay-length bucket, the one recorded relaxation —
 *                    safe because the comparison unit is already per-night.
 *   EXCLUDED ALWAYS  suspicious rows, lead-in teasers, rows outside the
 *                    lookback, rows that cannot yield an honest nightly.
 *
 * Percentile uses the midpoint rank (below + equal/2): an unchanged price
 * must read as ordinary, never as an all-time low.
 */

import type { DB } from "../db/index.js"
import { nightlyFor } from "./normalize.js"
import { nightsBucketLabel } from "./identity.js"
import type { StayAnomalyConfig } from "./config.js"
import type { PriceBasis } from "../providers/stays/types.js"

export type StayConfidenceLabel = "INSUFFICIENT" | "VERY_LOW" | "LOW" | "MEDIUM" | "HIGHER"

const TIER_ORDER: StayConfidenceLabel[] = ["INSUFFICIENT", "VERY_LOW", "LOW", "MEDIUM", "HIGHER"]

export interface StayBaselineStats {
  key: string
  scope: "strict" | "any-length"
  count: number
  min: number
  max: number
  median: number
  /** Midpoint-rank percentile of the judged nightly within the baseline. */
  percentile: number
  percentBelowMedian: number
  firstAt: string
  lastAt: string
  /** Age of the NEWEST member relative to asOf, in days. */
  ageDays: number
  stale: boolean
  confidence: StayConfidenceLabel
  confidenceValue: number
  isNewObservedLow: boolean
}

export interface StayBaselineQuery {
  propertyId: string
  sourceClass: string
  roomClass: string | null
  board: string
  adults: number
  children: number
  currency: string
  /** included | excluded | partial | unknown — hard dimension since 8e. */
  taxesFees: string
  nights: number
  /** The judged nightly figure. */
  nightly: number
  /** Strict cutoff: only observations fetched BEFORE this instant count. */
  asOf: string
  /** Same-search siblings to exclude, by id — never by timestamp. */
  searchRequestId: number | null
}

interface PriorRow {
  id: number
  price_amount: number
  price_basis: string
  nights: number
  fetched_at: string
}

export function buildStayBaseline(
  db: DB,
  query: StayBaselineQuery,
  config: StayAnomalyConfig,
): StayBaselineStats | null {
  const lookbackStart = new Date(Date.parse(query.asOf) - config.baseline.lookbackDays * 86_400_000).toISOString()

  // Hard dimensions in SQL; nightly derivation and the soft dimension in JS
  // (volumes are tiny and this keeps the basis arithmetic in ONE place —
  // normalize.ts — instead of duplicating it in SQL).
  const rows = db.prepare(`
    SELECT id, price_amount, price_basis, nights, fetched_at
    FROM stay_rate_observations
    WHERE property_id = @propertyId
      AND source_class = @sourceClass
      AND COALESCE(room_class, '~none~') = COALESCE(@roomClass, '~none~')
      AND board = @board
      AND adults = @adults
      AND children = @children
      AND price_currency = @currency
      AND taxes_fees = @taxesFees
      AND sanity = 'ok'
      AND price_basis != 'lead_in'
      AND fetched_at < @asOf
      AND fetched_at >= @lookbackStart
      AND (@searchRequestId IS NULL OR search_request_id IS NULL OR search_request_id <> @searchRequestId)
  `).all({
    propertyId: query.propertyId,
    sourceClass: query.sourceClass,
    roomClass: query.roomClass,
    board: query.board,
    adults: query.adults,
    children: query.children,
    currency: query.currency,
    taxesFees: query.taxesFees,
    asOf: query.asOf,
    lookbackStart,
    searchRequestId: query.searchRequestId,
  }) as PriorRow[]

  const nightlies = rows
    .map(r => ({ ...r, nightly: nightlyOf(r) }))
    .filter((r): r is PriorRow & { nightly: number } => r.nightly !== null && r.nightly > 0)

  // Relaxation ladder: strict (same nights bucket) first, then — recorded —
  // any length. Stop at the first scope that clears the minimum.
  const bucket = nightsBucketLabel(query.nights, config.baseline.nightsBuckets)
  const strict = nightlies.filter(r => nightsBucketLabel(r.nights, config.baseline.nightsBuckets) === bucket)

  let scope: "strict" | "any-length" = "strict"
  let sample = strict
  if (sample.length < config.baseline.minSamplesToEmit && config.baseline.relaxationOrder.includes("nightsBucket")) {
    scope = "any-length"
    sample = nightlies
  }
  if (sample.length < config.baseline.minSamplesToEmit) return null

  const values = sample.map(r => r.nightly).sort((a, b) => a - b)
  const fetchedAts = sample.map(r => r.fetched_at).sort()
  const lastAt = fetchedAts[fetchedAts.length - 1]
  const ageDays = (Date.parse(query.asOf) - Date.parse(lastAt)) / 86_400_000

  // A baseline whose newest member is an archive says nothing about today.
  if (ageDays > config.baseline.maxBaselineAgeDays) return null
  const stale = ageDays > config.baseline.staleBaselineDays

  const median = midMedian(values)
  const below = values.filter(v => v < query.nightly).length
  const equal = values.filter(v => v === query.nightly).length
  const percentile = round1(((below + equal / 2) / values.length) * 100)
  const percentBelowMedian = median > 0 ? round1((1 - query.nightly / median) * 100) : 0

  let confidence: StayConfidenceLabel = "INSUFFICIENT"
  let confidenceValue = 0
  for (const tier of config.confidenceTiers) {
    if (values.length >= tier.minSamples) {
      confidence = tier.label as StayConfidenceLabel
      confidenceValue = tier.value
    }
  }
  if (stale && confidence !== "INSUFFICIENT") {
    confidence = TIER_ORDER[Math.max(1, TIER_ORDER.indexOf(confidence) - 1)]
  }

  return {
    key: [
      query.propertyId, query.sourceClass, query.roomClass ?? "-", query.board,
      `${query.adults}a${query.children}c`, query.currency, `tax-${query.taxesFees}`,
      scope === "strict" ? bucket : "any-length",
    ].join("|"),
    scope,
    count: values.length,
    min: values[0],
    max: values[values.length - 1],
    median,
    percentile,
    percentBelowMedian,
    firstAt: fetchedAts[0],
    lastAt,
    ageDays: round1(ageDays),
    stale,
    confidence,
    confidenceValue,
    isNewObservedLow: query.nightly < values[0],
  }
}

function nightlyOf(row: PriorRow): number | null {
  return nightlyFor({
    priceBasis: row.price_basis as PriceBasis,
    price: { amount: row.price_amount, currency: "X" },
    nights: row.nights,
  })
}

function midMedian(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
