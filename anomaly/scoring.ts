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
import { absoluteReasonCode, type AbsoluteAssessment } from "./absolute.js"
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
  penalty?: { points: number; detail: string },
  /** Ceiling for a decision that rests on absolute price alone. */
  cap?: { max: number; detail: string },
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
  // §4 positioning is applied as a PENALTY on the assembled score, not as a
  // component of it. A component can be outvoted by a big enough discount; a
  // penalty cannot, so an overnight bus to a 6am departure always costs the
  // same visible number of points however cheap the fare is.
  if (penalty && penalty.points > 0) {
    components.positioningPenalty = {
      raw: 0, weight: 0,
      points: -Math.round(penalty.points * 10) / 10,
      detail: penalty.detail,
    }
    score -= penalty.points
  }

  // Renormalising after dropping a component is right for ONE gap - it stops
  // an award being punished for a hole in our cash history. It is wrong when
  // four of ten components are missing: the surviving weights inflate, and a
  // fare with no evidence at all can outscore one backed by sixty
  // observations saying the same thing. Evidence outranks assertion.
  if (cap && score > cap.max) {
    components.noHistoryCap = {
      raw: 0, weight: 0,
      points: -Math.round((score - cap.max) * 10) / 10,
      detail: cap.detail,
    }
    score = cap.max
  }

  // A missing or negative weight in config must not produce NaN or a score
  // outside the scale the whole product is described in.
  const final = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0
  return { score: Math.round(final * 10) / 10, components, weightsVersion, effectiveWeights }
}

export interface ScoreExtras {
  /** §21 absolute price judgement, independent of history. */
  absolute?: AbsoluteAssessment | null
  /** §23 how much this destination is actually wanted, 0..1. */
  routeDesirability?: number | null
  /** §23 has this particular price been confirmed? */
  verificationStatus?: string | null
  /** §4 positioning inconvenience, 0..1. */
  positioningPenalty?: number | null
  positioningDetail?: string | null
}

function extraParts(
  extras: ScoreExtras | undefined,
  weights: Record<string, number>,
  config: AnomalyConfig,
): Record<string, { raw: number | null; weight: number; detail: string }> {
  const statuses = (config as any).verificationStatusValues ?? {}
  const status = extras?.verificationStatus ?? null
  return {
    absolutePrice: {
      // A rule that did not MATCH is not a rule that says "bad price". When no
      // threshold exists for this group and cabin, the component is dropped and
      // the remaining weights renormalise - scoring it zero would penalise a
      // route for a gap in OUR config, which is the same mistake the CPP
      // component was explicitly designed to avoid.
      raw: extras?.absolute && extras.absolute.tier !== null ? extras.absolute.score : null,
      weight: weights.absolutePrice ?? 0,
      detail: extras?.absolute?.tier
        ? extras.absolute.detail
        : (extras?.absolute?.detail ?? "no absolute rule for this route and cabin"),
    },
    routeDesirability: {
      raw: extras?.routeDesirability ?? null,
      weight: weights.routeDesirability ?? 0,
      detail: extras?.routeDesirability != null
        ? `destination desirability ${extras.routeDesirability}`
        : "destination not scored for desirability",
    },
    verification: {
      raw: status ? (statuses[status] ?? statuses.unverified ?? 0.55) : null,
      weight: weights.verification ?? 0,
      detail: status ? `verification status: ${status}` : "verification status unknown",
    },
  }
}

function penaltyFor(
  extras: ScoreExtras | undefined, weight: number,
): { points: number; detail: string } | undefined {
  const penalty = extras?.positioningPenalty ?? 0
  if (!penalty || penalty <= 0) return undefined
  return {
    points: Math.max(0, Math.min(1, penalty)) * weight * 100,
    detail: extras?.positioningDetail ?? `positioning inconvenience ${penalty}`,
  }
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
  extras?: ScoreExtras,
): ScoreResult {
  const w = config.cash.weights
  const b = input.baseline
  // With no history there is nothing to be "below", so the history components
  // are dropped and the remaining weights renormalise. Scoring them zero would
  // punish a route for our never having watched it.
  const hasHistory = b.count > 0
  const savings = b.median - input.price
  const savingsScale = scaleFor(config.cash.absoluteSavingsFullCredit, input.currency)
  const quality = itineraryQuality(input.stops)
  const provider = providerRaw(input.providerConfidence, input.verificationLevel, config)

  return assemble({
    priceVsMedian: {
      raw: hasHistory ? clamp01(b.percentBelowMedian / config.cash.fullCreditPercentBelowMedian) : null,
      weight: w.priceVsMedian!,
      detail: hasHistory
        ? `${b.percentBelowMedian}% below observed median ${b.median} ${input.currency}`
        : "no prior observations on this route",
    },
    percentile: {
      raw: hasHistory ? clamp01((100 - b.percentile) / 100) : null,
      weight: w.percentile!,
      detail: hasHistory
        ? `${b.percentile}th percentile of ${b.count} observations`
        : "no prior observations to rank against",
    },
    sampleConfidence: {
      raw: hasHistory ? b.confidenceValue : null,
      weight: w.sampleConfidence!,
      detail: hasHistory ? `${b.count} observations, tier ${b.confidence}` : "no sample yet",
    },
    providerConfidence: { raw: provider.raw, weight: w.providerConfidence!, detail: provider.detail },
    absoluteSavings: {
      raw: hasHistory ? clamp01(savings / savingsScale) : null,
      weight: w.absoluteSavings!,
      detail: hasHistory
        ? `${Math.round(savings)} ${input.currency} below median (full credit at ${savingsScale})`
        : "no median to measure a saving against",
    },
    itineraryQuality: { raw: quality.raw, weight: w.itineraryQuality!, detail: quality.detail },
    ...extraParts(extras, w, config),
  }, config.weightsVersion,
     penaltyFor(extras, (config.cash as any).positioningPenaltyWeight ?? 0.18),
     hasHistory ? undefined : {
       max: (config as any).noHistoryScoreCap ?? 85,
       detail: "capped: judged on absolute price alone, with no observations behind it",
     })
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
  extras?: ScoreExtras,
): ScoreResult {
  const w = config.award.weights
  const b = input.baseline
  const hasHistory = b.count > 0
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
      raw: hasHistory ? clamp01(b.percentBelowMedian / config.award.fullCreditPercentBelowMedian) : null,
      weight: w.pointsVsMedian!,
      detail: hasHistory
        ? `${b.percentBelowMedian}% below observed median ${b.median} pts`
        : "no prior observations for this program on this route",
    },
    taxes: { raw: taxRaw, weight: w.taxes!, detail: taxDetail },
    cpp: { raw: cppRaw, weight: w.cpp!, detail: cppDetail },
    percentile: {
      raw: hasHistory ? clamp01((100 - b.percentile) / 100) : null,
      weight: w.percentile!,
      detail: hasHistory ? `${b.percentile}th percentile of ${b.count} observations` : "no sample to rank against",
    },
    sampleConfidence: {
      raw: hasHistory ? b.confidenceValue : null,
      weight: w.sampleConfidence!,
      detail: hasHistory ? `${b.count} observations, tier ${b.confidence}` : "no sample yet",
    },
    providerConfidence: { raw: provider.raw, weight: w.providerConfidence!, detail: provider.detail },
    itineraryQuality: { raw: quality.raw, weight: w.itineraryQuality!, detail: quality.detail },
    ...extraParts(extras, w, config),
  }, config.weightsVersion,
     penaltyFor(extras, (config.award as any).positioningPenaltyWeight ?? 0.18),
     hasHistory ? undefined : {
       max: (config as any).noHistoryScoreCap ?? 85,
       detail: "capped: judged on absolute price alone, with no observations behind it",
     })
}

// ─── §T Reason codes ─────────────────────────────────────────────────────────

/**
 * Why the engine thinks what it thinks - including the reasons NOT to trust it.
 * THIN_BASELINE, STALE_BASELINE, RELAXED_BASELINE and DISCOVERY_PRICE_ONLY are
 * emitted as loudly as the positive ones, because the point of the shadow
 * period is to find out which codes correlate with bad signals (§X).
 */
export interface ReasonExtras {
  absolute?: AbsoluteAssessment | null
  currency?: string | null
  destinationGroup?: string | null
  discoveredBy?: string | null
  positioning?: { required: boolean; penalty: number; savingVsHome: number | null; detail: string } | null
  openJaw?: { saving: number | null; currency: string; outboundOrigin: string; inboundDestination: string } | null
  sanity?: { verdict: string; detail: string } | null
  verificationStatus?: string | null
}

export function reasonsFor(input: {
  type: "cash" | "award"
  cabin: string
  stops: number | null
  baseline: BaselineStats
  verificationLevel: string
  cpp?: CppResult | null
  taxesAmount?: number | null
  config: AnomalyConfig
  extras?: ReasonExtras
}): Reason[] {
  const b = input.baseline
  const config = input.config
  const reasons: Reason[] = []

  // Every code below this line is a claim ABOUT HISTORY, and a no-history
  // decision has none to make. Without this guard the empty baseline's zeroed
  // percentile reads as "0th percentile" and the card claims to be in the top
  // 5% of a sample that does not exist - the most convincing kind of false
  // positive there is, and exactly the shape Phase 5's review caught.
  const hasHistory = b.count > 0

  if (hasHistory) {
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
  }
  if (input.cabin === "business") reasons.push({ code: "BUSINESS_CLASS", detail: "premium cabin" })
  if (input.cabin === "first") reasons.push({ code: "FIRST_CLASS", detail: "premium cabin" })
  if (input.stops === 0) reasons.push({ code: "DIRECT_FLIGHT", detail: "no connection" })

  if (hasHistory && !confidenceAtLeast(b.confidence, "MEDIUM")) {
    reasons.push({ code: "THIN_BASELINE", detail: `${b.count} observations, ${b.confidence} confidence` })
  }
  if (hasHistory && b.scope !== "strict") {
    reasons.push({ code: "RELAXED_BASELINE", detail: `compared against a wider set (${b.scope})` })
  }
  if (hasHistory && b.ageDays > config.baseline.staleBaselineDays) {
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

  // ── §24 discovery-era codes ────────────────────────────────────────────
  const e = input.extras
  if (e?.absolute?.tier) {
    const code = absoluteReasonCode(e.absolute, input.cabin, e.currency ?? "USD")
    if (code) reasons.push({ code, detail: e.absolute.detail })
    reasons.push({ code: `ABSOLUTE_${e.absolute.tier.toUpperCase()}`, detail: e.absolute.detail })
  }
  if (e?.destinationGroup === "wildcard") {
    reasons.push({
      code: "WILDCARD_DESTINATION",
      detail: "a destination the fixed observer does not watch - found by wildcard discovery",
    })
  }
  if (e?.positioning?.required) {
    reasons.push({
      code: "POSITIONING_REQUIRED",
      detail: e.positioning.detail,
    })
    if (e.positioning.penalty >= 0.6) {
      reasons.push({
        code: "HIGH_POSITIONING_PENALTY",
        detail: `inconvenience score ${e.positioning.penalty} - a saving has to be large to be worth this`,
      })
    }
  }
  if (e?.openJaw && e.openJaw.saving !== null) {
    reasons.push({
      code: `OPEN_JAW_SAVES_${Math.round(e.openJaw.saving)}`,
      detail: `out of ${e.openJaw.outboundOrigin}, back into ${e.openJaw.inboundDestination}, ` +
        `saving ${Math.round(e.openJaw.saving)} ${e.openJaw.currency} against the best round trip`,
    })
  }
  if (e?.sanity && e.sanity.verdict !== "ok") {
    reasons.push({ code: "SUSPICIOUS_DATA", detail: e.sanity.detail })
  }
  if (!hasHistory) {
    reasons.push({
      code: "NO_PRIOR_HISTORY",
      detail: "this radar has never watched this route - judged on absolute price alone, " +
        "with every history-based component and claim dropped",
    })
  } else if (!confidenceAtLeast(b.confidence, "LOW")) {
    reasons.push({
      code: "LOW_CONFIDENCE_BASELINE",
      detail: `only ${b.count} prior comparable observations - treat the percentage with suspicion`,
    })
  }
  if (e?.discoveredBy && e.discoveredBy !== "FIXED_OBSERVER") {
    reasons.push({ code: `FOUND_BY_${e.discoveredBy}`, detail: `discovery method: ${e.discoveredBy}` })
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
