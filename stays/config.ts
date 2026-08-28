/**
 * Stay Radar tuning — config/stays.json. Policy only, same rule as every
 * other config loader in this repo: no secrets, and tests override by passing
 * a config object rather than mutating the file.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { StaySanityConfig } from "./normalize.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "stays.json")

export interface StayObservationConfig {
  currency: string
  adults: number
  children: number
  defaultCheckInOffsetDays: number
  defaultNights: number
  calendarHorizonDays: number
  politeDelayMs: number
  maxRequestsPerRun: number
}

export interface StayTargetedSamplingConfig {
  cheapWindowSamplesPerRun: number
  minCheapRunNights: number
  neighborSamplesPerRun: number
  neighborTriggerPercentBelow: number
  neighborOffsetsDays: number[]
  recentSampleCooldownDays: number
}

export interface StaySamplingConfig {
  firstCheckInOffsetDays: number
  stepDays: number
  horizonDays: number
  datesPerPropertyPerRun: number
  calendarEveryNRuns: number
  targeted: StayTargetedSamplingConfig
}

export interface StaySchedulerConfig {
  frequencyHours: number
  tickSeconds: number
  leaseTtlSeconds: number
  staleRunMinutes: number
}

export interface StayBudgetsConfig {
  maxConfirmationsPerRun: number
  maxConfirmationsPerDay: number
  confirmationDelayMs: number
  breakerThreshold: number
  breakerCooldownMinutes: number
  emptyStreakSuspect: number
  calendarUnsupportedAfter: number
  rawRetention: number
}

export interface StayTriggerConfig {
  calendarTrigger: boolean
  calendarCheapFraction: number
  minSamplesForMedian: number
  percentBelowMedian: number
  lookbackDays: number
  maxTriggersPerRun: number
}

export interface StayNightsBucket {
  label: string
  maxNights: number
}

export interface StayBaselineConfig {
  lookbackDays: number
  minSamplesToEmit: number
  maxBaselineAgeDays: number
  staleBaselineDays: number
  relaxationOrder: string[]
  nightsBuckets: StayNightsBucket[]
}

export interface StayConfidenceTier {
  minSamples: number
  label: string
  value: number
}

export interface StayAbsoluteThresholds {
  interesting: number
  extreme: number
  wtf: number
}

export interface StayActionabilityConfig {
  neighborWindowDays: number
  priceTolerancePercent: number
  sustainedSpanDays: number
  values: { isolated: number; short: number; sustained: number }
  calendarSustainedValue: number
  requiresNotablePrice: boolean
  minNotableRelative: number
}

export interface StayVerificationConfig {
  nearMissBand: number
  minRelativeForGate: number
  minAbsoluteForGate: number
  maxPerRun: number
  maxPerDay: number
  monthlyBudget: number
  opportunityCooldownDays: number
}

export interface StayAnomalyConfig {
  engineVersion: string
  weightsVersion: string
  candidateThreshold: number
  storeBelowThreshold: boolean
  noHistoryScoreCap: number
  baseline: StayBaselineConfig
  confidenceTiers: StayConfidenceTier[]
  weights: { relative: number; absoluteValue: number; evidence: number; actionability: number }
  relativeComposition: { percentBelowMedian: number; percentile: number }
  fullCreditPercentBelowMedian: number
  lowPercentileFullCreditAt: number
  actionability: StayActionabilityConfig
  evidenceValues: {
    discovered: number
    confirmed: number
    verified: number
    metaWithRetailConfirmation: number
    metaWithVerified: number
  }
  crossSource: { retailSpreadHighPercent: number; verifiedSpreadHighPercent: number }
  category: {
    minSamples: number
    minProperties: number
    lookbackDays: number
    lowPercentileFullCreditAt: number
  }
  verification: StayVerificationConfig
  calendarSignal: { flipLookbackDays: number }
  absolute: {
    currency: string
    tierScale: Record<string, number>
    roomScale: Record<string, number>
    rules: Record<string, Record<string, StayAbsoluteThresholds>>
  }
}

export interface StaysConfig {
  observation: StayObservationConfig
  sanity: StaySanityConfig
  sampling: StaySamplingConfig
  scheduler: StaySchedulerConfig
  budgets: StayBudgetsConfig
  trigger: StayTriggerConfig
  anomaly: StayAnomalyConfig
}

let cached: StaysConfig | null = null

export function loadStaysConfig(force = false): StaysConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StaysConfig
  for (const key of ["observation", "sanity", "sampling", "scheduler", "budgets", "trigger", "anomaly"] as const) {
    if (!raw[key] || typeof raw[key] !== "object") {
      throw new Error(`config/stays.json is missing "${key}"`)
    }
  }
  // Confidence tiers are consulted by descending sample count; sort once here
  // so no consumer depends on the file's ordering.
  raw.anomaly.confidenceTiers = [...raw.anomaly.confidenceTiers].sort((a, b) => a.minSamples - b.minSamples)
  if (!raw.sanity.nightly?.default) {
    throw new Error(`config/stays.json sanity.nightly must define a "default" scale`)
  }
  if (!Number.isInteger(raw.observation.maxRequestsPerRun) || raw.observation.maxRequestsPerRun < 1) {
    throw new Error(`config/stays.json observation.maxRequestsPerRun must be a positive integer`)
  }
  cached = raw
  return raw
}
