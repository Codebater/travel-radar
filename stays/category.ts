/**
 * Category-relative value: where does a nightly sit against OTHER properties
 * of the same category (destination group × board × luxury tier × source
 * class × tax status × currency)?
 *
 * This is the axis property history cannot see: a property whose normal
 * price is the category's cheap tail is objectively exceptional even with a
 * flat personal baseline. The judged property's own rows are EXCLUDED — a
 * category of one property is a mirror, not a market — and the credit is
 * scaled by the same maturity tiers as property baselines. No look-ahead,
 * sibling exclusion and sanity/teaser exclusion apply identically.
 */

import type { DB } from "../db/index.js"
import { nightlyFor } from "./normalize.js"
import type { StayAnomalyConfig } from "./config.js"
import type { PriceBasis } from "../providers/stays/types.js"

export interface CategoryStats {
  key: string
  count: number
  properties: number
  median: number
  /** Midpoint-rank percentile of the judged nightly within the category. */
  percentile: number
  /** 0..1 credit for sitting in the category's cheap tail, maturity-scaled. */
  credit: number
  confidence: string
  detail: string
}

export function assessCategoryValue(
  db: DB,
  input: {
    propertyId: string
    destinationGroup: string
    luxuryTier: string
    board: string
    sourceClass: string
    taxesFees: string
    currency: string
    nightly: number
    asOf: string
    searchRequestId: number | null
  },
  config: StayAnomalyConfig,
): CategoryStats | null {
  const c = config.category
  const lookbackStart = new Date(Date.parse(input.asOf) - c.lookbackDays * 86_400_000).toISOString()

  const rows = db.prepare(`
    SELECT o.property_id, o.price_amount, o.price_basis, o.nights
    FROM stay_rate_observations o
    JOIN stay_properties p ON p.id = o.property_id
    WHERE p.destination_group = @destinationGroup
      AND p.luxury_tier = @luxuryTier
      AND o.property_id != @propertyId
      AND o.board = @board
      AND o.source_class = @sourceClass
      AND o.taxes_fees = @taxesFees
      AND o.price_currency = @currency
      AND o.sanity = 'ok'
      AND o.price_basis != 'lead_in'
      AND o.fetched_at < @asOf
      AND o.fetched_at >= @lookbackStart
      AND (@searchRequestId IS NULL OR o.search_request_id IS NULL OR o.search_request_id <> @searchRequestId)
  `).all({
    destinationGroup: input.destinationGroup,
    luxuryTier: input.luxuryTier,
    propertyId: input.propertyId,
    board: input.board,
    sourceClass: input.sourceClass,
    taxesFees: input.taxesFees,
    currency: input.currency,
    asOf: input.asOf,
    lookbackStart,
    searchRequestId: input.searchRequestId,
  }) as { property_id: string; price_amount: number; price_basis: string; nights: number }[]

  const nightlies = rows
    .map(r => ({
      propertyId: r.property_id,
      nightly: nightlyFor({
        priceBasis: r.price_basis as PriceBasis,
        price: { amount: r.price_amount, currency: input.currency },
        nights: r.nights,
      }),
    }))
    .filter((r): r is { propertyId: string; nightly: number } => r.nightly !== null && r.nightly > 0)

  const distinctProperties = new Set(nightlies.map(r => r.propertyId)).size
  if (nightlies.length < c.minSamples || distinctProperties < c.minProperties) return null

  const values = nightlies.map(r => r.nightly).sort((a, b) => a - b)
  const median = values.length % 2
    ? values[Math.floor(values.length / 2)]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
  const below = values.filter(v => v < input.nightly).length
  const equal = values.filter(v => v === input.nightly).length
  const percentile = Math.round(((below + equal / 2) / values.length) * 1000) / 10

  // Maturity from the shared confidence tiers.
  let maturity = 0
  let confidence = "INSUFFICIENT"
  for (const tier of config.confidenceTiers) {
    if (values.length >= tier.minSamples) {
      maturity = tier.value
      confidence = tier.label
    }
  }

  const rawCredit = Math.max(0, Math.min(1, (c.lowPercentileFullCreditAt - percentile) / c.lowPercentileFullCreditAt))
  const credit = Math.round(rawCredit * maturity * 1000) / 1000

  return {
    key: [input.destinationGroup, input.board, input.luxuryTier, input.sourceClass, `tax-${input.taxesFees}`, input.currency].join("|"),
    count: values.length,
    properties: distinctProperties,
    median,
    percentile,
    credit,
    confidence,
    detail: `${input.nightly} sits at the ${percentile}th percentile of ${values.length} observations ` +
      `across ${distinctProperties} other ${input.luxuryTier} ${input.board} properties in ${input.destinationGroup} ` +
      `(median ${median}; maturity ${maturity})`,
  }
}
