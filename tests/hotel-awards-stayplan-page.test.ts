/**
 * Life-Perk Stay Planner page + route wiring — the visual calendar planner on
 * hotel-awards.html and the perk-aware stayplan/entitlements routes.
 *
 * Pinned: the trip-length presets, optimization-goal radios (life-perk
 * coverage default), include-in-plan controls and the declared-entitlements
 * panel exist; the calendar is visualization-only wording included; perk
 * badge states are clearly distinguished (APPLIED vs QUALIFIES — PRICE
 * EFFECT UNKNOWN) and no fake discounted total is rendered; alternatives are
 * a collapsed "More plans" disclosure; the explainer exists; the entitlements
 * write sits behind the same gates as the only prior write endpoint; and the
 * EXISTING normal hotel search/results/calculator remain untouched.
 */

import fs from "fs"
import { describe, expect, it } from "vitest"

const hotel = fs.readFileSync("hotel-awards.html", "utf-8")
const serve = fs.readFileSync("serve.ts", "utf-8")

describe("quick trip-length presets", () => {
  it("offers exactly 7/14/30-day presets that set check-out from check-in", () => {
    for (const d of ["7", "14", "30"]) expect(hotel).toContain(`data-days="${d}"`)
    expect(hotel).toContain("StayPlanUI.presetCheckout")
    expect(hotel).toContain("StayPlanUI.activePreset")
    // Dates stay editable — the inputs survive and a manual edit re-checks
    // the highlight instead of locking the fields.
    expect(hotel).toContain('id="d-in"')
    expect(hotel).toContain('id="d-out"')
    expect(hotel).toMatch(/d-out.*addEventListener\("input", refreshPresets\)/s)
  })
})

describe("optimization goal + include-in-plan controls", () => {
  it("three goals with best life-perk coverage as the checked default", () => {
    expect(hotel).toContain('value="life_perks" checked')
    expect(hotel).toContain('value="points_cost"')
    expect(hotel).toContain('value="fewest_switches"')
  })

  it("the perk-mechanic include controls exist and buy-points promos are context-only", () => {
    for (const id of ["pk-cert", "pk-nth", "pk-card", "pk-promos"]) expect(hotel).toContain(`id="${id}"`)
    expect(hotel).toContain("a promo never changes ranking")
  })

  it("the entitlements panel declares, never assumes", () => {
    expect(hotel).toContain('id="ent-list"')
    expect(hotel).toContain(">Edit entitlements<")
    expect(hotel).toContain("never silently assumed")
    expect(hotel).toContain("Declared by you, never inferred")
  })
})

describe("calendar + plan rendering honesty", () => {
  it("the calendar is visualization only and gaps stay visible", () => {
    expect(hotel).toContain("visualization only")
    expect(hotel).toContain("never manufactures availability between observed")
    expect(hotel).toContain("no coverage")
    expect(hotel).toContain("uncovered nights stay visible — never filled in")
  })

  it("perk badge states are clearly distinguished and no discounted total exists", () => {
    expect(hotel).toContain("APPLIED")
    expect(hotel).toContain("QUALIFIES — PRICE EFFECT UNKNOWN")
    expect(hotel).toContain("No discounted total is shown")
    expect(hotel).toContain("its points value is never invented")
  })

  it("the summary keeps programs separate and flags per-night-only stay totals", () => {
    expect(hotel).toContain("points of different programs are never combined into one total")
    expect(hotel).toContain("A per-night average is never multiplied into a stay total")
    // "Stay total unavailable" renders through the shared model:
    const ui = fs.readFileSync("stayplan-ui.js", "utf-8")
    expect(ui).toContain("Stay total unavailable")
    expect(hotel).toContain("StayPlanUI.programTotalText")
  })

  it("alternatives collapse into More plans and the explainer exists", () => {
    expect(hotel).toContain('<details id="plan-alts"')
    expect(hotel).toContain("More plans")
    expect(hotel).toContain("How this plan works")
    expect(hotel).toContain("StayPlanUI.planExplanation")
  })

  it("goal/include changes only re-project stored data — never a provider search", () => {
    expect(hotel).toContain("re-project the SAME stored data")
    // The stayplan fetch is a GET of the read-only route; discovery stays
    // click-gated elsewhere on the page.
    expect(hotel).toContain("/api/hotel-awards/stayplan")
  })
})

describe("mockup parity elements", () => {
  it("display toggles, honesty footer and the rebuild action exist", () => {
    for (const id of ["dsp-cal-perks", "dsp-alts", "pf-rebuild"]) expect(hotel).toContain(`id="${id}"`)
    expect(hotel).toContain("Adjust &amp; rebuild plan")
    expect(hotel).toContain("Honesty first")
    expect(hotel).toContain("No synthetic totals")
    expect(hotel).toContain("Totals shown only where source-stated")
    expect(hotel).toContain("Free night used")
    expect(hotel).toContain("Status perk")
  })

  it("the persistent sidebar carries the mockup control groups and the demoted Advanced disclosure", () => {
    for (const s of ["Optimize for", "Include in plan", "Status &amp; entitlements", "Display",
      "Best life perk coverage", "Use free night certificates", "Card 4th night benefit"]) {
      expect(hotel).toContain(s)
    }
    // The Advanced planner disclosure lives inside the sidebar shell now.
    const side = hotel.slice(hotel.indexOf('<aside class="plan-side">'), hotel.indexOf("</aside>"))
    expect(side).toContain('<details class="adv" id="d-advanced">')
  })
})

describe("serve.ts perk-aware stayplan + entitlements routes", () => {
  it("the stayplan route validates goal and include and fails soft on perk config errors", () => {
    expect(serve).toContain("STAY_PLAN_GOALS.includes(goalParam")
    expect(serve).toContain("unknown include category")
    expect(serve).toContain("filterRulesByInclude")
    expect(serve).toContain("perksError")
  })

  it("the stayplan disclaimer states the perk honesty rules", () => {
    expect(serve).toContain("DECLARED entitlements (never inferred)")
    expect(serve).toContain("rule-supported free-night COUNT only")
    expect(serve).toContain("no discounted total is shown")
  })

  it("the entitlements write sits behind loopback/origin, JSON-only and validation gates", () => {
    const at = serve.indexOf('url.pathname === "/api/hotel-awards/entitlements"')
    expect(at).toBeGreaterThan(-1)
    const route = serve.slice(at, at + 4200)
    expect(route).toContain("isLoopback")
    expect(route).toContain("TRUSTED_ORIGINS")
    expect(route).toContain('Content-Type must be application/json')
    expect(route).toContain("saveEntitlements")
    expect(route).toContain("refuses loudly")
  })
})

describe("the existing normal hotel search survives", () => {
  it("search band, discovery, filters, results and calculator are all still wired", () => {
    for (const s of [
      'id="d-run"', ">Search stays<", 'addEventListener("click", runDiscovery)',
      'id="sort"', 'id="program"', 'id="provider"', 'id="q"',
      "/api/hotel-awards?limit=300", "perkBadges(o)",
      "Estimated cost to BUY these points", "not hotel value, not savings",
      "Historical/period award observation — not a live hold.",
    ]) expect(hotel).toContain(s)
    // And nothing on the page synthesizes a total out of nightly points.
    expect(hotel).not.toMatch(/pointsPerNight\s*\*/)
  })
})

describe("traveller functions: evidence, booking, re-check, filters, balances, status", () => {
  const segCardSrc = hotel.slice(hotel.indexOf("function segCard"), hotel.indexOf("function segIsGold"))

  it("plan cards carry evidence, the provider link ladder and the cash-context basis label", () => {
    expect(hotel).toContain("StayPlanUI.evidenceText")
    expect(hotel).toContain("display threshold only")
    expect(segCardSrc).toContain("action(s)")
    expect(segCardSrc).toContain("no trustworthy provider link")
    expect(hotel).toContain("per-night average (Roame)")
    expect(hotel).toContain("stay total (Gondola)")
    expect(hotel).toContain("basis not stated")
    expect(hotel).toMatch(/CASH_BASIS\[s\.provider\]/)          // basis comes from the PROVIDER, never guessed from quoteBasis
    expect(hotel).toMatch(/cash context[^<]*not a comparison/)
    expect(hotel).not.toMatch(/<img/)
    expect(hotel).not.toMatch(/\*\s*o?\.?nights/)
  })

  it("perk truth: night-count chip, declared attribution, nothing-declared banner, no '(via Card)'", () => {
    expect(hotel).toContain("StayPlanUI.payForText")
    expect(hotel).toContain("StayPlanUI.perkAttribution")
    expect(hotel).toContain("StayPlanUI.perkStateLabel")
    expect(hotel).toContain("No entitlements declared")
    expect(hotel).toContain("declare ›")
    expect(hotel).not.toContain("(via Card)")
  })

  it("Book this plan — separate reservations, copy as text, never a combined booking or price", () => {
    expect(hotel).toContain('id="plan-book"')
    expect(hotel).toContain("separate reservation")
    expect(hotel).toContain("search manually at")
    expect(hotel).toContain("Copy as text")
    expect(hotel).toContain("never confirms the quote")
    expect(hotel).toContain("No combined booking, no combined price")
    expect(hotel).toContain("StayPlanUI.bookingChecklist")
  })

  it("re-check is two-step (zero-call preview, then an explicit run) and windows come from the plan", () => {
    expect(hotel).toContain('id="p-recheck"')
    expect(hotel).toContain('id="p-fill"')
    expect(hotel).toContain("StayPlanUI.segmentWindows")
    expect(hotel).toContain("StayPlanUI.gapWindows")
    expect(hotel).toContain("preview: true")
    expect(hotel).toContain("spends provider calls")
    expect(hotel).toContain("Re-observed, not confirmed")
    expect(hotel).toContain("stays uncovered after this run")
    // Bound via addEventListener only — never auto-run.
    expect(hotel).not.toMatch(/(?<!function )recheckPlanWindows\(\)/)
    expect(hotel).not.toMatch(/(?<!function )searchGapWindows\(\)/)
    expect(hotel).not.toMatch(/(?<!function )runDiscovery\(\)/)
  })

  it("Hotels & programs filters and Swap this hotel re-project stored data only", () => {
    expect(hotel).toContain('id="pp-panel"')
    expect(hotel).toContain('class="swapbtn"')
    expect(hotel).toContain("Swap this hotel")
    expect(hotel).toContain('params.set("programs"')
    expect(hotel).toContain('params.set("exclude"')
    const side = hotel.slice(hotel.indexOf('<aside class="plan-side">'), hotel.indexOf("</aside>"))
    expect(side.indexOf('id="pp-panel"')).toBeGreaterThan(-1)
    expect(side.indexOf('id="pp-panel"')).toBeLessThan(side.indexOf('<details class="adv" id="d-advanced">'))
  })

  it("balances come from the local snapshot only and read 'unavailable' without numbers otherwise", () => {
    expect(hotel).toContain('id="bal-line"')
    expect(hotel).toContain("/api/balances")
    expect(hotel).toContain("never demo/fallback")
    expect(hotel).toContain("Balances unavailable")
    expect(hotel).toContain("StayPlanUI.heldForProgramTotal")
    expect(hotel).toContain("transfers not assumed")
  })

  it("the data-status pre-flight is a read that warns and never gates", () => {
    expect(hotel).toContain('id="ha-status"')
    expect(hotel).toContain("/api/hotel-awards/status")
    expect(hotel).toContain("per the saved file")
    expect(hotel).toContain("never geocoded")
  })

  it("serve.ts: filters validated, navigation attached after ranking, generatedAt echoed", () => {
    const at = serve.indexOf('url.pathname === "/api/hotel-awards/stayplan"')
    const route = serve.slice(at, serve.indexOf('url.pathname === "/api/balances"') > at ? serve.length : at + 6000)
    expect(route).toContain("unknown program token")
    expect(route).toContain("invalid exclude token")
    expect(route).toContain("attachSegmentNavigation(db, result, observations)")
    expect(route).toContain("generatedAt")
  })

  it("the spending step is reachable only from the explicit 'Run now' click, and preview/run send distinct bodies", () => {
    const calls = [...hotel.matchAll(/(?<!function )executeExplicitWindows\(/g)]
    expect(calls).toHaveLength(1)
    const i = calls[0].index!
    const line = hotel.slice(hotel.lastIndexOf("\n", i) + 1, hotel.indexOf("\n", i))
    expect(line).toMatch(/getElementById\("p-recheck-go"\)\.addEventListener\("click", \(\) => executeExplicitWindows\(ctx\)\)/)
    expect(hotel.match(/preview: true, windows: ctx\.windows/g)).toHaveLength(1)
    expect(hotel.match(/adults: ctx\.adults, windows: ctx\.windows \}\)/g)).toHaveLength(1)
    // The run button only exists inside the preview's rendered HTML — never in the static page.
    expect(hotel.indexOf('id="p-recheck-go"')).toBeGreaterThan(hotel.indexOf("async function runExplicitWindows"))
    // A re-plan invalidates the preview and the run refuses a changed plan.
    expect(hotel).toContain('document.getElementById("p-recheck-box").innerHTML = ""')
    expect(hotel).toContain("The plan changed since this preview")
    expect(hotel).toContain("planFingerprint")
  })

  it("empty evidence and an empty program selection are refused states, never a zero-segment planner or a silent 'all programs'", () => {
    expect(hotel).toContain("best.segments.length === 0")
    expect(hotel).toContain("Nothing was invented to fill the range")
    expect(hotel).toContain("No programs selected")
    expect(hotel).toContain("return on.length === 0 ? null : on")
    expect(hotel).toContain("ALL_PROGRAMS")
  })

  it("static copy names the ordering actually used and never '(via Card)'", () => {
    expect(hotel).toContain('id="pf-why"')
    expect(hotel).toContain("status perks are annotated, never ranked")
    expect(hotel).toContain("Perk layer unavailable")
    expect(hotel).not.toContain("(via Card)")
  })

  it("recheck-windows: bbox refusal → plan/budget → preview return → provider construction, in that order; body cannot raise the budget", () => {
    const rcAt = serve.indexOf('url.pathname === "/api/hotel-awards/recheck-windows"')
    const rc = serve.slice(rcAt, serve.indexOf('url.pathname === "/api/hotel-awards"', rcAt))
    const at = (s: string) => { const i = rc.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    expect(at("refusing to geocode")).toBeLessThan(at("buildExplicitWindowPlan("))
    expect(at("buildExplicitWindowPlan(")).toBeLessThan(at("payload.preview === true"))
    expect(at("payload.preview === true")).toBeLessThan(at("new RoameHotelAwardsProvider("))
    expect(rc.match(/new RoameHotelAwardsProvider\(/g)).toHaveLength(1)
    expect(rc).toContain("maxWindows: haCfg.roame.discovery?.maxWindowsPerRun ?? 8")
    expect(rc).not.toMatch(/payload\.maxWindows|searchParams\.get\("maxWindows"\)/)
    expect(rc).toContain("redactCredentialPaths")
  })

  it("the stayplan route selects in-range rows in SQL and the entitlements write refuses a missing declaration", () => {
    expect(serve).toContain("range: { from: checkIn, to: checkOut }")
    expect(serve).toContain("a missing declaration is refused, not emptied")
  })

  it("serve.ts: status is a read, recheck-windows is POST-only/JSON-only/preview-first, balances are loopback-gated and never fallback", () => {
    expect(serve).toContain('url.pathname === "/api/hotel-awards/status"')
    const statusSlice = serve.slice(serve.indexOf('url.pathname === "/api/hotel-awards/status"'), serve.indexOf('url.pathname === "/api/hotel-awards/plan"'))
    for (const s of ["executeWindowPlan", ".search(", "RoameHotelAwardsProvider"]) expect(statusSlice).not.toContain(s)
    const rcAt = serve.indexOf('url.pathname === "/api/hotel-awards/recheck-windows"')
    expect(rcAt).toBeGreaterThan(-1)
    const rc = serve.slice(rcAt, serve.indexOf('url.pathname === "/api/hotel-awards"', rcAt))
    expect(rc).toContain("POST only — re-check spends provider calls")
    expect(rc).toContain("Content-Type must be application/json")
    expect(rc).toContain("buildExplicitWindowPlan")
    expect(rc).toContain("payload.preview === true")
    expect(rc).toContain("refusing to geocode")
    expect(rc).not.toMatch(/gondola/i)
    expect(rc).not.toMatch(/serpapi/i)
    const bal = serve.slice(serve.indexOf('url.pathname === "/api/balances"'), serve.indexOf('url.pathname === "/api/hotel-awards/stayplan"'))
    expect(bal).toContain("isLoopback")
    expect(bal).toContain("balancesSnapshotPayload")
    expect(bal).toContain("no-store")
    expect(bal).not.toContain("getBalances(")
    expect(bal).not.toContain("FALLBACK")
  })
})
