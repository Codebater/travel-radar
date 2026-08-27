/**
 * Anomaly configuration loader.
 *
 * Every threshold, weight and tier lives in config/anomaly.json so tuning the
 * intelligence never means editing scoring code. The file is read once and
 * cached; tests override it by passing a config object explicitly.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { ConfidenceLabel } from "./types.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "anomaly.json")

export interface ConfidenceTier {
  label: ConfidenceLabel
  minSamples: number
  value: number
}

export interface AnomalyConfig {
  engineVersion: string
  weightsVersion: string
  candidateThreshold: number
  storeBelowThreshold: boolean
  confidenceTiers: ConfidenceTier[]
  minSamplesToEmit: number
  baseline: {
    lookbackDays: number
    maxBaselineAgeDays: number
    staleBaselineDays: number
    relaxationOrder: ("directness" | "tripLength")[]
    tripLengthBuckets: { label: string; maxNights: number }[]
  }
  seasonality: { enabled: boolean }
  cash: {
    weights: Record<string, number>
    fullCreditPercentBelowMedian: number
    absoluteSavingsFullCredit: Record<string, number>
  }
  award: {
    weights: Record<string, number>
    fullCreditPercentBelowMedian: number
    taxes: {
      lowFullCredit: Record<string, number>
      highZeroCredit: Record<string, number>
    }
    cpp: {
      zeroCreditCents: number
      fullCreditCentsByCabin: Record<string, number>
      maxCashComparableAgeDays: number
      minCashSamples: number
    }
  }
  openJaw: {
    weights: Record<string, number>
    frictionPenaltyWeight: number
    fullCreditSavingPercent: number
    highFrictionAt: number
    strongValuePercent: number
  }
  providerConfidenceValues: Record<string, number>
  verificationValues: Record<string, number>
  presets: Record<string, any>
  alerts: { enabled: boolean }
}

let cached: AnomalyConfig | null = null

export function loadAnomalyConfig(force = false): AnomalyConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AnomalyConfig
  // Tiers are consulted from the largest threshold down, so order is enforced
  // here rather than trusted from the file.
  raw.confidenceTiers = [...raw.confidenceTiers].sort((a, b) => a.minSamples - b.minSamples)
  cached = raw
  return raw
}

/** Sample size → product confidence label. NOT a statistical confidence interval. */
export function confidenceFor(samples: number, config: AnomalyConfig): ConfidenceTier {
  let tier = config.confidenceTiers[0]!
  for (const t of config.confidenceTiers) {
    if (samples >= t.minSamples) tier = t
  }
  return tier
}

const TIER_ORDER: ConfidenceLabel[] = ["INSUFFICIENT", "VERY_LOW", "LOW", "MEDIUM", "HIGHER"]

/** Is `label` at least as strong as `minimum`? Used by the preset gates. */
export function confidenceAtLeast(label: ConfidenceLabel, minimum: ConfidenceLabel): boolean {
  return TIER_ORDER.indexOf(label) >= TIER_ORDER.indexOf(minimum)
}

/** Currency-keyed scale with a `default` fallback — never a silent zero. */
export function scaleFor(table: Record<string, number>, currency: string | null): number {
  if (currency && table[currency] !== undefined) return table[currency]!
  return table.default ?? Object.values(table)[0] ?? 1
}
