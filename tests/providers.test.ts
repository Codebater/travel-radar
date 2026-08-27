/**
 * Provider abstraction, fallback, deduplication, quota accounting and the
 * SerpAPI budget guard.
 *
 * Every provider here is a mock. No test in this file contacts SerpAPI, Roame,
 * ATF, AwardWallet or Google.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  searchCashFlights, deduplicate, setProviders, getProviders, providerHealth,
} from "../providers/cash-flights/index.js"
import { SerpApiProvider } from "../providers/cash-flights/serpapi.js"
import { createMemoryDb, currentPeriod, type DB } from "../db/index.js"
import {
  readUsage, recordCallAttempt, recordCallOutcome, recordReportedQuota, allUsage,
} from "../db/repositories.js"
import { cacheKey } from "../cache/key.js"
import { readCache } from "../db/repositories.js"
import { MockProvider, makeQuery, makeFlight } from "./mocks.js"

let db: DB
const savedEnv = { ...process.env }

beforeEach(() => {
  db = createMemoryDb()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  setProviders(null)
  db.close()
  process.env = { ...savedEnv }
  vi.restoreAllMocks()
})

describe("provider registry", () => {
  it("exposes the real providers in free-then-metered priority order", () => {
    const names = getProviders().map(p => p.name)
    expect(names).toEqual(["fast_flights", "serpapi"])
    const kinds = getProviders().map(p => p.kind)
    expect(kinds).toEqual(["free", "metered"])
  })

  it("is interchangeable — swapping the registry changes nothing else", async () => {
    setProviders([new MockProvider({ name: "brand_new_vendor" })])
    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(out.flights).toHaveLength(1)
    expect(out.flights[0]!.provider).toBe("brand_new_vendor")
  })

  it("reports health without performing a billable search", async () => {
    const metered = new MockProvider({ name: "metered_mock", kind: "metered" })
    setProviders([new MockProvider({ name: "free_mock" }), metered])
    const health = await providerHealth(db)
    expect(health.map(h => h.provider)).toEqual(["free_mock", "metered_mock"])
    expect(metered.calls).toHaveLength(0)
  })
})

describe("tiering and fallback", () => {
  it("uses the free provider and does not touch the metered one", async () => {
    const free = new MockProvider({ name: "free_mock" })
    const metered = new MockProvider({ name: "metered_mock", kind: "metered", verificationLevel: "verified" })
    setProviders([free, metered])

    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(out.verificationLevel).toBe("discovered")
    expect(free.calls).toHaveLength(1)
    expect(metered.calls).toHaveLength(0)
    expect(out.callsSpent).toBe(0)
  })

  it("falls back to the metered provider when the free one finds nothing", async () => {
    const free = new MockProvider({ name: "free_mock", fail: "no-results" })
    const metered = new MockProvider({ name: "metered_mock", kind: "metered", verificationLevel: "verified" })
    setProviders([free, metered])

    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(metered.calls).toHaveLength(1)
    expect(out.verificationLevel).toBe("verified")
    expect(out.callsSpent).toBe(1)
  })

  it("calls the metered provider when verification is explicitly requested", async () => {
    const free = new MockProvider({ name: "free_mock" })
    const metered = new MockProvider({ name: "metered_mock", kind: "metered", verificationLevel: "verified" })
    setProviders([free, metered])

    await searchCashFlights(makeQuery(), { db, source: "test", verify: true })
    expect(metered.calls).toHaveLength(1)
  })

  it("keeps searching when a provider throws", async () => {
    const broken = new MockProvider({ name: "broken", throws: true })
    const working = new MockProvider({ name: "working" })
    setProviders([broken, working])

    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(out.flights).toHaveLength(1)
    expect(out.warnings.join(" ")).toContain("mock provider exploded")
  })

  it("returns an empty result with warnings when everything fails", async () => {
    setProviders([
      new MockProvider({ name: "a", fail: "provider-error" }),
      new MockProvider({ name: "b", kind: "metered", fail: "provider-error" }),
    ])
    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(out.flights).toEqual([])
    expect(out.warnings.length).toBeGreaterThan(0)
  })

  it("skips an unconfigured metered provider without counting it as a failure", async () => {
    const metered = new MockProvider({ name: "metered_mock", kind: "metered", configured: false })
    setProviders([new MockProvider({ name: "free_mock", fail: "no-results" }), metered])
    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(metered.calls).toHaveLength(0)
    expect(out.warnings.join(" ")).toContain("not configured")
  })
})

describe("the same search twice does not spend twice", () => {
  it("serves the second identical search from cache with zero provider calls", async () => {
    const metered = new MockProvider({ name: "metered_mock", kind: "metered", verificationLevel: "verified" })
    setProviders([new MockProvider({ name: "free_mock", fail: "no-results" }), metered])
    const q = makeQuery()

    const first = await searchCashFlights(q, { db, source: "test" })
    expect(first.fromCache).toBe(false)
    expect(first.callsSpent).toBe(1)
    expect(metered.calls).toHaveLength(1)

    const second = await searchCashFlights(q, { db, source: "test" })
    expect(second.fromCache).toBe(true)
    expect(second.callsSpent).toBe(0)
    expect(second.verificationLevel).toBe("cached")
    // The decisive assertion: the provider was never asked a second time.
    expect(metered.calls).toHaveLength(1)
  })

  it("does re-fetch once the cache has expired", async () => {
    process.env.CASH_CACHE_TTL_HOURS = "0"
    const free = new MockProvider({ name: "free_mock" })
    setProviders([free])
    const q = makeQuery()

    await searchCashFlights(q, { db, source: "test" })
    await searchCashFlights(q, { db, source: "test" })
    expect(free.calls).toHaveLength(2)
  })

  it("re-fetches when the caller forces a refresh", async () => {
    const free = new MockProvider({ name: "free_mock" })
    setProviders([free])
    const q = makeQuery()

    await searchCashFlights(q, { db, source: "test" })
    const forced = await searchCashFlights(q, { db, source: "test", forceRefresh: true })
    expect(free.calls).toHaveLength(2)
    expect(forced.fromCache).toBe(false)
  })

  it("does not append duplicate history rows when replaying the cache", async () => {
    setProviders([new MockProvider({ name: "free_mock" })])
    const q = makeQuery()
    await searchCashFlights(q, { db, source: "test" })
    const afterFirst = (db.prepare("SELECT COUNT(*) c FROM flight_prices").get() as any).c
    await searchCashFlights(q, { db, source: "test" })
    const afterSecond = (db.prepare("SELECT COUNT(*) c FROM flight_prices").get() as any).c
    expect(afterSecond).toBe(afterFirst)
  })

  it("writes a cache entry under the documented key", async () => {
    setProviders([new MockProvider({ name: "free_mock" })])
    const q = makeQuery()
    await searchCashFlights(q, { db, source: "test" })
    expect(readCache(db, cacheKey(q, "free_mock"))).not.toBeNull()
  })

  it("records every search request, cached or not", async () => {
    setProviders([new MockProvider({ name: "free_mock" })])
    const q = makeQuery()
    await searchCashFlights(q, { db, source: "test" })
    await searchCashFlights(q, { db, source: "test" })
    expect((db.prepare("SELECT COUNT(*) c FROM search_requests").get() as any).c).toBe(2)
  })
})

describe("deduplication", () => {
  it("collapses the same itinerary reported by two providers", () => {
    const shared = makeFlight()
    const out = deduplicate([
      { ...shared, provider: "free_mock", price: { amount: 405, currency: "EUR" } },
      { ...shared, provider: "metered_mock", price: { amount: 412, currency: "EUR" } },
    ])
    expect(out).toHaveLength(1)
  })

  it("prefers the verified price even when a discovered one is cheaper", () => {
    const shared = makeFlight()
    const out = deduplicate([
      { ...shared, provider: "free_mock", verificationLevel: "discovered", price: { amount: 380, currency: "EUR" } },
      { ...shared, provider: "metered_mock", verificationLevel: "verified", price: { amount: 412, currency: "EUR" } },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.verificationLevel).toBe("verified")
    expect(out[0]!.price.amount).toBe(412)
  })

  it("prefers the cheaper price at the same verification level", () => {
    const shared = makeFlight()
    const out = deduplicate([
      { ...shared, price: { amount: 500, currency: "EUR" } },
      { ...shared, price: { amount: 405, currency: "EUR" } },
    ])
    expect(out[0]!.price.amount).toBe(405)
  })

  it("never compares across currencies", () => {
    const shared = makeFlight()
    const out = deduplicate([
      { ...shared, price: { amount: 500, currency: "EUR" } },
      { ...shared, price: { amount: 100, currency: "USD" } },   // cheaper number, different currency
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.price.currency).toBe("EUR")   // first one kept, not "cheapest"
  })

  it("keeps genuinely different itineraries apart", () => {
    const out = deduplicate([
      makeFlight({ arrivalTime: "2026-11-11T13:05" }),
      makeFlight({ arrivalTime: "2026-11-11T06:25" }),
    ])
    expect(out).toHaveLength(2)
  })

  it("handles an empty list", () => {
    expect(deduplicate([])).toEqual([])
  })
})

describe("provider usage accounting", () => {
  it("tracks attempts, successes and failures separately", () => {
    recordCallAttempt(db, "serpapi")
    recordCallOutcome(db, "serpapi", { ok: true })
    recordCallAttempt(db, "serpapi")
    recordCallOutcome(db, "serpapi", { ok: false, error: "HTTP 401" })

    const usage = readUsage(db, "serpapi")
    expect(usage.attempted).toBe(2)
    expect(usage.succeeded).toBe(1)
    expect(usage.failed).toBe(1)
    expect(usage.lastError).toContain("401")
    expect(usage.lastCallAt).toBeTruthy()
  })

  it("does not lose increments under concurrent updates", () => {
    // Phase 1's JSON counter lost writes when two processes searched at once.
    const N = 200
    for (let i = 0; i < N; i++) recordCallAttempt(db, "serpapi")
    expect(readUsage(db, "serpapi").attempted).toBe(N)
  })

  it("survives interleaved attempts and outcomes across providers", () => {
    for (let i = 0; i < 50; i++) {
      recordCallAttempt(db, "serpapi")
      recordCallAttempt(db, "other")
      recordCallOutcome(db, "serpapi", { ok: i % 2 === 0 })
    }
    const serp = readUsage(db, "serpapi")
    expect(serp.attempted).toBe(50)
    expect(serp.succeeded + serp.failed).toBe(50)
    expect(readUsage(db, "other").attempted).toBe(50)
  })

  it("keeps the provider's reported quota apart from our local estimate", () => {
    recordCallAttempt(db, "serpapi")
    recordReportedQuota(db, "serpapi", { remaining: 63, limit: 100 })
    const usage = readUsage(db, "serpapi")
    expect(usage.attempted).toBe(1)          // local estimate
    expect(usage.reportedRemaining).toBe(63) // authoritative, from the provider
    expect(usage.reportedLimit).toBe(100)
  })

  it("scopes counters by month", () => {
    recordCallAttempt(db, "serpapi", "2026-07")
    recordCallAttempt(db, "serpapi", "2026-08")
    recordCallAttempt(db, "serpapi", "2026-08")
    expect(readUsage(db, "serpapi", "2026-07").attempted).toBe(1)
    expect(readUsage(db, "serpapi", "2026-08").attempted).toBe(2)
  })

  it("lists usage for every provider seen this period", () => {
    recordCallAttempt(db, "serpapi")
    recordCallAttempt(db, "atf")
    expect(allUsage(db).map(u => u.provider).sort()).toEqual(["atf", "serpapi"])
  })
})

describe("SerpAPI budget guard", () => {
  /** Drive the real provider's guard against an isolated in-memory database. */
  function guardFor(attempted: number, userInitiated: boolean): { allowed: boolean; message: string } {
    const provider = new SerpApiProvider()
    // The guard reads usage through getDb(); point it at our test database.
    vi.spyOn(provider, "quota").mockReturnValue({
      estimatedUsed: attempted, budget: 90, reserve: 10,
      automationRemaining: Math.max(0, 80 - attempted),
      reportedRemaining: null, reportedLimit: null, reportedAt: null,
    })
    return (provider as any).budgetCheck(userInitiated)
  }

  beforeEach(() => {
    process.env.SERPAPI_MONTHLY_BUDGET = "90"
    process.env.SERPAPI_RESERVE_CALLS = "10"
  })

  it("allows automation below the ceiling", () => {
    expect(guardFor(0, false).allowed).toBe(true)
    expect(guardFor(79, false).allowed).toBe(true)
  })

  it("stops automation at the ceiling, leaving the reserve intact", () => {
    const guard = guardFor(80, false)
    expect(guard.allowed).toBe(false)
    expect(guard.message).toContain("automation budget exhausted")
    expect(guard.message).toContain("cached/free-provider results shown")
  })

  it("lets an explicit user request spend the reserve", () => {
    expect(guardFor(80, true).allowed).toBe(true)
    expect(guardFor(89, true).allowed).toBe(true)
  })

  it("refuses everyone once the whole monthly budget is gone", () => {
    expect(guardFor(90, true).allowed).toBe(false)
    expect(guardFor(90, false).allowed).toBe(false)
    expect(guardFor(90, true).message).toContain("monthly budget exhausted")
  })

  it("reports budget exhaustion as a normal result, not a crash", async () => {
    const metered = new MockProvider({
      name: "metered_mock", kind: "metered", fail: "budget-exhausted", callsPerSearch: 0,
    })
    setProviders([new MockProvider({ name: "free_mock", fail: "no-results" }), metered])

    const out = await searchCashFlights(makeQuery(), { db, source: "test" })
    expect(out.flights).toEqual([])
    expect(out.callsSpent).toBe(0)
    expect(out.warnings.join(" ")).toContain("budget-exhausted")
  })
})

describe("current period", () => {
  it("formats as YYYY-MM", () => {
    expect(currentPeriod(new Date("2026-11-10T12:00:00Z"))).toBe("2026-11")
  })
})
