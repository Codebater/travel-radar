/**
 * Absolute luxury rules: "this nightly price is remarkable regardless of
 * history". The second independent axis, exactly as on the flight side —
 * history has a blind spot for products it has never observed, and a config
 * bar per destination group × board (scaled by luxury tier) covers it.
 *
 * The rulePath discipline is the whole point and is copied verbatim from the
 * flight engine's hardest-won lesson: "no rule exists" is UNCOMPUTABLE (the
 * component is dropped and weights renormalise), while "a rule ran and said
 * ordinary" is a REAL ZERO that keeps its weight. Conflating them multiplies
 * every unremarkable rate by the renormalisation factor.
 */

import type { StayAnomalyConfig, StayAbsoluteThresholds } from "./config.js"

export type StayAbsoluteTier = "wtf" | "extreme" | "interesting" | null

export interface StayAbsoluteAssessment {
  tier: StayAbsoluteTier
  /** 0..1 — how far past "interesting" toward "wtf". 0 when no tier. */
  score: number
  thresholdUsed: number | null
  rulePath: string          // "maldives.all_inclusive.luxury" | "none"
  detail: string
}

const NONE: StayAbsoluteAssessment = {
  tier: null, score: 0, thresholdUsed: null, rulePath: "none",
  detail: "no absolute rule matched this destination group / board / currency",
}

export function assessStayAbsolute(
  input: {
    nightly: number
    currency: string
    destinationGroup: string
    board: string
    luxuryTier: string
    /** Optional: raises the bar for villa/suite observations (retail tier). */
    roomClass?: string | null
  },
  config: StayAnomalyConfig,
): StayAbsoluteAssessment {
  const abs = config.absolute
  // Rules are stated in ONE currency; a rate in any other currency simply has
  // no rule (uncomputable), never a converted guess.
  if (input.currency !== abs.currency) return NONE

  const group = abs.rules[input.destinationGroup]
  if (!group) return NONE
  const boardKey = group[input.board] ? input.board : (group.any ? "any" : null)
  if (!boardKey) return NONE
  const base = group[boardKey]

  const tierScale = abs.tierScale[input.luxuryTier] ?? 1
  const roomScale = input.roomClass ? (abs.roomScale[input.roomClass] ?? 1) : 1
  const scale = tierScale * roomScale
  const scaled: StayAbsoluteThresholds = {
    interesting: base.interesting * scale,
    extreme: base.extreme * scale,
    wtf: base.wtf * scale,
  }
  const rulePath = `${input.destinationGroup}.${boardKey}.${input.luxuryTier}`
    + (input.roomClass && abs.roomScale[input.roomClass] !== undefined ? `.${input.roomClass}` : "")

  if (input.nightly > scaled.interesting) {
    return {
      tier: null, score: 0, thresholdUsed: scaled.interesting, rulePath,
      detail: `${input.nightly} ${abs.currency}/night is above the ${Math.round(scaled.interesting)} bar — a rule ran and said ordinary`,
    }
  }

  // Ramp linearly from "interesting" (0) to "wtf" (1) rather than stepping.
  const span = scaled.interesting - scaled.wtf
  const score = span > 0 ? clamp01((scaled.interesting - input.nightly) / span) : 1
  const tier: StayAbsoluteTier =
    input.nightly <= scaled.wtf ? "wtf"
      : input.nightly <= scaled.extreme ? "extreme"
        : "interesting"

  return {
    tier, score: Math.round(score * 1000) / 1000, thresholdUsed: scaled.interesting, rulePath,
    detail: `${input.nightly} ${abs.currency}/night crosses the ${tier} bar ` +
      `(interesting ${Math.round(scaled.interesting)} / extreme ${Math.round(scaled.extreme)} / wtf ${Math.round(scaled.wtf)}, ` +
      `${input.luxuryTier} ×${scale})`,
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
