/**
 * Award provider layer: cache keys, per-provider caching, failure isolation,
 * quota accounting, concurrency, cross-verification and the program≠airline
 * data model. Every provider is a mock; nothing here contacts Roame, ATF or
 * any other real service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  searchAwardFlights, setAwardProviders, getAwardProviders, dedupeAwards, crossVerify,
} from "../providers/award-flights/index.js"
import { awardCacheKey } from "../cache/key.js"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  readCache, readUsage, recordAwardObservations, awardPriceHistory, recordSearchRequest,
} from "../db/repositories.js"
import { buildRedemptionComparisons } from "../value-compare.js"
import { scoreFlights } from "../value-engine.js"
import type { UnifiedFlightResult } from "../roame-scraper.js"
import {
  MockAwardProvider, makeAwardQuery, makeAwardFlight, syntheticBalances,
} from "./mocks.js"

let db: DB
const savedEnv = { ...process.env }

beforeEach(() => {
  db = createMemoryDb()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  setAwardProviders(null)
  db.close()
  process.env = { ...savedEnv }
  vi.restoreAllMocks()
})

describe("award cache key", () => {
  it("is deterministic and matches the documented shape", () => {
    const q = makeAwardQuery()
    expect(awardCacheKey(q, "roame")).toBe("PRG:BKK:2026-11-10:oneway:PREM:1:f0:roame")
    expect(awardCacheKey(q, "roame")).toBe(awardCacheKey(makeAwardQuery(), "roame"))
  })

  it("separates providers, class, dates, flex and directions", () => {
    const keys = new Set([
      awardCacheKey(makeAwardQuery(), "roame"),
      awardCacheKey(makeAwardQuery(), "atf"),
      awardCacheKey(makeAwardQuery({ searchClass: "ECON" }), "roame"),
      awardCacheKey(makeAwardQuery({ departureDate: "2026-11-11" }), "roame"),
      awardCacheKey(makeAwardQuery({ returnDate: "2026-11-20" }), "roame"),
      awardCacheKey(makeAwardQuery({ flexDays: 1 }), "roame"),
      awardCacheKey(makeAwardQuery({ origin: "VIE" }), "roame"),
    ])
    expect(keys.size).toBe(7)
  })
})

describe("award registry", () => {
  it("exposes roame and atf as the real providers", () => {
    expect(getAwardProviders().map(p => p.name)).toEqual(["roame", "atf"])
  })

  it("honours ENABLE_* flags as enabled(), distinct from configured()", () => {
    process.env.ENABLE_ROAME = "false"
    const roame = getAwardProviders().find(p => p.name === "roame")!
    expect(roame.isEnabled()).toBe(false)
    expect(roame.isConfigured()).toBe(false)
    delete process.env.ENABLE_ROAME
    expect(roame.isEnabled()).toBe(true)
  })
})

describe("award cache", () => {
  it("caches a provider's results and serves the repeat search for zero calls", async () => {
    const provider = new MockAwardProvider({ name: "roame-mock" })
    setAwardProviders([provider])
    const q = makeAwardQuery()

    const first = await searchAwardFlights(q, { db })
    expect(first.flights).toHaveLength(1)
    expect(provider.calls).toHaveLength(1)

    const second = await searchAwardFlights(q, { db })
    expect(second.flights).toHaveLength(1)
    expect(second.flights[0]!.verificationLevel).toBe("cached")
    expect(second.callsSpent).toBe(0)
    // The decisive §34 assertion: the provider was not asked again.
    expect(provider.calls).toHaveLength(1)
  })

  it("re-queries once the award TTL has expired", async () => {
    process.env.AWARD_CACHE_TTL_HOURS = "0"
    const provider = new MockAwardProvider({ name: "roame-mock" })
    setAwardProviders([provider])
    const q = makeAwardQuery()
    await searchAwardFlights(q, { db })
    await searchAwardFlights(q, { db })
    expect(provider.calls).toHaveLength(2)
  })

  it("bypasses the cache on forceRefresh", async () => {
    const provider = new MockAwardProvider({ name: "roame-mock" })
    setAwardProviders([provider])
    const q = makeAwardQuery()
    await searchAwardFlights(q, { db })
    await searchAwardFlights(q, { db, forceRefresh: true })
    expect(provider.calls).toHaveLength(2)
  })

  it("caches each provider independently — fresh roame is kept while atf refreshes", async () => {
    const roame = new MockAwardProvider({ name: "roame-mock" })
    const atf = new MockAwardProvider({ name: "atf-mock", callsPerSearch: 5 })
    setAwardProviders([roame, atf])
    const q = makeAwardQuery()

    await searchAwardFlights(q, { db })
    expect(roame.calls).toHaveLength(1)
    expect(atf.calls).toHaveLength(1)

    // Expire only atf's entry.
    db.prepare("UPDATE search_cache SET expires_at = ? WHERE cache_key = ?")
      .run("2000-01-01T00:00:00.000Z", awardCacheKey(q, "atf-mock"))

    const second = await searchAwardFlights(q, { db })
    expect(roame.calls).toHaveLength(1)   // still cached
    expect(atf.calls).toHaveLength(2)     // refreshed
    const byProvider = new Map(second.perProvider.map(p => [p.provider, p]))
    expect(byProvider.get("roame-mock")!.fromCache).toBe(true)
    expect(byProvider.get("atf-mock")!.fromCache).toBe(false)
  })
})

describe("failure isolation", () => {
  it("keeps searching when one provider fails", async () => {
    setAwardProviders([
      new MockAwardProvider({ name: "roame-mock", fail: "provider-error" }),
      new MockAwardProvider({ name: "atf-mock" }),
    ])
    const out = await searchAwardFlights(makeAwardQuery(), { db })
    expect(out.flights).toHaveLength(1)
    expect(out.warnings.join(" ")).toContain("provider-error")
  })

  it("keeps searching when one provider throws", async () => {
    setAwardProviders([
      new MockAwardProvider({ name: "broken", throws: true }),
      new MockAwardProvider({ name: "working" }),
    ])
    const out = await searchAwardFlights(makeAwardQuery(), { db })
    expect(out.flights).toHaveLength(1)
    expect(out.warnings.join(" ")).toContain("exploded")
  })

  it("skips unconfigured providers with a warning, not a failure", async () => {
    const unconfigured = new MockAwardProvider({ name: "atf-mock", configured: false })
    setAwardProviders([new MockAwardProvider({ name: "roame-mock" }), unconfigured])
    const out = await searchAwardFlights(makeAwardQuery(), { db })
    expect(unconfigured.calls).toHaveLength(0)
    expect(out.flights).toHaveLength(1)
    expect(out.warnings.join(" ")).toContain("not configured")
  })

  it("returns empty flights with warnings when every provider fails", async () => {
    setAwardProviders([
      new MockAwardProvider({ name: "a", fail: "timeout" }),
      new MockAwardProvider({ name: "b", fail: "provider-error" }),
    ])
    const out = await searchAwardFlights(makeAwardQuery(), { db })
    expect(out.flights).toEqual([])
    expect(out.warnings.length).toBeGreaterThanOrEqual(2)
  })
})

describe("quota accounting", () => {
  it("records attempts and successes per provider, with multi-call searches counted fully", async () => {
    setAwardProviders([new MockAwardProvider({ name: "atf-mock", callsPerSearch: 5 })])
    await searchAwardFlights(makeAwardQuery(), { db })
    const usage = readUsage(db, "atf-mock")
    expect(usage.attempted).toBe(5)     // one ATF-style search = 5 airline calls
    expect(usage.succeeded).toBe(1)
    expect(usage.failed).toBe(0)
  })

  it("records failures without reclaiming the attempted calls", async () => {
    setAwardProviders([new MockAwardProvider({ name: "atf-mock", callsPerSearch: 5, fail: "provider-error" })])
    await searchAwardFlights(makeAwardQuery(), { db })
    const usage = readUsage(db, "atf-mock")
    expect(usage.attempted).toBe(5)
    expect(usage.failed).toBe(1)
  })

  it("stores provider-reported quota apart from the local estimate", async () => {
    setAwardProviders([new MockAwardProvider({
      name: "atf-mock", callsPerSearch: 5, reportedQuota: { remaining: 120, limit: 150 },
    })])
    await searchAwardFlights(makeAwardQuery(), { db })
    const usage = readUsage(db, "atf-mock")
    expect(usage.attempted).toBe(5)
    expect(usage.reportedRemaining).toBe(120)
    expect(usage.reportedLimit).toBe(150)
  })

  it("spends nothing at all on a cache hit", async () => {
    setAwardProviders([new MockAwardProvider({ name: "atf-mock", callsPerSearch: 5 })])
    const q = makeAwardQuery()
    await searchAwardFlights(q, { db })
    await searchAwardFlights(q, { db })
    expect(readUsage(db, "atf-mock").attempted).toBe(5)   // not 10
  })
})

describe("concurrent award requests", () => {
  it("collapses simultaneous identical searches into one provider call", async () => {
    const provider = new MockAwardProvider({ name: "roame-mock", delayMs: 120 })
    setAwardProviders([provider])
    const q = makeAwardQuery()

    const results = await Promise.all([
      searchAwardFlights(q, { db }),
      searchAwardFlights(q, { db }),
      searchAwardFlights(q, { db }),
      searchAwardFlights(q, { db }),
    ])
    expect(provider.calls).toHaveLength(1)
    for (const r of results) expect(r.flights).toHaveLength(1)
    // Only the originating caller pays; joiners spend nothing.
    expect(readUsage(db, "roame-mock").attempted).toBe(1)
  })
})

describe("program ≠ airline (§multi-program acceptance)", () => {
  /** One Austrian-operated flight, three programs, three prices — the Phase 3
   *  fixture from the specification. */
  function austrianTriple() {
    const flight = makeAwardFlight()   // establishes the shared physical identity
    return [
      { ...flight, loyaltyProgram: "AEROPLAN", loyaltyProgramName: "Aeroplan", points: 70000, taxes: { amount: 80, currency: "USD" } },
      { ...flight, loyaltyProgram: "LIFEMILES", loyaltyProgramName: "Avianca LifeMiles", points: 63000, taxes: { amount: 95, currency: "USD" } },
      { ...flight, loyaltyProgram: "MILES_AND_MORE", loyaltyProgramName: "Lufthansa Miles & More", points: 56000, taxes: { amount: 420, currency: "USD" } },
    ]
  }

  it("preserves the same flight priced by three different programs", () => {
    const out = dedupeAwards(austrianTriple())
    expect(out).toHaveLength(3)
    expect(new Set(out.map(f => f.itineraryHash)).size).toBe(1)      // one physical flight
    expect(new Set(out.map(f => f.loyaltyProgram)).size).toBe(3)     // three redemptions
  })

  it("collapses the same flight under the SAME program, keeping the cheaper", () => {
    const flight = makeAwardFlight()
    const out = dedupeAwards([
      { ...flight, loyaltyProgram: "AEROPLAN", points: 70000 },
      { ...flight, loyaltyProgram: "AEROPLAN", points: 65000 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.points).toBe(65000)
  })

  it("keeps genuinely different flights apart even in the same program", () => {
    const out = dedupeAwards([
      makeAwardFlight({ departureTime: "2026-11-10T10:20" }),
      makeAwardFlight({ departureTime: "2026-11-10T17:45", arrivalTime: "2026-11-11T13:40" }),
    ])
    expect(out).toHaveLength(2)
  })

  it("flows through the orchestrator end to end", async () => {
    setAwardProviders([new MockAwardProvider({ name: "roame-mock", flights: austrianTriple() })])
    const out = await searchAwardFlights(makeAwardQuery(), { db })
    expect(out.flights).toHaveLength(3)
    expect(new Set(out.flights.map(f => f.itineraryHash)).size).toBe(1)
  })
})

describe("cross-verification", () => {
  it("marks a redemption cross-verified only with two independent providers", async () => {
    const shared = makeAwardFlight()
    setAwardProviders([
      new MockAwardProvider({ name: "roame-mock", flights: [shared] }),
      new MockAwardProvider({ name: "atf-mock", flights: [{ ...shared }] }),
    ])
    const out = await searchAwardFlights(makeAwardQuery(), { db })
    expect(out.crossVerifiedCount).toBeGreaterThan(0)
    expect(out.flights.every(f => f.verificationLevel === "cross-verified")).toBe(true)
  })

  it("never cross-verifies from one provider repeating itself", () => {
    const a = makeAwardFlight({ provider: "roame" })
    const b = makeAwardFlight({ provider: "roame" })
    expect(crossVerify([a, b])).toBe(0)
    expect(a.verificationLevel).toBe("discovered")
  })
})

describe("award history (append-only, 'observed by this radar')", () => {
  it("appends observations and never overwrites", () => {
    const f = makeAwardFlight()
    recordAwardObservations(db, [f])
    recordAwardObservations(db, [{ ...f, points: 56000 }])
    const rows = db.prepare("SELECT points FROM award_prices ORDER BY id").all() as any[]
    expect(rows.map(r => r.points)).toEqual([70000, 56000])
  })

  it("computes per-program stats: count, min, max, median, average, latest, min taxes", () => {
    for (const points of [70000, 85000, 60000, 90000]) {
      recordAwardObservations(db, [makeAwardFlight({
        loyaltyProgram: "FLYING_BLUE", points,
        taxes: { amount: points === 60000 ? 180 : 220, currency: "USD" },
      })])
    }
    const [stats] = awardPriceHistory(db, { origin: "PRG", destination: "BKK", loyaltyProgram: "FLYING_BLUE" })
    expect(stats!.observations).toBe(4)
    expect(stats!.minPoints).toBe(60000)
    expect(stats!.maxPoints).toBe(90000)
    expect(stats!.medianPoints).toBe(77500)
    expect(stats!.averagePoints).toBe(76250)
    expect(stats!.latestPoints).toBe(90000)
    expect(stats!.minTaxes).toBe(180)
  })

  it("groups stats by program and cabin, never blending programs", () => {
    recordAwardObservations(db, [makeAwardFlight({ loyaltyProgram: "AEROPLAN", points: 70000 })])
    recordAwardObservations(db, [makeAwardFlight({ loyaltyProgram: "MILES_AND_MORE", points: 56000 })])
    const stats = awardPriceHistory(db, { origin: "PRG", destination: "BKK" })
    expect(stats).toHaveLength(2)
    expect(new Set(stats.map(s => s.loyaltyProgram))).toEqual(new Set(["AEROPLAN", "MILES_AND_MORE"]))
  })

  it("links observations to the unified search request", async () => {
    const id = recordSearchRequest(db, {
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10",
      returnDate: null, cabin: "business", adults: 1, currency: "USD",
    }, "test")
    setAwardProviders([new MockAwardProvider({ name: "roame-mock" })])
    await searchAwardFlights(makeAwardQuery(), { db, searchRequestId: id })
    const row = db.prepare("SELECT search_request_id s FROM award_prices").get() as any
    expect(row.s).toBe(id)
  })

  it("does not append duplicate history rows when replaying the cache", async () => {
    setAwardProviders([new MockAwardProvider({ name: "roame-mock" })])
    const q = makeAwardQuery()
    await searchAwardFlights(q, { db })
    const afterFirst = (db.prepare("SELECT COUNT(*) c FROM award_prices").get() as any).c
    await searchAwardFlights(q, { db })
    expect((db.prepare("SELECT COUNT(*) c FROM award_prices").get() as any).c).toBe(afterFirst)
  })
})

describe("redemption comparison (§best redemption view)", () => {
  function scoredTriple() {
    const base = makeAwardFlight()
    const toUnified = (f: ReturnType<typeof makeAwardFlight>, id: string): UnifiedFlightResult => ({
      id, source: "roame", type: "award",
      origin: f.origin, destination: f.destination,
      airline: f.operatingAirlines.join("/"), operatingAirlines: f.operatingAirlines,
      flightNumbers: f.flightNumbers, stops: f.stops ?? 0, durationMinutes: f.durationMinutes ?? 0,
      departureTime: f.departureTime || "", arrivalTime: f.arrivalTime || "",
      airports: f.airports, cabinClass: f.cabin, equipment: f.equipment,
      points: f.points, pointsProgram: f.loyaltyProgram, cashPrice: null,
      taxes: f.taxes?.amount ?? 0, currency: "USD", cppValue: null,
      roameScore: null, availableSeats: f.availableSeats,
      bookingUrl: f.bookingUrl, fareClass: "", travelDate: f.departureDate,
      itineraryHash: f.itineraryHash, loyaltyProgramName: f.loyaltyProgramName,
      provider: "roame", verificationLevel: "discovered",
    })
    return [
      toUnified({ ...base, loyaltyProgram: "AEROPLAN", loyaltyProgramName: "Aeroplan", points: 70000, taxes: { amount: 80, currency: "USD" } }, "a"),
      toUnified({ ...base, loyaltyProgram: "LIFEMILES", loyaltyProgramName: "Avianca LifeMiles", points: 63000, taxes: { amount: 95, currency: "USD" } }, "b"),
      toUnified({ ...base, loyaltyProgram: "MILES_AND_MORE", loyaltyProgramName: "Lufthansa Miles & More", points: 56000, taxes: { amount: 420, currency: "USD" } }, "c"),
    ]
  }

  it("identifies cheapest points, lowest taxes and best affordable separately", () => {
    const { scored } = scoreFlights(scoredTriple(), syntheticBalances(), "PRG", "BKK")
    const comparisons = buildRedemptionComparisons(scored)
    expect(comparisons).toHaveLength(1)
    const c = comparisons[0]!
    expect(c.optionCount).toBe(3)
    expect(c.cheapestPoints).toBe("MILES_AND_MORE")   // 56k
    expect(c.lowestTaxes).toBe("AEROPLAN")            // $80
    // Synthetic balances: 50k Aeroplan + 100k Chase UR (Chase→Aeroplan 1:1)
    // makes Aeroplan bookable; M&M and LifeMiles have no funding path.
    expect(c.bestAffordable).toBe("AEROPLAN")
    expect(c.bestTransferRoute).toBeTruthy()
  })

  it("reports pointsShortfall for unaffordable programs", () => {
    const { scored } = scoreFlights(scoredTriple(), syntheticBalances(), "PRG", "BKK")
    const mm = scored.find(f => f.pointsProgram === "MILES_AND_MORE")!
    expect(mm.canAfford).toBe(false)
    expect(mm.pointsShortfall).toBe(56000)   // no balance, no transfer path
  })
})
