import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { readUsage } from "../db/repositories.js"
import { serpApiBudget } from "../cache/policy.js"
import {
  SerpApiHotelsProvider,
  SERPAPI_HOTELS_PROVIDER,
  parseGoogleHotels,
  staysSerpApiMonthlyBudget,
} from "../providers/stays/serpapi-hotels.js"
import type { StayRateQuery } from "../providers/stays/types.js"
import { loadStaysConfig, type StaysConfig } from "../stays/config.js"
import { evaluateStayObservations } from "../stays/engine.js"
import { listStayCandidates } from "../stays/candidates.js"
import { gatherCrossSourceEvidence } from "../stays/evidence.js"
import { getStayProperty, seedStayProperties, type StayUniverseConfig } from "../stays/registry.js"
import { recordCalendarObservations, recordRateObservations, recordStaySearchRequest } from "../stays/store.js"
import { gatherTargetedSamples, consecutiveRuns } from "../stays/targeting.js"
import {
  listVerifications,
  runVerificationPass,
  selectVerificationTargets,
} from "../stays/verification.js"
import { assessActionability, listStayWindows, rebuildStayWindows } from "../stays/windows.js"
import { MockStayProvider, makeStayRate } from "./stay-mocks.js"
import type { NormalizedStayRate } from "../providers/stays/types.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, "fixtures", "stays")
const CONFIG: StaysConfig = loadStaysConfig(true)

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8")) as Record<string, unknown>
}

function stubFetch(body: unknown, opts: { status?: number; text?: string } = {}) {
  const calls: string[] = []
  const impl = (async (url: string | URL) => {
    calls.push(String(url))
    return new Response(opts.text ?? JSON.stringify(body), { status: opts.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

function universe(): StayUniverseConfig {
  return {
    destinationGroups: { maldives: { label: "Maldives", airports: ["MLE"] } },
    properties: [{
      id: "lily-beach-resort", name: "Lily Beach Resort & Spa", destinationGroup: "maldives",
      country: "Maldives", nearestAirports: ["MLE"], luxuryTier: "luxury", allInclusive: "only",
      defaultBoard: "all_inclusive", typicalStayNights: [5, 7], priority: 1, active: true,
      refs: { xotelo: "g1-d1", agoda: "1:2:3" },
    }],
  }
}

const STAY = { checkIn: "2026-11-15", checkOut: "2026-11-20", nights: 5 }

function obs(db: DB, over: Partial<NormalizedStayRate> = {}): number {
  const property = getStayProperty(db, "lily-beach-resort")!
  const requestId = recordStaySearchRequest(db, {
    propertyId: property.id, kind: "rates",
    checkIn: over.checkIn ?? STAY.checkIn, checkOut: over.checkOut ?? STAY.checkOut,
    currency: "USD", source: "test",
  })
  recordRateObservations(db, property, requestId, [makeStayRate({
    propertyId: property.id, checkIn: STAY.checkIn, checkOut: STAY.checkOut, nights: STAY.nights,
    board: "unknown", ...over,
  })], CONFIG.sanity)
  return requestId
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

const QUERY: StayRateQuery = {
  propertyId: "lily-beach-resort",
  providerRef: "q:Lily Beach Resort & Spa",
  checkIn: "2026-11-15", checkOut: "2026-11-20",
  adults: 2, children: 0, currency: "USD",
}

describe("serpapi hotels provider", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    process.env.SERP_API_KEY = "test-key"
    delete process.env.STAYS_SERPAPI_MONTHLY_BUDGET
  })
  afterEach(() => {
    process.env.SERP_API_KEY = ""
    delete process.env.STAYS_SERPAPI_MONTHLY_BUDGET
  })

  it("matches the right property and captures totals, before-tax figures and per-OTA offers", () => {
    const parsed = parseGoogleHotels(fixture("serpapi-hotels-ok.json"), QUERY, "Lily Beach Resort & Spa", 5, SERPAPI_HOTELS_PROVIDER)
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.matchedName).toContain("Lily Beach")
    // One stay-total row + three priced OTA rows (ghost/unpriced dropped).
    expect(parsed.rates).toHaveLength(4)

    const total = parsed.rates.find(r => r.priceBasis === "stay_total")!
    expect(total.price.amount).toBe(5440)
    expect(total.taxesFees).toBe("included")               // before-taxes 4720 < 5440
    expect(total.taxesFeesAmount).toBe(720)

    const official = parsed.rates.find(r => r.rateSource === "Official site")!
    expect(official.price.amount).toBe(1088)
    expect(official.taxesFees).toBe("included")
    expect(official.taxesFeesAmount).toBe(144)
    expect(official.verificationLevel).toBe("verified")
    expect(official.sourceClass).toBe("meta")
    expect(official.board).toBe("unknown")                 // Google states no board — never invented

    const booking = parsed.rates.find(r => r.rateSource === "Booking.com")!
    expect(booking.taxesFees).toBe("unknown")              // no before-taxes figure = unknown, not included
    expect(booking.taxesFeesAmount).toBeNull()
  })

  it("parses the DIRECT property response shape (specific-hotel q) — live-discovered regression", () => {
    // q naming one hotel returns the property at the TOP LEVEL, not in
    // properties[]. The first two live verifications failed on this.
    const direct = {
      search_metadata: { status: "Success" },
      search_parameters: { engine: "google_hotels", q: "Soneva Fushi", check_in_date: "2026-11-15", check_out_date: "2026-11-20", adults: 2, currency: "USD" },
      type: "hotel",
      name: "The Soneva Fushi",
      property_token: "tok_soneva",
      rate_per_night: { lowest: "$3,095", extracted_lowest: 3095, before_taxes_fees: "$2,386", extracted_before_taxes_fees: 2386 },
      total_rate: { lowest: "$15,474", extracted_lowest: 15474, before_taxes_fees: "$11,930", extracted_before_taxes_fees: 11930 },
      prices: [
        { source: "Booking.com", rate_per_night: { lowest: "$3,095", extracted_lowest: 3095 } },
        { source: "Official site", rate_per_night: { lowest: "$3,148", extracted_lowest: 3148, before_taxes_fees: "$2,427", extracted_before_taxes_fees: 2427 } },
      ],
    }
    const query = { ...QUERY, propertyId: "soneva-fushi", providerRef: "q:Soneva Fushi" }
    const parsed = parseGoogleHotels(direct, query, "Soneva Fushi", 5, SERPAPI_HOTELS_PROVIDER)
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.matchedName).toBe("The Soneva Fushi")
    const total = parsed.rates.find(r => r.priceBasis === "stay_total")!
    expect(total.price.amount).toBe(15474)
    expect(total.taxesFees).toBe("included")
    expect(total.taxesFeesAmount).toBe(3544)
    expect(parsed.rates.filter(r => r.priceBasis === "nightly_room")).toHaveLength(2)

    // A direct response for the WRONG hotel is rejected outright.
    const wrong = { ...direct, name: "Sun Siyam Vilu Reef" }
    const rejected = parseGoogleHotels(wrong, query, "Soneva Fushi", 5, "x")
    expect("error" in rejected && rejected.error).toContain("Sun Siyam")
  })

  it("refuses wrong property (no confident match), wrong dates and wrong currency", () => {
    const noMatch = parseGoogleHotels(fixture("serpapi-hotels-ok.json"), QUERY, "Soneva Fushi", 5, "x")
    expect("error" in noMatch && noMatch.reason).toBe("no-results")

    const badDates = fixture("serpapi-hotels-ok.json")
    ;(badDates.search_parameters as Record<string, unknown>).check_in_date = "2026-09-18"
    expect("error" in parseGoogleHotels(badDates, QUERY, "Lily Beach Resort & Spa", 5, "x") &&
      (parseGoogleHotels(badDates, QUERY, "Lily Beach Resort & Spa", 5, "x") as { error: string }).error).toContain("date mismatch")

    const badCurrency = fixture("serpapi-hotels-ok.json")
    ;(badCurrency.search_parameters as Record<string, unknown>).currency = "EUR"
    const c = parseGoogleHotels(badCurrency, QUERY, "Lily Beach Resort & Spa", 5, "x")
    expect("error" in c && c.error).toContain("currency mismatch")
  })

  it("enforces its OWN monthly budget, reserve-before-await, without touching the flight budget", async () => {
    process.env.STAYS_SERPAPI_MONTHLY_BUDGET = "2"
    const { impl } = stubFetch(fixture("serpapi-hotels-ok.json"))
    const provider = new SerpApiHotelsProvider({ fetchImpl: impl, db })

    expect((await provider.searchRates(QUERY)).ok).toBe(true)
    expect((await provider.searchRates(QUERY)).ok).toBe(true)
    const third = await provider.searchRates(QUERY)
    expect(third.ok).toBe(false)
    expect(third.reason).toBe("budget-exhausted")
    expect(third.callsSpent).toBe(0)

    // The stay tier counts under its OWN provider row; the flight radar's
    // 'serpapi' usage row and its configured reserve are untouched.
    expect(readUsage(db, SERPAPI_HOTELS_PROVIDER).attempted).toBe(2)
    expect(readUsage(db, "serpapi").attempted).toBe(0)
    expect(serpApiBudget().reserveCalls).toBeGreaterThan(0)   // flight reserve config intact
    expect(staysSerpApiMonthlyBudget()).toBe(2)
  })

  it("budget race: concurrent calls cannot overshoot the monthly ceiling", async () => {
    process.env.STAYS_SERPAPI_MONTHLY_BUDGET = "3"
    const { impl } = stubFetch(fixture("serpapi-hotels-ok.json"))
    const provider = new SerpApiHotelsProvider({ fetchImpl: impl, db })
    const results = await Promise.all(Array.from({ length: 8 }, () => provider.searchRates(QUERY)))
    const spent = results.filter(r => r.callsSpent > 0).length
    expect(spent).toBeLessThanOrEqual(3)
    expect(readUsage(db, SERPAPI_HOTELS_PROVIDER).attempted).toBeLessThanOrEqual(3)
  })

  it("is unconfigured without the key and never throws on outage/garbage", async () => {
    process.env.SERP_API_KEY = ""
    const provider = new SerpApiHotelsProvider({ fetchImpl: stubFetch({}).impl, db })
    expect((await provider.searchRates(QUERY)).reason).toBe("unconfigured")

    process.env.SERP_API_KEY = "test-key"
    const down = new SerpApiHotelsProvider({ fetchImpl: stubFetch(null, { status: 503, text: "down" }).impl, db })
    expect((await down.searchRates(QUERY)).reason).toBe("provider-error")
    const garbage = new SerpApiHotelsProvider({ fetchImpl: stubFetch(null, { text: "<html>" }).impl, db })
    expect((await garbage.searchRates(QUERY)).error).toContain("not JSON")
  })
})

describe("four-concept scoring paths", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  function history(amounts: number[], startAge = 60): void {
    amounts.forEach((amount, i) => {
      obs(db, { price: { amount, currency: "USD" }, fetchedAt: daysAgo(startAge - i * 3) })
    })
  }

  it("cheap ABSOLUTE VALUE with no anomaly: absolute concept strong, relative near zero", () => {
    // Lily's bars (maldives AI luxury): interesting 650 / extreme 550 / wtf 420.
    // A property that ALWAYS costs 500: strong absolute, no anomaly at all.
    history([500, 505, 495, 500, 510, 498, 502, 500])
    obs(db, { price: { amount: 493, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG })
    const c = listStayCandidates(db, { limit: 20 }).find(x => x.nightlyAmount === 493)!
    expect(c.absoluteValueScore).toBeGreaterThan(60)      // (650-493)/230 ≈ 68
    expect(c.relativeScore).toBeLessThan(25)              // barely-below-median + maturity-scaled 0th pct
    expect(c.reasons).toContain("ALL_INCLUSIVE_UNDER_ABSOLUTE_BAR")
    // Interesting — but a permanently-cheap property is not a mispricing.
    expect(c.score).toBeLessThan(CONFIG.anomaly.candidateThreshold)
  })

  it("huge ANOMALY that is still objectively expensive: relative strong, absolute a KEPT zero", () => {
    history([3000, 3100, 2950, 3050, 3000, 3080, 2990, 3020])
    obs(db, { price: { amount: 1900, currency: "USD" }, fetchedAt: daysAgo(0) })   // 37% below, still >> 650
    evaluateStayObservations({ db, config: CONFIG })
    const c = listStayCandidates(db, { limit: 1 })[0]
    expect(c.relativeScore).toBeGreaterThan(70)
    expect(c.absoluteValueScore).toBe(0)                  // rule RAN, said ordinary — a real zero
    const abs = c.scoreBreakdown.absoluteValue as { raw: number; weight: number }
    expect(abs.raw).toBe(0)
    expect(abs.weight).toBeGreaterThan(0)                 // the zero keeps its weight
    expect(c.score).toBeLessThan(CONFIG.anomaly.candidateThreshold)
  })

  it("strong anomaly AND strong absolute value compound toward extreme strength", () => {
    history([1200, 1180, 1220, 1190, 1210, 1200, 1195, 1205])
    obs(db, { price: { amount: 430, currency: "USD" }, fetchedAt: daysAgo(0) })    // 64% below AND near-wtf
    evaluateStayObservations({ db, config: CONFIG })
    const c = listStayCandidates(db, { limit: 1 })[0]
    expect(c.relativeScore).toBeGreaterThan(80)
    expect(c.absoluteValueScore).toBeGreaterThan(90)
    // Both paths agree: this is the shape that should tower over either alone.
    expect(c.score).toBeGreaterThan(55)
    const targets = selectVerificationTargets(db, CONFIG)
    expect(targets[0]?.gateReason).toBe("ANOMALY_AND_ABSOLUTE_VALUE")
  })

  it("percentile maturity: a tiny baseline's lowest-ever earns scaled credit only", () => {
    // 5 samples → VERY_LOW (value 0.3): percentile credit must be scaled.
    history([950, 960, 970, 980, 990].slice(0, 5))
    obs(db, { price: { amount: 940, currency: "USD" }, fetchedAt: daysAgo(0) })    // lowest ever, barely below median
    evaluateStayObservations({ db, config: CONFIG })
    const c = listStayCandidates(db, { limit: 1 })[0]
    const rel = c.scoreBreakdown.relative as { raw: number; detail: string }
    expect(c.reasons).toContain("NEW_OBSERVED_LOW")
    // pctBelow ≈ 3% → ~0.06 credit; percentile 0th → 1.0 × 0.3 maturity = 0.3.
    // relative = 0.7×0.086 + 0.3×0.3 = 0.15 — NOT the 0.36 an unscaled
    // percentile would produce. Assert the ceiling.
    expect(rel.raw).toBeLessThan(0.2)
    expect(rel.detail).toContain("maturity 0.3")
  })

  it("isolated glitch vs sustained window: same price, different actionability", () => {
    const p = getStayProperty(db, "lily-beach-resort")!
    history([950, 960, 970, 980, 990, 955, 965, 975])
    // Isolated: one cheap check-in only.
    obs(db, { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG })
    const isolated = listStayCandidates(db, { limit: 1 })[0]
    expect(isolated.actionabilityScore).toBe(20)
    expect(isolated.reasons).toContain("ISOLATED_CHEAP_DATE")

    // Sustained: comparable cheap prices on neighbouring check-ins.
    for (const [offset, amount] of [[-3, 640], [-1, 615], [2, 635], [4, 625]] as const) {
      const checkIn = new Date(Date.parse(`${STAY.checkIn}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
      const checkOut = new Date(Date.parse(checkIn) + 5 * 86_400_000).toISOString().slice(0, 10)
      obs(db, { price: { amount, currency: "USD" }, checkIn, checkOut, fetchedAt: daysAgo(0) })
    }
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const sustained = listStayCandidates(db, { limit: 10 }).find(c => c.nightlyAmount === 620)!
    expect(sustained.actionabilityScore).toBe(100)
    expect(sustained.reasons).toContain("SUSTAINED_CHEAP_WINDOW")
    expect(sustained.score).toBeGreaterThan(isolated.score)

    // And the windows table groups them into ONE opportunity family.
    rebuildStayWindows(db)
    const windows = listStayWindows(db)
    const family = windows.find(w => w.propertyId === "lily-beach-resort" && w.distinctCheckIns >= 4)!
    expect(family.persistence).toBe("sustained")
    expect(family.memberCount).toBeGreaterThanOrEqual(5)
    void p
  })

  it("persistence never rescues an ordinary price", () => {
    const p = getStayProperty(db, "lily-beach-resort")!
    history([950, 960, 970, 980, 990, 955, 965, 975])
    // A week of ORDINARY prices on neighbouring check-ins + a sustained-cheap calendar.
    const days = Array.from({ length: 9 }, (_, i) =>
      ({ date: new Date(Date.parse(`${STAY.checkIn}T00:00:00Z`) + (i - 2) * 86_400_000).toISOString().slice(0, 10), dayClass: "cheap" as const }))
    recordCalendarObservations(db, p, "xotelo", "g1-d1", null, days)
    for (const offset of [-2, 0, 2, 4]) {
      const checkIn = new Date(Date.parse(`${STAY.checkIn}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
      obs(db, { price: { amount: 965, currency: "USD" }, checkIn, fetchedAt: daysAgo(0) })
    }
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const judged = listStayCandidates(db, { limit: 10 }).filter(c => c.nightlyAmount === 965)
    for (const c of judged) {
      expect(c.actionabilityScore).toBe(0)      // gated: ran, found nothing actionable about ordinary
      const act = c.scoreBreakdown.actionability as { raw: number; weight: number; detail: string }
      expect(act.weight).toBeGreaterThan(0)     // a REAL zero, not a dropped component
      expect(act.detail).toContain("ordinary")
    }
  })

  it("verified corroboration raises meta evidence; a verified-higher price records the spread", () => {
    history([950, 960, 970, 980, 990, 955, 965, 975])
    obs(db, { price: { amount: 620, currency: "USD" }, fetchedAt: daysAgo(0) })
    // The paid tier answers: cheapest verified nightly 640 — corroborates 620.
    obs(db, {
      price: { amount: 640, currency: "USD" }, fetchedAt: daysAgo(0),
      provider: SERPAPI_HOTELS_PROVIDER, verificationLevel: "verified",
      rateSource: "Official site", sourceClass: "meta", taxesFees: "included",
    })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const meta = listStayCandidates(db, { limit: 10 })
      .find(c => c.nightlyAmount === 620 && c.verificationLevel === "discovered")!
    expect(meta.reasons).toContain("VERIFIED_CORROBORATES")
    expect((meta.scoreBreakdown.evidence as { raw: number }).raw)
      .toBe(CONFIG.anomaly.evidenceValues.metaWithVerified)

    // A verified price far ABOVE the meta quote instead records the caution.
    const evidence = gatherCrossSourceEvidence(db, {
      propertyId: "lily-beach-resort", checkIn: STAY.checkIn, sourceClass: "meta",
      nightly: 450, currency: "USD", fetchedAt: new Date().toISOString(),
    }, CONFIG.anomaly)
    expect(evidence.verifiedExists).toBe(true)
    expect(evidence.verifiedSpreadHigh).toBe(true)         // 640 vs 450 = +42%
    expect(evidence.verifiedCorroborates).toBe(false)
  })
})

describe("the verification gate", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  function strongCandidate(): void {
    const priors = [1200, 1180, 1220, 1190, 1210, 1200, 1195, 1205]
    priors.forEach((amount, i) => {
      obs(db, { price: { amount, currency: "USD" }, fetchedAt: daysAgo(60 - i * 3) })
    })
    obs(db, { price: { amount: 430, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
  }

  it("ordinary rates never qualify — no reason, no spend", () => {
    const priors = [950, 960, 970, 980, 990, 955, 965, 975]
    priors.forEach((amount, i) => {
      obs(db, { price: { amount, currency: "USD" }, fetchedAt: daysAgo(60 - i * 3) })
    })
    obs(db, { price: { amount: 940, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG })
    expect(selectVerificationTargets(db, CONFIG)).toHaveLength(0)
  })

  it("a qualified target names its gate reason and spends exactly one call through the mock", async () => {
    strongCandidate()
    const targets = selectVerificationTargets(db, CONFIG)
    expect(targets.length).toBeGreaterThanOrEqual(1)
    expect(targets[0].gateReason).toBe("ANOMALY_AND_ABSOLUTE_VALUE")

    const provider = new MockStayProvider({
      name: SERPAPI_HOTELS_PROVIDER,
      rates: [makeStayRate({
        propertyId: "lily-beach-resort", provider: SERPAPI_HOTELS_PROVIDER,
        verificationLevel: "verified", sourceClass: "meta",
        price: { amount: 455, currency: "USD" }, taxesFees: "included",
      })],
    })
    const pass = await runVerificationPass({ db, config: CONFIG, provider, sleep: async () => {} })
    expect(pass.spent).toBe(1)
    expect(pass.confirmed).toBe(1)
    const decisions = listVerifications(db)
    expect(decisions[0].status).toBe("spent")
    expect(decisions[0].gateReason).toBe("ANOMALY_AND_ABSOLUTE_VALUE")
    expect(decisions[0].gateDetail).toContain("relative")
    // The verified observation entered history and the candidate now knows.
    const verified = listStayCandidates(db, { limit: 10 }).find(c => c.verificationLevel === "verified")
    expect(verified).toBeDefined()
  })

  it("cooldown: the same opportunity is not re-bought within the window", async () => {
    strongCandidate()
    const provider = new MockStayProvider({
      name: SERPAPI_HOTELS_PROVIDER,
      rates: [makeStayRate({ propertyId: "lily-beach-resort", provider: SERPAPI_HOTELS_PROVIDER, verificationLevel: "verified", sourceClass: "meta", price: { amount: 455, currency: "USD" } })],
    })
    const first = await runVerificationPass({ db, config: CONFIG, provider, sleep: async () => {} })
    expect(first.spent).toBe(1)
    // Re-observe the same cheap week; re-evaluate; the gate must not re-spend.
    obs(db, { price: { amount: 428, currency: "USD" }, fetchedAt: daysAgo(0) })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const second = await runVerificationPass({ db, config: CONFIG, provider, sleep: async () => {} })
    expect(second.spent).toBe(0)
  })

  it("degrades gracefully when the provider is unavailable — considered, spent nothing", async () => {
    strongCandidate()
    const pass = await runVerificationPass({ db, config: CONFIG, provider: null, sleep: async () => {} })
    expect(pass.spent).toBe(0)
    expect(pass.details.join()).toContain("unavailable")
  })

  it("incompatible room/board stays isolated: a verified meta row never joins the retail baseline", () => {
    // Retail AI villa history…
    for (let i = 0; i < 5; i++) {
      obs(db, {
        price: { amount: 1000 + i, currency: "USD" }, fetchedAt: daysAgo(30 - i * 3),
        sourceClass: "retail", provider: "agoda", roomName: "Beach Villa", roomClass: "villa",
        board: "all_inclusive", boardSource: "structured", verificationLevel: "confirmed",
      })
    }
    // …then a verified META property-level row: different source_class, so the
    // retail baseline must remain invisible to it.
    obs(db, {
      price: { amount: 600, currency: "USD" }, fetchedAt: daysAgo(0),
      provider: SERPAPI_HOTELS_PROVIDER, verificationLevel: "verified", sourceClass: "meta",
    })
    evaluateStayObservations({ db, config: CONFIG, fromScratch: true })
    const verifiedMeta = listStayCandidates(db, { limit: 10 })
      .find(c => c.verificationLevel === "verified")!
    expect(verifiedMeta.sampleSize).toBe(0)     // no meta history — never borrowed retail's
  })
})

describe("targeted sampling", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, universe())
  })

  it("aims samples at calendar cheap runs and at neighbours of a low observation", () => {
    const p = getStayProperty(db, "lily-beach-resort")!
    const start = Date.now() + 40 * 86_400_000
    const cheapDays = Array.from({ length: 5 }, (_, i) =>
      ({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), dayClass: "cheap" as const }))
    recordCalendarObservations(db, p, "xotelo", "g1-d1", null, cheapDays)

    for (let i = 0; i < 6; i++) {
      obs(db, { price: { amount: 950, currency: "USD" }, fetchedAt: daysAgo(30 - i * 4) })
    }
    obs(db, { price: { amount: 700, currency: "USD" }, fetchedAt: daysAgo(1) })   // 26% below

    const samples = gatherTargetedSamples(db, [p], CONFIG, new Date())
    expect(samples.some(s => s.kind === "cheap-window")).toBe(true)
    expect(samples.some(s => s.kind === "neighbor")).toBe(true)
    // The cooldown keeps it from re-asking the exact date just sampled.
    expect(samples.some(s => s.checkIn === STAY.checkIn)).toBe(false)
  })

  it("consecutiveRuns finds the longest cheap runs", () => {
    expect(consecutiveRuns(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-20", "2026-11-21"]))
      .toEqual([["2026-11-10", "2026-11-11", "2026-11-12"], ["2026-11-20", "2026-11-21"]])
  })

  it("actionability calendar attestation needs a sustained run, not one cheap day", () => {
    const p = getStayProperty(db, "lily-beach-resort")!
    recordCalendarObservations(db, p, "xotelo", "g1-d1", null, [{ date: STAY.checkIn, dayClass: "cheap" }])
    const result = assessActionability(db, {
      propertyId: p.id, ...STAY, sourceClass: "meta", board: "all_inclusive",
      currency: "USD", taxesFees: "unknown", nightly: 700, fetchedAt: new Date().toISOString(),
    }, true, CONFIG.anomaly)
    expect(result.calendarSustained).toBe(false)
    expect(result.persistence).toBe("isolated")
  })
})
