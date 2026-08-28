import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, nowIso, type DB } from "../db/index.js"
import { packageBaseline, seasonalPosition } from "../packages/baseline.js"
import { capsFor, reservePackageSearch } from "../packages/budget.js"
import { packageBaselineFamily, packageKeyForOffer } from "../packages/identity.js"
import {
  createPackageSearchRequest,
  latestPackageObservations,
  packageSearchesToday,
  recordPackageObservations,
} from "../packages/store.js"
import { makeOffer } from "./package-mocks.js"

let db: DB

function seedProperty(id = "lily-beach-resort"): void {
  db.prepare(`
    INSERT INTO stay_properties (id, name, destination_group, country, nearest_airports, luxury_tier,
      all_inclusive, default_board, typical_stay_nights, priority, active, created_at, updated_at)
    VALUES (?, 'Lily Beach Resort & Spa', 'maldives', 'Maldives', '["MLE"]', 'luxury',
      'only', 'all_inclusive', '[5,7]', 1, 1, ?, ?)
  `).run(id, nowIso(), nowIso())
}

function request(kind: "calendar" | "offers" | "confirmation" = "calendar", provider = "tui_packages", source: "cli" | "test" = "cli"): number {
  return createPackageSearchRequest(db, {
    provider, kind, propertyId: "lily-beach-resort", origin: "VIE",
    rangeStart: "2026-10-01", rangeEnd: "2027-03-31", nights: 5,
    adults: 2, children: 0, currency: "EUR", source,
  })
}

beforeEach(() => {
  db = createMemoryDb()
  seedProperty()
})

describe("package identity", () => {
  it("is stable across repricing: same product, different price, same key", () => {
    const a = makeOffer({ totalPrice: { amount: 6628, currency: "EUR" } })
    const b = makeOffer({ totalPrice: { amount: 5900, currency: "EUR" }, pricePerPerson: 2950 })
    expect(packageKeyForOffer(a)).toBe(packageKeyForOffer(b))
  })

  it("changes with every hard dimension: seller, board, cabin, occupancy, origin, currency", () => {
    const base = packageKeyForOffer(makeOffer())
    expect(packageKeyForOffer(makeOffer({ provider: "check24_packages" }))).not.toBe(base)
    expect(packageKeyForOffer(makeOffer({ board: "half_board" }))).not.toBe(base)
    expect(packageKeyForOffer(makeOffer({ cabin: "business" }))).not.toBe(base)
    expect(packageKeyForOffer(makeOffer({ adults: 1 }))).not.toBe(base)
    expect(packageKeyForOffer(makeOffer({ origin: "MUC" }))).not.toBe(base)
    expect(packageKeyForOffer(makeOffer({ totalPrice: { amount: 6628, currency: "USD" } }))).not.toBe(base)
  })

  it("groups check-ins on the fixed 3-day date grid", () => {
    const base = packageKeyForOffer(makeOffer({ checkIn: "2026-11-19" }))
    const sameFamily = packageKeyForOffer(makeOffer({ checkIn: "2026-11-20", checkOut: "2026-11-25" }))
    const otherFamily = packageKeyForOffer(makeOffer({ checkIn: "2026-11-26", checkOut: "2026-12-01" }))
    expect(sameFamily).toBe(base)
    expect(otherFamily).not.toBe(base)
  })

  it("derives the baseline family by dropping only the date component", () => {
    const key = packageKeyForOffer(makeOffer())
    const family = packageBaselineFamily(key)
    expect(family).not.toContain(key.split("|")[4])
    expect(family).toContain("tui_packages")
    expect(family).toContain("all_inclusive")
  })
})

describe("append-only observations", () => {
  it("stores duplicates as new rows and reads the latest per (key, check-in) by MAX(id)", () => {
    const r1 = request()
    recordPackageObservations(db, [makeOffer({ totalPrice: { amount: 6628, currency: "EUR" } })], r1)
    const r2 = request()
    recordPackageObservations(db, [makeOffer({ totalPrice: { amount: 5900, currency: "EUR" } })], r2)

    const all = db.prepare("SELECT COUNT(*) n FROM package_offer_observations").get() as { n: number }
    expect(all.n).toBe(2)

    const latest = latestPackageObservations(db)
    expect(latest).toHaveLength(1)
    expect(latest[0].totalPrice).toBe(5900)   // MAX(id), not a timestamp comparison
  })

  it("excludes stale observations from the fresh view without deleting them", () => {
    const r1 = request()
    recordPackageObservations(db, [makeOffer({ fetchedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })], r1)
    expect(latestPackageObservations(db, { maxAgeDays: 7 })).toHaveLength(0)
    expect(latestPackageObservations(db)).toHaveLength(1)
  })
})

describe("package baselines — history, not curve snapshots", () => {
  it("refuses to manufacture maturity from one calendar response: many rows, one fetch day → immature", () => {
    const r1 = request()
    const day = "2026-08-28T10:00:00.000Z"
    // Six observations of the same product from ONE fetch — a snapshot.
    recordPackageObservations(db, Array.from({ length: 6 }, () => makeOffer({ fetchedAt: day })), r1)
    const result = packageBaseline(db, packageKeyForOffer(makeOffer()), "2026-09-15T00:00:00.000Z")
    expect(result.mature).toBe(false)
    if (!result.mature) {
      expect(result.distinctFetchDays).toBe(1)
      expect(result.reason).toMatch(/distinct fetch days/)
    }
  })

  it("matures once the SAME product has been re-observed across enough fetch days, and yields a median", () => {
    for (const [day, price] of [["2026-08-20", 6600], ["2026-08-20", 6620], ["2026-08-23", 6400], ["2026-08-23", 6500], ["2026-08-26", 6700], ["2026-08-26", 6800]] as const) {
      recordPackageObservations(db, [makeOffer({
        fetchedAt: `${day}T09:00:00.000Z`, totalPrice: { amount: price, currency: "EUR" },
      })], request())
    }
    const result = packageBaseline(db, packageKeyForOffer(makeOffer()), "2026-09-01T00:00:00.000Z")
    expect(result.mature).toBe(true)
    if (result.mature) {
      expect(result.samples).toBe(6)
      expect(result.distinctFetchDays).toBe(3)
      expect(result.median).toBe(6610)
    }
  })

  it("enforces no-look-ahead: observations at or after as-of never join the baseline", () => {
    for (const day of ["2026-08-20", "2026-08-23", "2026-08-26", "2026-09-10", "2026-09-11", "2026-09-12"]) {
      recordPackageObservations(db, [makeOffer({ fetchedAt: `${day}T09:00:00.000Z` })], request())
    }
    const early = packageBaseline(db, packageKeyForOffer(makeOffer()), "2026-08-27T00:00:00.000Z")
    expect(early.mature).toBe(false)             // only 3 observations before as-of
    if (!early.mature) expect(early.samples).toBe(3)
  })

  it("excludes the judged request's own siblings by id, never by timestamp", () => {
    const judged = request()
    for (const day of ["2026-08-20", "2026-08-23", "2026-08-26"]) {
      recordPackageObservations(db, [
        makeOffer({ fetchedAt: `${day}T09:00:00.000Z` }),
        makeOffer({ fetchedAt: `${day}T09:00:00.000Z` }),
      ], day === "2026-08-26" ? judged : request())
    }
    const withSiblings = packageBaseline(db, packageKeyForOffer(makeOffer()), "2026-09-01T00:00:00.000Z", null)
    const withoutSiblings = packageBaseline(db, packageKeyForOffer(makeOffer()), "2026-09-01T00:00:00.000Z", judged)
    expect(withSiblings.samples).toBe(6)
    expect(withoutSiblings.samples).toBe(4)
  })

  it("labels the seasonal curve position as NOT history", () => {
    const r1 = request()
    recordPackageObservations(db, [
      makeOffer({ checkIn: "2026-11-08", checkOut: "2026-11-13", totalPrice: { amount: 6392, currency: "EUR" } }),
      makeOffer({ checkIn: "2026-11-19", checkOut: "2026-11-24", totalPrice: { amount: 9498, currency: "EUR" } }),
      makeOffer({ checkIn: "2026-12-29", checkOut: "2027-01-03", totalPrice: { amount: 13268, currency: "EUR" } }),
    ], r1)
    const position = seasonalPosition(db, r1, "2026-11-19")
    expect(position).not.toBeNull()
    expect(position!.percentile).toBe(0.5)
    expect(position!.note).toBe("curve_position_not_history")
  })
})

describe("request ceilings — reserve before await, refusals recorded", () => {
  it("refuses beyond the per-run ceiling and records a skipped event", () => {
    const caps = capsFor("tui_packages")
    const input = {
      provider: "tui_packages", kind: "calendar" as const, propertyId: "lily-beach-resort",
      origin: "VIE", rangeStart: null, rangeEnd: null, nights: 5,
      adults: 2, children: 0, currency: "EUR", source: "cli" as const,
    }
    const refused = reservePackageSearch(db, input, caps.perRun)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toMatch(/run ceiling/)
    const events = db.prepare("SELECT kind FROM provider_events WHERE provider = 'tui_packages'").all() as { kind: string }[]
    expect(events.some(e => e.kind === "skipped")).toBe(true)
  })

  it("refuses beyond the daily ceiling counted from stored search requests", () => {
    const caps = capsFor("check24_packages")
    for (let i = 0; i < caps.perDay; i++) request("confirmation", "check24_packages", "cli")
    expect(packageSearchesToday(db, "check24_packages")).toBe(caps.perDay)
    const refused = reservePackageSearch(db, {
      provider: "check24_packages", kind: "confirmation", propertyId: "lily-beach-resort",
      origin: "VIE", rangeStart: null, rangeEnd: null, nights: 5,
      adults: 2, children: 0, currency: "EUR", source: "cli",
    }, 0)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toMatch(/daily ceiling/)
  })

  it("grants a reservation inside the ceilings and the reservation itself counts against the day", () => {
    const granted = reservePackageSearch(db, {
      provider: "tui_packages", kind: "calendar", propertyId: "lily-beach-resort",
      origin: "VIE", rangeStart: null, rangeEnd: null, nights: 5,
      adults: 2, children: 0, currency: "EUR", source: "cli",
    }, 0)
    expect(granted.ok).toBe(true)
    expect(packageSearchesToday(db, "tui_packages")).toBe(1)
  })

  it("an unknown provider has NO budget, not an accidental infinite one", () => {
    const refused = reservePackageSearch(db, {
      provider: "mystery_packages", kind: "calendar", propertyId: null,
      origin: "VIE", rangeStart: null, rangeEnd: null, nights: 5,
      adults: 2, children: 0, currency: "EUR", source: "cli",
    }, 0)
    expect(refused.ok).toBe(false)
  })
})
