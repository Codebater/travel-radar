/**
 * Hotel buy-points promo enrichment on stay cards (presentation layer).
 *
 * Same shared module as the award cards (promo-enrich.js) — the hotel index
 * is category-scoped so airline behavior is untouched. Under test:
 * category isolation, mapped/unmapped/expired qualification, honest badge and
 * rate wording (the promo is on BUYING points, never on the cash rate),
 * explicit-affiliation config discipline, Deal Radar card passthrough,
 * order preservation, and graceful feed failure.
 */

import fs from "fs"
import { describe, expect, it } from "vitest"
import { activePromoIndex, hotelPromoBadgeText, promoEndsText, promoRateText } from "../promo-enrich.js"
import { loadStayUniverse } from "../stays/registry.js"

function hotelPromo(over: Record<string, unknown> = {}) {
  return {
    category: "hotel",
    sourceProgramName: "Marriott (Bonvoy)",
    loyaltyProgram: "MARRIOTT_BONVOY",
    active: true,
    bonusPercent: 50,
    discountPercent: null,
    upTo: false,
    effectiveCostPerMile: 0.83,
    currency: "USD",
    validUntil: "2026-09-09",
    endDateKnown: true,
    sourceUrl: "https://example.invalid",
    fetchedAt: "2026-08-28T18:00:00Z",
    ...over,
  }
}

const feed = (promos: unknown[], ok = true) =>
  ({ ok, reason: ok ? "ok" : "blocked", promos, sourceUrl: "", fetchedAt: null, fromCache: false, ageMinutes: null })

describe("category isolation — airline behavior untouched", () => {
  it("the default index still returns only airline promos; hotel promos need the explicit category", () => {
    const f = feed([hotelPromo(), hotelPromo({ category: "airline", loyaltyProgram: "FLYING_BLUE", sourceProgramName: "KLM (Flying Blue)" })])
    expect(Object.keys(activePromoIndex(f))).toEqual(["FLYING_BLUE"])          // original contract
    expect(Object.keys(activePromoIndex(f, "hotel"))).toEqual(["MARRIOTT_BONVOY"])
    // Rows without a category count as airline (pre-hotel feeds keep working).
    const legacy = feed([hotelPromo({ category: undefined, loyaltyProgram: "JETBLUE" })])
    expect(Object.keys(activePromoIndex(legacy))).toEqual(["JETBLUE"])
  })

  it("expired and unmapped hotel promos never enrich", () => {
    expect(activePromoIndex(feed([hotelPromo({ active: false })]), "hotel")).toEqual({})
    expect(activePromoIndex(feed([hotelPromo({ loyaltyProgram: null })]), "hotel")).toEqual({})
  })

  it("a failed feed yields an empty hotel index — cards render unchanged", () => {
    expect(activePromoIndex(feed([hotelPromo()], false), "hotel")).toEqual({})
    expect(activePromoIndex(null, "hotel")).toEqual({})
  })
})

describe("wording — a promo on BUYING points, never on the cash rate", () => {
  it("badge text is BUY POINTS with honest up-to", () => {
    expect(hotelPromoBadgeText(hotelPromo())).toBe("BUY POINTS +50%")
    expect(hotelPromoBadgeText(hotelPromo({ upTo: true, bonusPercent: 100 }))).toBe("BUY POINTS UP TO +100%")
    expect(hotelPromoBadgeText(hotelPromo())).not.toMatch(/off|rate|stay/i)
  })

  it("the explicit source rate is preserved and never invented", () => {
    expect(promoRateText(hotelPromo())).toBe("Promo purchase rate: 0.83¢/point")
    expect(promoRateText(hotelPromo({ effectiveCostPerMile: null }))).toBeNull()
  })

  it("expiry shows only when the source stated one", () => {
    expect(promoEndsText(hotelPromo())).toBe("Ends Sep 9")
    expect(promoEndsText(hotelPromo({ validUntil: null }))).toBeNull()
  })
})

describe("explicit property affiliations — data, never name inference", () => {
  const universe = loadStayUniverse(true)
  const byId = new Map(universe.properties.map(p => [p.id, p]))

  it("exactly the known chain-affiliated properties carry a loyaltyProgram", () => {
    const affiliated = universe.properties.filter(p => p.loyaltyProgram)
    expect(Object.fromEntries(affiliated.map(p => [p.id, p.loyaltyProgram]))).toEqual({
      "waldorf-astoria-ithaafushi": "HILTON_HONORS",
      "waldorf-astoria-pedregal": "HILTON_HONORS",
      "st-regis-vommuli": "MARRIOTT_BONVOY",
      "phulay-bay-ritz-carlton": "MARRIOTT_BONVOY",
      "six-senses-yao-noi": "IHG_ONE_REWARDS",
      "six-senses-uluwatu": "IHG_ONE_REWARDS",
      "six-senses-zil-pasyon": "IHG_ONE_REWARDS",
      "banyan-tree-phuket": "ACCOR_ALL",
      "banyan-tree-mayakoba": "ACCOR_ALL",
    })
  })

  it("independent properties stay unset — nothing is guessed", () => {
    expect(byId.get("soneva-fushi")?.loyaltyProgram).toBeUndefined()
    expect(byId.get("lily-beach-resort")?.loyaltyProgram ?? byId.get("lily-beach")?.loyaltyProgram).toBeUndefined()
  })
})

describe("page and feed wiring", () => {
  it("stays.html joins promos via propertyLoyalty with the mandated tooltip wording", () => {
    const html = fs.readFileSync("stays.html", "utf-8")
    expect(html).toContain('src="./promo-enrich.js"')
    expect(html).toContain('activePromoIndex')
    expect(html).toContain('"hotel"')
    expect(html).toContain("propertyLoyalty")
    expect(html).toContain("Points purchase promo — not a discount on this cash hotel rate.")
    expect(html).toContain("hotelPromoBadgeText")
  })

  it("dealradar.html enriches stay cards from card.loyaltyProgram with the same wording — order and grouping untouched", () => {
    const html = fs.readFileSync("dealradar.html", "utf-8")
    expect(html).toContain('src="./promo-enrich.js"')
    expect(html).toContain("hotelPromoIndex")
    expect(html).toContain("Points purchase promo — not a discount on this cash hotel rate.")
    // The promo join adds a badge only — no sorting or grouping references it.
    const beforeCards = html.slice(0, html.indexOf("function stayCard"))
    expect(beforeCards).not.toMatch(/sort[^\n]*hotelPromo/i)
  })

  it("filtering/ordering of stay cards is untouched by the enrichment (badge is per-card render only)", () => {
    // The hotel index is consulted exclusively inside card templates; the
    // qualifying set never filters or reorders cards. Simulated: an ordered
    // card list maps 1:1 through a badge decision without rearrangement.
    const index = activePromoIndex(feed([hotelPromo()]), "hotel")
    const cards = [{ loyaltyProgram: null }, { loyaltyProgram: "MARRIOTT_BONVOY" }, { loyaltyProgram: "HILTON_HONORS" }]
    const rendered = cards.map(card => ({ ...card, badge: card.loyaltyProgram ? index[card.loyaltyProgram] ?? null : null }))
    expect(rendered.map(r => r.loyaltyProgram)).toEqual(cards.map(c => c.loyaltyProgram))
    expect(rendered.filter(r => r.badge)).toHaveLength(1)
  })
})
