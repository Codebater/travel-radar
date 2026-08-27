/**
 * §L/§M — what may be compared with what.
 *
 * The engine is only as honest as its baseline. Comparing an economy fare with
 * a business fare, or a one-way with a return, manufactures "50% below median"
 * out of nothing. So four dimensions are HARD (never relaxed):
 *
 *   origin, destination, cabin, trip type   (+ loyalty program for awards)
 *
 * and two are soft — trip length bucket and direct-vs-connecting. When the
 * strict sample is too thin the soft dimensions are dropped in configured
 * order, and the candidate records exactly which relaxation was used.
 *
 * Travel period is deliberately NOT part of the key yet (§M): the features are
 * preserved on every candidate so a later phase can split Christmas Bangkok
 * from September Bangkok retroactively, using history collected now.
 */

import type { AnomalyConfig } from "./config.js"
import type { ComparabilityKey, ObservationFeatures, TripType } from "./types.js"

export function tripTypeOf(returnDate: string | null | undefined): TripType {
  return returnDate ? "return" : "oneway"
}

export function nightsBetween(departureDate: string, returnDate: string | null | undefined): number | null {
  if (!returnDate) return null
  const a = Date.parse(`${departureDate}T00:00:00Z`)
  const b = Date.parse(`${returnDate}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86_400_000)
}

export function tripLengthBucket(nights: number | null, config: AnomalyConfig): string | null {
  if (nights === null) return null
  for (const bucket of config.baseline.tripLengthBuckets) {
    if (nights <= bucket.maxNights) return bucket.label
  }
  return config.baseline.tripLengthBuckets[config.baseline.tripLengthBuckets.length - 1]?.label ?? null
}

export function directnessOf(stops: number | null | undefined): ComparabilityKey["directness"] {
  if (stops === null || stops === undefined) return "unknown"
  return stops === 0 ? "direct" : "connecting"
}

export function buildComparabilityKey(input: {
  origin: string
  destination: string
  cabin: string
  departureDate: string
  returnDate: string | null
  stops: number | null
  loyaltyProgram?: string | null
}, config: AnomalyConfig): ComparabilityKey {
  const nights = nightsBetween(input.departureDate, input.returnDate)
  return {
    origin: input.origin.toUpperCase(),
    destination: input.destination.toUpperCase(),
    cabin: input.cabin,
    tripType: tripTypeOf(input.returnDate),
    tripLengthBucket: tripLengthBucket(nights, config),
    directness: directnessOf(input.stops),
    loyaltyProgram: input.loyaltyProgram ?? null,
  }
}

/** Stable printable form, used as the stored baseline_key. */
export function keyToString(key: ComparabilityKey, dropped: string[] = []): string {
  const parts = [
    key.origin, key.destination, key.cabin, key.tripType,
    dropped.includes("tripLength") ? "any-length" : (key.tripLengthBucket ?? "n/a"),
    dropped.includes("directness") ? "any-stops" : key.directness,
  ]
  if (key.loyaltyProgram) parts.push(key.loyaltyProgram)
  return parts.join("|")
}

export function featuresFor(input: {
  departureDate: string
  returnDate: string | null
  observedAt: string
}): ObservationFeatures {
  const dep = new Date(`${input.departureDate}T00:00:00Z`)
  const observed = new Date(input.observedAt)
  const daysUntilDeparture = Math.round((dep.getTime() - observed.getTime()) / 86_400_000)
  return {
    travelMonth: dep.getUTCMonth() + 1,
    departureWeekday: dep.getUTCDay(),
    tripLengthNights: nightsBetween(input.departureDate, input.returnDate),
    // Relative to the OBSERVATION, not to now — otherwise a backfilled
    // candidate from three weeks ago would claim a negative booking horizon.
    daysUntilDeparture,
  }
}
