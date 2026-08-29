/**
 * Design spine (redesign slice 1) — shared navbar/tokens on dashboard +
 * Hotel Award Radar, the flight→stay journey CTA, and the hotel page's
 * consumer search band with the planner demoted to an Advanced disclosure.
 *
 * Pinned: presentation only — the backend, provider, discovery and ranking
 * code paths are untouched by this slice, all planner controls still exist
 * (secondary/collapsed), every sort/calculator/perk honesty string survives,
 * and nothing auto-runs a provider search.
 */

import fs from "fs"
import { describe, expect, it } from "vitest"

const dash = fs.readFileSync("dashboard.html", "utf-8")
const hotel = fs.readFileSync("hotel-awards.html", "utf-8")
const nav = fs.readFileSync("radar-nav.js", "utf-8")
const css = fs.readFileSync("radar.css", "utf-8")

describe("shared design spine", () => {
  it("radar.css defines the token system: ink surfaces, emerald actions, amber points, 12px cards", () => {
    expect(css).toContain("--emerald:")
    expect(css).toContain("--amber:")
    expect(css).toContain("--radius: 12px")
    expect(css).toContain(".r-btn.primary")
    expect(css).toContain(".r-chip")
    expect(css).toContain(".radar-nav")
  })

  it("the shared navbar carries the product links and the quiet Radar menu", () => {
    for (const l of ["Flights", "Stays", "Deals", "Trips", "Observer", "Fare Radar", "Market"]) {
      expect(nav).toContain(`"${l}"`)
    }
    expect(nav).toContain('"/hotel-awards.html"')
    expect(nav).toContain('"/observer.html"')
    expect(nav).toContain('"/fares.html"')
  })

  it("both slice-1 pages load the spine (stylesheet + navbar script)", () => {
    for (const page of [dash, hotel]) {
      expect(page).toContain('href="./radar.css"')
      expect(page).toContain('src="./radar-nav.js"')
    }
  })
})

describe("dashboard journey CTA", () => {
  it("the flight→stay hand-off is a visible journey band with the same context helper", () => {
    expect(dash).toContain('id="findStayBand"')
    expect(dash).toContain('id="findStayLink"')
    expect(dash).toContain("Continue → Find your stay in ${m.destination}")
    // Context construction is unchanged — same helper, same one-way honesty.
    expect(dash).toContain("hotelStayUrl(m.destination, m.departureDate, m.returnDate)")
    expect(dash).toContain("pick your own check-out on the hotel page")
    expect(dash).not.toContain("/api/hotel-awards/discover")   // navigating never searches
  })
})

describe("hotel page: consumer search band + demoted planner", () => {
  it("the visible band is destination/dates/guests with one primary Search stays action", () => {
    for (const id of ["d-location", "d-in", "d-out", "d-adults"]) expect(hotel).toContain(`id="${id}"`)
    expect(hotel).toContain(">Search stays<")
    expect(hotel).toMatch(/id="d-run"[^>]*>Search stays|class="r-btn primary" id="d-run"/)
  })

  it("ALL planner controls still exist, unchanged, inside the collapsed Advanced disclosure", () => {
    const advStart = hotel.indexOf('<details class="adv" id="d-advanced">')
    expect(advStart).toBeGreaterThan(-1)
    const adv = hotel.slice(advStart, hotel.indexOf("</details>", advStart))
    expect(adv).toContain("Advanced search details")
    expect(adv).not.toContain("open")                        // collapsed by default
    for (const n of ["2", "4", "5", "7"]) expect(adv).toContain(`class="d-n" value="${n}" checked`)
    expect(adv).toContain('id="d-max"')
    expect(adv).toContain('id="d-preview"')
    expect(adv).toContain('id="d-plan"')
  })

  it("every sort/calculator/perk honesty string survives the redesign", () => {
    for (const s of [
      'option value="buypoints"', "Estimated cost to BUY these points", "not hotel value, not savings",
      "Calculate points", "Full stay: use the source-stated total",
      "perkBadges(o)", "needs status/card", "join free", "· unverified", "Source-verified",
      "Historical/period award observation — not a live hold.",
    ]) expect(hotel).toContain(s)
    expect(hotel).toMatch(/cash context[^<]*not a comparison/)
  })

  it("split cards use program-branded tiles, never fake hotel photos, and gate the provider action on the locator", () => {
    expect(hotel).toContain('class="card split"')
    expect(hotel).toContain("r-tile")
    expect(css).toContain("deliberately NOT hotel photos")
    expect(hotel).not.toMatch(/<img/)                        // no imagery is faked anywhere on the page
    expect(hotel).toContain('n.quality === "UNAVAILABLE") return ""')
    expect(hotel).toContain("no trustworthy provider link")  // the fact moved into Details, not deleted
  })

  it("nothing auto-runs: search still requires the explicit click", () => {
    expect(hotel).toContain('addEventListener("click", runDiscovery)')
    expect(hotel).not.toMatch(/(?<!function )runDiscovery\(\)/)
  })
})
