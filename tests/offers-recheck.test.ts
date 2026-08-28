import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { buildPackageLocator, getLocator, upsertLocator } from "../offers/locators.js"
import {
  freshnessFor,
  latestVerification,
  offerStateFor,
  recheckOffer,
} from "../offers/recheck.js"
import { getPackageObservation, recordPackageObservations } from "../packages/store.js"
import type { PackageProvider, PackageSearchResult, NormalizedPackageOffer } from "../providers/packages/types.js"
import { makeOffer } from "./package-mocks.js"
import { seedProperty } from "./market-mocks.js"

let db: DB

function seedLocator(over: Parameters<typeof makeOffer>[0] = {}): number {
  const [obsId] = recordPackageObservations(db, [makeOffer(over)], null)
  return upsertLocator(db, buildPackageLocator(getPackageObservation(db, obsId)!))
}

/** A package provider whose searchOffers returns a canned result. */
function mockProvider(
  outcome: Partial<PackageSearchResult> & { offers?: NormalizedPackageOffer[] },
): { provider: PackageProvider; calls: number[] } {
  const calls: number[] = []
  const provider: PackageProvider = {
    name: "tui_packages", kind: "free", confidence: "medium",
    capabilities: { calendar: true, datedOffers: true, multiOperator: false, flightIdentity: true, priceSplit: true, taxesFees: "included" },
    isConfigured: () => true,
    health: async () => ({ provider: "tui_packages", status: "ok", detail: "", latencyMs: null, checkedAt: "", quota: null }),
    quota: () => null,
    searchOffers: async () => {
      calls.push(1)
      return {
        provider: "tui_packages", ok: outcome.ok ?? true,
        offers: outcome.offers ?? [], reason: outcome.reason, error: outcome.error,
        callsSpent: 1, latencyMs: 5,
      }
    },
  }
  return { provider, calls }
}

beforeEach(() => {
  db = createMemoryDb()
  seedProperty(db)
})

describe("recheck outcomes", () => {
  it("verified: the same offer re-resolves with every checked dimension equal", async () => {
    const locatorId = seedLocator()
    const { provider } = mockProvider({ offers: [makeOffer()] })   // identical quote
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })
    expect(result.status).toBe("verified")
    expect(result.currentPrice).toBe(6628)
    expect(result.changes).toEqual([])
    expect(offerStateFor(latestVerification(db, locatorId))).toBe("VERIFIED")
  })

  it("changed price is a NEW observation: the historical price, observation and locator survive untouched", async () => {
    const locatorId = seedLocator()                                 // observed 6,908-style EUR 6,628
    const { provider } = mockProvider({
      offers: [makeOffer({ totalPrice: { amount: 7104, currency: "EUR" }, pricePerPerson: 3552 })],
    })
    const before = db.prepare("SELECT COUNT(*) n FROM package_offer_observations").get() as { n: number }
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })

    expect(result.status).toBe("changed")
    expect(result.observedPrice).toBe(6628)
    expect(result.currentPrice).toBe(7104)
    expect(result.changes).toEqual([{ dimension: "price", observed: 6628, current: 7104 }])

    // New observation rows appended; the original one unchanged.
    const after = db.prepare("SELECT COUNT(*) n FROM package_offer_observations").get() as { n: number }
    expect(after.n).toBe(before.n + 1)
    const original = db.prepare("SELECT total_price FROM package_offer_observations WHERE id = 1").get() as { total_price: number }
    expect(original.total_price).toBe(6628)
    // The locator's stored link/price is NOT overwritten by verification.
    const locator = getLocator(db, locatorId)!
    expect(locator.nativePrice).toBe(6628)
    expect(offerStateFor(latestVerification(db, locatorId))).toBe("CHANGED")
  })

  it("a transfer-inclusion change is a recorded dimension change, never silently the same offer", async () => {
    const locatorId = seedLocator({ transfer: "included" })
    const { provider } = mockProvider({ offers: [makeOffer({ transfer: "not_included" })] })
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })
    expect(result.status).toBe("changed")
    expect(result.changes.some(c => c.dimension === "transfer")).toBe(true)
  })

  it("unavailable: the offer is gone, the historical observation is NOT destroyed", async () => {
    const locatorId = seedLocator()
    const { provider } = mockProvider({ ok: false, reason: "no-results", error: "no offers" })
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })
    expect(result.status).toBe("unavailable")
    const original = db.prepare("SELECT COUNT(*) n FROM package_offer_observations").get() as { n: number }
    expect(original.n).toBe(1)
    expect(offerStateFor(latestVerification(db, locatorId))).toBe("UNAVAILABLE")
  })

  it("a different operator's offers do not masquerade as ours — unavailable, with the new data still stored", async () => {
    const locatorId = seedLocator({ tourOperator: "LTUR" })
    const { provider } = mockProvider({ offers: [makeOffer({ tourOperator: "TUID" })] })
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })
    expect(result.status).toBe("unavailable")
    expect(result.newObservationIds.length).toBe(1)                 // the recheck's data is kept as observations
  })

  it("blocked: ONE provider call, no retry loop, named result", async () => {
    const locatorId = seedLocator()
    const { provider, calls } = mockProvider({ ok: false, reason: "blocked", error: "bot wall answered" })
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })
    expect(result.status).toBe("blocked")
    expect(calls.length).toBe(1)
    // A second recheck is a NEW deliberate act, not an automatic retry:
    expect((db.prepare("SELECT COUNT(*) n FROM offer_verifications").get() as { n: number }).n).toBe(1)
  })

  it("unsupported navigation/recheck gives a named result — never a guess", async () => {
    // A flight locator has no recheck resolver.
    db.prepare(`
      INSERT INTO offer_locators (kind, source_table, source_id, provider, navigation_quality,
        search_replay_params, provider_ids, observed_at, created_at)
      VALUES ('flight', 'flight_prices', 99, 'fast_flights', 'SEARCH_REPLAY_LINK', '{}', '{}', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString())
    const locatorId = (db.prepare("SELECT id FROM offer_locators WHERE source_id = 99").get() as { id: number }).id
    const result = await recheckOffer(db, locatorId)
    expect(result.status).toBe("unsupported")
    expect(result.detail).toMatch(/named limitation/)
  })

  it("a provider-stated expiry in the past short-circuits to expired without any provider call", async () => {
    const locatorId = seedLocator()
    db.prepare("UPDATE offer_locators SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(locatorId)
    const { provider, calls } = mockProvider({ offers: [makeOffer()] })
    const result = await recheckOffer(db, locatorId, { packageProvider: provider })
    expect(result.status).toBe("expired")
    expect(calls.length).toBe(0)
  })

  it("verifications are append-only history: a re-verified offer keeps its CHANGED record", async () => {
    const locatorId = seedLocator()
    await recheckOffer(db, locatorId, {
      packageProvider: mockProvider({ offers: [makeOffer({ totalPrice: { amount: 7104, currency: "EUR" } })] }).provider,
    })
    await recheckOffer(db, locatorId, { packageProvider: mockProvider({ offers: [makeOffer()] }).provider })
    const rows = db.prepare("SELECT status FROM offer_verifications WHERE locator_id = ? ORDER BY id").all(locatorId) as { status: string }[]
    expect(rows.map(r => r.status)).toEqual(["changed", "verified"])
    expect(offerStateFor(latestVerification(db, locatorId))).toBe("VERIFIED")
  })
})

describe("freshness", () => {
  it("derives explicit observed/verified ages — no invented 'still available' language anywhere", async () => {
    const locatorId = seedLocator()
    const locator = getLocator(db, locatorId)!
    const noVerification = freshnessFor(locator, null, new Date(Date.parse(locator.observedAt) + 8 * 60_000))
    expect(noVerification.observedAgoMinutes).toBe(8)
    expect(noVerification.verifiedAgoMinutes).toBeNull()
    expect(noVerification.recentlyVerified).toBe(false)

    await recheckOffer(db, locatorId, { packageProvider: mockProvider({ offers: [makeOffer()] }).provider })
    const verification = latestVerification(db, locatorId)!
    const fresh = freshnessFor(locator, verification, new Date(Date.parse(verification.checkedAt) + 60_000))
    expect(fresh.recentlyVerified).toBe(true)

    const stale = freshnessFor(locator, null, new Date(Date.parse(locator.observedAt) + 3 * 24 * 60 * 60_000))
    expect(stale.staleObservation).toBe(true)
  })
})
