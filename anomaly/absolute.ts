/**
 * §21/§22 - absolute opportunity rules.
 *
 * Phase 5 scored purely on history: how does this price compare with what this
 * radar has seen on this route? That has a blind spot the discovery engine
 * makes serious. A wildcard destination the radar has never watched has no
 * history, so a genuinely remarkable fare there scores nothing; and a route
 * the radar has only ever seen expensive treats "slightly less expensive" as
 * the signal.
 *
 * So a second, independent axis: is this a good price FULL STOP, by the
 * standards of someone flying long-haul out of Central Europe? Those standards
 * are judgement, not measurement, which is exactly why they live in
 * config/anomaly.json and why the tier that fired is recorded on every
 * candidate rather than folded silently into a number.
 *
 * The two axes are deliberately independent. A fare can be 60% below a route's
 * median and still be an ordinary price (an expensive route having a normal
 * day), or bang on the median and still be extraordinary (a route that is
 * cheap all the time). Only using both stops each one's blind spot.
 */

import type { AnomalyConfig } from "./config.js"
import { scaleFor } from "./config.js"

export type AbsoluteTier = "wtf" | "extreme" | "interesting" | null

export interface AbsoluteAssessment {
  tier: AbsoluteTier
  /** 0..1 for the scorer: how far past "interesting" this price is. */
  score: number
  /** The threshold that was applied, so a reader can check the judgement. */
  thresholdUsed: number | null
  rulePath: string
  detail: string
}

const NONE: AbsoluteAssessment = {
  tier: null, score: 0, thresholdUsed: null, rulePath: "none",
  detail: "no absolute rule matched this route or cabin",
}

function tierTable(
  table: any, destinationGroup: string | null, cabin: string,
): { table: any; path: string } | null {
  const group = (destinationGroup && table[destinationGroup]) ? destinationGroup : "default"
  const byCabin = table[group]
  if (!byCabin) return null
  const forCabin = byCabin[cabin]
  if (!forCabin) return null
  return { table: forCabin, path: `${group}.${cabin}` }
}

/**
 * Cash: which tier does this fare reach, and how convincingly?
 *
 * The score ramps between the "interesting" and "wtf" thresholds rather than
 * stepping, so a fare just under a boundary is not treated as identical to one
 * far under it — and a step function would make the whole component hinge on a
 * number somebody guessed.
 */
export function assessCashAbsolute(
  input: { price: number; currency: string; cabin: string; destinationGroup: string | null },
  config: AnomalyConfig,
): AbsoluteAssessment {
  const found = tierTable((config as any).absolute?.cash, input.destinationGroup, input.cabin)
  if (!found) return NONE

  const interesting = scaleFor(found.table.interesting ?? {}, input.currency)
  const extreme = scaleFor(found.table.extreme ?? {}, input.currency)
  const wtf = scaleFor(found.table.wtf ?? {}, input.currency)
  if (!interesting) return NONE

  let tier: AbsoluteTier = null
  let thresholdUsed: number | null = null
  if (wtf && input.price <= wtf) { tier = "wtf"; thresholdUsed = wtf }
  else if (extreme && input.price <= extreme) { tier = "extreme"; thresholdUsed = extreme }
  else if (input.price <= interesting) { tier = "interesting"; thresholdUsed = interesting }

  // Linear from "interesting" (0) down to "wtf" (1). Anything above
  // "interesting" contributes nothing rather than going negative.
  const floor = wtf || extreme || interesting * 0.6
  const span = Math.max(1, interesting - floor)
  const score = tier === null ? 0 : Math.max(0, Math.min(1, (interesting - input.price) / span))

  return {
    tier,
    score: Math.round(score * 1000) / 1000,
    thresholdUsed,
    rulePath: `cash.${found.path}`,
    detail: tier === null
      ? `${input.price} ${input.currency} is above the ${interesting} ${input.currency} "interesting" threshold`
      : `${input.price} ${input.currency} reaches "${tier}" (threshold ${thresholdUsed} ${input.currency})`,
  }
}

/**
 * Award: points thresholds are per PROGRAM, because a number that means
 * "bargain" in one program means "poor" in another. The surcharge is a
 * separate gate — a cheap award carrying a 600 EUR fuel surcharge is not a
 * cheap award, and letting points alone decide the tier would say it was.
 */
export function assessAwardAbsolute(
  input: {
    points: number
    cabin: string
    loyaltyProgram: string
    taxesAmount: number | null
    taxesCurrency: string | null
  },
  config: AnomalyConfig,
): AbsoluteAssessment {
  const table = (config as any).absolute?.award
  if (!table) return NONE
  const byProgram = table[input.loyaltyProgram] ?? table.default
  const forCabin = byProgram?.[input.cabin]
  if (!forCabin) return NONE

  const interesting = forCabin.interesting as number
  const extreme = forCabin.extreme as number
  const wtf = forCabin.wtf as number
  if (!interesting) return NONE

  let tier: AbsoluteTier = null
  let thresholdUsed: number | null = null
  if (wtf && input.points <= wtf) { tier = "wtf"; thresholdUsed = wtf }
  else if (extreme && input.points <= extreme) { tier = "extreme"; thresholdUsed = extreme }
  else if (input.points <= interesting) { tier = "interesting"; thresholdUsed = interesting }

  const floor = wtf || extreme || interesting * 0.6
  const span = Math.max(1, interesting - floor)
  let score = tier === null ? 0 : Math.max(0, Math.min(1, (interesting - input.points) / span))
  let detail = tier === null
    ? `${input.points} pts is above the ${interesting} pt "interesting" threshold for ${input.loyaltyProgram}`
    : `${input.points} pts reaches "${tier}" for ${input.loyaltyProgram} (threshold ${thresholdUsed})`

  // §O again, in the tier language: the surcharge can demote a tier it cannot
  // promote. Points and cash-out-of-pocket are both real costs.
  const ceilings = table.maxSurcharge
  if (tier && ceilings && input.taxesAmount !== null) {
    const limit = scaleFor(ceilings[tier] ?? {}, input.taxesCurrency ?? "USD")
    if (limit && input.taxesAmount > limit) {
      const demoted: Record<string, AbsoluteTier> = { wtf: "extreme", extreme: "interesting", interesting: null }
      const before = tier
      tier = demoted[tier] ?? null
      score = Math.min(score, tier === null ? 0 : 0.5)
      detail += ` — demoted from "${before}" by a ${input.taxesAmount} ${input.taxesCurrency ?? ""} surcharge (limit ${limit})`
    }
  }

  return {
    tier,
    score: Math.round(score * 1000) / 1000,
    thresholdUsed,
    rulePath: `award.${table[input.loyaltyProgram] ? input.loyaltyProgram : "default"}.${input.cabin}`,
    detail,
  }
}

/** §23 route desirability: how much I actually want to go there. */
export function routeDesirability(
  destination: string,
  destinationGroup: string | null,
  config: AnomalyConfig,
  groupDefault?: number,
): number {
  const table = (config as any).routeDesirability
  if (!table) return 1
  const byAirport = table.byAirport?.[destination.toUpperCase()]
  if (typeof byAirport === "number") return byAirport
  if (typeof groupDefault === "number") return groupDefault
  void destinationGroup
  return table.default ?? 0.75
}

/** Reason code for a tier, e.g. BUSINESS_UNDER_1200. */
export function absoluteReasonCode(
  assessment: AbsoluteAssessment, cabin: string, currency: string,
): string | null {
  if (!assessment.tier || assessment.thresholdUsed === null) return null
  const cabinPart = cabin.toUpperCase().replace(/[^A-Z]/g, "_")
  return `${cabinPart}_UNDER_${Math.round(assessment.thresholdUsed)}_${currency}`
}
