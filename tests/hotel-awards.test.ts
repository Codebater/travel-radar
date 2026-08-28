/**
 * Hotel Award Radar Phase 1 — provider contract, honesty rules, storage.
 *
 * Fixtures are the REAL Gondola MCP markdown dialect captured live
 * 2026-08-28. Load-bearing claims under test:
 *   - a stay total exists only when the source printed one (never nightly×N,
 *     enforced twice: validation and schema CHECK);
 *   - taxes unknown stays unknown, never zero;
 *   - echo/identity mismatches are rejected at the door;
 *   - blocked/empty/format-drift are structured states, never throws;
 *   - duplicates append, history never mutates;
 *   - booking navigation rides the existing honesty ladder.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  GondolaHotelAwardsProvider,
  loadHotelAwardsConfig,
  mapHotelProgram,
  multiNightConfirmsWindow,
  parseBookingLink,
  parseSearchMarkdown,
} from "../providers/hotel-awards/gondola.js"
import {
  buildHotelAwardLocator,
  hotelAwardDedupeKey,
  insertHotelAwards,
  listHotelAwards,
  validateHotelAward,
} from "../providers/hotel-awards/store.js"
import type { NormalizedHotelAward } from "../providers/hotel-awards/types.js"

const CFG = loadHotelAwardsConfig(true)

// Captured live from mcp.gondola.ai 2026-08-28 (Bangkok, Nov 21–26).
const SEARCH_MD = `## Hotel Search Results (40 hotels found, showing top 20)

### Ramada Plaza by Wyndham Bangkok Menam Riverside (ID: 39678735)
**Location:** 2074 Charoenkrung Road, Bangkok, , TH | **City:** Bangkok | **Chain:** Wyndham | **Stars:** 5.0 | **Guest Rating:** 8.4/10 (961 reviews)
**Cash: USD 185.00/night** (total: USD 926.47) | Cash deal score: 9.0/10 (Excellent!)
**Points: 7,500 pts/night** (37,500 pts total) via Wyndham Rewards | **2.5 cpp** (Excellent value!) | Points deal score: 9.9/10 (Excellent!)
**Recommendation: Use points**

### InterContinental Bangkok Sukhumvit, an IHG Hotel (ID: 41613692)
**Location:** 10 Soi Sukhumvit 59, Bangkok, , TH | **City:** Bangkok | **Chain:** IHG | **Stars:** 5.0 | **Guest Rating:** 9.0/10 (31 reviews)
**Cash: USD 204.00/night** (total: USD 1018.74) | Cash deal score: 9.5/10 (Excellent!)
**Points: 31,200 pts/night** (124,800 pts total) via IHG One Rewards | **0.6 cpp** (Below average) | Points deal score: 9.8/10 (Excellent!)
**Recommendation: Pay cash**

### Cash Only Hotel Bangkok (ID: 12345678)
**Location:** Somewhere, Bangkok, TH | **City:** Bangkok | **Chain:** Independent | **Stars:** 4.0
**Cash: USD 99.00/night** (total: USD 495.00) | Cash deal score: 8.0/10

### Nightly Only Resort (ID: 87654321)
**Location:** Riverside, Bangkok, TH | **City:** Bangkok | **Chain:** Hyatt | **Stars:** 5.0
**Cash: USD 300.00/night** | Cash deal score: 5.0/10
**Points: 25,000 pts/night** via World of Hyatt | **1.2 cpp** (Good value)
`

const MULTI_NIGHT_MD = `## Rate Calendar (1 dates available)

**2026-11-21 → 2026-11-26** — THB 6090.00/night | total THB 30450.00 | 7,500 pts/night | 2.5 cpp | cash 10th pctl | redemption 100th pctl`

const BOOKING_MD = `## Book This Hotel

**[Book on Gondola.ai](https://gondola.ai/hotel/details/39678735?checkin=2026-11-21&checkout=2026-11-26&numberOfAdults=2&scrollToBooking=true)**
Opens the hotel page with your dates pre-filled.`

const QUERY = { location: "Bangkok", checkIn: "2026-11-21", checkOut: "2026-11-26", adults: 2 }

type StubResponse = { text: string | null; status: number | null; error: string | null }
function stubClient(byTool: Record<string, StubResponse>): { calls: string[]; callTool: (name: string, args: Record<string, unknown>) => Promise<StubResponse> } {
  const calls: string[] = []
  return {
    calls,
    async callTool(name: string) {
      calls.push(name)
      return byTool[name] ?? { text: null, status: 500, error: "unexpected tool" }
    },
  }
}

const ok = (text: string): StubResponse => ({ text, status: 200, error: null })

function provider(byTool: Record<string, StubResponse>) {
  const client = stubClient(byTool)
  // Zero politeness delay for tests.
  const cfg = { ...CFG, budget: { ...CFG.budget, politenessMs: 0 } }
  return { provider: new GondolaHotelAwardsProvider(cfg, client), client }
}

let db: DB
beforeEach(() => { db = createMemoryDb() })

describe("the gondola provider — honest normalization", () => {
  it("a source-stated stay total becomes a full_stay quote; the multi-night echo confirms availability", async () => {
    const { provider: p } = provider({
      search_hotels: ok(SEARCH_MD),
      get_multi_night_rates: ok(MULTI_NIGHT_MD),
      get_booking_link: ok(BOOKING_MD),
    })
    const result = await p.search(QUERY)
    expect(result.ok).toBe(true)
    expect(result.searchState).toBe("complete")

    const ramada = result.awards.find(a => a.providerPropertyRef === "39678735")!
    expect(ramada.quoteBasis).toBe("full_stay")
    expect(ramada.pointsTotal).toBe(37500)          // exactly as the source printed it
    expect(ramada.pointsPerNight).toBe(7500)
    expect(ramada.program).toBe("WYNDHAM_REWARDS")  // explicit config map
    expect(ramada.sourceProgramName).toBe("Wyndham Rewards")
    expect(ramada.nights).toBe(5)
    expect(ramada.availabilityState).toBe("available")   // window echoed by the calendar
    expect(ramada.bookingUrl).toContain("gondola.ai/hotel/details/39678735")
    // Cash context is labelled and separate — never a valuation.
    expect(ramada.cashComparisonAmount).toBe(926.47)
    expect(ramada.cashComparisonCurrency).toBe("USD")
  })

  it("a nightly-only quote can NEVER become a full-stay total", async () => {
    const { provider: p } = provider({ search_hotels: ok(SEARCH_MD), get_multi_night_rates: ok(MULTI_NIGHT_MD), get_booking_link: ok(BOOKING_MD) })
    const result = await p.search(QUERY)
    const nightly = result.awards.find(a => a.providerPropertyRef === "87654321")!
    expect(nightly.quoteBasis).toBe("per_night")
    expect(nightly.pointsTotal).toBeNull()          // 25,000 × 5 is never computed
    expect(nightly.pointsPerNight).toBe(25000)
    expect(nightly.program).toBe("WORLD_OF_HYATT")
  })

  it("cash-only hotels are not award observations; taxes stay unknown, never zero", async () => {
    const { provider: p } = provider({ search_hotels: ok(SEARCH_MD), get_multi_night_rates: ok(MULTI_NIGHT_MD), get_booking_link: ok(BOOKING_MD) })
    const result = await p.search(QUERY)
    expect(result.awards.some(a => a.providerPropertyRef === "12345678")).toBe(false)
    for (const a of result.awards) {
      expect(a.taxesFeesState).toBe("unknown")
      expect(a.taxesFeesAmount).toBeNull()
    }
  })

  it("a missing multi-night echo leaves availability unknown — absence of proof is not proof either way", async () => {
    const { provider: p } = provider({
      search_hotels: ok(SEARCH_MD),
      get_multi_night_rates: ok("## Rate Calendar (1 dates available)\n\n**2026-11-22 → 2026-11-25** — 7,500 pts/night"),
      get_booking_link: ok(BOOKING_MD),
    })
    const result = await p.search(QUERY)
    const detailed = result.awards.find(a => a.providerPropertyRef === "39678735")!
    expect(detailed.availabilityState).toBe("unknown")
  })

  it("blocked, empty and format-drift are structured states — never a throw", async () => {
    const blocked = await provider({ search_hotels: { text: null, status: 403, error: "HTTP 403" } }).provider.search(QUERY)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe("blocked")
    expect(blocked.searchState).toBe("blocked")

    const empty = await provider({ search_hotels: ok("## Hotel Search Results (0 hotels found)\n") }).provider.search(QUERY)
    expect(empty.ok).toBe(true)
    expect(empty.searchState).toBe("empty")
    expect(empty.awards).toHaveLength(0)

    const drifted = await provider({ search_hotels: ok("<html>redesigned</html>") }).provider.search(QUERY)
    expect(drifted.ok).toBe(false)
    expect(drifted.reason).toBe("format-changed")
  })

  it("the request plan is capped: 1 search + 2 calls per detailed hotel", async () => {
    const { provider: p, client } = provider({ search_hotels: ok(SEARCH_MD), get_multi_night_rates: ok(MULTI_NIGHT_MD), get_booking_link: ok(BOOKING_MD) })
    expect(p.plannedCalls()).toBe(1 + 2 * CFG.budget.detailTopN)
    const result = await p.search(QUERY)
    expect(result.callsSpent).toBeLessThanOrEqual(p.plannedCalls())
    expect(client.calls.filter(c => c === "search_hotels")).toHaveLength(1)
  })
})

describe("storage — echo-checked, append-only, schema-locked", () => {
  function award(over: Partial<NormalizedHotelAward> = {}): NormalizedHotelAward {
    return {
      provider: "gondola_hotels", providerPropertyRef: "39678735", propertyId: null,
      propertyName: "Ramada Plaza by Wyndham Bangkok Menam Riverside", chain: "Wyndham",
      program: "WYNDHAM_REWARDS", sourceProgramName: "Wyndham Rewards",
      checkIn: "2026-11-21", checkOut: "2026-11-26", nights: 5,
      quoteBasis: "full_stay", roomClass: null, roomName: null,
      pointsTotal: 37500, pointsPerNight: 7500,
      taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
      awardType: "points", cashComparisonAmount: 926.47, cashComparisonCurrency: "USD",
      availabilityState: "available", searchState: "complete", verificationLevel: "discovered",
      sourceFreshness: null,
      bookingUrl: "https://gondola.ai/hotel/details/39678735?checkin=2026-11-21&checkout=2026-11-26&numberOfAdults=2",
      fetchedAt: "2026-08-28T21:00:00.000Z",
      ...over,
    }
  }

  it("date/nights, property and program mismatches are rejected at the door", () => {
    expect(validateHotelAward(award({ nights: 4 }))).toMatch(/nights mismatch/)
    expect(validateHotelAward(award({ checkOut: "2026-11-20" }))).toMatch(/invalid stay window/)
    expect(validateHotelAward(award({ propertyName: " " }))).toMatch(/property identity/)
    expect(validateHotelAward(award({ program: "" }))).toMatch(/program missing/)
    expect(validateHotelAward(award())).toBeNull()
  })

  it("a per-night quote carrying a stay total is rejected — and the schema refuses it too", () => {
    expect(validateHotelAward(award({ quoteBasis: "per_night" }))).toMatch(/never multiplied/)
    const summary = insertHotelAwards(db, [award({ quoteBasis: "per_night" })])
    expect(summary.inserted).toBe(0)
    expect(summary.rejected[0].reason).toMatch(/never multiplied/)
    // Second lock: a raw insert bypassing validation trips the CHECK.
    expect(() => db.prepare(`
      INSERT INTO hotel_award_observations (dedupe_key, provider, provider_property_ref, property_name,
        program, source_program_name, check_in, check_out, nights, quote_basis, points_total, points_per_night,
        taxes_fees_state, award_type, availability_state, search_state, verification_level, fetched_at, created_at)
      VALUES ('k','gondola_hotels','1','X','P','P','2026-11-21','2026-11-26',5,'per_night',37500,7500,
        'unknown','points','unknown','complete','discovered','t','t')
    `).run()).toThrow(/CHECK/)
    // And a full_stay quote without a stated total is equally unpersistable.
    expect(validateHotelAward(award({ pointsTotal: null }))).toMatch(/without a source-stated points total/)
  })

  it("unknown taxes stay unknown — an amount on an unknown state is rejected", () => {
    expect(validateHotelAward(award({ taxesFeesAmount: 0 }))).toMatch(/cannot carry an amount/)
    expect(validateHotelAward(award({ taxesFeesState: "stated", taxesFeesAmount: 120, taxesFeesCurrency: "USD" }))).toBeNull()
    expect(validateHotelAward(award({ taxesFeesState: "stated" }))).toMatch(/need an amount/)
  })

  it("duplicates append honestly — same dedupe key, both rows kept, nothing mutated", () => {
    insertHotelAwards(db, [award()])
    insertHotelAwards(db, [award({ pointsTotal: 40000, fetchedAt: "2026-08-29T09:00:00.000Z" })])
    const rows = listHotelAwards(db)
    expect(rows).toHaveLength(2)
    expect(rows[0].dedupeKey).toBe(rows[1].dedupeKey)
    expect(new Set(rows.map(r => r.pointsTotal))).toEqual(new Set([37500, 40000]))
  })

  it("the dedupe key is price-free identity — nights and basis are hard dimensions", () => {
    const base = { provider: "gondola_hotels", providerPropertyRef: "1", program: "P", checkIn: "2026-11-21", nights: 5, roomClass: null, quoteBasis: "full_stay" }
    expect(hotelAwardDedupeKey(base)).toBe(hotelAwardDedupeKey({ ...base }))
    expect(hotelAwardDedupeKey(base)).not.toBe(hotelAwardDedupeKey({ ...base, nights: 4 }))
    expect(hotelAwardDedupeKey(base)).not.toBe(hotelAwardDedupeKey({ ...base, quoteBasis: "per_night" }))
  })

  it("booking navigation rides the honesty ladder — dates-encoded allowlisted URL is a replay, never EXACT", () => {
    const replay = buildHotelAwardLocator(award(), 1)
    expect(replay.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    expect(replay.deepLinkUrl).toBeNull()
    expect(replay.searchReplayUrl).toContain("gondola.ai")

    const landing = buildHotelAwardLocator(award({ bookingUrl: "https://gondola.ai/hotel/details/39678735" }), 1)
    expect(landing.navigationQuality).toBe("PROVIDER_LANDING_LINK")

    const hostile = buildHotelAwardLocator(award({ bookingUrl: "https://evil.example.com/x?checkin=2026-11-21&checkout=2026-11-26" }), 1)
    expect(hostile.navigationQuality).toBe("UNAVAILABLE")
    expect(buildHotelAwardLocator(award({ bookingUrl: null }), 1).navigationQuality).toBe("UNAVAILABLE")
  })

  it("stored observations carry a locator and survive listing round-trip", () => {
    const summary = insertHotelAwards(db, [award()])
    expect(summary.inserted).toBe(1)
    const row = listHotelAwards(db)[0]
    expect(row.locatorId).not.toBeNull()
    expect(row.program).toBe("WYNDHAM_REWARDS")
    expect(row.quoteBasis).toBe("full_stay")
    expect(row.taxesFeesState).toBe("unknown")
  })
})

describe("small pure helpers", () => {
  it("program mapping is explicit; unmapped keeps the source's own normalized name", () => {
    expect(mapHotelProgram("Wyndham Rewards", CFG.programMap)).toBe("WYNDHAM_REWARDS")
    expect(mapHotelProgram("IHG One Rewards", CFG.programMap)).toBe("IHG_ONE_REWARDS")
    expect(mapHotelProgram("Some Future Program", CFG.programMap)).toBe("SOME_FUTURE_PROGRAM")
  })

  it("multi-night confirmation requires the exact window echo", () => {
    expect(multiNightConfirmsWindow(MULTI_NIGHT_MD, "2026-11-21", "2026-11-26")).toBe(true)
    expect(multiNightConfirmsWindow(MULTI_NIGHT_MD, "2026-11-21", "2026-11-25")).toBe(false)
  })

  it("booking link parsing takes the provider URL verbatim or nothing", () => {
    expect(parseBookingLink(BOOKING_MD)).toContain("https://gondola.ai/hotel/details/39678735")
    expect(parseBookingLink("no links here")).toBeNull()
  })

  it("search markdown drift returns null, never a guess", () => {
    expect(parseSearchMarkdown("<html>redesign</html>")).toBeNull()
    expect(parseSearchMarkdown(SEARCH_MD)!.length).toBe(4)
  })
})
