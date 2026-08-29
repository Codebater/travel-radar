/**
 * Discovery execution + API/UI wiring — the testable discovery layer on the
 * EXISTING Hotel Award Radar.
 *
 * Pinned: executeWindowPlan drives a WindowPlan through any provider and the
 * append-only store (aggregates honest totals, stops dead on blocked, keeps
 * going past ordinary failures, dedupes across windows, never synthesizes a
 * total); the plan-preview payload is pure date math with zero provider
 * involvement; and hotel-awards.html wires preview/run to the new routes
 * with no automatic searching. No live providers anywhere — the provider
 * here is a canned fake.
 */

import fs from "fs"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { executeWindowPlan } from "../providers/hotel-awards/discover.js"
import { planStayWindows } from "../providers/hotel-awards/planner.js"
import { listHotelAwards } from "../providers/hotel-awards/store.js"
import type {
  HotelAwardProvider, HotelAwardQuery, HotelAwardSearchResult, NormalizedHotelAward,
} from "../providers/hotel-awards/types.js"

function award(checkIn: string, nights: number, over: Partial<NormalizedHotelAward> = {}): NormalizedHotelAward {
  const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)
  return {
    provider: "roame_hotels", providerPropertyRef: "bkkzs", propertyId: null,
    propertyName: "Hyatt Place Bangkok Sukhumvit 24", chain: "PLACE",
    program: "WORLD_OF_HYATT", sourceProgramName: "HYATT",
    checkIn, checkOut, nights,
    quoteBasis: "per_night", roomClass: "GuestRoom", roomName: "1 King Bed",
    pointsTotal: null, pointsPerNight: 4500,
    taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
    awardType: "points", cashComparisonAmount: 104, cashComparisonCurrency: "USD",
    availabilityState: "unknown", searchState: "complete", verificationLevel: "discovered",
    sourceFreshness: null, bookingUrl: null, fetchedAt: "2026-08-29T00:00:00.000Z",
    ...over,
  }
}

/** Canned provider: answers each window from a scripted queue, records what
 *  it was asked. Never touches the network. */
function fakeProvider(script: (q: HotelAwardQuery) => Omit<HotelAwardSearchResult, "provider" | "latencyMs">): HotelAwardProvider & { queries: HotelAwardQuery[] } {
  const queries: HotelAwardQuery[] = []
  return {
    name: "roame_hotels",
    capabilities: { multiNightQuotes: true, statesPointsPerNight: true, statesTaxes: true, statesRooms: true, dynamicPrograms: false, metered: false },
    isConfigured: () => true,
    queries,
    async search(q) {
      queries.push(q)
      return { provider: "roame_hotels", latencyMs: 1, ...script(q) }
    },
  }
}

const okResult = (q: HotelAwardQuery, awards: NormalizedHotelAward[]): Omit<HotelAwardSearchResult, "provider" | "latencyMs"> =>
  ({ ok: true, searchState: "complete", awards, callsSpent: 1, appliedMinNights: q.minNights })

let db: DB
beforeEach(() => { db = createMemoryDb() })

const PLAN = planStayWindows("2026-11-01", "2026-12-01", {})   // 8 windows (starts + ends)
const OPTS = { location: "Bangkok", adults: 2, politenessMs: 0 }

describe("executeWindowPlan", () => {
  it("runs every planned window as its own exact query and aggregates honest totals", async () => {
    const p = fakeProvider(q => okResult(q, [
      award(q.checkIn, q.minNights!),
      award(q.checkIn, q.minNights!, { providerPropertyRef: "icbkk", propertyName: "InterContinental Bangkok", chain: "ICON", program: "IHG_ONE_REWARDS", sourceProgramName: "IHG" }),
    ]))
    const s = await executeWindowPlan(db, p, PLAN, OPTS)
    expect(p.queries).toHaveLength(8)
    // Each search asked for the window's EXACT dates and its own length as the filter.
    expect(p.queries.map(q => [q.checkIn, q.checkOut, q.minNights])).toEqual(PLAN.windows.map(w => [w.checkIn, w.checkOut, w.nights]))
    expect(s.windowsPlanned).toBe(8)
    expect(s.windowsCompleted).toBe(8)
    expect(s.providerCalls).toBe(8)
    expect(s.observationsStored).toBe(16)                   // 2 per window, all distinct windows
    expect(s.distinctHotels).toBe(2)
    expect(s.programs).toEqual(["IHG_ONE_REWARDS", "WORLD_OF_HYATT"])
    expect(s.stoppedOnBlock).toBe(false)
  })

  it("a BLOCKED window stops the run dead — later windows are never searched, and the stop is reported", async () => {
    const p = fakeProvider(q => q.checkIn === PLAN.windows[2].checkIn && q.minNights === PLAN.windows[2].nights
      ? { ok: false, searchState: "blocked", awards: [], reason: "blocked", error: "Roame HTTP 429 — throttled", callsSpent: 1 }
      : okResult(q, [award(q.checkIn, q.minNights!)]))
    const s = await executeWindowPlan(db, p, PLAN, OPTS)
    expect(p.queries).toHaveLength(3)                       // stopped at the blocked third window
    expect(s.stoppedOnBlock).toBe(true)
    expect(s.windowsCompleted).toBe(2)
    expect(s.results).toHaveLength(3)
    expect(s.results[2].reason).toBe("blocked")
  })

  it("an ordinary failed window is reported and skipped — the run continues", async () => {
    const p = fakeProvider(q => q.minNights === 7
      ? { ok: false, searchState: "incomplete", awards: [], reason: "provider-error", error: "Roame HTTP 500", callsSpent: 1 }
      : okResult(q, [award(q.checkIn, q.minNights!)]))
    const s = await executeWindowPlan(db, p, PLAN, OPTS)
    expect(p.queries).toHaveLength(8)                       // both 7n windows failed, run continued
    expect(s.windowsCompleted).toBe(6)
    expect(s.stoppedOnBlock).toBe(false)
    expect(s.results.filter(r => !r.ok)).toHaveLength(2)
  })

  it("stores through the append-only HISTORY path — repeat observations append with a shared dedupe key, nothing is rewritten", async () => {
    // Every window returns the SAME observation (same dates): the store's
    // contract is append-only history, so 8 rows exist, one per observation,
    // all sharing one dedupe key for downstream latest-per-key reads.
    const fixed = award("2026-11-01", 2)
    const p = fakeProvider(q => okResult(q, [fixed]))
    const s = await executeWindowPlan(db, p, PLAN, OPTS)
    expect(s.observationsStored).toBe(8)
    const rows = listHotelAwards(db, { limit: 50 })
    expect(rows).toHaveLength(8)
    expect(new Set(rows.map(r => r.dedupeKey)).size).toBe(1)
    expect(s.distinctHotels).toBe(1)                        // the summary still counts hotels, not rows
  })

  it("never synthesizes a stay total — stored rows stay per-night exactly as the provider stated them", async () => {
    const p = fakeProvider(q => okResult(q, [award(q.checkIn, q.minNights!)]))
    await executeWindowPlan(db, p, PLAN, OPTS)
    for (const row of listHotelAwards(db, { limit: 50 })) {
      expect(row.quoteBasis).toBe("per_night")
      expect(row.pointsTotal).toBeNull()
      expect(row.pointsPerNight).toBe(4500)
    }
  })
})

// Lockstep replica of GET /api/hotel-awards/plan (serve.ts) — pure date math.
function planPayload(params: Record<string, string>) {
  const { location, checkIn, checkOut } = params
  if (!location || !checkIn || !checkOut) throw new Error("location, checkIn and checkOut are required")
  const candidateNights = params.nights !== undefined ? params.nights.split(",").map(s => Number(s.trim())) : undefined
  const maxWindows = params.maxWindows !== undefined ? Number(params.maxWindows) : undefined
  const plan = planStayWindows(checkIn, checkOut, { candidateNights, maxWindows })
  const maxPages = 2
  return { plan, candidatesBeforeBudget: plan.windows.length + plan.dropped.length, maxHttpCalls: plan.windows.length * maxPages }
}

describe("the plan-preview payload", () => {
  it("answers the Bangkok 30-day example without any provider: 12 candidates, 8 selected, 4 dropped, ≤16 calls", () => {
    const p = planPayload({ location: "Bangkok", checkIn: "2026-11-01", checkOut: "2026-12-01", nights: "2,4,5,7", maxWindows: "8" })
    expect(p.candidatesBeforeBudget).toBe(12)
    expect(p.plan.windows).toHaveLength(8)
    expect(p.plan.dropped).toHaveLength(4)
    expect(p.maxHttpCalls).toBe(16)
    for (const w of p.plan.windows) {
      expect(w.checkIn >= "2026-11-01" && w.checkOut <= "2026-12-01").toBe(true)
    }
  })

  it("refuses bad input with the planner's own message instead of guessing", () => {
    expect(() => planPayload({ location: "Bangkok", checkIn: "2026-12-01", checkOut: "2026-11-01" })).toThrow(/must follow/)
    expect(() => planPayload({ location: "", checkIn: "2026-11-01", checkOut: "2026-12-01" })).toThrow(/required/)
  })
})

describe("flight dashboard → Find stay hand-off", () => {
  const dash = fs.readFileSync("dashboard.html", "utf-8")
  const hotel = fs.readFileSync("hotel-awards.html", "utf-8")

  it("the dashboard hands trip context to the EXISTING hotel page — no duplicate hotel search anywhere", () => {
    expect(dash).toContain("function hotelStayUrl")
    expect(dash).toContain("./hotel-awards.html?")
    expect(dash).toContain('id="findStayLink"')
    // Both integration points reuse the one helper: the search header and the
    // selected round-trip summary (the dashboard's detail state).
    expect(dash).toContain("hotelStayUrl(m.destination, m.departureDate, m.returnDate)")
    expect(dash).toContain("hotelStayUrl(outbound.destination, getTravelDate(outbound), getTravelDate(returnFlight))")
    // No hotel searching from the dashboard itself — hand-off only.
    expect(dash).not.toContain("/api/hotel-awards/discover")
    expect(dash).not.toContain("/api/hotel-awards/plan")
  })

  it("a one-way trip never invents a check-out: the URL only carries checkOut when the trip has one", () => {
    // The helper guards every field — checkOut is set only when truthy.
    expect(dash).toMatch(/if \(checkOut\) p\.set\('checkOut', checkOut\);/)
    expect(dash).toContain("pick your own check-out on the hotel page")
  })

  it("the hotel page prefills from the hand-off and maps known airports to configured hotel regions", () => {
    expect(hotel).toContain("function prefillFromTrip")
    expect(hotel).toMatch(/\nprefillFromTrip\(\)/)                    // prefill runs on load…
    expect(hotel).not.toMatch(/(?<!function )runDiscovery\(\)/)       // …but never a search
    expect(hotel).toContain('BKK: "Bangkok"')
    expect(hotel).toContain('DMK: "Bangkok"')
    // Unknown airports pass through verbatim for the provider's honest
    // structured refusal — never a guessed region.
    expect(hotel).toContain("IATA_LOCATIONS[dest.toUpperCase()] || dest.toUpperCase()")
  })

  it("a one-way hand-off clears the default check-out and both actions refuse until the user picks one", () => {
    expect(hotel).toContain('document.getElementById("d-out").value = checkOut ?? ""')
    expect(hotel).toContain("No date was invented for you")
    expect(hotel).toContain("function checkOutMissing")
    expect(hotel).toContain("check-out is required — a one-way flight hand-off does not invent one")
    // Both preview and run guard before any fetch.
    expect(hotel.match(/checkOutMissing\((box|status)\)/g)).toHaveLength(2)
  })

  it("adults from the hand-off travel into discovery params when present", () => {
    expect(hotel).toContain('id="d-adults"')
    expect(hotel).toContain('p.set("adults", String(adults))')
  })
})

describe("serve.ts + page wiring", () => {
  it("serve.ts registers both routes on the shared planner/executor — no duplicated loop", () => {
    const s = fs.readFileSync("serve.ts", "utf-8")
    expect(s).toContain('url.pathname === "/api/hotel-awards/plan"')
    expect(s).toContain('url.pathname === "/api/hotel-awards/discover"')
    expect(s).toContain("planStayWindows")
    expect(s).toContain("executeWindowPlan")
    expect(s).toMatch(/POST only — discovery spends provider calls/)
    // The discover route builds ONLY the Roame provider — no Gondola, no SerpAPI.
    const route = s.slice(s.indexOf('"/api/hotel-awards/discover"'), s.indexOf('"/api/hotel-awards"'))
    expect(route).toContain("RoameHotelAwardsProvider")
    expect(route).not.toMatch(/Gondola/i)
    expect(route).not.toMatch(/serpapi/i)
  })

  it("the page has the discovery panel, read-only preview, and explicit-click-only execution", () => {
    const html = fs.readFileSync("hotel-awards.html", "utf-8")
    for (const id of ["d-location", "d-in", "d-out", "d-max", "d-preview", "d-run", "d-plan", "d-status"]) {
      expect(html).toContain(`id="${id}"`)
    }
    for (const n of ["2", "4", "5", "7"]) expect(html).toContain(`class="d-n" value="${n}" checked`)
    expect(html).toContain("/api/hotel-awards/plan?")
    expect(html).toContain('{ method: "POST" }')
    expect(html).toMatch(/zero provider calls/)
    // Execution only via the explicit click listener — never invoked on load
    // (the only parenthesized appearances are the function declarations).
    expect(html).toContain('addEventListener("click", runDiscovery)')
    expect(html).not.toMatch(/(?<!function )runDiscovery\(\)/)
    expect(html).not.toMatch(/(?<!function )previewPlan\(\)/)
    // After a run, the EXISTING read-out re-renders (cards, filters, badges).
    expect(html).toMatch(/await load\(\)/)
    expect(html).toContain("perkBadges(o)")
  })
})
