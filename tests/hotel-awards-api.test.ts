/**
 * Hotel Award Radar read-out — the API shape and the page's honesty wiring.
 *
 * The route is read-only over hotel_award_observations; this pins that stored
 * observations are exposed unchanged, the program filter works, per-night
 * stays never gain a synthesized total, unknown taxes stay unknown, unknown
 * availability carries bounded wording on the page, provider identity is
 * preserved, and an empty DB renders cleanly.
 */

import fs from "fs"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { insertHotelAwards, listHotelAwards } from "../providers/hotel-awards/store.js"
import { applicablePerks, loadEntitlements, loadHotelPerkRules } from "../providers/hotel-awards/perks.js"
import type { NormalizedHotelAward } from "../providers/hotel-awards/types.js"

// The route body is small and lives in serve.ts (which starts a listener on
// import); replicate its exact read+serialize here so we test the same logic
// without booting the server. Kept in lockstep with serve.ts /api/hotel-awards.
function hotelAwardsPayload(db: DB, opts: { limit?: number; program?: string } = {}) {
  const perkRules = loadHotelPerkRules(true)
  const entitlements = loadEntitlements(true)
  const observations = listHotelAwards(db, {
    limit: opts.limit ?? 100,
    program: opts.program,
  }).map(o => ({
    ...o,
    perks: applicablePerks({ program: o.program, chain: o.chain, nights: o.nights, checkIn: o.checkIn }, perkRules, entitlements),
    navigation: { quality: "UNAVAILABLE", url: null },
  }))
  return {
    programs: [...new Set(listHotelAwards(db, { limit: 500 }).map(o => o.program))].sort(),
    providers: [...new Set(listHotelAwards(db, { limit: 500 }).map(o => o.provider))].sort(),
    count: observations.length,
    observations,
  }
}

function award(over: Partial<NormalizedHotelAward> = {}): NormalizedHotelAward {
  return {
    provider: "roame_hotels", providerPropertyRef: "bkkzs", propertyId: null,
    propertyName: "Hyatt Place Bangkok", chain: "PLACE",
    program: "WORLD_OF_HYATT", sourceProgramName: "HYATT",
    checkIn: "2026-11-21", checkOut: "2026-11-26", nights: 5,
    quoteBasis: "per_night", roomClass: "GuestRoom", roomName: "1 King Bed",
    pointsTotal: null, pointsPerNight: 4500,
    taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
    awardType: "points", cashComparisonAmount: 104, cashComparisonCurrency: "USD",
    availabilityState: "unknown", searchState: "complete", verificationLevel: "discovered",
    sourceFreshness: "2026-08-28T04:21:19Z", bookingUrl: null,
    fetchedAt: "2026-08-28T21:00:00.000Z",
    ...over,
  }
}

let db: DB
beforeEach(() => { db = createMemoryDb() })

describe("the /api/hotel-awards payload", () => {
  it("exposes stored observations unchanged (per-night, no synthesized total)", () => {
    insertHotelAwards(db, [award()])
    const p = hotelAwardsPayload(db)
    expect(p.count).toBe(1)
    const o = p.observations[0]
    expect(o.provider).toBe("roame_hotels")
    expect(o.quoteBasis).toBe("per_night")
    expect(o.pointsPerNight).toBe(4500)
    expect(o.pointsTotal).toBeNull()                       // 4500 × 5 is never introduced by the read-out
    expect(o.program).toBe("WORLD_OF_HYATT")
  })

  it("filters by program", () => {
    insertHotelAwards(db, [award(), award({ providerPropertyRef: "h2", program: "HILTON_HONORS", sourceProgramName: "HILTON" })])
    expect(hotelAwardsPayload(db).count).toBe(2)
    const hilton = hotelAwardsPayload(db, { program: "HILTON_HONORS" })
    expect(hilton.count).toBe(1)
    expect(hilton.observations[0].program).toBe("HILTON_HONORS")
  })

  it("preserves provider identity and lists distinct programs/providers", () => {
    insertHotelAwards(db, [
      award(),
      award({ provider: "gondola_hotels", providerPropertyRef: "39678735", program: "MARRIOTT_BONVOY", sourceProgramName: "Marriott (Bonvoy)", quoteBasis: "full_stay", pointsTotal: 200000, pointsPerNight: 40000 }),
    ])
    const p = hotelAwardsPayload(db)
    expect(p.providers).toEqual(["gondola_hotels", "roame_hotels"])
    expect(p.programs).toEqual(["MARRIOTT_BONVOY", "WORLD_OF_HYATT"])
    expect(new Set(p.observations.map(o => o.provider))).toEqual(new Set(["roame_hotels", "gondola_hotels"]))
  })

  it("unknown taxes stay unknown; a positive stated surcharge is carried", () => {
    insertHotelAwards(db, [
      award(),
      award({ providerPropertyRef: "h3", taxesFeesState: "stated", taxesFeesAmount: 38.5, taxesFeesCurrency: "USD" }),
    ])
    const rows = hotelAwardsPayload(db).observations
    expect(rows.find(o => o.providerPropertyRef === "bkkzs")!.taxesFeesState).toBe("unknown")
    expect(rows.find(o => o.providerPropertyRef === "bkkzs")!.taxesFeesAmount).toBeNull()
    expect(rows.find(o => o.providerPropertyRef === "h3")!.taxesFeesState).toBe("stated")
  })

  it("newest first", () => {
    insertHotelAwards(db, [award({ providerPropertyRef: "old" })])
    insertHotelAwards(db, [award({ providerPropertyRef: "new" })])
    expect(hotelAwardsPayload(db).observations[0].providerPropertyRef).toBe("new")
  })

  it("perk badges are pure enrichment — every stored observation field is unchanged and no number is synthesized", () => {
    insertHotelAwards(db, [award({ program: "MARRIOTT_BONVOY", sourceProgramName: "MARRIOTT", chain: "Marriott" })])
    const o = hotelAwardsPayload(db).observations[0]
    // The 5-night Marriott stay picks up the verified 5th-night rule…
    const b = o.perks.find(p => p.ruleId === "marriott-award-5th-night-free")
    expect(b).toBeDefined()
    expect(b!.eligibility).toBe("purchasable")             // nothing held by default — never inferred
    // …while the observation itself is exposed exactly as stored.
    expect(o.pointsPerNight).toBe(4500)
    expect(o.pointsTotal).toBeNull()                       // a rule NEVER licenses avg × nights
    expect(o.quoteBasis).toBe("per_night")
    expect(listHotelAwards(db, { limit: 10 })[0].pointsTotal).toBeNull()
  })

  it("a stay below a rule's minimum nights gets no badge for it", () => {
    insertHotelAwards(db, [award({ program: "MARRIOTT_BONVOY", sourceProgramName: "MARRIOTT", chain: "Marriott", checkOut: "2026-11-24", nights: 3 })])
    const o = hotelAwardsPayload(db).observations[0]
    expect(o.perks.find(p => p.ruleId === "marriott-award-5th-night-free")).toBeUndefined()
  })

  it("an empty DB serializes cleanly", () => {
    const p = hotelAwardsPayload(db)
    expect(p.count).toBe(0)
    expect(p.observations).toEqual([])
    expect(p.programs).toEqual([])
    expect(p.providers).toEqual([])
  })
})

describe("serve.ts wiring + page honesty", () => {
  it("serve.ts registers the read-only route calling listHotelAwards", () => {
    const s = fs.readFileSync("serve.ts", "utf-8")
    expect(s).toContain('url.pathname === "/api/hotel-awards"')
    expect(s).toContain("listHotelAwards")
    // The hotel-awards disclaimer uses no comparison/saving language.
    expect(s).toMatch(/never a synthesized stay total/)
    const disclaimer = s.slice(s.indexOf("Points STAYS observed"), s.indexOf("Points STAYS observed") + 400)
    expect(disclaimer).not.toMatch(/saving/i)
    expect(disclaimer).toMatch(/context only, never a comparison/i)
  })

  it("the page renders per-night points and the bounded-availability wording, never a synthesized total", () => {
    const html = fs.readFileSync("hotel-awards.html", "utf-8")
    expect(html).toContain("/api/hotel-awards")
    expect(html).toContain("pts/night")
    expect(html).toContain("Historical/period award observation — not a live hold.")
    expect(html).toMatch(/cash context[^<]*not a comparison/)
    // No multiplication of per-night into a total anywhere in the card code.
    expect(html).not.toMatch(/pointsPerNight\s*\*/)
    // Perk badges render all three declared eligibility states, display-only.
    expect(html).toContain("perkBadges(o)")
    expect(html).toContain("needs status/card")
    expect(html).toContain("join free")
    expect(html).toMatch(/display only/i)
    // Only source_page rules may present as verified; the rest are marked.
    expect(html).toContain('p.verification === "source_page"')
    expect(html).toContain("Source-verified")
    expect(html).toContain("UNVERIFIED")
    expect(html).toContain("· unverified")
    expect(html).not.toMatch(/\*\s*o?\.?nights/)
  })

  it("Observer links to the hotel-awards page for discoverability", () => {
    const obs = fs.readFileSync("observer.html", "utf-8")
    expect(obs).toContain('href="/hotel-awards.html"')
  })
})
