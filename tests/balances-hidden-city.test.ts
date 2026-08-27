/**
 * Balance caching, transfer bonus windows, affordability, CPP provenance,
 * hidden-city budget protection, the Phase 3 migration, and results.json
 * independence. Synthetic data throughout — no real balances, no API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import Database from "better-sqlite3"
import { createMemoryDb, migrate, type DB } from "../db/index.js"
import {
  saveBalanceSnapshot, latestBalanceSnapshot, saveSearchResult, latestSearchResult,
  recordSearchRequest, readUsage,
} from "../db/repositories.js"
import { effectiveRatio, canAfford, findFundingPaths, type TransferPartner } from "../transfer-partners.js"
import { scoreFlights } from "../value-engine.js"
import { searchHiddenCity } from "../providers/cash-flights/hidden-city.js"
import { setProviders } from "../providers/cash-flights/index.js"
import {
  MockProvider, makeFlight, syntheticBalances,
} from "./mocks.js"

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

describe("loyalty balance snapshots", () => {
  it("stores and returns the latest snapshot batch with its age", () => {
    saveBalanceSnapshot(db, syntheticBalances(), "awardwallet")
    const snap = latestBalanceSnapshot(db)
    expect(snap).not.toBeNull()
    expect(snap!.balances).toHaveLength(3)
    expect(snap!.ageMinutes).toBeLessThan(2)
  })

  it("returns the NEWEST batch when several exist (history accumulates)", () => {
    saveBalanceSnapshot(db, syntheticBalances(), "awardwallet")
    const updated = syntheticBalances().map(b => ({ ...b, balance: b.balance + 500 }))
    saveBalanceSnapshot(db, updated, "awardwallet")
    const snap = latestBalanceSnapshot(db)
    expect(snap!.balances.find(b => b.programKey === "chase-ur")!.balance).toBe(100500)
    // Both batches remain — snapshots are append-only balance history.
    expect((db.prepare("SELECT COUNT(*) c FROM balance_snapshots").get() as any).c).toBe(6)
  })

  it("treats a snapshot beyond the TTL as absent", () => {
    saveBalanceSnapshot(db, syntheticBalances(), "awardwallet")
    db.prepare("UPDATE balance_snapshots SET fetched_at = ?").run("2020-01-01T00:00:00.000Z")
    expect(latestBalanceSnapshot(db, { maxAgeHours: 12 })).toBeNull()
    // But without a TTL constraint the stale batch is still retrievable.
    expect(latestBalanceSnapshot(db)).not.toBeNull()
  })
})

describe("transfer bonuses (§architecture only — no fabricated data)", () => {
  const partner: TransferPartner = {
    from: "chase-ur", fromName: "Chase UR", to: "FLYING_BLUE", toName: "Flying Blue",
    ratio: 1.0, transferTime: "instant",
    bonus: { ratio: 1.25, startDate: "2026-08-01", endDate: "2026-09-30", source: "test fixture" },
  }

  it("applies the bonus ratio inside the window", () => {
    expect(effectiveRatio(partner, new Date("2026-08-27T12:00:00Z"))).toBe(1.25)
    expect(effectiveRatio(partner, new Date("2026-08-01T00:00:00Z"))).toBe(1.25)
    expect(effectiveRatio(partner, new Date("2026-09-30T23:00:00Z"))).toBe(1.25)
  })

  it("falls back to the standard ratio outside the window", () => {
    expect(effectiveRatio(partner, new Date("2026-07-31T12:00:00Z"))).toBe(1.0)
    expect(effectiveRatio(partner, new Date("2026-10-01T12:00:00Z"))).toBe(1.0)
  })

  it("uses the standard ratio when no bonus is recorded", () => {
    expect(effectiveRatio({ ...partner, bonus: undefined })).toBe(1.0)
  })

  it("ships with NO active bonuses hardcoded in the real transfer data", async () => {
    const { TRANSFER_PARTNERS } = await import("../transfer-partners.js")
    expect(TRANSFER_PARTNERS.every(p => p.bonus === undefined)).toBe(true)
  })
})

describe("affordability and shortfall", () => {
  const balances = syntheticBalances()   // 100k chase-ur, 50k AEROPLAN, 20k FLYING_BLUE

  it("canBook via direct balance", () => {
    const r = canAfford("AEROPLAN", 45000, balances)
    expect(r.affordable).toBe(true)
    expect(r.shortfall).toBe(0)
  })

  it("canBook via transfer when the direct balance is short", () => {
    // Needs 70k Aeroplan; has 50k direct + 100k Chase UR at 1:1.
    const r = canAfford("AEROPLAN", 70000, balances)
    expect(r.affordable).toBe(true)
    expect(r.shortfall).toBe(0)
  })

  it("reports the exact pointsShortfall when nothing covers it", () => {
    // Flying Blue: 20k direct + 100k Chase UR = 120k max.
    const r = canAfford("FLYING_BLUE", 150000, balances)
    expect(r.affordable).toBe(false)
    expect(r.totalAvailable).toBe(120000)
    expect(r.shortfall).toBe(30000)
  })

  it("shortfall equals the full amount for a program with no path at all", () => {
    const r = canAfford("MILES_AND_MORE", 56000, balances)
    expect(r.affordable).toBe(false)
    expect(r.shortfall).toBe(56000)
  })

  it("orders funding paths with the direct balance first", () => {
    const paths = findFundingPaths("AEROPLAN", 60000, balances)
    expect(paths[0]!.transferTime).toBe("already have")
  })
})

describe("CPP provenance (§cpp must not hide its basis)", () => {
  function award(): Parameters<typeof scoreFlights>[0][number] {
    return {
      id: "aw", source: "roame", type: "award", origin: "PRG", destination: "BKK",
      airline: "OS", operatingAirlines: ["OS"], flightNumbers: ["OS 25"], stops: 1,
      durationMinutes: 715, departureTime: "2026-11-10T10:20", arrivalTime: "2026-11-11T06:15",
      airports: ["PRG", "VIE", "BKK"], cabinClass: "business", equipment: [],
      points: 70000, pointsProgram: "AEROPLAN", cashPrice: null, taxes: 80, currency: "USD",
      cppValue: null, roameScore: null, availableSeats: 2, bookingUrl: "x", fareClass: "",
      travelDate: "2026-11-10",
    }
  }
  function cash(verificationLevel: "verified" | "discovered") {
    return {
      ...award(), id: `cash-${verificationLevel}`, type: "cash" as const,
      points: null, pointsProgram: null, cashPrice: 2800, taxes: 0,
      provider: verificationLevel === "verified" ? "serpapi" : "fast_flights",
      verificationLevel,
    }
  }

  it("inherits 'verified' when the cash comparable was metered-verified", () => {
    const { scored } = scoreFlights([award(), cash("verified")], syntheticBalances(), "PRG", "BKK")
    expect(scored.find(f => f.type === "award")!.cppBasis).toBe("verified")
  })

  it("inherits 'discovered' when the cash comparable is a free-provider price", () => {
    const { scored } = scoreFlights([award(), cash("discovered")], syntheticBalances(), "PRG", "BKK")
    expect(scored.find(f => f.type === "award")!.cppBasis).toBe("discovered")
  })

  it("labels 'estimated' when no real cash fare existed at all", () => {
    const { scored } = scoreFlights([award()], syntheticBalances(), "PRG", "BKK")
    const a = scored.find(f => f.type === "award")!
    expect(a.cashSource).toBe("estimated")
    expect(a.cppBasis).toBe("estimated")
  })
})

describe("hidden-city engine (§no invisible SerpAPI spend)", () => {
  /** Cash flights whose segments connect through BKK on the way to SIN. */
  function viaBkkFlight(price: number) {
    return makeFlight({
      destination: "SIN", returnDate: null, cabin: "economy",
      price: { amount: price, currency: "USD" },
      segments: [
        { origin: "PRG", destination: "BKK", departureTime: "2026-11-10T10:00", arrivalTime: "2026-11-10T22:00", airline: null, flightNumber: null, durationMinutes: 660, aircraft: null },
        { origin: "BKK", destination: "SIN", departureTime: "2026-11-11T01:00", arrivalTime: "2026-11-11T03:30", airline: null, flightNumber: null, durationMinutes: 150, aircraft: null },
      ],
    })
  }
  function directFlight(price: number) {
    return makeFlight({
      destination: "BKK", returnDate: null, cabin: "economy",
      price: { amount: price, currency: "USD" },
    })
  }

  it("finds a beyond-city itinerary cheaper than the direct fare", async () => {
    // BKK is a hub in data/hub-connections.json with beyond cities incl. SIN.
    const provider = new MockProvider({
      name: "free_mock",
      flights: [directFlight(900)],   // direct search result
    })
    // Different flights per call: first call = direct, later calls = beyond.
    let call = 0
    provider.search = async (query, options = {}) => {
      provider.calls.push({ query, options })
      call++
      const flights = (call === 1 ? [directFlight(900)] : [viaBkkFlight(520)])
        .map(f => ({ ...f, provider: "free_mock" }))
      return { provider: "free_mock", ok: true, flights, callsSpent: 0, latencyMs: 1 }
    }
    setProviders([provider])
    process.env.HIDDEN_CITY_MAX_BEYOND = "2"

    const out = await searchHiddenCity({
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10", currency: "USD",
    }, { db, source: "test" })

    expect(out.opportunities.length).toBeGreaterThan(0)
    const opp = out.opportunities[0]!
    expect(opp.hiddenCity).toBe(true)
    expect(opp.savings).toBeGreaterThanOrEqual(30)
    expect(opp.warnings.join(" ")).toContain("checked bags")
    expect(opp.riskLevel).toBeTruthy()
    expect(out.callsSpent).toBe(0)     // free provider throughout
  })

  it("respects the SerpAPI budget guard — exhausted budget means zero spend, not a crash", async () => {
    // Free provider finds nothing; metered provider refuses (budget-exhausted).
    setProviders([
      new MockProvider({ name: "free_mock", fail: "no-results" }),
      new MockProvider({ name: "metered_mock", kind: "metered", fail: "budget-exhausted", callsPerSearch: 0 }),
    ])
    process.env.HIDDEN_CITY_MAX_BEYOND = "2"

    const out = await searchHiddenCity({
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10", currency: "USD",
    }, { db, source: "test" })

    expect(out.opportunities).toEqual([])
    expect(out.callsSpent).toBe(0)
    expect(out.notes.join(" ")).toContain("cannot compare")
  })

  it("serves a repeated hidden-city sweep from the cash cache", async () => {
    const provider = new MockProvider({ name: "free_mock", flights: [directFlight(900)] })
    setProviders([provider])
    process.env.HIDDEN_CITY_MAX_BEYOND = "2"
    const q = { origin: "PRG", destination: "BKK", departureDate: "2026-11-10", currency: "USD" }

    await searchHiddenCity(q, { db, source: "test" })
    const callsAfterFirst = provider.calls.length
    await searchHiddenCity(q, { db, source: "test" })
    // Second sweep: every underlying cash search is a cache hit.
    expect(provider.calls.length).toBe(callsAfterFirst)
  })
})

describe("Phase 3 migration (§populated Phase 2 DB survives)", () => {
  it("applies 002 to a database that only has 001, preserving cash history", () => {
    const file = path.join(os.tmpdir(), `travel-radar-mig-${process.pid}-${Math.floor(Math.random() * 1e6)}.db`)
    const raw = new Database(file)
    try {
      // Build a "Phase 2" database: apply ONLY 001, then populate it.
      raw.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
      const sql001 = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "001_init.sql"), "utf-8")
      raw.exec(sql001)
      raw.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('001_init.sql', '2026-08-27T00:00:00Z')").run()
      raw.prepare(`INSERT INTO flight_prices (
        itinerary_hash, origin, destination, departure_date, cabin, adults,
        price_amount, price_currency, provider, verification_level, provider_confidence, fetched_at
      ) VALUES ('h1','PRG','BKK','2026-11-10','business',1,2814,'USD','fast_flights','discovered','medium','2026-08-27T10:00:00Z')`).run()

      // Phase 3 migration on the populated DB.
      const applied = migrate(raw as never)
      expect(applied).toContain("002_awards.sql")
      expect(applied).not.toContain("001_init.sql")   // never re-run

      // Old data intact, new tables present and usable.
      expect((raw.prepare("SELECT COUNT(*) c FROM flight_prices").get() as any).c).toBe(1)
      expect((raw.prepare("SELECT price_amount p FROM flight_prices").get() as any).p).toBe(2814)
      raw.prepare(`INSERT INTO award_prices (
        itinerary_hash, origin, destination, departure_date, cabin, loyalty_program,
        points, provider, verification_level, provider_confidence, fetched_at
      ) VALUES ('h1','PRG','BKK','2026-11-10','business','AEROPLAN',70000,'roame','discovered','high','2026-08-27T11:00:00Z')`).run()
      expect((raw.prepare("SELECT COUNT(*) c FROM award_prices").get() as any).c).toBe(1)
    } finally {
      raw.close()
      fs.rmSync(file, { force: true })
    }
  })
})

describe("results.json independence (§SQLite is the persistence source)", () => {
  it("persists and reloads a full search result through the database alone", () => {
    const id = recordSearchRequest(db, {
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10",
      returnDate: null, cabin: "both", adults: 1, currency: "USD",
    }, "test")
    const payload = { meta: { origin: "PRG", destination: "BKK" }, flights: [{ id: "f1" }] }
    saveSearchResult(db, id, payload)

    const latest = latestSearchResult(db)
    expect(latest).not.toBeNull()
    expect(latest!.searchRequestId).toBe(id)
    expect((latest!.payload as any).meta.origin).toBe("PRG")
  })

  it("overwrites the payload for the same search id rather than duplicating", () => {
    const id = recordSearchRequest(db, {
      origin: "PRG", destination: "BKK", departureDate: "2026-11-10",
      returnDate: null, cabin: "both", adults: 1, currency: "USD",
    }, "test")
    saveSearchResult(db, id, { v: 1 })
    saveSearchResult(db, id, { v: 2 })
    expect((db.prepare("SELECT COUNT(*) c FROM search_results").get() as any).c).toBe(1)
    expect((latestSearchResult(db)!.payload as any).v).toBe(2)
  })

  it("returns null (→ HTTP 404) when nothing was ever persisted", () => {
    expect(latestSearchResult(db)).toBeNull()
  })
})

describe("provider usage accounting keeps awardwallet visible", () => {
  it("readUsage creates and reads the awardwallet row like any provider", () => {
    const usage = readUsage(db, "awardwallet")
    expect(usage.attempted).toBe(0)
  })
})
