import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import type { NormalizedStayRate } from "../providers/stays/types.js"
import { buildStayBaseline } from "../stays/baseline.js"
import { assessStayAbsolute } from "../stays/absolute.js"
import { assembleStayScore } from "../stays/scoring.js"
import { loadStaysConfig, type StaysConfig } from "../stays/config.js"
import { evaluateStayObservations } from "../stays/engine.js"
import { listStayCandidates, stayCandidateTotals } from "../stays/candidates.js"
import { gatherCrossSourceEvidence, gatherCalendarSignal } from "../stays/evidence.js"
import { stayOpportunityKey } from "../stays/identity.js"
import { classifyRoomText } from "../stays/normalize.js"
import { getStayProperty, seedStayProperties, type StayUniverseConfig } from "../stays/registry.js"
import {
  recordCalendarObservations,
  recordRateObservations,
  recordStaySearchRequest,
} from "../stays/store.js"
import { makeStayRate } from "./stay-mocks.js"

// The REAL shipped config: these tests must hold against the thresholds we
// actually run, not against a convenient fixture.
const CONFIG: StaysConfig = loadStaysConfig(true)

const STAY = { checkIn: "2026-11-10", checkOut: "2026-11-15", nights: 5 }

function universe(): StayUniverseConfig {
  return {
    destinationGroups: {
      maldives: { label: "Maldives", airports: ["MLE"] },
      bali: { label: "Bali", airports: ["DPS"] },
    },
    properties: [
      {
        id: "ai-resort", name: "AI Resort", destinationGroup: "maldives", country: "Maldives",
        nearestAirports: ["MLE"], luxuryTier: "luxury", allInclusive: "only",
        defaultBoard: "all_inclusive", typicalStayNights: [5, 7], priority: 1, active: true,
        refs: { xotelo: "g1-d1", agoda: "1:2:3" },
      },
      {
        id: "bb-hotel", name: "BB Hotel", destinationGroup: "bali", country: "Indonesia",
        nearestAirports: ["DPS"], luxuryTier: "luxury", allInclusive: "none",
        defaultBoard: "unknown", typicalStayNights: [5], priority: 2, active: true,
        refs: { xotelo: "g1-d2" },
      },
    ],
  }
}

/** Record ONE observation under its own search request; returns the request id. */
function obs(db: DB, propertyId: string, over: Partial<NormalizedStayRate> = {}): number {
  const property = getStayProperty(db, propertyId)!
  const requestId = recordStaySearchRequest(db, {
    propertyId, kind: "rates",
    checkIn: over.checkIn ?? STAY.checkIn, checkOut: over.checkOut ?? STAY.checkOut,
    currency: "USD", source: "test",
  })
  recordRateObservations(db, property, requestId, [makeStayRate({
    propertyId,
    checkIn: STAY.checkIn, checkOut: STAY.checkOut, nights: STAY.nights,
    board: "unknown",                       // let the property default apply unless overridden
    ...over,
  })], CONFIG.sanity)
  return requestId
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

describe("stay baselines — the hard dimensions", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  const query = (over: Record<string, unknown> = {}) => ({
    propertyId: "ai-resort", sourceClass: "meta", roomClass: null as string | null,
    board: "all_inclusive", adults: 2, children: 0, currency: "USD", taxesFees: "unknown",
    nights: 5, nightly: 700, asOf: new Date().toISOString(), searchRequestId: null,
    ...over,
  })

  it("builds from strictly prior comparable observations only (no look-ahead)", () => {
    for (const [amount, age] of [[900, 40], [950, 30], [1000, 20], [980, 10], [920, 5]] as const) {
      obs(db, "ai-resort", { price: { amount, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    // A FUTURE crash-price relative to asOf must be invisible.
    obs(db, "ai-resort", { price: { amount: 100, currency: "USD" }, fetchedAt: daysAgo(0) })
    const asOf = daysAgo(2)
    const b = buildStayBaseline(db, query({ asOf }), CONFIG.anomaly)!
    expect(b.count).toBe(5)
    expect(b.min).toBe(900)                  // the 100 from "the future" is not here
    expect(b.median).toBe(950)
  })

  it("excludes same-search siblings by request id, never by timestamp", () => {
    for (const age of [40, 30, 20, 10]) {
      obs(db, "ai-resort", { price: { amount: 900 + age, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    const siblingRequest = obs(db, "ai-resort", { price: { amount: 5000, currency: "USD" }, fetchedAt: daysAgo(1) })
    const withSibling = buildStayBaseline(db, query({ searchRequestId: null }), CONFIG.anomaly)
    const withoutSibling = buildStayBaseline(db, query({ searchRequestId: siblingRequest }), CONFIG.anomaly)
    expect(withSibling!.count).toBe(5)
    expect(withoutSibling).toBeNull()        // 4 remain — below the minimum, silent
  })

  it("never blends source classes: retail history is invisible to a meta baseline", () => {
    for (const age of [40, 30, 20, 10, 5]) {
      obs(db, "ai-resort", {
        price: { amount: 2000, currency: "USD" }, fetchedAt: daysAgo(age),
        sourceClass: "retail", provider: "agoda", roomName: "Villa", roomClass: "villa",
        board: "all_inclusive", verificationLevel: "confirmed",
      })
    }
    expect(buildStayBaseline(db, query(), CONFIG.anomaly)).toBeNull()
    expect(buildStayBaseline(db, query({ sourceClass: "retail", roomClass: "villa" }), CONFIG.anomaly)).not.toBeNull()
  })

  it("never blends board bases: full-board history is invisible to an all-inclusive baseline", () => {
    for (const age of [40, 30, 20, 10, 5]) {
      obs(db, "ai-resort", { price: { amount: 800, currency: "USD" }, fetchedAt: daysAgo(age), board: "full_board" })
    }
    expect(buildStayBaseline(db, query({ board: "all_inclusive" }), CONFIG.anomaly)).toBeNull()
    expect(buildStayBaseline(db, query({ board: "full_board" }), CONFIG.anomaly)).not.toBeNull()
  })

  it("never blends currencies or occupancies", () => {
    for (const age of [40, 30, 20, 10, 5]) {
      obs(db, "ai-resort", { price: { amount: 800, currency: "EUR" }, fetchedAt: daysAgo(age) })
    }
    expect(buildStayBaseline(db, query({ currency: "USD" }), CONFIG.anomaly)).toBeNull()
    for (const age of [40, 30, 20, 10, 5]) {
      obs(db, "ai-resort", { price: { amount: 800, currency: "USD" }, fetchedAt: daysAgo(age), adults: 4 })
    }
    expect(buildStayBaseline(db, query({ adults: 2 }), CONFIG.anomaly)).toBeNull()
    expect(buildStayBaseline(db, query({ adults: 4 }), CONFIG.anomaly)).not.toBeNull()
  })

  it("relaxes ONLY the stay-length bucket, and records the relaxation", () => {
    // Three short stays + three long stays, same product: strict bucket has
    // too few, the recorded any-length relaxation clears the minimum.
    for (const [nights, age] of [[3, 40], [3, 30], [3, 20], [12, 15], [12, 10], [12, 5]] as const) {
      obs(db, "ai-resort", {
        price: { amount: 900, currency: "USD" }, fetchedAt: daysAgo(age),
        nights, checkOut: shift(STAY.checkIn, nights),
      })
    }
    const b = buildStayBaseline(db, query({ nights: 5 }), CONFIG.anomaly)!
    expect(b.scope).toBe("any-length")
    expect(b.count).toBe(6)
  })

  it("emits nothing below the minimum sample count (thin baseline)", () => {
    for (const age of [30, 20, 10, 5]) {
      obs(db, "ai-resort", { price: { amount: 900, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    expect(buildStayBaseline(db, query(), CONFIG.anomaly)).toBeNull()
  })

  it("degrades a stale baseline's confidence and refuses an archived one", () => {
    for (const age of [100, 95, 90, 85, 80, 75, 70, 65]) {
      obs(db, "ai-resort", { price: { amount: 900, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    // Newest member 65 days old: past staleBaselineDays (45), within max (120).
    const stale = buildStayBaseline(db, query(), CONFIG.anomaly)!
    expect(stale.stale).toBe(true)
    expect(stale.confidence).toBe("VERY_LOW")     // LOW (8 samples) knocked down one tier
    // Push everything past maxBaselineAgeDays: an archive, not a comparison.
    const b = buildStayBaseline(db, query({ asOf: new Date(Date.now() + 60 * 86_400_000).toISOString() }), CONFIG.anomaly)
    expect(b).toBeNull()
  })

  it("excludes suspicious rows and teasers from every baseline", () => {
    for (const age of [40, 30, 20, 10, 5]) {
      obs(db, "ai-resort", { price: { amount: 900, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    obs(db, "ai-resort", { price: { amount: 2, currency: "USD" }, fetchedAt: daysAgo(3) })          // suspicious
    obs(db, "ai-resort", { price: { amount: 99, currency: "USD" }, priceBasis: "lead_in", fetchedAt: daysAgo(2) })
    const b = buildStayBaseline(db, query(), CONFIG.anomaly)!
    expect(b.count).toBe(5)
    expect(b.min).toBe(900)
  })
})

describe("absolute rules — rulePath discipline", () => {
  it("distinguishes 'rule ran and said ordinary' from 'no rule applies'", () => {
    const ordinary = assessStayAbsolute(
      { nightly: 900, currency: "EUR", destinationGroup: "maldives", board: "all_inclusive", luxuryTier: "luxury" },
      CONFIG.anomaly)
    expect(ordinary.rulePath).toBe("maldives.all_inclusive.luxury")
    expect(ordinary.tier).toBeNull()
    expect(ordinary.score).toBe(0)               // a REAL zero

    // Bars are EUR since the 8h currency switch; a USD rate has NO rule now.
    const noRule = assessStayAbsolute(
      { nightly: 900, currency: "USD", destinationGroup: "maldives", board: "all_inclusive", luxuryTier: "luxury" },
      CONFIG.anomaly)
    expect(noRule.rulePath).toBe("none")          // uncomputable, not zero
  })

  it("fires tiers with the luxury-tier scale applied", () => {
    const hit = assessStayAbsolute(
      { nightly: 430, currency: "EUR", destinationGroup: "maldives", board: "all_inclusive", luxuryTier: "luxury" },
      CONFIG.anomaly)
    expect(hit.tier).toBe("extreme")              // EUR bars 550/470/360 at ×1.0
    const ultraSame = assessStayAbsolute(
      { nightly: 600, currency: "EUR", destinationGroup: "maldives", board: "all_inclusive", luxuryTier: "ultra" },
      CONFIG.anomaly)
    expect(ultraSame.tier).toBe("extreme")        // ×1.4 → 770/658/504
  })
})

describe("score assembly — the zero-vs-absent invariant", () => {
  const base = {
    percentBelowMedian: { raw: 0.8, weight: 0.4, detail: "" },
    percentile: { raw: 0.9, weight: 0.15, detail: "" },
    evidence: { raw: 0.9, weight: 0.1, detail: "" },
  }

  it("an applicable zero KEEPS its weight; dropping it would inflate the score", () => {
    const withZero = assembleStayScore(
      { ...base, absolute: { raw: 0, weight: 0.25, detail: "rule ran, ordinary" } }, "t")
    const dropped = assembleStayScore(
      { ...base, absolute: { raw: null, weight: 0.25, detail: "no rule" } }, "t")
    // The same observation must score LOWER with an ordinary-verdict on the
    // books than it would if the verdict were (incorrectly) treated as absent
    // — this is the exact inflation the flight engine shipped once and fixed.
    expect(withZero.score).toBeLessThan(dropped.score)
    expect(withZero.components.absolute.weight).toBeGreaterThan(0)
    expect(dropped.components.absolute.weight).toBe(0)
    expect(dropped.components.absolute.detail).toContain("not available")
  })

  it("caps a no-history assembly and records the cap as a visible component", () => {
    const result = assembleStayScore(
      {
        absolute: { raw: 1, weight: 0.25, detail: "wtf bar crossed" },
        evidence: { raw: 1, weight: 0.1, detail: "" },
      },
      "t",
      { max: CONFIG.anomaly.noHistoryScoreCap, detail: "no baseline" },
    )
    expect(result.score).toBe(CONFIG.anomaly.noHistoryScoreCap)
    expect(result.capped).toBe(true)
    expect(result.components.noHistoryCap).toBeDefined()
  })
})

describe("the engine end to end", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  function history(propertyId: string, amounts: number[], startAge = 60): void {
    amounts.forEach((amount, i) => {
      obs(db, propertyId, { price: { amount, currency: "USD" }, fetchedAt: daysAgo(startAge - i * 5) })
    })
  }

  it("a strong META-ONLY anomaly stays below candidacy; retail confirmation lifts it into gate territory", () => {
    // The four-concept model's designed funnel, asserted end to end: a 36%-
    // below-median sighting from the meta tier alone must NOT interrupt-grade
    // itself; an Agoda confirmation upgrades belief into the verification
    // gate's band — and only verified + actionable evidence can cross 70.
    history("ai-resort", [950, 980, 1000, 940, 990, 960, 1010, 970])
    obs(db, "ai-resort", { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    const summary = evaluateStayObservations({ db, config: CONFIG })
    expect(summary.evaluated).toBe(9)
    const metaOnly = listStayCandidates(db, { limit: 1 })[0]
    expect(metaOnly.nightlyAmount).toBe(620)
    expect(metaOnly.sampleSize).toBe(8)
    expect(metaOnly.relativeScore).toBeGreaterThan(70)          // the relative concept is strong…
    expect(metaOnly.score).toBeLessThan(CONFIG.anomaly.candidateThreshold)  // …the decision is not
    expect(metaOnly.status).toBe("below_threshold")
    expect(metaOnly.reasons).toContain("PROPERTY_LOW_36_PERCENT")
    expect(metaOnly.reasons).toContain("NEW_OBSERVED_LOW")
    expect(metaOnly.reasons).toContain("META_ONLY")
    // The breakdown carries every concept, including what was missing.
    expect(Object.keys(metaOnly.scoreBreakdown)).toEqual(
      expect.arrayContaining(["relative", "absoluteValue", "evidence", "actionability"]))

    // A same-window retail confirmation arrives; re-judging upgrades the
    // evidence concept and the SAME observation gains score.
    obs(db, "ai-resort", {
      price: { amount: 1050, currency: "USD" }, fetchedAt: daysAgo(0),
      sourceClass: "retail", provider: "agoda", roomName: "Beach Villa", roomClass: "villa",
      board: "all_inclusive", boardSource: "structured", taxesFees: "included",
      verificationLevel: "confirmed",
    })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const confirmed = listStayCandidates(db, { limit: 10 })
      .find(c => c.sourceClass === "meta" && c.nightlyAmount === 620)!
    expect(confirmed.confirmationState).toBe("retail_confirmed")
    expect(confirmed.score).toBeGreaterThan(metaOnly.score)
    expect(confirmed.score).toBeGreaterThanOrEqual(
      CONFIG.anomaly.candidateThreshold - CONFIG.anomaly.verification.nearMissBand)
    expect(confirmed.status).toBe("below_threshold")            // still not an alert-grade claim
  })

  it("caps a no-history decision at the configured maximum", () => {
    // One observation, crazy-cheap: no baseline exists, absolute + evidence max out.
    obs(db, "ai-resort", { price: { amount: 300, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG })
    const c = listStayCandidates(db, { limit: 1 })[0]
    expect(c.sampleSize).toBe(0)
    expect(c.score).toBeLessThanOrEqual(CONFIG.anomaly.noHistoryScoreCap)
    expect(c.reasons).toContain("NO_BASELINE")
    expect((c.scoreBreakdown as Record<string, unknown>).relative).toMatchObject({ weight: 0 })
  })

  it("marks a suspicious ultra-low rate suspicious — never a candidate, score 0", () => {
    history("ai-resort", [950, 980, 1000, 940, 990])
    obs(db, "ai-resort", { price: { amount: 3, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG })
    const totals = stayCandidateTotals(db)
    expect(totals.suspicious).toBe(1)
    const suspicious = listStayCandidates(db, { status: "suspicious" })[0]
    expect(suspicious.score).toBe(0)
    expect(suspicious.reasons).toEqual(["SUSPICIOUS_DATA"])
  })

  it("heatmap-cheap with an ordinary price stays far below candidacy", () => {
    history("ai-resort", [950, 980, 1000, 940, 990, 960, 1010, 970])
    const p = getStayProperty(db, "ai-resort")!
    const cheapDays = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]
      .map(date => ({ date, dayClass: "cheap" as const }))
    recordCalendarObservations(db, p, "xotelo", "g1-d1", null, cheapDays)
    obs(db, "ai-resort", { price: { amount: 985, currency: "USD" }, fetchedAt: daysAgo(0) })   // dead ordinary
    evaluateStayObservations({ db, config: CONFIG })
    const rows = listStayCandidates(db, { limit: 20 })
    const judged = rows.find(r => r.nightlyAmount === 985)!
    expect(judged.status).toBe("below_threshold")
    expect(judged.score).toBeLessThan(30)
    expect(judged.reasons).not.toContain("CALENDAR_FLIP_TO_CHEAP")
  })

  it("records a calendar FLIP as a signal, cheap-without-flip as a real zero-ish", () => {
    const p = getStayProperty(db, "ai-resort")!
    const dates = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]
    recordCalendarObservations(db, p, "xotelo", "g1-d1",
      null, dates.map(date => ({ date, dayClass: "high" as const })))
    recordCalendarObservations(db, p, "xotelo", "g1-d1",
      null, dates.map(date => ({ date, dayClass: "cheap" as const })))
    const signal = gatherCalendarSignal(db, {
      propertyId: "ai-resort", ...STAY, fetchedAt: new Date().toISOString(),
    }, CONFIG.anomaly)
    expect(signal.covered).toBe(true)
    expect(signal.flippedToCheap).toBe(true)
  })

  it("meta anomaly with NO retail confirmation carries META_ONLY and lower evidence", () => {
    history("ai-resort", [950, 980, 1000, 940, 990, 960, 1010, 970])
    obs(db, "ai-resort", { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG })
    const c = listStayCandidates(db, { limit: 1 })[0]
    expect(c.confirmationState).toBe("meta_only")
    expect((c.scoreBreakdown.evidence as { raw: number }).raw).toBe(CONFIG.anomaly.evidenceValues.discovered)
  })

  it("retail confirmation raises meta evidence and records the spread as a FACT, never a blend", () => {
    history("ai-resort", [950, 980, 1000, 940, 990, 960, 1010, 970])
    obs(db, "ai-resort", { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    // Same window, retail tier, materially higher, AI board, tax-inclusive.
    obs(db, "ai-resort", {
      price: { amount: 1019, currency: "USD" }, fetchedAt: daysAgo(0),
      sourceClass: "retail", provider: "agoda", roomName: "Beach Villa", roomClass: "villa",
      board: "all_inclusive", boardSource: "structured", taxesFees: "included",
      verificationLevel: "confirmed",
    })
    evaluateStayObservations({ db, config: CONFIG })
    const meta = listStayCandidates(db, { limit: 10 }).find(c => c.sourceClass === "meta" && c.nightlyAmount === 620)!
    expect(meta.confirmationState).toBe("retail_confirmed")
    expect(meta.reasons).toContain("RETAIL_CONFIRMATION_ON_RECORD")
    expect(meta.reasons).toContain("AI_CONFIRMED_AT_RETAIL")
    expect(meta.reasons).toContain("RETAIL_SPREAD_HIGH")       // +64% > 30%
    expect((meta.scoreBreakdown.evidence as { raw: number }).raw)
      .toBe(CONFIG.anomaly.evidenceValues.metaWithRetailConfirmation)
    const cross = (meta.evidence.crossSource as Record<string, unknown>)
    expect(cross.retailMinNightly).toBe(1019)
    expect(Math.round(cross.retailSpreadPercent as number)).toBe(64)
    // The retail observation itself is judged in ITS OWN baseline world.
    const retail = listStayCandidates(db, { limit: 10 }).find(c => c.sourceClass === "retail")!
    expect(retail.sampleSize).toBe(0)                          // no retail history — never borrowed meta's
    expect(retail.reasons).toContain("CONFIRMED_BY_AGODA")
    expect(retail.reasons).toContain("TAX_INCLUDED")
  })

  it("wrong room/board at the same property+window does not fake an AI confirmation", () => {
    obs(db, "ai-resort", { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    obs(db, "ai-resort", {
      price: { amount: 900, currency: "USD" }, fetchedAt: daysAgo(0),
      sourceClass: "retail", provider: "agoda", roomName: "Garden Room", roomClass: "entry",
      board: "breakfast", boardSource: "structured", verificationLevel: "confirmed",
    })
    const evidence = gatherCrossSourceEvidence(db, {
      propertyId: "ai-resort", checkIn: STAY.checkIn, sourceClass: "meta",
      nightly: 620, currency: "USD", fetchedAt: new Date().toISOString(),
    }, CONFIG.anomaly)
    expect(evidence.confirmationState).toBe("retail_confirmed")
    expect(evidence.boardConfirmedAllInclusive).toBe(false)    // breakfast proves nothing about AI
  })

  it("regression: the 8b promo-text room name classifies as suite, not villa", () => {
    expect(classifyRoomText(
      "Beach Suite With Jacuzzi - Complimentary In-Villa Dining Breakfast (once per stay) for book dates, 10th FEB 2026 onwards",
    )).toBe("suite")
    expect(classifyRoomText("Lagoon Villa")).toBe("villa")
    expect(classifyRoomText("Overwater Bungalow")).toBe("villa")
  })

  it("duplicate evaluation upserts: same decisions, no duplicate rows, cursor honoured", () => {
    history("ai-resort", [950, 980, 1000, 940, 990])
    obs(db, "ai-resort", { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    const first = evaluateStayObservations({ db, config: CONFIG })
    expect(first.evaluated).toBe(6)
    const second = evaluateStayObservations({ db, config: CONFIG })
    expect(second.evaluated).toBe(0)                           // cursor: nothing new
    const backfill = evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    expect(backfill.evaluated).toBe(6)
    expect(stayCandidateTotals(db).decisions).toBe(6)          // upserted, not duplicated
  })

  it("opportunity identity is stable across re-evaluation and across sibling observations", () => {
    history("ai-resort", [950, 980, 1000, 940, 990])
    obs(db, "ai-resort", { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(1) })
    obs(db, "ai-resort", { price: { amount: 640, currency: "USD" }, fetchedAt: daysAgo(0), checkIn: "2026-11-11", checkOut: "2026-11-16" })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const rows = listStayCandidates(db, { limit: 10 }).filter(c => c.nightlyAmount === 620 || c.nightlyAmount === 640)
    // Same property, same 3-day date family, same product: ONE opportunity.
    expect(new Set(rows.map(r => r.opportunityKey)).size).toBe(1)
    const before = rows[0].opportunityKey
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    expect(listStayCandidates(db, { limit: 1 })[0].opportunityKey).toBe(before)
    // A different board is a DIFFERENT opportunity.
    const key = (board: string) => stayOpportunityKey({
      propertyId: "ai-resort", checkIn: STAY.checkIn, nights: 5,
      board, roomClass: null, sourceClass: "meta", currency: "USD",
    }, CONFIG.anomaly.baseline.nightsBuckets)
    expect(key("all_inclusive")).not.toBe(key("breakfast"))
  })
})

function shift(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
