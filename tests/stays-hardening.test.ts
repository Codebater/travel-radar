import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { readUsage } from "../db/repositories.js"
import { serpApiBudget } from "../cache/policy.js"
import {
  SerpApiHotelsProvider,
  SERPAPI_HOTELS_PROVIDER,
  serpApiAccountAllowance,
  staysEffectiveMonthlyBudget,
} from "../providers/stays/serpapi-hotels.js"
import type { NormalizedStayRate } from "../providers/stays/types.js"
import { buildStayBaseline } from "../stays/baseline.js"
import { assessCategoryValue } from "../stays/category.js"
import { loadStaysConfig, type StaysConfig } from "../stays/config.js"
import { evaluateStayObservations } from "../stays/engine.js"
import { listStayCandidates } from "../stays/candidates.js"
import { buildStayOpportunities } from "../stays/opportunities.js"
import { getStayProperty, seedStayProperties, type StayUniverseConfig } from "../stays/registry.js"
import { recordRateObservations, recordStaySearchRequest } from "../stays/store.js"
import { gatherTargetedSamples } from "../stays/targeting.js"
import { listStayWindows, rebuildStayWindows } from "../stays/windows.js"
import { makeStayRate } from "./stay-mocks.js"

const CONFIG: StaysConfig = loadStaysConfig(true)
const STAY = { checkIn: "2026-11-15", checkOut: "2026-11-20", nights: 5 }

function universe(): StayUniverseConfig {
  return {
    destinationGroups: { maldives: { label: "Maldives", airports: ["MLE"] } },
    properties: [
      {
        id: "lily-beach-resort", name: "Lily Beach Resort & Spa", destinationGroup: "maldives",
        country: "Maldives", nearestAirports: ["MLE"], luxuryTier: "luxury", allInclusive: "only",
        defaultBoard: "all_inclusive", typicalStayNights: [5, 7], priority: 1, active: true,
        refs: { xotelo: "g1-d1", agoda: "1:2:3" },
      },
      {
        id: "peer-ai-resort", name: "Peer AI Resort", destinationGroup: "maldives",
        country: "Maldives", nearestAirports: ["MLE"], luxuryTier: "luxury", allInclusive: "only",
        defaultBoard: "all_inclusive", typicalStayNights: [5], priority: 2, active: true,
        refs: { xotelo: "g1-d2" },
      },
      {
        id: "second-peer", name: "Second Peer", destinationGroup: "maldives",
        country: "Maldives", nearestAirports: ["MLE"], luxuryTier: "luxury", allInclusive: "only",
        defaultBoard: "all_inclusive", typicalStayNights: [5], priority: 3, active: true,
        refs: { xotelo: "g1-d3" },
      },
    ],
  }
}

function obs(db: DB, propertyId: string, over: Partial<NormalizedStayRate> = {}): number {
  const property = getStayProperty(db, propertyId)!
  const requestId = recordStaySearchRequest(db, {
    propertyId, kind: "rates",
    checkIn: over.checkIn ?? STAY.checkIn, checkOut: over.checkOut ?? STAY.checkOut,
    currency: "USD", source: "test",
  })
  recordRateObservations(db, property, requestId, [makeStayRate({
    propertyId, checkIn: STAY.checkIn, checkOut: STAY.checkOut, nights: STAY.nights,
    board: "unknown", ...over,
  })], CONFIG.sanity)
  return requestId
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

describe("tax-basis comparability — the Lily contamination regression", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  it("tax-included rows never enter a tax-unknown baseline (and vice versa)", () => {
    // The 8d incident, reproduced: xotelo history at ~950 tax-unknown…
    for (const [amount, age] of [[940, 40], [950, 30], [953, 20], [960, 10], [970, 5]] as const) {
      obs(db, "lily-beach-resort", { price: { amount, currency: "USD" }, fetchedAt: daysAgo(age), taxesFees: "unknown" })
    }
    // …then verified TAX-INCLUSIVE rows arrive around 1079.
    for (const age of [4, 3, 2]) {
      obs(db, "lily-beach-resort", {
        price: { amount: 1079, currency: "USD" }, fetchedAt: daysAgo(age),
        provider: SERPAPI_HOTELS_PROVIDER, verificationLevel: "verified",
        taxesFees: "included", taxesFeesAmount: 259,
      })
    }
    const base = {
      propertyId: "lily-beach-resort", sourceClass: "meta", roomClass: null,
      board: "all_inclusive", adults: 2, children: 0, currency: "USD",
      nights: 5, nightly: 681, asOf: daysAgo(0), searchRequestId: null,
    }
    const unknownBand = buildStayBaseline(db, { ...base, taxesFees: "unknown" }, CONFIG.anomaly)!
    expect(unknownBand.count).toBe(5)
    expect(unknownBand.median).toBe(953)        // NOT 1079-contaminated
    // The included band stands alone and is too thin to speak.
    expect(buildStayBaseline(db, { ...base, taxesFees: "included" }, CONFIG.anomaly)).toBeNull()
  })

  it("stores a before-tax nightly only when the provider genuinely stated the tax", () => {
    obs(db, "lily-beach-resort", {
      price: { amount: 1079, currency: "USD" }, taxesFees: "included", taxesFeesAmount: 259,
    })
    obs(db, "lily-beach-resort", {
      price: { amount: 937, currency: "USD" }, taxesFees: "included", taxesFeesAmount: null,
    })
    obs(db, "lily-beach-resort", { price: { amount: 700, currency: "USD" }, taxesFees: "unknown" })
    const rows = db.prepare(
      "SELECT price_amount, before_tax_nightly FROM stay_rate_observations ORDER BY id",
    ).all() as { price_amount: number; before_tax_nightly: number | null }[]
    expect(rows[0].before_tax_nightly).toBe(820)      // 1079 − 259, derived
    expect(rows[1].before_tax_nightly).toBeNull()     // tax stated included but amount unknown → never estimated
    expect(rows[2].before_tax_nightly).toBeNull()
  })
})

describe("category-relative absolute value", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  function seedPeers(): void {
    // Two peer properties price the category at 1000–1600.
    for (let i = 0; i < 12; i++) {
      obs(db, "peer-ai-resort", { price: { amount: 1000 + i * 50, currency: "USD" }, fetchedAt: daysAgo(40 - i * 2) })
      obs(db, "second-peer", { price: { amount: 1100 + i * 40, currency: "USD" }, fetchedAt: daysAgo(39 - i * 2) })
    }
  }

  it("credits a rate in the category's cheap tail, excluding the property's own rows", () => {
    seedPeers()
    const stats = assessCategoryValue(db, {
      propertyId: "lily-beach-resort", destinationGroup: "maldives", luxuryTier: "luxury",
      board: "all_inclusive", sourceClass: "meta", taxesFees: "unknown", currency: "USD",
      nightly: 700, asOf: daysAgo(0), searchRequestId: null,
    }, CONFIG.anomaly)!
    expect(stats.properties).toBe(2)
    expect(stats.percentile).toBe(0)
    expect(stats.credit).toBeGreaterThan(0.4)   // full tail credit × MEDIUM-ish maturity

    // The same nightly judged as ORDINARY inside the category earns zero.
    const mid = assessCategoryValue(db, {
      propertyId: "lily-beach-resort", destinationGroup: "maldives", luxuryTier: "luxury",
      board: "all_inclusive", sourceClass: "meta", taxesFees: "unknown", currency: "USD",
      nightly: 1300, asOf: daysAgo(0), searchRequestId: null,
    }, CONFIG.anomaly)!
    expect(mid.credit).toBe(0)
  })

  it("a category of one property is a mirror — no category, rules-only behaviour", () => {
    // Only the judged property has data: excluding its own rows leaves nothing.
    for (let i = 0; i < 25; i++) {
      obs(db, "lily-beach-resort", { price: { amount: 950, currency: "USD" }, fetchedAt: daysAgo(30 - i) })
    }
    expect(assessCategoryValue(db, {
      propertyId: "lily-beach-resort", destinationGroup: "maldives", luxuryTier: "luxury",
      board: "all_inclusive", sourceClass: "meta", taxesFees: "unknown", currency: "USD",
      nightly: 700, asOf: daysAgo(0), searchRequestId: null,
    }, CONFIG.anomaly)).toBeNull()
  })

  it("surfaces CATEGORY_CHEAP_TAIL through the engine: exceptional-for-category, normal-for-property", () => {
    seedPeers()
    // Lily's OWN history says 700 is normal; the category says it's the tail.
    for (const age of [40, 30, 20, 10, 5]) {
      obs(db, "lily-beach-resort", { price: { amount: 700, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    obs(db, "lily-beach-resort", { price: { amount: 695, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const c = listStayCandidates(db, { limit: 40 })
      .find(x => x.propertyId === "lily-beach-resort" && x.nightlyAmount === 695)!
    expect(c.relativeScore).toBeLessThan(20)          // not an anomaly for the property
    expect(c.absoluteValueScore).toBeGreaterThan(30)  // but objectively cheap for the category
    expect(c.reasons).toContain("CATEGORY_CHEAP_TAIL")
  })
})

describe("shared SerpAPI account ceiling", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    process.env.SERP_API_KEY = "test-key"
    delete process.env.STAYS_SERPAPI_MONTHLY_BUDGET
    delete process.env.SERPAPI_ACCOUNT_MONTHLY_ALLOWANCE
  })
  afterEach(() => {
    process.env.SERP_API_KEY = ""
    delete process.env.STAYS_SERPAPI_MONTHLY_BUDGET
    delete process.env.SERPAPI_ACCOUNT_MONTHLY_ALLOWANCE
  })

  it("defaults: free-tier allowance 100 − flight budget 90 caps stays at 10, not its configured 15", () => {
    expect(serpApiAccountAllowance()).toBe(100)       // never silently a paid tier
    expect(serpApiBudget().monthlyBudget).toBe(90)
    const effective = staysEffectiveMonthlyBudget()
    expect(effective.configured).toBe(15)
    expect(effective.accountHeadroom).toBe(10)
    expect(effective.ceiling).toBe(10)                // the flight budget + reserve are untouchable
  })

  it("the combined-usage guard refuses even when per-radar budgets were misconfigured", async () => {
    process.env.SERPAPI_ACCOUNT_MONTHLY_ALLOWANCE = "100"
    process.env.STAYS_SERPAPI_MONTHLY_BUDGET = "50"   // misconfigured high
    // The flight radar has already spent 98 this month.
    for (let i = 0; i < 98; i++) {
      db.prepare(`
        INSERT INTO provider_usage (provider, period, attempted, succeeded, failed)
        VALUES ('serpapi', strftime('%Y-%m', 'now'), 1, 1, 0)
        ON CONFLICT(provider, period) DO UPDATE SET attempted = attempted + 1
      `).run()
    }
    const stub = (async () => new Response("{}", { status: 200 })) as typeof fetch
    const provider = new SerpApiHotelsProvider({ fetchImpl: stub, db })
    // Stays has spent 2; combined = 100 = allowance → refuse.
    db.prepare(`
      INSERT INTO provider_usage (provider, period, attempted, succeeded, failed)
      VALUES ('serpapi_hotels', strftime('%Y-%m', 'now'), 2, 2, 0)
    `).run()
    const result = await provider.searchRates({
      propertyId: "x", providerRef: "q:Some Hotel", checkIn: "2026-11-15", checkOut: "2026-11-20",
      adults: 2, children: 0, currency: "USD",
    })
    expect(result.reason).toBe("budget-exhausted")
    expect(result.error).toContain("account allowance")
    expect(result.callsSpent).toBe(0)
    // The flight radar's row was read, never written.
    expect(readUsage(db, "serpapi").attempted).toBe(98)
  })
})

describe("window probing and the opportunity object", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  it("plans window-probe samples around a promising short window", () => {
    for (const age of [40, 30, 20, 10, 5, 4, 3, 2]) {
      obs(db, "lily-beach-resort", { price: { amount: 950 + age, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    for (const [checkIn, amount] of [["2026-11-15", 640], ["2026-11-17", 655]] as const) {
      obs(db, "lily-beach-resort", {
        price: { amount, currency: "USD" }, checkIn,
        checkOut: new Date(Date.parse(checkIn) + 5 * 86_400_000).toISOString().slice(0, 10),
        fetchedAt: daysAgo(0),
      })
    }
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })

    const p = getStayProperty(db, "lily-beach-resort")!
    const samples = gatherTargetedSamples(db, [p], CONFIG, new Date())
    const probes = samples.filter(s => s.kind === "window-probe")
    expect(probes.length).toBeGreaterThan(0)
    // Probes aim at the window's edges, not its middle.
    expect(probes.some(s => s.checkIn === "2026-11-14" || s.checkIn === "2026-11-18" || s.checkIn === "2026-11-20")).toBe(true)
  })

  it("builds a trip-ready opportunity: flex window, separated source prices, cancellation, scores", () => {
    for (const age of [40, 30, 20, 10, 5, 4, 3, 2]) {
      obs(db, "lily-beach-resort", { price: { amount: 950, currency: "USD" }, fetchedAt: daysAgo(age) })
    }
    for (const [checkIn, amount] of [["2026-11-15", 640], ["2026-11-17", 630], ["2026-11-20", 650]] as const) {
      obs(db, "lily-beach-resort", {
        price: { amount, currency: "USD" }, checkIn,
        checkOut: new Date(Date.parse(checkIn) + 5 * 86_400_000).toISOString().slice(0, 10),
        fetchedAt: daysAgo(0),
      })
    }
    // A retail confirmation with cancellation evidence, and a verified row —
    // different tax statuses, which must stay SEPARATE source prices.
    obs(db, "lily-beach-resort", {
      price: { amount: 890, currency: "USD" }, checkIn: "2026-11-17",
      checkOut: "2026-11-22",
      sourceClass: "retail", provider: "agoda", roomName: "Beach Villa", roomClass: "villa",
      board: "all_inclusive", boardSource: "structured", taxesFees: "included", taxesFeesAmount: 120,
      refundable: true, cancellationDeadline: "2026-10-27", verificationLevel: "confirmed",
      fetchedAt: daysAgo(0),
    })
    obs(db, "lily-beach-resort", {
      price: { amount: 833, currency: "USD" }, checkIn: "2026-11-19", checkOut: "2026-11-24",
      provider: SERPAPI_HOTELS_PROVIDER, verificationLevel: "verified", sourceClass: "meta",
      taxesFees: "included", taxesFeesAmount: 141, fetchedAt: daysAgo(0),
    })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })

    const opportunities = buildStayOpportunities(db, { minScore: 20 })
    expect(opportunities.length).toBeGreaterThan(0)
    const best = opportunities[0]
    expect(best.property.nearestAirports).toEqual(["MLE"])
    expect(best.flexWindow.distinctCheckIns).toBeGreaterThanOrEqual(3)
    expect(best.flexWindow.persistence).toBe("sustained")
    expect(best.pricing.cheapestNightlyInWindow).toBe(630)

    // Source prices: one per (provider, source class, tax status), separate.
    const keys = best.sourcePrices.map(s => `${s.provider}|${s.sourceClass}|${s.taxStatus}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(best.sourcePrices.some(s => s.provider === "mock-stays" && s.taxStatus === "unknown")).toBe(true)
    expect(best.sourcePrices.some(s => s.provider === SERPAPI_HOTELS_PROVIDER && s.taxStatus === "included")).toBe(true)
    const verified = best.sourcePrices.find(s => s.provider === SERPAPI_HOTELS_PROVIDER)!
    expect(verified.beforeTaxNightly).toBe(692)       // 833 − 141, provider-stated

    expect(best.evidence.cancellation).toMatchObject({ refundable: true, deadline: "2026-10-27" })
    expect(best.scores.final).toBeGreaterThan(0)
    expect(best.scores.relative).not.toBeNull()

    // The windows table now carries cheapest + persistence evidence.
    rebuildStayWindows(db)
    const w = listStayWindows(db)[0]
    expect(w.cheapestNightly).not.toBeNull()
    expect((w.evidence.checkIns as string[]).length).toBeGreaterThanOrEqual(2)
  })
})
