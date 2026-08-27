/**
 * Shadow anomaly engine: comparability, baselines without look-ahead, sample
 * confidence, scoring, reason codes, CPP, multi-program comparison, feedback,
 * the false-positive report, backups and the "no alerts" guarantee.
 *
 * Entirely offline. The engine is pure database work - it contacts no provider
 * by design, and these tests assert that too.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import Database from "better-sqlite3"
import { createMemoryDb, migrate, type DB } from "../db/index.js"
import { recordPriceObservations, recordAwardObservations } from "../db/repositories.js"
import { loadAnomalyConfig, confidenceFor, confidenceAtLeast, type AnomalyConfig } from "../anomaly/config.js"
import {
  buildComparabilityKey, tripLengthBucket, directnessOf, featuresFor, keyToString,
} from "../anomaly/comparability.js"
import { cashBaselineRows, awardBaselineRows, buildBaseline } from "../anomaly/baseline.js"
import { computeCpp } from "../anomaly/cpp.js"
import { scoreCash, reasonsFor, matchPresets } from "../anomaly/scoring.js"
import { compareProgramsForItinerary } from "../anomaly/programs.js"
import {
  evaluateNewObservations, recomputeHistory, evaluateCashObservation, evaluateAwardObservation,
} from "../anomaly/engine.js"
import { listCandidates, getCandidate, recordFeedback, saveCandidate } from "../anomaly/store.js"
import { buildReport } from "../anomaly/report.js"
import { backupDatabase, listBackups, pruneBackups, backupIfDue } from "../db/backup.js"
import { makeFlight, makeAwardFlight } from "./mocks.js"
import type { DealCandidate } from "../anomaly/types.js"

let db: DB
let config: AnomalyConfig

/** A fixed clock keeps every assertion about dates and ages deterministic. */
const T0 = Date.parse("2026-06-01T00:00:00.000Z")
const at = (dayOffset: number) => new Date(T0 + dayOffset * 86_400_000).toISOString()

beforeEach(() => {
  db = createMemoryDb()
  config = loadAnomalyConfig(true)
})

afterEach(() => {
  db.close()
})

/** Insert one cash observation and return its row id. */
function cash(over: Parameters<typeof makeFlight>[0] & { fetchedAt?: string } = {}): number {
  recordPriceObservations(db, [makeFlight({ cabin: "economy", returnDate: null, ...over })], { adults: 1 })
  return (db.prepare(`SELECT MAX(id) id FROM flight_prices`).get() as any).id
}

function award(over: Parameters<typeof makeAwardFlight>[0] = {}): number {
  recordAwardObservations(db, [makeAwardFlight(over)])
  return (db.prepare(`SELECT MAX(id) id FROM award_prices`).get() as any).id
}

/** N cash observations at one price, spread over prior days. */
function cashHistory(count: number, price: number, over: Record<string, any> = {}): void {
  for (let i = 0; i < count; i++) {
    cash({ price: { amount: price, currency: "USD" }, fetchedAt: at(-30 + i), ...over })
  }
}

function awardHistory(count: number, points: number, over: Record<string, any> = {}): void {
  for (let i = 0; i < count; i++) {
    award({ points, fetchedAt: at(-30 + i), ...over })
  }
}

function readCashRow(id: number): any {
  return db.prepare(`SELECT * FROM flight_prices WHERE id = ?`).get(id)
}

function readAwardRow(id: number): any {
  return db.prepare(`SELECT * FROM award_prices WHERE id = ?`).get(id)
}

// ─── §L comparability ────────────────────────────────────────────────────────

describe("comparability (what may be compared with what)", () => {
  it("never compares economy with business", () => {
    cashHistory(20, 2000, { cabin: "business" })
    const id = cash({ cabin: "economy", price: { amount: 900, currency: "USD" }, fetchedAt: at(0) })

    const decision = evaluateCashObservation(db, readCashRow(id), config)
    // The only comparable rows are business, so economy has no baseline at all.
    expect("skipped" in decision).toBe(true)
  })

  it("never compares a one-way with a return", () => {
    cashHistory(20, 2000, { returnDate: "2026-11-20" })
    const id = cash({ returnDate: null, price: { amount: 900, currency: "USD" }, fetchedAt: at(0) })
    expect("skipped" in evaluateCashObservation(db, readCashRow(id), config)).toBe(true)
  })

  it("never compares one loyalty program's points with another's", () => {
    awardHistory(20, 150_000, { loyaltyProgram: "AEROPLAN" })
    const id = award({ loyaltyProgram: "FLYING_BLUE", points: 60_000, fetchedAt: at(0) })
    expect("skipped" in evaluateAwardObservation(db, readAwardRow(id), config)).toBe(true)
  })

  it("never compares across currencies", () => {
    cashHistory(20, 2000, { price: { amount: 2000, currency: "EUR" } })
    const id = cash({ price: { amount: 900, currency: "USD" }, fetchedAt: at(0) })
    expect("skipped" in evaluateCashObservation(db, readCashRow(id), config)).toBe(true)
  })

  it("relaxes the soft dimensions in configured order and records the scope", () => {
    // History is all 1-stop; the observation is direct. Strict has no rows, so
    // directness is dropped first - and that must be visible on the decision.
    cashHistory(12, 1000, { stops: 1 })
    const id = cash({ stops: 0, price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })

    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate
    expect("skipped" in decision).toBe(false)
    expect(decision.baseline.scope).toBe("relaxed:directness")
    expect(decision.reasons.map(r => r.code)).toContain("RELAXED_BASELINE")
  })

  it("buckets trip length and classifies directness", () => {
    expect(tripLengthBucket(5, config)).toBe("short")
    expect(tripLengthBucket(10, config)).toBe("medium")
    expect(tripLengthBucket(21, config)).toBe("long")
    expect(tripLengthBucket(60, config)).toBe("extended")
    expect(tripLengthBucket(null, config)).toBeNull()
    expect(directnessOf(0)).toBe("direct")
    expect(directnessOf(2)).toBe("connecting")
    expect(directnessOf(null)).toBe("unknown")
  })

  it("prints a key that names the relaxed dimensions", () => {
    const key = buildComparabilityKey({
      origin: "vie", destination: "cun", cabin: "business",
      departureDate: "2026-11-10", returnDate: "2026-11-20", stops: 1,
    }, config)
    expect(keyToString(key)).toBe("VIE|CUN|business|return|medium|connecting")
    expect(keyToString(key, ["directness"])).toContain("any-stops")
    expect(keyToString(key, ["tripLength", "directness"])).toContain("any-length")
  })
})

// ─── §M seasonality features ─────────────────────────────────────────────────

describe("seasonality features (preserved, not yet used)", () => {
  it("keeps month, weekday, trip length and booking horizon on every candidate", () => {
    // History must share the trip type, or there is nothing comparable to
    // judge against - which is itself asserted in the comparability tests.
    cashHistory(20, 1000, { departureDate: "2026-12-24", returnDate: "2027-01-07" })
    const id = cash({
      departureDate: "2026-12-24", returnDate: "2027-01-07",
      price: { amount: 400, currency: "USD" }, fetchedAt: at(0),
    })
    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate
    expect(decision.features.travelMonth).toBe(12)
    expect(decision.features.tripLengthNights).toBe(14)
    expect(decision.features.daysUntilDeparture).toBeGreaterThan(200)
  })

  it("measures the booking horizon from the OBSERVATION, not from now", () => {
    // An observation made three weeks ago about a flight next week had a
    // 28-day horizon then; computing it against today would say 7 and make
    // every backfilled candidate look like a last-minute booking.
    const f = featuresFor({
      departureDate: "2026-06-29", returnDate: null, observedAt: "2026-06-01T00:00:00.000Z",
    })
    expect(f.daysUntilDeparture).toBe(28)
  })

  it("does not partition baselines by travel period yet", () => {
    expect(config.seasonality.enabled).toBe(false)
  })
})

// ─── §Y no look-ahead ────────────────────────────────────────────────────────

describe("historical evaluation without look-ahead", () => {
  it("ignores observations recorded after the one being judged", () => {
    // Cheap history first, then the observation, then a wave of expensive
    // prices. Judged against the future it would look like a steal.
    cashHistory(10, 400)
    const id = cash({ price: { amount: 380, currency: "USD" }, fetchedAt: at(-1) })
    for (let i = 0; i < 30; i++) cash({ price: { amount: 4000, currency: "USD" }, fetchedAt: at(i + 1) })

    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate
    expect(decision.baseline.count).toBe(10)
    expect(decision.baseline.median).toBe(400)
    // 5% below a 400 median, not 90% below a 4000 one.
    expect(decision.baseline.percentBelowMedian).toBeCloseTo(5, 1)
  })

  it("excludes siblings from the same fetch", () => {
    // One search returning twenty fares must not make its own cheapest fare
    // look like a historic low against the other nineteen.
    const stamp = at(0)
    for (let i = 0; i < 20; i++) {
      cash({ price: { amount: 1000 + i, currency: "USD" }, fetchedAt: stamp, departureTime: `2026-11-10T0${i % 9}:00` })
    }
    const id = (db.prepare(`SELECT MIN(id) id FROM flight_prices`).get() as any).id
    expect("skipped" in evaluateCashObservation(db, readCashRow(id), config)).toBe(true)
  })

  it("produces the same decision no matter when the backfill is run", () => {
    cashHistory(20, 1000)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(-1) })

    const first = evaluateNewObservations({ db, config, quiet: true })
    const before = listCandidates(db, { limit: 100, collapse: false }).map(c => `${c.sourceId}:${c.score}`)

    // More observations arrive; a re-run must not change the OLD verdicts.
    for (let i = 0; i < 15; i++) cash({ price: { amount: 200, currency: "USD" }, fetchedAt: at(i + 1) })
    recomputeHistory({ db, config, quiet: true })

    const after = listCandidates(db, { limit: 100, collapse: false })
      .filter(c => before.some(b => b.startsWith(`${c.sourceId}:`)))
      .map(c => `${c.sourceId}:${c.score}`)
    expect(after.sort()).toEqual(before.sort())
    expect(first.evaluated).toBeGreaterThan(0)
  })

  it("stores the cut-off it used", () => {
    cashHistory(20, 1000)
    const id = cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate
    expect(decision.asOf).toBe(decision.observedAt)
  })
})

// ─── §K sample-size confidence ───────────────────────────────────────────────

describe("small samples are not trusted", () => {
  it("maps sample size to the configured tiers", () => {
    expect(confidenceFor(0, config).label).toBe("INSUFFICIENT")
    expect(confidenceFor(4, config).label).toBe("INSUFFICIENT")
    expect(confidenceFor(5, config).label).toBe("VERY_LOW")
    expect(confidenceFor(9, config).label).toBe("VERY_LOW")
    expect(confidenceFor(10, config).label).toBe("LOW")
    expect(confidenceFor(19, config).label).toBe("LOW")
    expect(confidenceFor(20, config).label).toBe("MEDIUM")
    expect(confidenceFor(49, config).label).toBe("MEDIUM")
    expect(confidenceFor(50, config).label).toBe("HIGHER")
    expect(confidenceFor(5000, config).label).toBe("HIGHER")
  })

  it("orders the tiers for preset gates", () => {
    expect(confidenceAtLeast("HIGHER", "MEDIUM")).toBe(true)
    expect(confidenceAtLeast("LOW", "MEDIUM")).toBe(false)
    expect(confidenceAtLeast("MEDIUM", "MEDIUM")).toBe(true)
  })

  it("records no decision at all below the emit threshold", () => {
    cashHistory(3, 1000)
    const id = cash({ price: { amount: 100, currency: "USD" }, fetchedAt: at(0) })
    const decision = evaluateCashObservation(db, readCashRow(id), config)
    expect(decision).toEqual({ skipped: "thin-baseline" })
  })

  it("flags a thin baseline and scores it lower than an identical fat one", () => {
    const thinDb = createMemoryDb()
    const fatDb = createMemoryDb()
    try {
      for (const [target, n] of [[thinDb, 6], [fatDb, 60]] as const) {
        for (let i = 0; i < n; i++) {
          recordPriceObservations(target, [makeFlight({
            cabin: "economy", returnDate: null,
            price: { amount: 1000, currency: "USD" }, fetchedAt: at(-30 + i * 0.1),
          })], { adults: 1 })
        }
        recordPriceObservations(target, [makeFlight({
          cabin: "economy", returnDate: null,
          price: { amount: 500, currency: "USD" }, fetchedAt: at(0),
        })], { adults: 1 })
      }
      const lastId = (target: DB) => (target.prepare(`SELECT MAX(id) id FROM flight_prices`).get() as any).id
      const thin = evaluateCashObservation(thinDb, thinDb.prepare(`SELECT * FROM flight_prices WHERE id = ?`).get(lastId(thinDb)) as any, config) as DealCandidate
      const fat = evaluateCashObservation(fatDb, fatDb.prepare(`SELECT * FROM flight_prices WHERE id = ?`).get(lastId(fatDb)) as any, config) as DealCandidate

      expect(thin.baseline.confidence).toBe("VERY_LOW")
      expect(fat.baseline.confidence).toBe("HIGHER")
      expect(thin.reasons.map(r => r.code)).toContain("THIN_BASELINE")
      expect(fat.reasons.map(r => r.code)).not.toContain("THIN_BASELINE")
      // Same 50% discount, different trust: the fat baseline must score higher.
      expect(fat.score).toBeGreaterThan(thin.score)
    } finally {
      thinDb.close()
      fatDb.close()
    }
  })

  it("honours a reconfigured tier table", () => {
    const strict: AnomalyConfig = {
      ...config,
      minSamplesToEmit: 25,
      confidenceTiers: [
        { label: "INSUFFICIENT", minSamples: 0, value: 0 },
        { label: "HIGHER", minSamples: 25, value: 1 },
      ],
    }
    cashHistory(10, 1000)
    const id = cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    expect(evaluateCashObservation(db, readCashRow(id), strict)).toEqual({ skipped: "thin-baseline" })
  })
})

// ─── §J/§S scoring ───────────────────────────────────────────────────────────

describe("cash scoring", () => {
  it("computes the metrics the spec asks for", () => {
    // The worked example from the brief: current well under the observed median.
    cashHistory(30, 1850, { cabin: "business" })
    const id = cash({
      cabin: "business", price: { amount: 980, currency: "USD" }, fetchedAt: at(0),
    })
    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate

    expect(decision.baseline.median).toBe(1850)
    expect(decision.baseline.percentBelowMedian).toBeCloseTo(47, 0)
    expect(decision.baseline.percentile).toBe(0)
    expect(decision.baseline.count).toBe(30)
    expect(decision.baseline.differenceFromMinimum).toBe(980 - 1850)
    expect(decision.baseline.isNewObservedLow).toBe(true)
    expect(decision.score).toBeGreaterThan(config.candidateThreshold)
    expect(decision.status).toBe("candidate")
  })

  it("keeps the score inside 0-100 and sums the component points", () => {
    cashHistory(30, 1850)
    const id = cash({ price: { amount: 5, currency: "USD" }, fetchedAt: at(0) })
    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate
    expect(decision.score).toBeLessThanOrEqual(100)
    expect(decision.score).toBeGreaterThanOrEqual(0)
    const summed = Object.values(decision.scoreBreakdown.components).reduce((s, c) => s + c.points, 0)
    expect(summed).toBeCloseTo(decision.score, 0)
  })

  it("uses the configured weights", () => {
    const baseline = {
      key: "k", scope: "strict", count: 30, min: 900, max: 3000, median: 1850,
      percentile: 0, percentBelowMedian: 47, differenceFromMinimum: -870,
      firstAt: at(-30), lastAt: at(-1), ageDays: 1,
      confidence: "MEDIUM" as const, confidenceValue: 0.75,
      medianTaxes: null, taxesCurrency: null, isNewObservedLow: true,
    }
    const input = {
      price: 980, currency: "USD", stops: 1,
      providerConfidence: "medium", verificationLevel: "discovered", baseline,
    }
    const normal = scoreCash(input, config)
    const priceOnly = scoreCash(input, {
      ...config,
      cash: {
        ...config.cash,
        weights: {
          priceVsMedian: 1, percentile: 0, sampleConfidence: 0,
          providerConfidence: 0, absoluteSavings: 0, itineraryQuality: 0,
        },
      },
    })
    expect(priceOnly.components.priceVsMedian!.weight).toBe(1)
    expect(priceOnly.score).not.toBe(normal.score)
    expect(priceOnly.score).toBeCloseTo(94, 0)   // 47% of a 50% full-credit scale
  })

  it("rates a verified price above a discovered one, all else equal", () => {
    const baseline = {
      key: "k", scope: "strict", count: 30, min: 900, max: 3000, median: 1850,
      percentile: 0, percentBelowMedian: 47, differenceFromMinimum: -870,
      firstAt: at(-30), lastAt: at(-1), ageDays: 1,
      confidence: "MEDIUM" as const, confidenceValue: 0.75,
      medianTaxes: null, taxesCurrency: null, isNewObservedLow: true,
    }
    const discovered = scoreCash({ price: 980, currency: "USD", stops: 1, providerConfidence: "medium", verificationLevel: "discovered", baseline }, config)
    const verified = scoreCash({ price: 980, currency: "USD", stops: 1, providerConfidence: "high", verificationLevel: "verified", baseline }, config)
    expect(verified.score).toBeGreaterThan(discovered.score)
  })
})

// ─── §N/§O award scoring ─────────────────────────────────────────────────────

describe("award scoring", () => {
  it("compares points per route + cabin + program", () => {
    awardHistory(30, 95_000, { loyaltyProgram: "FLYING_BLUE", cabin: "business" })
    const id = award({
      loyaltyProgram: "FLYING_BLUE", cabin: "business", points: 68_500,
      taxes: { amount: 120, currency: "USD" }, fetchedAt: at(0),
    })
    const decision = evaluateAwardObservation(db, readAwardRow(id), config) as DealCandidate

    expect(decision.loyaltyProgram).toBe("FLYING_BLUE")
    expect(decision.baseline.median).toBe(95_000)
    expect(decision.baseline.percentBelowMedian).toBeCloseTo(27.9, 0)
    expect(decision.points).toBe(68_500)
    expect(decision.taxesAmount).toBe(120)
  })

  it("keeps points and taxes as separate dimensions", () => {
    awardHistory(20, 70_000, { taxes: { amount: 300, currency: "USD" } })
    const cheapTaxes = award({ points: 55_000, taxes: { amount: 90, currency: "USD" }, fetchedAt: at(0) })
    const dearTaxes = award({ points: 55_000, taxes: { amount: 600, currency: "USD" }, fetchedAt: at(0) })

    const a = evaluateAwardObservation(db, readAwardRow(cheapTaxes), config) as DealCandidate
    const b = evaluateAwardObservation(db, readAwardRow(dearTaxes), config) as DealCandidate

    // Identical points, so only the surcharge separates them - and it must.
    expect(a.points).toBe(b.points)
    expect(a.scoreBreakdown.components.taxes!.raw).toBeGreaterThan(b.scoreBreakdown.components.taxes!.raw)
    expect(a.score).toBeGreaterThan(b.score)
    expect(a.reasons.map(r => r.code)).toContain("LOW_AWARD_TAXES")
    expect(b.reasons.map(r => r.code)).toContain("HIGH_AWARD_TAXES")
  })

  it("never collapses points and taxes into one number", () => {
    awardHistory(20, 70_000)
    const id = award({ points: 55_000, taxes: { amount: 600, currency: "USD" }, fetchedAt: at(0) })
    const decision = evaluateAwardObservation(db, readAwardRow(id), config) as DealCandidate
    expect(decision.points).toBe(55_000)
    expect(decision.taxesAmount).toBe(600)
    expect(decision.taxesCurrency).toBe("USD")
  })
})

// ─── §P CPP ──────────────────────────────────────────────────────────────────

describe("CPP and the strength of the cash comparable", () => {
  it("computes cents per point net of the surcharge", () => {
    cashHistory(10, 2000, { cabin: "business" })
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "business",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    const cpp = computeCpp(db, {
      key, departureDate: "2026-11-10", points: 70_000,
      taxesAmount: 250, taxesCurrency: "USD", asOf: at(0),
    }, config)
    // (2000 - 250) / 70000 * 100 = 2.5 cents
    expect(cpp.cpp).toBeCloseTo(2.5, 2)
    expect(cpp.cashProvenance.samples).toBe(10)
    expect(cpp.basis).toBe("discovered")
  })

  it("refuses to invent an exchange rate", () => {
    cashHistory(10, 2000, { cabin: "business" })
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "business",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    const cpp = computeCpp(db, {
      key, departureDate: "2026-11-10", points: 70_000,
      taxesAmount: 250, taxesCurrency: "EUR", asOf: at(0),
    }, config)
    expect(cpp.cpp).toBeNull()
    // The cash side is still reported, so the gap is visible rather than silent.
    expect(cpp.cashProvenance.samples).toBe(10)
  })

  it("marks a verified cash comparable as a stronger basis", () => {
    cashHistory(6, 2000, { cabin: "business" })
    cash({ cabin: "business", price: { amount: 2000, currency: "USD" }, verificationLevel: "verified", provider: "serpapi", fetchedAt: at(-2) })
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "business",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    expect(computeCpp(db, {
      key, departureDate: "2026-11-10", points: 70_000, taxesAmount: 0, taxesCurrency: "USD", asOf: at(0),
    }, config).basis).toBe("verified")
  })

  it("drops the CPP component rather than scoring it zero when no cash exists", () => {
    awardHistory(20, 70_000)
    const id = award({ points: 40_000, fetchedAt: at(0) })
    const decision = evaluateAwardObservation(db, readAwardRow(id), config) as DealCandidate

    expect(decision.cpp?.cpp ?? null).toBeNull()
    expect(decision.scoreBreakdown.components.cpp!.weight).toBe(0)
    expect(decision.reasons.map(r => r.code)).toContain("NO_CASH_COMPARATOR")
    // Weights renormalise: an award is not punished for a hole in OUR data.
    const usedWeight = Object.values(decision.scoreBreakdown.effectiveWeights).reduce((a, b) => a + b, 0)
    expect(usedWeight).toBeCloseTo(1, 2)
  })

  it("caps the CPP component when the cash comparable is weak", () => {
    // A single cash observation is not enough to call an award exceptional.
    cash({ cabin: "business", price: { amount: 9000, currency: "USD" }, fetchedAt: at(-1) })
    awardHistory(20, 200_000, { cabin: "business" })
    const id = award({ cabin: "business", points: 100_000, taxes: { amount: 100, currency: "USD" }, fetchedAt: at(0) })

    const decision = evaluateAwardObservation(db, readAwardRow(id), config) as DealCandidate
    expect(decision.cpp?.cpp).toBeGreaterThan(5)
    expect(decision.scoreBreakdown.components.cpp!.raw).toBeLessThanOrEqual(0.5)
    expect(decision.reasons.map(r => r.code)).toContain("WEAK_CASH_COMPARATOR")
  })
})

// ─── §Q multi-program comparison ─────────────────────────────────────────────

describe("multi-program comparison", () => {
  it("names a winner per dimension instead of one universal winner", () => {
    const shared = { origin: "VIE", destination: "BKK", cabin: "business" as const, departureDate: "2026-11-10", returnDate: null }
    const hash = "shared-itinerary-hash"
    award({ ...shared, itineraryHash: hash, loyaltyProgram: "AEROPLAN", points: 55_000, taxes: { amount: 600, currency: "USD" }, fetchedAt: at(-1) })
    award({ ...shared, itineraryHash: hash, loyaltyProgram: "FLYING_BLUE", points: 70_000, taxes: { amount: 90, currency: "USD" }, fetchedAt: at(-1) })

    const comparison = compareProgramsForItinerary(db, hash, at(0), config)!
    expect(comparison.offers).toHaveLength(2)
    expect(comparison.winners.lowestPoints).toBe("AEROPLAN")
    expect(comparison.winners.lowestTaxes).toBe("FLYING_BLUE")
    // Bookability is unknown, not false, when no balance snapshot exists.
    expect(comparison.offers.every(o => o.bookable === null)).toBe(true)
    expect(comparison.note).toContain("unknown, not false")
  })

  it("uses only the most recent observation per program", () => {
    const hash = "h2"
    award({ itineraryHash: hash, loyaltyProgram: "AEROPLAN", points: 90_000, fetchedAt: at(-5) })
    award({ itineraryHash: hash, loyaltyProgram: "AEROPLAN", points: 60_000, fetchedAt: at(-1) })
    const comparison = compareProgramsForItinerary(db, hash, at(0), config)!
    expect(comparison.offers).toHaveLength(1)
    expect(comparison.offers[0]!.points).toBe(60_000)
  })

  it("never looks past the as-of moment", () => {
    const hash = "h3"
    award({ itineraryHash: hash, loyaltyProgram: "AEROPLAN", points: 90_000, fetchedAt: at(-5) })
    award({ itineraryHash: hash, loyaltyProgram: "AEROPLAN", points: 10_000, fetchedAt: at(5) })
    const comparison = compareProgramsForItinerary(db, hash, at(0), config)!
    expect(comparison.offers[0]!.points).toBe(90_000)
  })
})

// ─── §T reason codes ─────────────────────────────────────────────────────────

describe("reason codes", () => {
  const baseline = {
    key: "k", scope: "strict", count: 60, min: 900, max: 3000, median: 1850,
    percentile: 2, percentBelowMedian: 42, differenceFromMinimum: -20,
    firstAt: at(-60), lastAt: at(-1), ageDays: 1,
    confidence: "HIGHER" as const, confidenceValue: 1,
    medianTaxes: 300, taxesCurrency: "USD", isNewObservedLow: true,
  }

  it("explains a cash candidate", () => {
    const codes = reasonsFor({
      type: "cash", cabin: "business", stops: 0, baseline,
      verificationLevel: "verified", config,
    }).map(r => r.code)
    expect(codes).toContain("NEW_OBSERVED_LOW")
    expect(codes).toContain("PERCENT_BELOW_MEDIAN")
    expect(codes).toContain("TOP_5_PERCENT_OBSERVED_PRICE")
    expect(codes).toContain("BUSINESS_CLASS")
    expect(codes).toContain("DIRECT_FLIGHT")
    expect(codes).toContain("VERIFIED_PRICE")
  })

  it("says out loud when the baseline is weak", () => {
    const codes = reasonsFor({
      type: "cash", cabin: "economy", stops: 1,
      baseline: { ...baseline, count: 6, confidence: "VERY_LOW", confidenceValue: 0.25, scope: "relaxed:directness", ageDays: 90 },
      verificationLevel: "discovered", config,
    }).map(r => r.code)
    expect(codes).toContain("THIN_BASELINE")
    expect(codes).toContain("RELAXED_BASELINE")
    expect(codes).toContain("STALE_BASELINE")
    expect(codes).toContain("DISCOVERY_PRICE_ONLY")
  })

  it("carries a human-readable detail with every code", () => {
    for (const reason of reasonsFor({ type: "cash", cabin: "economy", stops: 1, baseline, verificationLevel: "discovered", config })) {
      expect(reason.detail.length).toBeGreaterThan(0)
    }
  })
})

// ─── §U/§Z threshold and presets ─────────────────────────────────────────────

describe("threshold and extreme-deal presets", () => {
  it("defaults to the configured threshold and records sub-threshold decisions", () => {
    expect(config.candidateThreshold).toBe(70)
    cashHistory(20, 1000)
    cash({ price: { amount: 995, currency: "USD" }, fetchedAt: at(0) })   // barely below
    evaluateNewObservations({ db, config, quiet: true })

    const below = db.prepare(`SELECT COUNT(*) c FROM deal_candidates WHERE status = 'below-threshold'`).get() as any
    expect(below.c).toBeGreaterThan(0)
    expect(listCandidates(db, { status: "candidate" })).toHaveLength(0)
  })

  it("records which preset a candidate WOULD have matched", () => {
    const matched = matchPresets({
      type: "cash", score: 95,
      baseline: {
        key: "k", scope: "strict", count: 60, min: 900, max: 3000, median: 2000,
        percentile: 0, percentBelowMedian: 60, differenceFromMinimum: -100,
        firstAt: at(-60), lastAt: at(-1), ageDays: 1,
        confidence: "HIGHER", confidenceValue: 1,
        medianTaxes: null, taxesCurrency: null, isNewObservedLow: true,
      },
      config,
    })
    expect(matched).toContain("EXTREME")
    expect(matched).toContain("WTF")
  })

  it("refuses a preset when the sample confidence is too low", () => {
    const matched = matchPresets({
      type: "cash", score: 95,
      baseline: {
        key: "k", scope: "strict", count: 6, min: 900, max: 3000, median: 2000,
        percentile: 0, percentBelowMedian: 60, differenceFromMinimum: -100,
        firstAt: at(-60), lastAt: at(-1), ageDays: 1,
        confidence: "VERY_LOW", confidenceValue: 0.25,
        medianTaxes: null, taxesCurrency: null, isNewObservedLow: true,
      },
      config,
    })
    expect(matched).toEqual([])
  })

  it("keeps alerting off", () => {
    expect(config.alerts.enabled).toBe(false)
  })
})

// ─── shadow mode: nothing is ever sent ───────────────────────────────────────

describe("shadow mode", () => {
  it("has no notification transport anywhere in the anomaly package", () => {
    const dir = path.join(process.cwd(), "anomaly")
    const sources = fs.readdirSync(dir).filter(f => f.endsWith(".ts"))
    expect(sources.length).toBeGreaterThan(5)
    for (const file of sources) {
      const text = fs.readFileSync(path.join(dir, file), "utf-8")
      // The engine must not be able to reach the outside world at all: no HTTP,
      // no webhook, no mail, no push. Comments saying "no alerts" are allowed;
      // an actual call is not.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      expect(code).not.toMatch(/\bfetch\s*\(/)
      expect(code).not.toMatch(/require\(['"]https?['"]\)/)
      expect(code).not.toMatch(/nodemailer|telegram|ntfy|webhook|pushover|sendgrid|twilio/i)
    }
  })

  it("writes notified = 0 on every decision", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    evaluateNewObservations({ db, config, quiet: true })
    const notified = db.prepare(`SELECT SUM(notified) s, COUNT(*) c FROM deal_candidates`).get() as any
    expect(notified.c).toBeGreaterThan(0)
    expect(notified.s).toBe(0)
  })

  it("marks every decision as shadow mode", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    evaluateNewObservations({ db, config, quiet: true })
    const modes = db.prepare(`SELECT DISTINCT mode FROM deal_candidates`).all() as any[]
    expect(modes).toEqual([{ mode: "shadow" }])
  })
})

// ─── §R/§AA persistence ──────────────────────────────────────────────────────

describe("candidate persistence", () => {
  it("updates rather than duplicates when an observation is re-judged", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })

    evaluateNewObservations({ db, config, quiet: true })
    const first = (db.prepare(`SELECT COUNT(*) c FROM deal_candidates`).get() as any).c
    recomputeHistory({ db, config, quiet: true })
    recomputeHistory({ db, config, quiet: true })
    const third = (db.prepare(`SELECT COUNT(*) c FROM deal_candidates`).get() as any).c

    expect(third).toBe(first)
  })

  it("keeps feedback attached across a re-evaluation", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    evaluateNewObservations({ db, config, quiet: true })

    const candidate = listCandidates(db, { limit: 1 })[0]!
    recordFeedback(db, candidate.id, "BAD_SIGNAL", { note: "same fare every week" })
    recomputeHistory({ db, config, quiet: true })

    expect(getCandidate(db, candidate.id)!.feedback!.verdict).toBe("BAD_SIGNAL")
  })

  it("advances its cursor so repeat evaluation does no work", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    const first = evaluateNewObservations({ db, config, quiet: true })
    const second = evaluateNewObservations({ db, config, quiet: true })
    expect(first.evaluated + first.skippedThinBaseline + first.skippedNoBaseline).toBeGreaterThan(0)
    expect(second.evaluated).toBe(0)
  })

  it("collapses repeat observations of the same offer when listing", () => {
    awardHistory(20, 100_000)
    // The same fare seen three times on three different days.
    for (const day of [-2, -1, 0]) {
      award({ points: 40_000, fetchedAt: at(day), departureDate: "2026-11-10" })
    }
    evaluateNewObservations({ db, config, quiet: true })

    const collapsed = listCandidates(db, { minScore: 0, limit: 100 })
    const raw = listCandidates(db, { minScore: 0, limit: 100, collapse: false })
    const same = raw.filter(c => c.points === 40_000)
    expect(same.length).toBe(3)
    expect(collapsed.filter(c => c.points === 40_000).length).toBe(1)
  })
})

// ─── §W feedback ─────────────────────────────────────────────────────────────

describe("feedback", () => {
  function seedOne(): number {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    evaluateNewObservations({ db, config, quiet: true })
    return listCandidates(db, { limit: 1 })[0]!.id
  }

  it("stores a verdict and reads back the latest one", () => {
    const id = seedOne()
    recordFeedback(db, id, "GOOD_DEAL")
    recordFeedback(db, id, "NORMAL", { note: "changed my mind" })

    const stored = getCandidate(db, id)!
    expect(stored.feedback!.verdict).toBe("NORMAL")
    // History is kept: an opinion that changed is data, not a correction.
    expect((db.prepare(`SELECT COUNT(*) c FROM deal_feedback WHERE candidate_id = ?`).get(id) as any).c).toBe(2)
  })

  it("rejects an unknown candidate", () => {
    expect(() => recordFeedback(db, 999_999, "GOOD_DEAL")).toThrow(/unknown candidate/)
  })

  it("only accepts the three defined verdicts", () => {
    const id = seedOne()
    expect(() => recordFeedback(db, id, "AMAZING" as any)).toThrow()
  })
})

// ─── §X false-positive analysis ──────────────────────────────────────────────

describe("false-positive report", () => {
  beforeEach(() => {
    cashHistory(30, 1850, { cabin: "business" })
    cash({ cabin: "business", price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    cash({ cabin: "business", price: { amount: 600, currency: "USD" }, fetchedAt: at(0), departureTime: "2026-11-10T18:00" })
    evaluateNewObservations({ db, config, quiet: true })
  })

  it("counts what was produced and what was judged", () => {
    const candidates = listCandidates(db, { limit: 10 })
    recordFeedback(db, candidates[0]!.id, "BAD_SIGNAL")

    const report = buildReport(db)
    expect(report.totals.decisions).toBeGreaterThan(0)
    expect(report.totals.candidates).toBeGreaterThan(0)
    expect(report.verdicts.BAD_SIGNAL).toBe(1)
    expect(report.totals.withFeedback).toBe(1)
  })

  it("correlates reason codes with bad signals", () => {
    for (const c of listCandidates(db, { limit: 10, collapse: false })) {
      recordFeedback(db, c.id, "BAD_SIGNAL")
    }
    const report = buildReport(db)
    const business = report.reasonCorrelation.find(r => r.code === "BUSINESS_CLASS")!
    expect(business.judged).toBeGreaterThan(0)
    expect(business.badSignalRate).toBe(100)
  })

  it("leaves the correlation empty until somebody judges", () => {
    const report = buildReport(db)
    expect(report.reasonCorrelation.every(r => r.badSignalRate === null)).toBe(true)
  })

  it("shows which routes flood the list", () => {
    const report = buildReport(db)
    const route = report.routeVolume[0]!
    expect(route.route).toBe("PRG-BKK")
    expect(route.observations).toBeGreaterThan(route.candidates)
    expect(route.candidateRate).toBeGreaterThan(0)
  })

  it("does not tune weights by itself", () => {
    const before = JSON.stringify(loadAnomalyConfig(true).cash.weights)
    buildReport(db)
    expect(JSON.stringify(loadAnomalyConfig(true).cash.weights)).toBe(before)
  })
})

// ─── §AA migration against a populated database ──────────────────────────────

describe("migration", () => {
  it("adds the Phase 5 tables to a populated Phase 4 database without losing history", () => {
    const file = path.join(os.tmpdir(), `radar-migration-${process.pid}-${Date.now()}.db`)
    const fresh = new Database(file)
    try {
      // Apply everything, seed Phase 2-4 data, then prove Phase 5 is additive
      // by re-running the migrator: nothing may be dropped or rewritten.
      migrate(fresh)
      recordPriceObservations(fresh, [makeFlight({ cabin: "economy", returnDate: null })], { adults: 1 })
      recordAwardObservations(fresh, [makeAwardFlight()])
      const before = {
        cash: (fresh.prepare(`SELECT COUNT(*) c FROM flight_prices`).get() as any).c,
        award: (fresh.prepare(`SELECT COUNT(*) c FROM award_prices`).get() as any).c,
      }

      expect(migrate(fresh)).toEqual([])   // idempotent

      expect((fresh.prepare(`SELECT COUNT(*) c FROM flight_prices`).get() as any).c).toBe(before.cash)
      expect((fresh.prepare(`SELECT COUNT(*) c FROM award_prices`).get() as any).c).toBe(before.award)
      for (const table of ["deal_candidates", "deal_feedback", "provider_events", "app_state"]) {
        expect(() => fresh.prepare(`SELECT COUNT(*) FROM ${table}`).get()).not.toThrow()
      }
      const runCols = (fresh.prepare(`PRAGMA table_info(observation_runs)`).all() as any[]).map(c => c.name)
      expect(runCols).toContain("scheduled_for")
      const leaseCols = (fresh.prepare(`PRAGMA table_info(scheduler_state)`).all() as any[]).map(c => c.name)
      expect(leaseCols).toEqual(expect.arrayContaining(["rss_bytes", "cpu_seconds", "ticks"]))
    } finally {
      fresh.close()
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(file + suffix) } catch { /* nothing to clean */ }
      }
    }
  })
})

// ─── §AB/§AC retention and backups ───────────────────────────────────────────

describe("backups and retention", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-backup-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("writes a restorable copy of the database", async () => {
    cashHistory(5, 1000)
    const result = await backupDatabase(db, { dir, retention: 14, at: new Date(T0) })

    expect(fs.existsSync(result.path)).toBe(true)
    const restored = new Database(result.path, { readonly: true })
    try {
      expect((restored.prepare(`SELECT COUNT(*) c FROM flight_prices`).get() as any).c).toBe(5)
    } finally {
      restored.close()
    }
  })

  it("keeps only the configured number of copies, newest first", async () => {
    for (let i = 0; i < 5; i++) {
      await backupDatabase(db, { dir, retention: 3, at: new Date(T0 + i * 86_400_000) })
    }
    const kept = listBackups(dir)
    expect(kept).toHaveLength(3)
    expect(kept[0]!.file > kept[1]!.file).toBe(true)
  })

  it("skips a backup that is not due yet", async () => {
    const first = await backupIfDue(db, { dir, intervalHours: 24, at: new Date(T0) })
    expect(first).not.toBeNull()
    const second = await backupIfDue(db, { dir, intervalHours: 24, at: new Date(T0 + 3600_000) })
    expect(second).toBeNull()
  })

  it("prunes nothing when the directory is empty", () => {
    expect(pruneBackups(3, path.join(dir, "missing"))).toEqual([])
  })

  it("never deletes observation history", () => {
    // §AB: cache entries expire, history does not. Nothing in the anomaly or
    // backup code may delete from the observation tables.
    for (const dirName of ["anomaly", "db"]) {
      for (const file of fs.readdirSync(path.join(process.cwd(), dirName)).filter(f => f.endsWith(".ts"))) {
        const text = fs.readFileSync(path.join(process.cwd(), dirName, file), "utf-8")
        expect(text).not.toMatch(/DELETE\s+FROM\s+flight_prices/i)
        expect(text).not.toMatch(/DELETE\s+FROM\s+award_prices/i)
      }
    }
  })
})

// ─── engine hygiene ──────────────────────────────────────────────────────────

describe("engine hygiene", () => {
  it("survives an observation it cannot judge", () => {
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    const summary = evaluateNewObservations({ db, config, quiet: true })
    expect(summary.skippedNoBaseline + summary.skippedThinBaseline).toBe(1)
    expect(summary.candidates).toBe(0)
  })

  it("reports what it did", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    const summary = evaluateNewObservations({ db, config, quiet: true })
    expect(summary.evaluated).toBeGreaterThan(0)
    expect(summary.byType.cash).toBe(summary.evaluated)
    expect(summary.topScore).not.toBeNull()
    expect(summary.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("stores the engine and weights version on every decision", () => {
    cashHistory(20, 1850)
    cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    evaluateNewObservations({ db, config, quiet: true })
    const row = db.prepare(`SELECT engine_version, weights_version FROM deal_candidates LIMIT 1`).get() as any
    expect(row.engine_version).toBe(config.engineVersion)
    expect(row.weights_version).toBe(config.weightsVersion)
  })

  it("saves and reads back a hand-built candidate unchanged", () => {
    cashHistory(20, 1850)
    const id = cash({ price: { amount: 500, currency: "USD" }, fetchedAt: at(0) })
    const decision = evaluateCashObservation(db, readCashRow(id), config) as DealCandidate
    const savedId = saveCandidate(db, decision)
    const read = getCandidate(db, savedId)!

    expect(read.score).toBe(decision.score)
    expect(read.reasons.map(r => r.code)).toEqual(decision.reasons.map(r => r.code))
    expect(read.baseline.median).toBe(decision.baseline.median)
    expect(read.features.travelMonth).toBe(decision.features.travelMonth)
  })
})

// ─── currency honesty (live-validation finding) ──────────────────────────────

describe("currencies are never converted at an invented rate", () => {
  it("keeps the provider's own currency in the accounted ATF path", () => {
    // Live validation caught this: ATF quoted 75 GBP and the provider stored
    // 95 USD, converted at a rate hardcoded in Phase 1. Phase 5 does real
    // arithmetic on award taxes (baseline, score component, and a CPP that
    // SUBTRACTS them from a cash fare), so a frozen guess would corrupt three
    // numbers at once while still looking like data.
    const source = fs.readFileSync(path.join(process.cwd(), "providers", "award-flights", "atf.ts"), "utf-8")
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(code).not.toMatch(/\*\s*1\.27/)
    expect(code).toMatch(/taxes_currency/)
  })

  it("refuses a CPP rather than mixing currencies", () => {
    cashHistory(10, 2000, { cabin: "business" })
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "business",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    const mixed = computeCpp(db, {
      key, departureDate: "2026-11-10", points: 70_000,
      taxesAmount: 75, taxesCurrency: "GBP", asOf: at(0),
    }, config)
    expect(mixed.cpp).toBeNull()
    expect(mixed.basis).toBe("none")
  })

  it("keeps a GBP-taxed award scoreable even without a CPP", () => {
    awardHistory(20, 70_000, { taxes: { amount: 300, currency: "GBP" } })
    const id = award({ points: 45_000, taxes: { amount: 75, currency: "GBP" }, fetchedAt: at(0) })
    const decision = evaluateAwardObservation(db, readAwardRow(id), config) as DealCandidate

    expect(decision.taxesCurrency).toBe("GBP")
    expect(decision.cpp?.cpp ?? null).toBeNull()
    expect(decision.score).toBeGreaterThan(0)
    expect(decision.reasons.map(r => r.code)).toContain("NO_CASH_COMPARATOR")
  })
})

// ─── baseline internals ──────────────────────────────────────────────────────

describe("baseline internals", () => {
  it("returns null when there is nothing comparable", () => {
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "economy",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    expect(buildBaseline([], key, 100, at(0), config)).toBeNull()
  })

  it("measures age from the freshest comparable observation", () => {
    cashHistory(10, 1000)
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "economy",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    const rows = cashBaselineRows(db, key, at(10), config, "USD")
    const baseline = buildBaseline(rows, key, 500, at(10), config)!
    // Newest history row is at day -21 relative to day +10.
    expect(baseline.ageDays).toBeCloseTo(10 - -21, 0)
  })

  it("respects the lookback window", () => {
    cash({ price: { amount: 1000, currency: "USD" }, fetchedAt: "2020-01-01T00:00:00.000Z" })
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "economy",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
    }, config)
    expect(cashBaselineRows(db, key, at(0), config, "USD")).toHaveLength(0)
  })

  it("picks the dominant currency for award surcharges", () => {
    awardHistory(6, 70_000, { taxes: { amount: 100, currency: "USD" } })
    award({ points: 70_000, taxes: { amount: 5000, currency: "CZK" }, fetchedAt: at(-2) })
    const key = buildComparabilityKey({
      origin: "PRG", destination: "BKK", cabin: "business",
      departureDate: "2026-11-10", returnDate: null, stops: 1,
      loyaltyProgram: "AEROPLAN",
    }, config)
    const rows = awardBaselineRows(db, key, at(0), config)
    const baseline = buildBaseline(rows, key, 60_000, at(0), config)!
    expect(baseline.taxesCurrency).toBe("USD")
    expect(baseline.medianTaxes).toBe(100)
  })
})
