/**
 * §25/§26 - is this observation believable at all?
 *
 * Phase 5 demonstrated, with a reproduction, how convincing a fabricated
 * candidate looks: it arrives at the top of the feed wearing NEW_OBSERVED_LOW
 * and a confident percentage. The same shape appears when a provider starts
 * returning nonsense — a mis-mapped cabin, a per-segment price read as a total,
 * a currency dropped somewhere upstream. A €12 business fare to Bangkok is not
 * the find of the decade; it is a bug, and the difference matters more as the
 * engine searches places nobody is watching.
 *
 * So implausible values are FLAGGED, not discarded. Discarding hides a
 * provider that has begun producing garbage — exactly the thing worth knowing.
 * A flagged observation is stored, scored as suspicious rather than
 * exceptional, and kept visible with the reason attached.
 */

import type { AnomalyConfig } from "./config.js"
import { scaleFor } from "./config.js"

export type SanityVerdict = "ok" | "SUSPICIOUS_DATA"

export interface SanityResult {
  verdict: SanityVerdict
  reasons: string[]
  detail: string
}

const OK: SanityResult = { verdict: "ok", reasons: [], detail: "" }

function isLongHaul(destinationGroup: string | null, config: AnomalyConfig): boolean {
  const groups: string[] = (config as any).sanity?.longHaulGroups ?? []
  return destinationGroup !== null && groups.includes(destinationGroup)
}

/** Shared itinerary checks: shape problems that make any price meaningless. */
function itinerarySanity(
  input: { stops: number | null; durationMinutes?: number | null; departureDate: string | null },
  config: AnomalyConfig,
): string[] {
  const rules = (config as any).sanity?.itinerary
  if (!rules) return []
  const reasons: string[] = []

  if (rules.requireDepartureDate && !input.departureDate) {
    reasons.push("no departure date")
  }
  if (input.stops !== null && input.stops > rules.maxStops) {
    reasons.push(`${input.stops} stops exceeds the plausible maximum of ${rules.maxStops}`)
  }
  if (input.durationMinutes != null) {
    if (input.durationMinutes < rules.minDurationMinutes) {
      reasons.push(`${input.durationMinutes}min total duration is impossibly short`)
    }
    if (input.durationMinutes > rules.maxDurationMinutes) {
      reasons.push(`${input.durationMinutes}min total duration is implausibly long`)
    }
  }
  return reasons
}

export function checkCashSanity(
  input: {
    price: number
    currency: string
    cabin: string
    destinationGroup: string | null
    stops: number | null
    durationMinutes?: number | null
    departureDate: string | null
  },
  config: AnomalyConfig,
): SanityResult {
  const rules = (config as any).sanity?.cash
  if (!rules) return OK
  const reasons = itinerarySanity(input, config)

  if (!Number.isFinite(input.price) || input.price <= 0) {
    reasons.push(`price ${input.price} is not a usable number`)
  } else {
    const byCabin = rules.minPlausible?.[input.cabin]
    if (byCabin) {
      const table = isLongHaul(input.destinationGroup, config) ? byCabin.longHaul : byCabin.default
      const floor = scaleFor(table ?? {}, input.currency)
      if (floor && input.price < floor) {
        reasons.push(
          `${input.price} ${input.currency} is below the ${floor} ${input.currency} floor for ` +
          `${input.cabin}${isLongHaul(input.destinationGroup, config) ? " long-haul" : ""} — ` +
          `far more likely a data error than a fare`,
        )
      }
    }
    const ceiling = scaleFor(rules.maxPlausible ?? {}, input.currency)
    if (ceiling && input.price > ceiling) {
      reasons.push(`${input.price} ${input.currency} is above the ${ceiling} plausibility ceiling`)
    }
  }

  return reasons.length === 0
    ? OK
    : { verdict: "SUSPICIOUS_DATA", reasons, detail: reasons.join("; ") }
}

export function checkAwardSanity(
  input: {
    points: number
    taxesAmount: number | null
    taxesCurrency: string | null
    stops: number | null
    durationMinutes?: number | null
    departureDate: string | null
  },
  config: AnomalyConfig,
): SanityResult {
  const rules = (config as any).sanity?.award
  if (!rules) return OK
  const reasons = itinerarySanity(input, config)

  if (!Number.isFinite(input.points) || input.points <= 0) {
    reasons.push(`points value ${input.points} is not usable`)
  } else {
    if (input.points < rules.minPoints) {
      reasons.push(
        `${input.points} pts is below the ${rules.minPoints} pt floor — usually a partial ` +
        `segment priced as a whole journey`,
      )
    }
    if (input.points > rules.maxPoints) {
      reasons.push(`${input.points} pts is above the ${rules.maxPoints} pt plausibility ceiling`)
    }
  }

  if (input.taxesAmount !== null) {
    const ceiling = scaleFor(rules.maxSurcharge ?? {}, input.taxesCurrency ?? "USD")
    if (ceiling && input.taxesAmount > ceiling) {
      reasons.push(`${input.taxesAmount} ${input.taxesCurrency ?? ""} surcharge exceeds the ${ceiling} ceiling`)
    }
    if (input.taxesAmount < 0) reasons.push("negative surcharge")
  }

  return reasons.length === 0
    ? OK
    : { verdict: "SUSPICIOUS_DATA", reasons, detail: reasons.join("; ") }
}

/**
 * §25 - the comparability guards, asserted as a unit rather than trusted.
 *
 * Each of these is enforced structurally somewhere in the pipeline already.
 * This function exists so a single test can prove the whole set holds, and so
 * a future refactor that quietly drops one is caught rather than discovered
 * three weeks into a collection period.
 */
export function checkComparabilityGuards(input: {
  observationCabin: string
  baselineCabin: string
  observationTripType: string
  baselineTripType: string
  observationCurrency: string | null
  baselineCurrency: string | null
  observationOrigin: string
  observationDestination: string
  baselineOrigin: string
  baselineDestination: string
  observationProgram?: string | null
  baselineProgram?: string | null
  sharesSearchWithBaseline: boolean
}): SanityResult {
  const reasons: string[] = []
  if (input.observationCabin !== input.baselineCabin) {
    reasons.push(`cabin mismatch: ${input.observationCabin} judged against ${input.baselineCabin}`)
  }
  if (input.observationTripType !== input.baselineTripType) {
    reasons.push(`trip-type mismatch: ${input.observationTripType} judged against ${input.baselineTripType}`)
  }
  if (input.observationCurrency && input.baselineCurrency &&
      input.observationCurrency !== input.baselineCurrency) {
    reasons.push(`currency mismatch: ${input.observationCurrency} judged against ${input.baselineCurrency}`)
  }
  if (input.observationOrigin !== input.baselineOrigin ||
      input.observationDestination !== input.baselineDestination) {
    reasons.push(
      `route mismatch: ${input.observationOrigin}-${input.observationDestination} judged against ` +
      `${input.baselineOrigin}-${input.baselineDestination}`,
    )
  }
  if ((input.observationProgram ?? null) !== (input.baselineProgram ?? null)) {
    reasons.push(`loyalty-program mismatch: ${input.observationProgram} judged against ${input.baselineProgram}`)
  }
  if (input.sharesSearchWithBaseline) {
    reasons.push("baseline contains rows from the observation's own search")
  }
  return reasons.length === 0
    ? OK
    : { verdict: "SUSPICIOUS_DATA", reasons, detail: reasons.join("; ") }
}
