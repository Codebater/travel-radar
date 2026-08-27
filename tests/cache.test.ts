/**
 * Cache keys, itinerary identity, cache hit/expiry, and the price history
 * helpers. Entirely offline — no provider is contacted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { cacheKey, itineraryHash } from "../cache/key.js"
import { cachePolicy, serpApiBudget, ttlToExpiry } from "../cache/policy.js"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  readCache, writeCache, recordCacheHit, pruneCache, clearCache,
  recordPriceObservations, priceHistory, recordSearchRequest,
} from "../db/repositories.js"
import { makeQuery, makeFlight } from "./mocks.js"

describe("cache key", () => {
  it("is deterministic and matches the documented shape", () => {
    const q = makeQuery()
    expect(cacheKey(q, "fast_flights")).toBe("PRG:BKK:2026-11-10:2026-11-20:business:1:fast_flights")
    expect(cacheKey(q, "fast_flights")).toBe(cacheKey(makeQuery(), "fast_flights"))
  })

  it("separates providers, cabins, dates, passenger counts and directions", () => {
    const base = makeQuery()
    const keys = new Set([
      cacheKey(base, "fast_flights"),
      cacheKey(base, "serpapi"),
      cacheKey(makeQuery({ cabin: "economy" }), "fast_flights"),
      cacheKey(makeQuery({ departureDate: "2026-11-11" }), "fast_flights"),
      cacheKey(makeQuery({ returnDate: null }), "fast_flights"),
      cacheKey(makeQuery({ adults: 2 }), "fast_flights"),
      cacheKey(makeQuery({ origin: "VIE" }), "fast_flights"),
      cacheKey(makeQuery({ destination: "CUN" }), "fast_flights"),
    ])
    expect(keys.size).toBe(8)
  })

  it("marks one-way explicitly so it cannot collide with a blank return date", () => {
    expect(cacheKey(makeQuery({ returnDate: null }), "p")).toContain(":oneway:")
    expect(cacheKey(makeQuery({ returnDate: null }), "p"))
      .not.toBe(cacheKey(makeQuery({ returnDate: "" as any }), "p").replace("oneway", ""))
  })

  it("normalises case and sanitises separators in provider names", () => {
    expect(cacheKey(makeQuery({ origin: "prg" }), "p")).toContain("PRG:")
    // A colon in a provider name must not shift the meaning of other fields.
    expect(cacheKey(makeQuery(), "evil:name").split(":").length)
      .toBe(cacheKey(makeQuery(), "safename").split(":").length)
  })
})

describe("itinerary identity", () => {
  const base = {
    origin: "PRG", destination: "BKK", departureDate: "2026-11-10",
    departureTime: "2026-11-10T11:30", arrivalTime: "2026-11-11T13:45",
    cabin: "business", airlines: ["Lufthansa"], stops: 1,
  }

  it("is stable for the same itinerary", () => {
    expect(itineraryHash(base)).toBe(itineraryHash({ ...base }))
  })

  it("ignores price so two providers can disagree about it", () => {
    // price is not an input at all — same identity regardless of what was paid
    expect(itineraryHash(base)).toBe(itineraryHash({ ...base }))
  })

  it("matches across providers even when only one supplies flight numbers", () => {
    // fast_flights gives no flight numbers, SerpAPI does; they must still agree.
    const withNumbers = { ...base } as any
    withNumbers.flightNumbers = ["LH 1401", "LH 772"]
    expect(itineraryHash(withNumbers)).toBe(itineraryHash(base))
  })

  it("separates two same-carrier itineraries that differ only by arrival", () => {
    // The Phase 2 regression: a €3,276 and a €5,155 Lufthansa option left at the
    // same minute with the same stop count and collapsed into one.
    const early = { ...base, arrivalTime: "2026-11-11T06:25" }
    expect(itineraryHash(base)).not.toBe(itineraryHash(early))
  })

  it("falls back to duration when a provider gives no arrival time", () => {
    const a = { ...base, arrivalTime: null, durationMinutes: 720 }
    const b = { ...base, arrivalTime: null, durationMinutes: 710 }
    expect(itineraryHash(a)).not.toBe(itineraryHash(b))
  })

  it("is order-insensitive for multi-carrier itineraries", () => {
    const ab = { ...base, airlines: ["British Airways", "American"] }
    const ba = { ...base, airlines: ["American", "British Airways"] }
    expect(itineraryHash(ab)).toBe(itineraryHash(ba))
  })

  it("distinguishes cabins and routes", () => {
    expect(itineraryHash(base)).not.toBe(itineraryHash({ ...base, cabin: "economy" }))
    expect(itineraryHash(base)).not.toBe(itineraryHash({ ...base, destination: "CUN" }))
  })
})

describe("cache policy", () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it("uses documented defaults", () => {
    delete process.env.CASH_CACHE_TTL_HOURS
    delete process.env.AWARD_CACHE_TTL_HOURS
    const p = cachePolicy()
    expect(p.cashTtlHours).toBe(8)
    // Award availability is more volatile, so it must expire sooner than cash.
    expect(p.awardTtlHours).toBeLessThan(p.cashTtlHours)
  })

  it("reads overrides from the environment", () => {
    process.env.CASH_CACHE_TTL_HOURS = "3"
    expect(cachePolicy().cashTtlHours).toBe(3)
  })

  it("ignores nonsense values rather than caching forever", () => {
    process.env.CASH_CACHE_TTL_HOURS = "not-a-number"
    expect(cachePolicy().cashTtlHours).toBe(8)
    process.env.CASH_CACHE_TTL_HOURS = "-5"
    expect(cachePolicy().cashTtlHours).toBe(8)
  })

  it("reserves calls out of the automation ceiling", () => {
    process.env.SERPAPI_MONTHLY_BUDGET = "90"
    process.env.SERPAPI_RESERVE_CALLS = "10"
    const b = serpApiBudget()
    expect(b.automationCeiling).toBe(80)
  })

  it("never lets the reserve exceed the whole budget", () => {
    process.env.SERPAPI_MONTHLY_BUDGET = "5"
    process.env.SERPAPI_RESERVE_CALLS = "50"
    const b = serpApiBudget()
    expect(b.reserveCalls).toBe(5)
    expect(b.automationCeiling).toBe(0)
  })
})

describe("cache storage", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })
  afterEach(() => { db.close() })

  it("stores and replays a payload", () => {
    const q = makeQuery()
    const key = cacheKey(q, "fast_flights")
    writeCache(db, key, "fast_flights", q, [makeFlight()], ttlToExpiry(8))

    const hit = readCache(db, key)
    expect(hit).not.toBeNull()
    expect(hit!.isExpired).toBe(false)
    expect(hit!.flights).toHaveLength(1)
    expect(hit!.flights[0]!.price.amount).toBe(405)
  })

  it("misses on an unknown key", () => {
    expect(readCache(db, "PRG:BKK:2026-11-10:oneway:economy:1:nobody")).toBeNull()
  })

  it("reports an entry past its TTL as expired", () => {
    const q = makeQuery()
    const key = cacheKey(q, "fast_flights")
    writeCache(db, key, "fast_flights", q, [makeFlight()], ttlToExpiry(-1))
    expect(readCache(db, key)!.isExpired).toBe(true)
  })

  it("computes entry age", () => {
    const q = makeQuery()
    const key = cacheKey(q, "fast_flights")
    writeCache(db, key, "fast_flights", q, [makeFlight()], ttlToExpiry(8))
    const twoHoursOn = new Date(Date.now() + 2 * 3600_000)
    expect(readCache(db, key, twoHoursOn)!.ageMinutes).toBeGreaterThanOrEqual(119)
  })

  it("overwrites rather than duplicating on rewrite", () => {
    const q = makeQuery()
    const key = cacheKey(q, "fast_flights")
    writeCache(db, key, "fast_flights", q, [makeFlight()], ttlToExpiry(8))
    writeCache(db, key, "fast_flights", q, [makeFlight(), makeFlight({ price: { amount: 500, currency: "EUR" } })], ttlToExpiry(8))
    expect(readCache(db, key)!.flights).toHaveLength(2)
    expect(db.prepare("SELECT COUNT(*) c FROM search_cache").get()).toEqual({ c: 1 })
  })

  it("treats a corrupt payload as a miss instead of throwing", () => {
    const q = makeQuery()
    const key = cacheKey(q, "fast_flights")
    writeCache(db, key, "fast_flights", q, [makeFlight()], ttlToExpiry(8))
    db.prepare("UPDATE search_cache SET payload = ? WHERE cache_key = ?").run("{not json", key)
    expect(readCache(db, key)).toBeNull()
  })

  it("counts hits, prunes expired rows and clears by provider", () => {
    const q = makeQuery()
    const key = cacheKey(q, "fast_flights")
    writeCache(db, key, "fast_flights", q, [makeFlight()], ttlToExpiry(8))
    recordCacheHit(db, key)
    recordCacheHit(db, key)
    expect((db.prepare("SELECT hit_count h FROM search_cache WHERE cache_key = ?").get(key) as any).h).toBe(2)

    const stale = cacheKey(makeQuery({ origin: "VIE" }), "fast_flights")
    writeCache(db, stale, "fast_flights", makeQuery({ origin: "VIE" }), [makeFlight()], ttlToExpiry(-1))
    expect(pruneCache(db)).toBe(1)

    expect(clearCache(db, "serpapi")).toBe(0)
    expect(clearCache(db, "fast_flights")).toBe(1)
  })
})

describe("price history", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })
  afterEach(() => { db.close() })

  it("appends observations instead of overwriting them", () => {
    const f = makeFlight()
    recordPriceObservations(db, [f], { adults: 1 })
    recordPriceObservations(db, [{ ...f, price: { amount: 512, currency: "EUR" } }], { adults: 1 })

    const rows = db.prepare("SELECT * FROM flight_prices ORDER BY id").all() as any[]
    expect(rows).toHaveLength(2)
    // Same itinerary, two different observed prices — both kept.
    expect(rows[0].itinerary_hash).toBe(rows[1].itinerary_hash)
    expect([rows[0].price_amount, rows[1].price_amount]).toEqual([405, 512])
  })

  it("computes count, min, max, median, average and latest", () => {
    const amounts = [400, 500, 300, 700]
    for (const amount of amounts) {
      recordPriceObservations(db, [makeFlight({ price: { amount, currency: "EUR" } })], { adults: 1 })
    }
    const [stats] = priceHistory(db, { origin: "PRG", destination: "BKK", cabin: "business" })
    expect(stats!.observations).toBe(4)
    expect(stats!.min).toBe(300)
    expect(stats!.max).toBe(700)
    expect(stats!.median).toBe(450)      // (400 + 500) / 2
    expect(stats!.average).toBe(475)
    expect(stats!.latest).toBe(700)      // last inserted
  })

  it("keeps currencies apart rather than blending them", () => {
    recordPriceObservations(db, [makeFlight({ price: { amount: 400, currency: "EUR" } })], { adults: 1 })
    recordPriceObservations(db, [makeFlight({ price: { amount: 900, currency: "USD" } })], { adults: 1 })
    const stats = priceHistory(db, { origin: "PRG", destination: "BKK" })
    expect(stats).toHaveLength(2)
    expect(stats.map(s => s.currency).sort()).toEqual(["EUR", "USD"])
  })

  it("filters by route, date, cabin and provider", () => {
    recordPriceObservations(db, [makeFlight()], { adults: 1 })
    recordPriceObservations(db, [makeFlight({ destination: "CUN" })], { adults: 1 })
    expect(priceHistory(db, { origin: "PRG", destination: "BKK" })[0]!.observations).toBe(1)
    expect(priceHistory(db, { origin: "PRG", destination: "CUN" })[0]!.observations).toBe(1)
    expect(priceHistory(db, { origin: "PRG", destination: "BKK", cabin: "economy" })).toHaveLength(0)
    expect(priceHistory(db, { origin: "PRG", destination: "BKK", provider: "nobody" })).toHaveLength(0)
  })

  it("returns nothing for a route never searched", () => {
    expect(priceHistory(db, { origin: "AAA", destination: "BBB" })).toEqual([])
  })

  it("links observations to the originating search request", () => {
    const id = recordSearchRequest(db, makeQuery(), "test")
    recordPriceObservations(db, [makeFlight()], { adults: 1, searchRequestId: id })
    const row = db.prepare("SELECT search_request_id s FROM flight_prices").get() as any
    expect(row.s).toBe(id)
  })
})
