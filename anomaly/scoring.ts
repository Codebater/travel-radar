/**
 * §S/§T — the experimental shadow score and the reasons behind it.
 *
 * THE SCORE IS NOT TRUTH. It is a 0-100 opinion assembled from weighted
 * components, every one of which is stored alongside it so a bad candidate can
 * be traced to the component that oversold it. Weights live in
 * config/anomaly.json; changing them requires no code change, and the version
 * that produced each decision is recorded on the row.
 *
 * Two rules keep it defensible:
 *   - a component that cannot be computed is REMOVED and the remaining weights
 *     renormalised, never scored zero. Scoring an award 0 for CPP because our
 *     cash history has a gap would blame the award for our own blind spot.
 *   - sample confidence is a first-class component, so a 60%-below-median
 *     "deal" backed by six observations cannot reach the same score as one
 *     backed by sixty.
 */

import type { AnomalyConfig } from "./config.js"
import { confidenceAtLeast, scaleFor } from "./config.js"
import type {
  BaselineStats, CppResult, Reason, ScoreComponent, ScoreResult,
} from "./types.js"

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Stops as a crude itinerary-quality signal. Deliberately crude: this is a
 *  10% (cash) / 5% (award) component, not a comfort model. */
function itineraryQuality(stops: number | null): { raw: number; detail: string } {
  if (stops === null) return { raw: 0.6, detail: "stop count unknown" }
  if (stops === 0) return { raw: 1, detail: "direct" }
  if (stops === 1) return { raw: 0.7, detail: "1 stop" }
  return { raw: 0.4, detail: `${stops} stops` }
}

function providerRaw(
  providerConfidence: string, verificationLevel: string, config: AnomalyConfig,
): { raw: number; detail: string } {
  const p = config.providerConfidenceValues[providerConfidence] ?? 0.3
  const v = config.verificationValues[verificationLevel] ?? 0.5
  return { raw: (p + v) / 2, detail: `${providerConfidence} confidence, ${verificationLevel}` }
}

/**
 * Combine components into a score, dropping any whose raw value is null and
 * renormalising the rest so the result stays on a 0-100 scale.
 */
function assemble(
  parts: Record<string, { raw: number | null; weight: number; detail: string }>,
  weightsVersion: string,
): ScoreResult {
  const usable = Object.entries(parts).filter(([, p]) => p.raw !== null)
  const totalWeight = usable.reduce((sum, [, p]) => sum + p.weight, 0)
  const components: Record<string, ScoreComponent> = {}
  const effectiveWeights: Record<string, number> = {}
  let score = 0

  for (const [name, part] of usable) {
    const weight = totalWeight > 0 ? part.weight / totalWeight : 0
    const points = clamp01(part.raw!) * weight * 100
    components[name] = {
      raw: Math.round(clamp01(part.raw!) * 1000) / 1000,
      weight: Math.round(weight * 1000) / 1000,
      points: Math.round(points * 10) / 10,
      detail: part.detail,
    }
    effectiveWeights[name] = Math.round(weight * 1000) / 1000
    score += points
  }
  // Dropped components are still reported, with weight 0, so a reader can see
  // WHICH inputs were missing rather than wondering why the mix looks odd.
  for (const [name, part] of Object.entries(parts)) {
    if (part.raw === null) {
      components[name] = { raw: 0, weight: 0, points: 0, detail: `not available - ${part.detail}` }
    }
  }
  return { score: Math.round(score * 10) / 10, components, weightsVersion, effectiveWeights }
}

export function scoreCash(
  input: {
    price: number
    currency: string
    stops: number | null
    providerConfidence: string
    verificationLevel: string
    baseline: BaselineStats
  },
  config: AnomalyConfig,
): ScoreResult {
  const w = config.cash.weights
  const b = input.baseline
  const savings = b.median - input.price
  const savingsScale = scaleFor(config.cash.absoluteSavingsFullCredit, input.currency)
  const quality = itineraryQuality(input.stops)
  const provider = providerRaw(input.providerConfidence, input.verificationLevel, config)

  return assemble({
    priceVsMedian: {
      raw: clamp01(b.percentBelowMedian / config.cash.fullCreditPercentBelowMedian),
      weight: w.priceVsMedian!,
      detail: `${b.percentBelowMedian}% below observed median ${b.median} ${input.currency}`,
    },
    percentile: {
      raw: clamp01((100 - b.percentile) / 100),
      weight: w.percentile!,
      detail: `${b.percentile}th percentile of ${b.count} observations`,
    },
    sampleConfidence: {
      raw: b.confidenceValue,
      weight: w.sampleConfidence!,
      detail: `${b.count} observations, tier ${b.confidence}`,
    },
    providerConfidence: { raw: provider.raw, weight: w.providerConfidence!, detail: provider.detail },
    absoluteSavings: {
      raw: clamp01(savings / savingsScale),
      weight: w.absoluteSavings!,
      detail: `${Math.round(savings)} ${input.currency} below median (full credit at ${savingsScale})`,
    },
    itineraryQuality: { raw: quality.raw, weight: w.itineraryQuality!, detail: quality.detail },
  }, config.weightsVersion)
}

export function scoreAward(
  input: {
    points: number
    taxesAmount: number | null
    taxesCurrency: string | null
    cabin: string
    stops: number | null
    providerConfidence: string
    verificationLevel: string
    baseline: BaselineStats
    cpp: CppResult
  },
  config: AnomalyConfig,
): ScoreResult {
  const w = config.award.weights
  const b = input.baseline
  const quality = itineraryQuality(input.stops)
  const provider = providerRaw(input.providerConfidence, input.verificationLevel, config)

  // §O - taxes are scored in their own right, never folded into the points.
  let taxRaw: number | null = null
  let taxDetail = "no surcharge reported"
  if (input.taxesAmount !== null) {
    const low = scaleFor(config.award.taxes.lowFullCredit, input.taxesCurrency)
    const high = scaleFor(config.award.taxes.highZeroCredit, input.taxesCurrency)
    const absolute = clamp01((high - input.taxesAmount) / Math.max(1, high - low))
    taxDetail = `${input.taxesAmount} ${input.taxesCurrency ?? ""} surcharge`
    if (b.medianTaxes !== null && b.medianTaxes > 0 && b.taxesCurrency === input.taxesCurrency) {
      // Half absolute, half relative: a 90 EUR surcharge is good in absolute
      // terms AND better still when this program usually charges 300.
      const relative = clamp01(((b.medianTaxes - input.taxesAmount) / b.medianTaxes) / 0.5)
      taxRaw = (absolute + relative) / 2
      taxDetail += ` vs ${b.medianTaxes} usually observed`
    } else {
      taxRaw = absolute
    }
  }

  // §P - CPP only counts when a real cash comparable backs it. Missing means
  // the component is dropped; weak means it is capped rather than believed.
  let cppRaw: number | null = null
  let cppDetail = "no comparable cash fare observed"
  if (input.cpp.cpp !== null) {
    const full = config.award.cpp.fullCreditCentsByCabin[input.cabin]
      ?? config.award.cpp.fullCreditCentsByCabin.economy!
    const zero = config.award.cpp.zeroCreditCents
    cppRaw = clamp01((input.cpp.cpp - zero) / Math.max(0.1, full - zero))
    cppDetail = `${input.cpp.cpp} cents/pt vs ${full} full credit (${input.cpp.basis}, ${input.cpp.cashProvenance.samples} cash obs)`
    const weakCash = input.cpp.cashProvenance.samples < config.award.cpp.minCashSamples
      || (input.cpp.basis === "discovered" && input.cpp.confidence === "INSUFFICIENT")
    if (weakCash) {
      cppRaw = Math.min(cppRaw, 0.5)
      cppDetail += " - capped, weak cash comparable"
    }
  }

  return assemble({
    pointsVsMedian: {
      raw: clamp01(b.percentBelowMedian / config.award.fullCreditPercentBelowMedian),
      weight: w.pointsVsMedian!,
      detail: `${b.percentBelowMedian}% below observed median ${b.median} pts`,
    },
    taxes: { raw: taxRaw, weight: w.taxes!, detail: taxDetail },
    cpp: { raw: cppRaw, weight: w.cpp!, detail: cppDetail },
    percentile: {
      raw: clamp01((100 - b.percentile) / 100),
      weight: w.percentile!,
      detail: `${b.percentile}th percentile of ${b.count} observations`,
    },
    sampleConfidence: {
      raw: b.confidenceValue,
      weight: w.sampleConfidence!,
      detail: `${b.count} observations, tier ${b.confidence}`,
    },
    providerConfidence: { raw: provider.raw, weight: w.providerConfidence!, detail: provider.detail },
    itineraryQuality: { raw: quality.raw, weight: w.itineraryQuality!, detail: quality.detail },
  }, config.weightsVersion)
}

// ─── §T Reason codes ─────────────────────────────────────────────────────────

/**
 * Why the engine thinks what it thinks - including the reasons NOT to trust it.
 * THIN_BASELINE, STALE_BASELINE, RELAXED_BASELINE and DISCOVERY_PRICE_ONLY are
 * emitted as loudly as the positive ones, because the point of the shadow
 * period is to find out which codes correlate with bad signals (§X).
 */
export function reasonsFor(input: {
  type: "cash" | "award"
  cabin: string
  stops: number | null
  baseline: BaselineStats
  verificationLevel: string
  cpp?: CppResult | null
  taxesAmount?: number | null
  config: AnomalyConfig
}): Reason[] {
  const b = input.baseline
  const config = input.config
  const reasons: Reason[] = []

  if (b.isNewObservedLow) {
    reasons.push({ code: "NEW_OBSERVED_LOW", detail: `below the previous observed minimum of ${b.min}` })
  }
  if (b.percentBelowMedian >= 10) {
    reasons.push({
      code: "PERCENT_BELOW_MEDIAN",
      detail: `${b.percentBelowMedian}% below the observed median (${b.median})`,
    })
  }
  if (b.percentile <= 5) {
    reasons.push({ code: "TOP_5_PERCENT_OBSERVED_PRICE", detail: `${b.percentile}th percentile of ${b.count} observations` })
  } else if (b.percentile <= 10) {
    reasons.push({ code: "TOP_10_PERCENT_OBSERVED_PRICE", detail: `${b.percentile}th percentile of ${b.count} observations` })
  }
  if (input.cabin === "business") reasons.push({ code: "BUSINESS_CLASS", detail: "premium cabin" })
  if (input.cabin === "first") reasons.push({ code: "FIRST_CLASS", detail: "premium cabin" })
  if (input.stops === 0) reasons.push({ code: "DIRECT_FLIGHT", detail: "no connection" })

  if (!confidenceAtLeast(b.confidence, "MEDIUM")) {
    reasons.push({ code: "THIN_BASELINE", detail: `${b.count} observations, ${b.confidence} confidence` })
  }
  if (b.scope !== "strict") {
    reasons.push({ code: "RELAXED_BASELINE", detail: `compared against a wider set (${b.scope})` })
  }
  if (b.ageDays > config.baseline.staleBaselineDays) {
    reasons.push({ code: "STALE_BASELINE", detail: `newest comparable observation is ${b.ageDays}d old` })
  }
  if (input.verificationLevel === "discovered") {
    reasons.push({ code: "DISCOVERY_PRICE_ONLY", detail: "free-tier discovery price, not verified against a paid source" })
  }
  if (input.verificationLevel === "cross-verified") {
    reasons.push({ code: "CROSS_VERIFIED", detail: "two independent providers reported it" })
  }
  if (input.verificationLevel === "verified") {
    reasons.push({ code: "VERIFIED_PRICE", detail: "confirmed by a metered provider" })
  }

  if (input.type === "award") {
    const cpp = input.cpp
    if (!cpp || cpp.cpp === null) {
      reasons.push({ code: "NO_CASH_COMPARATOR", detail: "no comparable cash fare observed; CPP not scored" })
    } else {
      const full = config.award.cpp.fullCreditCentsByCabin[input.cabin] ?? 2.5
      if (cpp.cpp >= full) reasons.push({ code: "HIGH_CPP", detail: `${cpp.cpp} cents/pt against observed cash fares` })
      if (cpp.cashProvenance.samples < config.award.cpp.minCashSamples) {
        reasons.push({ code: "WEAK_CASH_COMPARATOR", detail: `only ${cpp.cashProvenance.samples} cash observation(s) behind the CPP` })
      }
    }
    if (input.taxesAmount !== null && input.taxesAmount !== undefined) {
      const low = scaleFor(config.award.taxes.lowFullCredit, b.taxesCurrency)
      const high = scaleFor(config.award.taxes.highZeroCredit, b.taxesCurrency)
      if (input.taxesAmount <= low) reasons.push({ code: "LOW_AWARD_TAXES", detail: `${input.taxesAmount} surcharge` })
      if (input.taxesAmount >= high) reasons.push({ code: "HIGH_AWARD_TAXES", detail: `${input.taxesAmount} surcharge - points alone would flatter this` })
    }
  }

  return reasons
}

// ─── §Z Preset matching (CONFIG ONLY - never alerts) ─────────────────────────

/**
 * Which extreme-deal presets this decision WOULD have matched. Recorded for
 * evaluation only: nothing reads this to notify anybody, and config.alerts is
 * hard-off. When alerting is eventually built, these thresholds are the
 * starting point - measured against real candidates rather than guessed.
 */
export function matchPresets(input: {
  type: "cash" | "award"
  score: number
  baseline: BaselineStats
  cpp?: CppResult | null
  config: AnomalyConfig
}): string[] {
  const matched: string[] = []
  for (const [name, preset] of Object.entries(input.config.presets)) {
    if (name === "note" || typeof preset !== "object" || preset === null) continue
    const rules = input.type === "cash" ? (preset as any).cash : (preset as any).award
    if (!rules) continue
    if (input.score < ((preset as any).minScore ?? 0)) continue
    if (rules.minSampleConfidence && !confidenceAtLeast(input.baseline.confidence, rules.minSampleConfidence)) continue

    const byMedian = input.baseline.percentBelowMedian >= (rules.minPercentBelowMedian ?? Infinity)
    const byCpp = rules.orMinCpp !== undefined && (input.cpp?.cpp ?? -Infinity) >= rules.orMinCpp
    const byNewLow = rules.orNewObservedLow === true && input.baseline.isNewObservedLow
    if (byMedian || byCpp || byNewLow) matched.push(name)
  }
  return matched
}
