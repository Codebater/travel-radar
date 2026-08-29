/**
 * Hotel Award Radar toolbar sorting + buy-points enrichment + points cost
 * calculator (presentation layer).
 *
 * Pinned: sort modes over observations exactly as stored (newest default
 * untouched, nulls last, currencies never converted); promo matching by the
 * observation's own loyaltyProgram through the SHARED hotel promo index
 * (promo-enrich.js — expired/unmapped never qualify); acquisition math that
 * exists only with an explicit source-stated purchase rate and NEVER touches
 * stay nights (an average points/night can never become a stay total); a
 * source-stated full-stay total staying usable on explicit choice; and the
 * page wiring (labels say cost to BUY points, perks stay visible, details
 * prose is a disclosure).
 */

import fs from "fs"
import { describe, expect, it } from "vitest"
import { activePromoIndex } from "../promo-enrich.js"
import {
  acquisitionPerNightCents, buyPointsCostCents, centsToDollars, sortObservations,
} from "../hotel-awards-ui.js"

function obs(over: Record<string, unknown> = {}) {
  return {
    program: "MARRIOTT_BONVOY",
    pointsPerNight: 30000 as number | null,
    cashComparisonAmount: 200 as number | null,
    cashComparisonCurrency: "USD" as string | null,
    nights: 5,
    ...over,
  }
}

function hotelPromo(over: Record<string, unknown> = {}) {
  return {
    category: "hotel", sourceProgramName: "Marriott (Bonvoy)", loyaltyProgram: "MARRIOTT_BONVOY",
    active: true, bonusPercent: 50, discountPercent: null, upTo: false,
    effectiveCostPerMile: 0.83, currency: "USD", validUntil: "2026-09-25", endDateKnown: true,
    sourceUrl: "https://example.invalid",
    ...over,
  }
}

const feed = (promos: unknown[]) => ({ ok: true, promos })

describe("sorting", () => {
  it("newest (the default) and unknown modes return an untouched copy", () => {
    const rows = [obs({ pointsPerNight: 5000 }), obs({ pointsPerNight: 2000 })]
    expect(sortObservations(rows, "newest", {})).toEqual(rows)
    expect(sortObservations(rows, "nonsense", {})).toEqual(rows)
    expect(sortObservations(rows, "newest", {})).not.toBe(rows)   // a copy, never a mutation
  })

  it("points/night ascending, rows without a stated figure last in original order", () => {
    const rows = [obs({ pointsPerNight: 5000 }), obs({ pointsPerNight: null, program: "A1" }), obs({ pointsPerNight: 2000 }), obs({ pointsPerNight: null, program: "A2" })]
    expect(sortObservations(rows, "points", {}).map(r => r.pointsPerNight ?? r.program)).toEqual([2000, 5000, "A1", "A2"])
  })

  it("cash context ascending — USD first, other currencies grouped after (never converted), no-cash last", () => {
    const rows = [
      obs({ cashComparisonAmount: 200, cashComparisonCurrency: "USD" }),
      obs({ cashComparisonAmount: 10, cashComparisonCurrency: "THB" }),
      obs({ cashComparisonAmount: null, cashComparisonCurrency: null }),
      obs({ cashComparisonAmount: 50, cashComparisonCurrency: "USD" }),
    ]
    expect(sortObservations(rows, "cash", {}).map(r => `${r.cashComparisonCurrency ?? "-"}${r.cashComparisonAmount ?? ""}`))
      .toEqual(["USD50", "USD200", "THB10", "-"])
  })

  it("buy-points: only programs with an explicit current purchase rate participate; everyone else follows in original order", () => {
    const index = activePromoIndex(feed([
      hotelPromo(),                                                             // MARRIOTT, 0.83¢ explicit
      hotelPromo({ loyaltyProgram: "HILTON_HONORS", effectiveCostPerMile: null }), // badge-only promo — no rate
    ]), "hotel")
    const rows = [
      obs({ program: "WORLD_OF_HYATT", pointsPerNight: 1000 }),                 // no promo → non-participant
      obs({ pointsPerNight: 30000 }),                                           // 30000×0.83 = 24900¢
      obs({ program: "HILTON_HONORS", pointsPerNight: 500 }),                   // promo without rate → non-participant
      obs({ pointsPerNight: 10000 }),                                           // 10000×0.83 = 8300¢
      obs({ pointsPerNight: null }),                                            // no stated figure → non-participant
    ]
    const sorted = sortObservations(rows, "buypoints", index)
    expect(sorted.map(r => `${r.program}:${r.pointsPerNight}`)).toEqual([
      "MARRIOTT_BONVOY:10000", "MARRIOTT_BONVOY:30000",
      "WORLD_OF_HYATT:1000", "HILTON_HONORS:500", "MARRIOTT_BONVOY:null",
    ])
  })
})

describe("promo matching by program (the SHARED feed index)", () => {
  it("matches an observation's own loyaltyProgram; unmapped and airline-category rows never enter", () => {
    const index = activePromoIndex(feed([
      hotelPromo(),
      hotelPromo({ category: "airline", loyaltyProgram: "FLYING_BLUE" }),
      hotelPromo({ loyaltyProgram: null }),
    ]), "hotel")
    expect(Object.keys(index)).toEqual(["MARRIOTT_BONVOY"])
  })

  it("an expired promo never appears current", () => {
    const index = activePromoIndex(feed([hotelPromo({ active: false })]), "hotel")
    expect(index).toEqual({})
  })
})

describe("the buy-points calculation", () => {
  it("an explicit rate computes the estimated cost to BUY the points: 30,000 × 0.5¢ = $150", () => {
    expect(buyPointsCostCents(30000, 0.5)).toBe(15000)
    expect(centsToDollars(15000)).toBe("$150")
  })

  it("no explicit rate → no number, ever", () => {
    expect(buyPointsCostCents(30000, null)).toBeNull()
    expect(buyPointsCostCents(30000, undefined)).toBeNull()
    expect(buyPointsCostCents(30000, 0)).toBeNull()
    expect(acquisitionPerNightCents(obs(), activePromoIndex(feed([hotelPromo({ effectiveCostPerMile: null })]), "hotel"))).toBeNull()
    expect(acquisitionPerNightCents(obs(), {})).toBeNull()
  })

  it("NEVER synthesizes from nights: the per-night acquisition estimate is identical for a 2-night and a 30-night stay", () => {
    const index = activePromoIndex(feed([hotelPromo()]), "hotel")
    const a = acquisitionPerNightCents(obs({ nights: 2 }), index)
    const b = acquisitionPerNightCents(obs({ nights: 30 }), index)
    expect(a).toBe(24900)
    expect(b).toBe(24900)
    // And the implementation cannot even see nights — no property access exists.
    expect(fs.readFileSync("hotel-awards-ui.js", "utf-8")).not.toMatch(/\.nights\b/)
  })

  it("a source-stated full-stay total remains a legitimate input (explicit choice)", () => {
    expect(buyPointsCostCents(37500, 0.83)).toBe(31125)   // Gondola's stated '(37,500 pts total)'
  })
})

describe("page wiring", () => {
  const html = fs.readFileSync("hotel-awards.html", "utf-8")

  it("has the sort toolbar with the four modes and keeps the honest newest default", () => {
    for (const v of ["newest", "points", "cash", "buypoints"]) expect(html).toContain(`option value="${v}"`)
    expect(html).toMatch(/id="sort"/)
    expect(html).toContain('let SORT = "newest"')
    expect(html).toContain("HotelAwardsUI.sortObservations(rows, SORT, PROMOS)")
  })

  it("reuses the shared promo feed and joins by the card's own program — no second feed anywhere", () => {
    expect(html).toContain('src="./promo-enrich.js"')
    expect(html).toContain('src="./hotel-awards-ui.js"')
    expect(html).toContain('PromoEnrich.activePromoIndex(await (await fetch("/api/promos/miles")).json(), "hotel")')
    expect(html).toContain("PROMOS[o.program]")
    expect(html).toContain("never a discount on any hotel rate")
  })

  it("the calculator is labelled as the cost to BUY points, offers the stated full-stay total only explicitly, and stays silent without a rate", () => {
    expect(html).toContain("Estimated cost to BUY these points")
    expect(html).toContain("not hotel value, not savings")
    expect(html).toContain("Calculate points")
    expect(html).toContain("Full stay: use the source-stated total")
    expect(html).toContain("no explicit purchase rate stated")
    // Prefill passes the stated per-night figure and the stated total — no arithmetic.
    expect(html).toContain("calcFromCard('${esc(o.program)}', ${o.pointsPerNight},")
  })

  it("cards keep perk badges and the acquisition tag is labelled as acquisition, shown only under its sort", () => {
    expect(html).toContain("${perkBadges(o)}")
    expect(html).toContain('if (SORT !== "buypoints") return ""')
    expect(html).toContain("acquisition cost, not hotel cash value")
  })

  it("diagnostic prose moved into a Details disclosure but every honesty statement survives", () => {
    expect(html).toContain('<details class="dcard"><summary>Details</summary>')
    expect(html).toContain("Historical/period award observation — not a live hold.")
    expect(html).toMatch(/cash context[^<]*not a comparison/)
  })
})
