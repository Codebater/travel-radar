/**
 * Cross-source evidence: FACTS about what the other tier saw, never a blended
 * number. A Xotelo meta quote and an Agoda retail room are different products
 * observed through different channels; comparing them numerically inside one
 * baseline would poison both. What IS legitimate — and valuable — is recording
 * that a retail confirmation exists for the same property and window, what its
 * cheapest room cost, whether board and tax-inclusiveness were proven, and how
 * far retail sits above the meta teaser (the spread is a caution, not a price).
 *
 * The calendar signal lives here too: a date that FLIPPED to cheap relative to
 * an earlier snapshot is supporting evidence. A day merely being cheap in one
 * snapshot is a provider's coarse opinion and earns a real zero, not a boost.
 */

import type { DB } from "../db/index.js"
import type { StayAnomalyConfig } from "./config.js"

export type ConfirmationState = "meta_only" | "retail_confirmed" | "retail" | "verified"

export interface StayCrossSourceEvidence {
  confirmationState: ConfirmationState
  /** Cheapest same-window retail nightly (any room/board), when one exists. */
  retailMinNightly: number | null
  retailCurrency: string | null
  /** (retailMin − metaNightly) / metaNightly × 100, meta observations only. */
  retailSpreadPercent: number | null
  retailSpreadHigh: boolean
  /** A same-window retail row proved ALL-INCLUSIVE board. */
  boardConfirmedAllInclusive: boolean
  /** A same-window retail row carried an explicitly tax-inclusive price. */
  taxInclusiveConfirmed: boolean
  /** Metered (verified-level) same-window facts — the paid tier's answer. */
  verifiedExists: boolean
  verifiedMinNightly: number | null
  verifiedSpreadPercent: number | null
  verifiedSpreadHigh: boolean
  /** The verified tier's cheapest nightly is within tolerance of (or below) this rate. */
  verifiedCorroborates: boolean
  detail: string
}

/**
 * Same property, same stay window (check-in within ±windowDays), retail tier.
 * "Same window" is deliberate slack: the trigger→confirmation flow uses the
 * exact same dates, but a later verification tier may land a day off.
 */
export function gatherCrossSourceEvidence(
  db: DB,
  observation: {
    propertyId: string
    checkIn: string
    sourceClass: string
    nightly: number
    currency: string
    fetchedAt: string
    verificationLevel?: string
  },
  config: StayAnomalyConfig,
  windowDays = 3,
): StayCrossSourceEvidence {
  const none: StayCrossSourceEvidence = {
    confirmationState: "meta_only",
    retailMinNightly: null, retailCurrency: null,
    retailSpreadPercent: null, retailSpreadHigh: false,
    boardConfirmedAllInclusive: false, taxInclusiveConfirmed: false,
    verifiedExists: false, verifiedMinNightly: null,
    verifiedSpreadPercent: null, verifiedSpreadHigh: false, verifiedCorroborates: false,
    detail: "",
  }

  if (observation.verificationLevel === "verified") {
    return { ...none, confirmationState: "verified", detail: "this observation IS the verified tier" }
  }
  if (observation.sourceClass === "retail") {
    return { ...none, confirmationState: "retail", detail: "this observation IS the retail tier" }
  }

  const from = shiftDay(observation.checkIn, -windowDays)
  const to = shiftDay(observation.checkIn, windowDays)

  // Free retail confirmations (Agoda room-level) for the window.
  const retailRows = db.prepare(`
    SELECT price_amount, price_currency, board, taxes_fees
    FROM stay_rate_observations
    WHERE property_id = ? AND source_class = 'retail' AND sanity = 'ok'
      AND price_basis = 'nightly_room'
      AND check_in >= ? AND check_in <= ?
  `).all(observation.propertyId, from, to) as {
    price_amount: number; price_currency: string; board: string; taxes_fees: string
  }[]

  // Metered verifications (verified-level, any basis nightly-derivable) for
  // the window — the paid tier's answer, kept as separate facts.
  const verifiedRows = db.prepare(`
    SELECT price_amount, price_basis, nights
    FROM stay_rate_observations
    WHERE property_id = ? AND verification_level = 'verified' AND sanity = 'ok'
      AND price_basis != 'lead_in' AND price_currency = ?
      AND check_in >= ? AND check_in <= ?
  `).all(observation.propertyId, observation.currency, from, to) as {
    price_amount: number; price_basis: string; nights: number
  }[]
  const verifiedNightlies = verifiedRows
    .map(r => r.price_basis === "nightly_room" ? r.price_amount : r.nights > 0 ? r.price_amount / r.nights : null)
    .filter((n): n is number => n !== null && n > 0)
  const verifiedMin = verifiedNightlies.length ? Math.round(Math.min(...verifiedNightlies) * 100) / 100 : null
  const verifiedSpread = verifiedMin !== null && observation.nightly > 0
    ? Math.round(((verifiedMin - observation.nightly) / observation.nightly) * 1000) / 10
    : null

  const sameCurrency = retailRows.filter(r => r.price_currency === observation.currency)
  const cheapest = sameCurrency.length
    ? sameCurrency.reduce((a, b) => (a.price_amount <= b.price_amount ? a : b))
    : null
  const spread = cheapest && observation.nightly > 0
    ? Math.round(((cheapest.price_amount - observation.nightly) / observation.nightly) * 1000) / 10
    : null

  const verified = {
    verifiedExists: verifiedMin !== null,
    verifiedMinNightly: verifiedMin,
    verifiedSpreadPercent: verifiedSpread,
    verifiedSpreadHigh: verifiedSpread !== null && verifiedSpread > config.crossSource.verifiedSpreadHighPercent,
    verifiedCorroborates: verifiedSpread !== null && verifiedSpread <= config.crossSource.verifiedSpreadHighPercent,
  }

  if (retailRows.length === 0) {
    return {
      ...none, ...verified,
      confirmationState: "meta_only",
      detail: `no retail observation within ±${windowDays}d of ${observation.checkIn}` +
        (verifiedMin !== null ? `; verified tier saw ${verifiedMin} ${observation.currency}/nt` : ""),
    }
  }

  return {
    ...none, ...verified,
    confirmationState: "retail_confirmed",
    retailMinNightly: cheapest?.price_amount ?? null,
    retailCurrency: cheapest?.price_currency ?? null,
    retailSpreadPercent: spread,
    retailSpreadHigh: spread !== null && spread > config.crossSource.retailSpreadHighPercent,
    boardConfirmedAllInclusive: retailRows.some(r => r.board === "all_inclusive"),
    taxInclusiveConfirmed: retailRows.some(r => r.taxes_fees === "included"),
    detail: cheapest
      ? `retail confirmed: cheapest same-window retail room ${cheapest.price_amount} ${cheapest.price_currency}/night` +
        (spread !== null ? ` (${spread > 0 ? "+" : ""}${spread}% vs this meta quote)` : "") +
        (verifiedMin !== null ? `; verified tier saw ${verifiedMin} ${observation.currency}/nt` : "")
      : `retail rows exist for the window but in a different currency`,
  }
}

export interface CalendarSignal {
  /** null = no calendar coverage for the stay (component uncomputable). */
  covered: boolean
  /** Latest classification says cheap for ≥ half the stay's nights. */
  currentlyCheap: boolean
  /** At least one stay night FLIPPED to cheap from an earlier average/high. */
  flippedToCheap: boolean
  detail: string
}

export function gatherCalendarSignal(
  db: DB,
  observation: { propertyId: string; checkIn: string; checkOut: string; nights: number; fetchedAt: string },
  config: StayAnomalyConfig,
): CalendarSignal {
  // Latest classification per date, by row id — never by timestamp equality.
  // Only snapshots at or before the observation count: no look-ahead here
  // either, a later calendar must not retroactively colour an old judgement.
  const latest = db.prepare(`
    SELECT o.stay_date, o.day_class
    FROM stay_calendar_observations o
    WHERE o.property_id = ? AND o.stay_date >= ? AND o.stay_date < ?
      AND o.fetched_at <= ?
      AND o.id = (
        SELECT MAX(i.id) FROM stay_calendar_observations i
        WHERE i.property_id = o.property_id AND i.stay_date = o.stay_date
          AND i.fetched_at <= ?
      )
  `).all(observation.propertyId, observation.checkIn, observation.checkOut,
    observation.fetchedAt, observation.fetchedAt) as { stay_date: string; day_class: string }[]

  if (latest.length === 0) {
    return { covered: false, currentlyCheap: false, flippedToCheap: false, detail: "no calendar coverage for this stay" }
  }

  const cheapNow = latest.filter(r => r.day_class === "cheap")
  const currentlyCheap = cheapNow.length >= observation.nights / 2

  // A flip: some date that is cheap NOW was average/high in an EARLIER
  // snapshot within the lookback.
  let flippedToCheap = false
  if (cheapNow.length > 0) {
    const lookbackStart = new Date(
      Date.parse(observation.fetchedAt) - config.calendarSignal.flipLookbackDays * 86_400_000).toISOString()
    const earlier = db.prepare(`
      SELECT DISTINCT o.stay_date
      FROM stay_calendar_observations o
      WHERE o.property_id = ? AND o.day_class IN ('average', 'high')
        AND o.fetched_at >= ? AND o.fetched_at <= ?
        AND o.stay_date IN (${cheapNow.map(() => "?").join(",")})
        AND o.id < (
          SELECT MAX(i.id) FROM stay_calendar_observations i
          WHERE i.property_id = o.property_id AND i.stay_date = o.stay_date
            AND i.fetched_at <= ?
        )
    `).all(observation.propertyId, lookbackStart, observation.fetchedAt,
      ...cheapNow.map(r => r.stay_date), observation.fetchedAt) as { stay_date: string }[]
    flippedToCheap = earlier.length > 0
  }

  return {
    covered: true,
    currentlyCheap,
    flippedToCheap,
    detail: flippedToCheap
      ? `${cheapNow.length}/${latest.length} covered nights cheap, at least one FLIPPED from average/high`
      : `${cheapNow.length}/${latest.length} covered nights classified cheap, no flip observed`,
  }
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
