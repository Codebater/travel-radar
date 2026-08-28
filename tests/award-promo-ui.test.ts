/**
 * Award-card promo enrichment (presentation layer).
 *
 * The join lives in promo-enrich.js — ONE implementation shared by the
 * dashboard (classic script) and these tests (module import), so the tested
 * behavior IS the page's behavior. Under test: qualification by the
 * loyaltyProgram enum only, expired/unmapped exclusion, honest badge wording
 * (a promo on BUYING miles, never a fare discount), order preservation, and
 * graceful degradation when the feed is unavailable.
 */

import fs from "fs"
import { describe, expect, it } from "vitest"
import { activePromoIndex, promoBadgeText, promoEndsText, qualifies } from "../promo-enrich.js"

function promo(over: Record<string, unknown> = {}) {
  return {
    sourceProgramName: "KLM (Flying Blue)",
    loyaltyProgram: "FLYING_BLUE",
    active: true,
    bonusPercent: 80,
    discountPercent: null,
    upTo: true,
    effectiveCostPerMile: null,
    currency: null,
    validUntil: "2026-09-16",
    endDateKnown: true,
    sourceUrl: "https://example.invalid",
    fetchedAt: "2026-08-28T18:00:00Z",
    ...over,
  }
}

function feed(promos: unknown[], ok = true) {
  return { ok, reason: ok ? "ok" : "blocked", detail: null, promos, sourceUrl: "", fetchedAt: null, fromCache: false, ageMinutes: null }
}

const award = (program: string | null) => ({ type: "award", pointsProgram: program, points: 15000, taxes: 293 })
const cash = () => ({ type: "cash", cashPrice: 1494 })

describe("qualification — by the loyaltyProgram enum only", () => {
  it("a mapped active promo highlights exactly its program's award results", () => {
    const index = activePromoIndex(feed([promo()]))
    expect(qualifies(award("FLYING_BLUE"), index)).toBe(true)
    expect(qualifies(award("DELTA"), index)).toBe(false)      // no promo = normal card
    expect(qualifies(award(null), index)).toBe(false)
  })

  it("an expired promo never qualifies", () => {
    const index = activePromoIndex(feed([promo({ active: false })]))
    expect(index).toEqual({})
    expect(qualifies(award("FLYING_BLUE"), index)).toBe(false)
  })

  it("an unmapped source program never qualifies anything", () => {
    const index = activePromoIndex(feed([promo({ loyaltyProgram: null, sourceProgramName: "Copa Airlines (ConnectMiles)" })]))
    expect(index).toEqual({})
  })

  it("only award cards can qualify — cash results are untouched by the Miles sale filter", () => {
    const index = activePromoIndex(feed([promo()]))
    expect(qualifies({ ...cash(), pointsProgram: "FLYING_BLUE" }, index)).toBe(false)
    const mixed = [award("FLYING_BLUE"), cash(), award("DELTA")]
    expect(mixed.filter(f => qualifies(f, index))).toEqual([award("FLYING_BLUE")])
  })

  it("filtering preserves the existing order — it never re-ranks", () => {
    const index = activePromoIndex(feed([promo(), promo({ loyaltyProgram: "JETBLUE", sourceProgramName: "JetBlue (TrueBlue)" })]))
    const ordered = [award("JETBLUE"), award("DELTA"), award("FLYING_BLUE"), award("JETBLUE")]
    const filtered = ordered.filter(f => qualifies(f, index))
    expect(filtered.map(f => f.pointsProgram)).toEqual(["JETBLUE", "FLYING_BLUE", "JETBLUE"])
  })
})

describe("wording — the promo is on BUYING miles, never on the fare", () => {
  it("up-to bonuses are displayed honestly", () => {
    expect(promoBadgeText(promo())).toBe("BUY MILES UP TO +80%")
  })

  it("flat bonus vs discount wording is correct", () => {
    expect(promoBadgeText(promo({ upTo: false, bonusPercent: 50 }))).toBe("BUY MILES +50%")
    expect(promoBadgeText(promo({ upTo: false, bonusPercent: null, discountPercent: 40 }))).toBe("BUY MILES -40%")
  })

  it("never uses fare-discount language", () => {
    for (const p of [promo(), promo({ bonusPercent: null, discountPercent: 40 })]) {
      expect(promoBadgeText(p)).not.toMatch(/off|flight|fare/i)
    }
  })

  it("expiry renders only when the source stated one", () => {
    expect(promoEndsText(promo())).toBe("Ends Sep 16")
    expect(promoEndsText(promo({ validUntil: null, endDateKnown: false }))).toBeNull()
  })
})

describe("graceful degradation", () => {
  it("a failed or malformed feed yields an empty index — results stay fully functional", () => {
    expect(activePromoIndex(feed([], false))).toEqual({})
    expect(activePromoIndex(null)).toEqual({})
    expect(activePromoIndex({ ok: true })).toEqual({})
    // With an empty index nothing qualifies and nothing renders a badge.
    expect(qualifies(award("FLYING_BLUE"), {})).toBe(false)
  })
})

describe("dashboard wiring", () => {
  const html = fs.readFileSync("dashboard.html", "utf-8")

  it("loads the shared enrichment module and the Miles sale filter, hidden until promos exist", () => {
    expect(html).toContain('src="./promo-enrich.js"')
    expect(html).toContain('id="filter-milessale"')
    expect(html).toMatch(/filter-milessale[^>]*class="hidden/)
    expect(html).toContain("loadMilesPromos")
  })

  it("the Miles sale branch only filters; the sort switch knows nothing about promos", () => {
    expect(html).toMatch(/currentFilter === 'milessale'[\s\S]{0,200}PromoEnrich\.qualifies/)
    const sortBlock = html.slice(html.indexOf("switch (currentSort)"), html.indexOf("return flights;"))
    expect(sortBlock).not.toMatch(/promo/i)
  })

  it("recommendations rendering is untouched by promo metadata", () => {
    const recs = html.slice(html.indexOf("function renderRecommendations"), html.indexOf("function renderFlightCard"))
    expect(recs).not.toMatch(/promo/i)
  })

  it("card wording says miles purchase promo, never a fare discount", () => {
    expect(html).toContain("Miles purchase promo")
    expect(html).not.toMatch(/\d+% off/i)
  })
})
