import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  listStayProperties,
  getStayProperty,
  loadStayUniverse,
  seedStayProperties,
  validateUniverse,
  type StayUniverseConfig,
} from "../stays/registry.js"
import {
  rateHistory,
  recordCalendarObservations,
  recordRateObservations,
  recordStaySearchRequest,
  stayObservationCounts,
} from "../stays/store.js"
import type { StaySanityConfig } from "../stays/normalize.js"
import { makeStayRate } from "./stay-mocks.js"

const SANITY: StaySanityConfig = {
  nightly: { USD: { min: 10, max: 50000 }, default: { min: 10, max: 50000 } },
  maxNights: 30,
}

function smallUniverse(): StayUniverseConfig {
  return {
    destinationGroups: {
      maldives: { label: "Maldives", airports: ["MLE"] },
      "riviera-maya": { label: "Riviera Maya", airports: ["CUN"] },
    },
    properties: [
      {
        id: "soneva-fushi", name: "Soneva Fushi", destinationGroup: "maldives",
        country: "Maldives", region: "Baa Atoll", nearestAirports: ["MLE"],
        luxuryTier: "ultra", allInclusive: "available", defaultBoard: "unknown",
        typicalStayNights: [5, 7], priority: 1, active: true,
        refs: { xotelo: "g3252668-d301967" },
      },
      {
        id: "grand-velas-riviera-maya", name: "Grand Velas Riviera Maya", destinationGroup: "riviera-maya",
        country: "Mexico", nearestAirports: ["CUN"],
        luxuryTier: "luxury", allInclusive: "only", defaultBoard: "all_inclusive",
        typicalStayNights: [5, 7], priority: 1, active: true,
        refs: { xotelo: "g150812-d1204526" },
      },
      {
        id: "quiet-hotel", name: "Quiet Hotel", destinationGroup: "maldives",
        country: "Maldives", nearestAirports: ["MLE"],
        luxuryTier: "upper", allInclusive: "none", defaultBoard: "unknown",
        typicalStayNights: [3], priority: 5, active: false,
        refs: {},
      },
    ],
  }
}

describe("stay universe config validation", () => {
  it("accepts the small test universe", () => {
    expect(validateUniverse(smallUniverse())).toEqual([])
  })

  it("collects every problem instead of stopping at the first", () => {
    const bad = smallUniverse()
    bad.properties[0].destinationGroup = "atlantis"
    bad.properties[1].nearestAirports = ["Cancun"]
    bad.properties.push({ ...bad.properties[2] })                 // duplicate id
    const problems = validateUniverse(bad)
    expect(problems.some(p => p.includes("atlantis"))).toBe(true)
    expect(problems.some(p => p.includes("IATA"))).toBe(true)
    expect(problems.some(p => p.includes("duplicate"))).toBe(true)
  })

  it("rejects bad tiers, boards and priorities", () => {
    const bad = smallUniverse()
    ;(bad.properties[0] as any).luxuryTier = "budget"
    ;(bad.properties[1] as any).defaultBoard = "brunch"
    ;(bad.properties[2] as any).priority = 0
    const problems = validateUniverse(bad)
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })

  it("the REAL shipped config is valid, has ~50 properties, and every one has a xotelo ref or is deliberately refless", () => {
    const real = loadStayUniverse(true)
    expect(validateUniverse(real)).toEqual([])
    expect(real.properties.length).toBeGreaterThanOrEqual(45)
    const active = real.properties.filter(p => p.active)
    expect(active.length).toBeGreaterThanOrEqual(8)
    // Phase 8a shipped with full Xotelo resolution; a missing ref here means
    // a property was added without resolving it — allowed, but every ACTIVE
    // property must be observable by at least one provider.
    for (const p of active) {
      expect(Object.keys(p.refs).length, `${p.id} is active but unobservable`).toBeGreaterThan(0)
    }
  })
})

describe("seeding the Luxury Universe", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  it("inserts, then updates idempotently without duplicating", () => {
    const first = seedStayProperties(db, smallUniverse())
    expect(first.inserted).toBe(3)
    expect(first.refsWritten).toBe(2)
    const second = seedStayProperties(db, smallUniverse())
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(3)
    expect(listStayProperties(db)).toHaveLength(3)
  })

  it("separates the Active Observation Set from the universe", () => {
    seedStayProperties(db, smallUniverse())
    expect(listStayProperties(db)).toHaveLength(3)
    expect(listStayProperties(db, { activeOnly: true }).map(p => p.id).sort())
      .toEqual(["grand-velas-riviera-maya", "soneva-fushi"])
  })

  it("deactivates — but never deletes — properties removed from the config", () => {
    seedStayProperties(db, smallUniverse())
    const shrunk = smallUniverse()
    shrunk.properties = shrunk.properties.filter(p => p.id !== "soneva-fushi")
    const summary = seedStayProperties(db, shrunk)
    expect(summary.orphaned).toEqual(["soneva-fushi"])
    const ghost = getStayProperty(db, "soneva-fushi")
    expect(ghost).not.toBeNull()               // history-bearing row survives
    expect(ghost!.active).toBe(false)          // but spends no more budget
  })

  it("round-trips metadata through the database", () => {
    seedStayProperties(db, smallUniverse())
    const p = getStayProperty(db, "grand-velas-riviera-maya")!
    expect(p.allInclusive).toBe("only")
    expect(p.defaultBoard).toBe("all_inclusive")
    expect(p.nearestAirports).toEqual(["CUN"])
    expect(p.typicalStayNights).toEqual([5, 7])
    expect(p.refs).toEqual({ xotelo: "g150812-d1204526" })
  })
})

describe("recording observations", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    seedStayProperties(db, smallUniverse())
  })

  const property = () => getStayProperty(db, "soneva-fushi")!
  const aiProperty = () => getStayProperty(db, "grand-velas-riviera-maya")!

  it("appends rates and reports baseline eligibility", () => {
    const requestId = recordStaySearchRequest(db, {
      propertyId: "soneva-fushi", kind: "rates",
      checkIn: "2026-11-10", checkOut: "2026-11-15",
      currency: "USD", source: "test",
    })
    const summary = recordRateObservations(db, property(), requestId, [
      makeStayRate(), makeStayRate({ rateSource: "Trip.com", price: { amount: 2872, currency: "USD" } }),
    ], SANITY)
    expect(summary).toEqual({ inserted: 2, suspicious: 0, baselineEligible: 2 })
    const rows = rateHistory(db, { propertyId: "soneva-fushi" })
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.searchRequestId === requestId)).toBe(true)
  })

  it("append-only: re-recording identical rates makes MORE rows, distinguishable by search request", () => {
    const r1 = recordStaySearchRequest(db, { propertyId: "soneva-fushi", kind: "rates", checkIn: "2026-11-10", checkOut: "2026-11-15", currency: "USD", source: "test" })
    const r2 = recordStaySearchRequest(db, { propertyId: "soneva-fushi", kind: "rates", checkIn: "2026-11-10", checkOut: "2026-11-15", currency: "USD", source: "test" })
    recordRateObservations(db, property(), r1, [makeStayRate()], SANITY)
    recordRateObservations(db, property(), r2, [makeStayRate()], SANITY)
    const rows = rateHistory(db, { propertyId: "soneva-fushi" })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.searchRequestId))).toEqual(new Set([r1, r2]))
  })

  it("refuses to record a rate under the wrong property — identity poisoning is unrecoverable", () => {
    const foreign = makeStayRate({ propertyId: "grand-velas-riviera-maya" })
    expect(() => recordRateObservations(db, property(), null, [foreign], SANITY))
      .toThrow(/refusing to record/)
    expect(rateHistory(db)).toHaveLength(0)   // the transaction rolled back
  })

  it("applies the property's board default at an all-inclusive-only property", () => {
    recordRateObservations(db, aiProperty(), null,
      [makeStayRate({ propertyId: "grand-velas-riviera-maya", board: "unknown" })], SANITY)
    const row = rateHistory(db, { propertyId: "grand-velas-riviera-maya" })[0]
    expect(row.board).toBe("all_inclusive")
    const stored = db.prepare(
      "SELECT board_source FROM stay_rate_observations WHERE property_id = ?",
    ).get("grand-velas-riviera-maya") as { board_source: string }
    expect(stored.board_source).toBe("property_default")
  })

  it("stores absurd prices flagged, visible, and baseline-ineligible — never discarded", () => {
    const summary = recordRateObservations(db, property(), null,
      [makeStayRate({ price: { amount: 2, currency: "USD" } })], SANITY)
    expect(summary).toEqual({ inserted: 1, suspicious: 1, baselineEligible: 0 })
    const row = rateHistory(db, { propertyId: "soneva-fushi" })[0]
    expect(row.sanity).toBe("SUSPICIOUS_DATA")
  })

  it("keeps lead-in teasers out of the baseline-eligible count", () => {
    const summary = recordRateObservations(db, property(), null,
      [makeStayRate({ priceBasis: "lead_in" })], SANITY)
    expect(summary).toEqual({ inserted: 1, suspicious: 0, baselineEligible: 0 })
  })

  it("stamps the provider ref as verified once it has demonstrably returned data", () => {
    const before = db.prepare(
      "SELECT verified_at FROM stay_property_refs WHERE property_id = 'soneva-fushi'",
    ).get() as { verified_at: string | null }
    expect(before.verified_at).toBeNull()
    // The stamp keys on (property, provider): the rate must come from the
    // provider the ref belongs to, as it always does in the real flow.
    recordRateObservations(db, property(), null, [makeStayRate({ provider: "xotelo" })], SANITY)
    const after = db.prepare(
      "SELECT verified_at FROM stay_property_refs WHERE property_id = 'soneva-fushi'",
    ).get() as { verified_at: string | null }
    expect(after.verified_at).not.toBeNull()
  })

  it("records calendar day classes append-only", () => {
    const days = [
      { date: "2026-11-11", dayClass: "cheap" as const },
      { date: "2026-12-28", dayClass: "high" as const },
    ]
    const n = recordCalendarObservations(db, property(), "mock-stays", "g3252668-d301967", null, days)
    expect(n).toBe(2)
    recordCalendarObservations(db, property(), "mock-stays", "g3252668-d301967", null, days)
    const counts = stayObservationCounts(db)
    expect(counts.calendarObservations).toBe(4)
  })

  it("counts the world accurately", () => {
    recordRateObservations(db, property(), null,
      [makeStayRate(), makeStayRate({ price: { amount: 1, currency: "USD" } })], SANITY)
    const c = stayObservationCounts(db)
    expect(c.properties).toBe(3)
    expect(c.activeProperties).toBe(2)
    expect(c.refs).toBe(2)
    expect(c.rateObservations).toBe(2)
    expect(c.suspiciousRates).toBe(1)
    expect(c.lastFetchAt).not.toBeNull()
  })
})
