/**
 * The confirmation trigger: does THIS fresh cheap-tier observation justify
 * spending ONE room-level confirmation request?
 *
 * This is deliberately not a score. It answers a binary question with two
 * conservative rules and shows its arithmetic:
 *
 *   CALENDAR_CHEAP        the provider's own forward calendar classifies at
 *                         least a configured fraction of the stay's nights as
 *                         "cheap". The provider's cross-date comparison, so it
 *                         needs no history of ours.
 *   PRICE_BELOW_MEDIAN    the cheapest fresh baseline-eligible nightly rate is
 *                         materially below this property's own observed median
 *                         — computed with the flight engine's discipline:
 *                         strictly-prior observations only, same-search
 *                         siblings excluded by search_request_id, suspicious
 *                         rows and lead-ins excluded, silent below the minimum
 *                         sample count.
 *
 * Phase 8c owns real scoring; nothing here may leak into an alert decision.
 */

import type { DB } from "../db/index.js"
import type { NormalizedStayRate } from "../providers/stays/types.js"
import type { StayTriggerConfig } from "./config.js"
import type { StoredStayProperty } from "./registry.js"

export type TriggerReason = "CALENDAR_CHEAP" | "PRICE_BELOW_MEDIAN"

export interface TriggerEvidence {
  reason: TriggerReason
  detail: string
  /** The arithmetic, with real numbers — stored on the trigger row. */
  numbers: Record<string, number | string>
}

export interface TriggerVerdict {
  triggered: boolean
  evidence: TriggerEvidence | null
}

export function evaluateConfirmationTrigger(
  db: DB,
  property: StoredStayProperty,
  stay: { checkIn: string; checkOut: string; nights: number },
  freshRates: NormalizedStayRate[],
  searchRequestId: number | null,
  config: StayTriggerConfig,
): TriggerVerdict {
  const median = priceBelowMedian(db, property, stay, freshRates, searchRequestId, config)
  if (median) return { triggered: true, evidence: median }

  if (config.calendarTrigger) {
    const calendar = calendarCheap(db, property, stay, config)
    if (calendar) return { triggered: true, evidence: calendar }
  }

  return { triggered: false, evidence: null }
}

/**
 * Cheapest fresh eligible nightly vs the property's own strictly-prior median.
 * Hard comparability: same currency, same source class as the fresh rate,
 * baseline-eligible rows only. Below minSamplesForMedian: silent, by design.
 */
function priceBelowMedian(
  db: DB,
  property: StoredStayProperty,
  stay: { checkIn: string; checkOut: string; nights: number },
  freshRates: NormalizedStayRate[],
  searchRequestId: number | null,
  config: StayTriggerConfig,
): TriggerEvidence | null {
  const eligible = freshRates.filter(r => r.priceBasis !== "lead_in" && r.price.amount > 0)
  if (eligible.length === 0) return null
  const cheapest = eligible.reduce((a, b) => (a.price.amount <= b.price.amount ? a : b))
  const asOf = cheapest.fetchedAt

  const priors = db.prepare(`
    SELECT price_amount FROM stay_rate_observations
    WHERE property_id = ?
      AND price_currency = ?
      AND source_class = ?
      AND taxes_fees = ?
      AND price_basis = 'nightly_room'
      AND sanity = 'ok'
      AND fetched_at < ?
      AND fetched_at >= ?
      AND (? IS NULL OR search_request_id IS NULL OR search_request_id <> ?)
  `).all(
    property.id,
    cheapest.price.currency,
    cheapest.sourceClass,
    cheapest.taxesFees,
    asOf,
    new Date(Date.parse(asOf) - config.lookbackDays * 86_400_000).toISOString(),
    searchRequestId, searchRequestId,
  ) as { price_amount: number }[]

  if (priors.length < config.minSamplesForMedian) return null

  const sorted = priors.map(p => p.price_amount).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  if (median <= 0) return null

  const percentBelow = Math.round((1 - cheapest.price.amount / median) * 1000) / 10
  if (percentBelow < config.percentBelowMedian) return null

  return {
    reason: "PRICE_BELOW_MEDIAN",
    detail: `${cheapest.price.amount} ${cheapest.price.currency}/night is ${percentBelow}% below the ` +
      `observed median ${median} over ${sorted.length} prior observations (${config.lookbackDays}d lookback)`,
    numbers: {
      nightly: cheapest.price.amount,
      currency: cheapest.price.currency,
      median,
      percentBelow,
      samples: sorted.length,
      rateSource: cheapest.rateSource ?? "?",
      checkIn: stay.checkIn,
    },
  }
}

/**
 * The LATEST calendar snapshot's classification of the stay's nights. Only the
 * newest fetch counts — calendar history is for Phase 8c flip-detection, not
 * for this gate.
 */
function calendarCheap(
  db: DB,
  property: StoredStayProperty,
  stay: { checkIn: string; checkOut: string; nights: number },
  config: StayTriggerConfig,
): TriggerEvidence | null {
  // The newest classification PER DATE, selected by row id — never by
  // timestamp equality: two snapshots recorded in the same millisecond share
  // a fetched_at, and filtering on it silently merges them (the flight
  // radar's fetchedAt trap, re-encountered here in its calendar form).
  const rows = db.prepare(`
    SELECT o.stay_date, o.day_class, o.fetched_at
    FROM stay_calendar_observations o
    WHERE o.property_id = ? AND o.stay_date >= ? AND o.stay_date < ?
      AND o.id = (
        SELECT MAX(i.id) FROM stay_calendar_observations i
        WHERE i.property_id = o.property_id AND i.stay_date = o.stay_date
      )
  `).all(property.id, stay.checkIn, stay.checkOut) as
    { stay_date: string; day_class: string; fetched_at: string }[]

  if (rows.length === 0) return null            // calendar does not cover this stay

  const cheap = rows.filter(r => r.day_class === "cheap").length
  const fraction = cheap / stay.nights
  if (fraction < config.calendarCheapFraction) return null

  const newestAt = rows.map(r => r.fetched_at).sort().pop() ?? "?"
  return {
    reason: "CALENDAR_CHEAP",
    detail: `${cheap} of ${stay.nights} stay nights classified cheap in the latest calendar ` +
      `(${newestAt}); threshold ${Math.round(config.calendarCheapFraction * 100)}%`,
    numbers: {
      cheapNights: cheap,
      nights: stay.nights,
      coveredNights: rows.length,
      calendarFetchedAt: newestAt,
      checkIn: stay.checkIn,
    },
  }
}
