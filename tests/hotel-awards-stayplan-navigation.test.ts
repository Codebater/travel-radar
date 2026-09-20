/**
 * Stay-plan booking navigation — the read-only join from ranked segments to
 * stored locators.
 *
 * Pinned: a provider URL that survives the allowlist AND carries the stay's
 * dates surfaces as SEARCH_REPLAY_LINK with the verbatim URL and the
 * observation's fetchedAt; an off-allowlist URL and a missing URL both
 * surface as UNAVAILABLE with a null url; EXACT_DEEP_LINK is never claimed
 * for a hotel award; the fallback source lookup resolves an observation the
 * caller did not hand over; an observation with no locator row at all is
 * UNAVAILABLE with a null observedAt; enrichment mutates in place and leaves
 * plan signatures and segment order byte-identical; and the module's source
 * neither writes locators nor reaches a provider.
 */

import fs from "fs"
import { beforeAll, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { insertHotelAwards, listHotelAwards, type StoredHotelAward } from "../providers/hotel-awards/store.js"
import { buildStayPlan, type PlanSegment, type StayPlanResult } from "../providers/hotel-awards/stayplan.js"
import { attachSegmentNavigation } from "../providers/hotel-awards/stayplan-navigation.js"
import type { NormalizedHotelAward } from "../providers/hotel-awards/types.js"

const RANGE = { start: "2026-11-21", end: "2026-11-26" }   // 5 nights
const FETCHED_AT = "2026-08-28T21:00:00.000Z"

// gondola.ai is allowlisted for gondola_hotels (config/offers.json); the URL
// carries both stay dates, so the stored locator is a SEARCH_REPLAY_LINK.
const GONDOLA_URL = "https://gondola.ai/hotel/details/39678735?checkin=2026-11-21&checkout=2026-11-26&numberOfAdults=2"
const GONDOLA_URL_TAIL = "https://gondola.ai/hotel/details/41120000?checkin=2026-11-23&checkout=2026-11-26&numberOfAdults=2"
// roame_hotels is allowlisted for roame.travel only — a hyatt.com URL is
// dropped at locator build time and the locator degrades to UNAVAILABLE.
const HYATT_URL = "https://www.hyatt.com/shop/rooms/bkkzs?checkinDate=2026-11-21&checkoutDate=2026-11-26"

function award(over: Partial<NormalizedHotelAward> = {}): NormalizedHotelAward {
  return {
    provider: "roame_hotels", providerPropertyRef: "bkkzs", propertyId: null,
    propertyName: "Hyatt Place Bangkok", chain: "PLACE",
    program: "WORLD_OF_HYATT", sourceProgramName: "HYATT",
    checkIn: RANGE.start, checkOut: RANGE.end, nights: 5,
    quoteBasis: "per_night", roomClass: "GuestRoom", roomName: "1 King Bed",
    pointsTotal: null, pointsPerNight: 4500,
    taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
    awardType: "points", cashComparisonAmount: 104, cashComparisonCurrency: "USD",
    availabilityState: "unknown", searchState: "complete", verificationLevel: "discovered",
    sourceFreshness: "2026-08-28T04:21:19Z", bookingUrl: null,
    fetchedAt: FETCHED_AT,
    ...over,
  }
}

/** The fixture set: three whole-range stays plus a 2n+3n split pair so at
 *  least one plan carries two segments in date order. */
function fixtures(): NormalizedHotelAward[] {
  return [
    award({
      provider: "gondola_hotels", providerPropertyRef: "39678735", propertyName: "JW Marriott Bangkok", chain: "MC",
      program: "MARRIOTT_BONVOY", sourceProgramName: "Marriott (Bonvoy)",
      quoteBasis: "full_stay", pointsTotal: 200000, pointsPerNight: 40000, bookingUrl: GONDOLA_URL,
    }),
    award({ bookingUrl: HYATT_URL }),                                              // roame_hotels, off-allowlist URL
    award({ providerPropertyRef: "h3", propertyName: "Hyatt Regency Bangkok", bookingUrl: null }),
    award({ providerPropertyRef: "s1", propertyName: "Park Hyatt Bangkok", checkOut: "2026-11-23", nights: 2 }),
    award({
      provider: "gondola_hotels", providerPropertyRef: "41120000", propertyName: "Marriott Marquis Bangkok", chain: "MC",
      program: "MARRIOTT_BONVOY", sourceProgramName: "Marriott (Bonvoy)",
      checkIn: "2026-11-23", checkOut: RANGE.end, nights: 3,
      quoteBasis: "full_stay", pointsTotal: 120000, pointsPerNight: 40000, bookingUrl: GONDOLA_URL_TAIL,
    }),
  ]
}

function segmentsOf(result: StayPlanResult): PlanSegment[] {
  return result.plans.flatMap(p => p.segments)
}

function segmentFor(result: StayPlanResult, providerPropertyRef: string): PlanSegment {
  const seg = segmentsOf(result).find(s => s.providerPropertyRef === providerPropertyRef)
  expect(seg, `a plan segment for ${providerPropertyRef}`).toBeDefined()
  return seg!
}

/** Strip the enrichment so the remainder can be compared with the pre-enrichment clone. */
function withoutNavigation(result: StayPlanResult): StayPlanResult {
  return {
    ...result,
    plans: result.plans.map(p => ({
      ...p,
      segments: p.segments.map(s => { const rest = { ...s }; delete rest.navigation; return rest }),
    })),
  }
}

// Built once: the DB, the stored observations, a pre-enrichment deep clone
// and the enriched result all describe the same scenario.
let db: DB
let observations: StoredHotelAward[]
let before: StayPlanResult
let result: StayPlanResult
let returned: StayPlanResult

beforeAll(() => {
  db = createMemoryDb()
  const summary = insertHotelAwards(db, fixtures())
  expect(summary.rejected).toEqual([])
  expect(summary.inserted).toBe(5)
  observations = listHotelAwards(db, { limit: 100 })
  result = buildStayPlan(observations, RANGE.start, RANGE.end, { maxAlternatives: 10 })
  before = JSON.parse(JSON.stringify(result)) as StayPlanResult
  returned = attachSegmentNavigation(db, result, observations)
})

describe("attachSegmentNavigation resolves each segment to its stored locator", () => {
  it("an allowlisted provider URL carrying the stay dates is a SEARCH_REPLAY_LINK — verbatim URL, dated by the observation's fetchedAt", () => {
    const seg = segmentFor(result, "39678735")
    expect(seg.provider).toBe("gondola_hotels")
    expect(seg.navigation).toEqual({ quality: "SEARCH_REPLAY_LINK", url: GONDOLA_URL, observedAt: FETCHED_AT })
    // observedAt is the stored observation's own fetchedAt, not "now".
    const stored = observations.find(o => o.id === seg.observationId)!
    expect(seg.navigation!.observedAt).toBe(stored.fetchedAt)
    expect(seg.navigation!.observedAt).toBe(seg.evidence.fetchedAt)
  })

  it("an off-allowlist provider URL (hyatt.com for roame_hotels) is UNAVAILABLE with a null url — never repaired", () => {
    const seg = segmentFor(result, "bkkzs")
    expect(seg.provider).toBe("roame_hotels")
    expect(seg.navigation!.quality).toBe("UNAVAILABLE")
    expect(seg.navigation!.url).toBeNull()
    // The degraded locator row still exists, so its observation date is carried.
    expect(seg.navigation!.observedAt).toBe(FETCHED_AT)
  })

  it("a missing booking URL is UNAVAILABLE with a null url", () => {
    const seg = segmentFor(result, "h3")
    expect(seg.navigation!.quality).toBe("UNAVAILABLE")
    expect(seg.navigation!.url).toBeNull()
  })

  it("every segment of every plan gets a navigation, and none is ever EXACT_DEEP_LINK", () => {
    const segs = segmentsOf(result)
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) {
      expect(s.navigation).toBeDefined()
      expect(s.navigation!.quality).not.toBe("EXACT_DEEP_LINK")
      expect(["SEARCH_REPLAY_LINK", "PROVIDER_LANDING_LINK", "UNAVAILABLE"]).toContain(s.navigation!.quality)
      // A null url is only ever paired with UNAVAILABLE, and vice versa.
      expect(s.navigation!.url === null).toBe(s.navigation!.quality === "UNAVAILABLE")
    }
  })

  it("the split plan carries both segments in date order, each with its own navigation", () => {
    const split = result.plans.find(p => p.segments.length === 2)
    expect(split).toBeDefined()
    expect(split!.segments.map(s => s.providerPropertyRef)).toEqual(["s1", "41120000"])
    expect(split!.segments[0].navigation!.quality).toBe("UNAVAILABLE")
    expect(split!.segments[1].navigation).toEqual({ quality: "SEARCH_REPLAY_LINK", url: GONDOLA_URL_TAIL, observedAt: FETCHED_AT })
  })
})

describe("enrichment is pure — nothing about the ranked plans moves", () => {
  it("mutates in place and returns the same result object", () => {
    expect(returned).toBe(result)
  })

  it("plan signatures and segment order are byte-identical before and after", () => {
    expect(result.plans.map(p => p.signature)).toEqual(before.plans.map(p => p.signature))
    expect(result.plans.map(p => p.segments.map(s => s.observationId)))
      .toEqual(before.plans.map(p => p.segments.map(s => s.observationId)))
    // Everything except the attached navigation is exactly what ranking produced.
    expect(JSON.parse(JSON.stringify(withoutNavigation(result)))).toEqual(before)
  })

  it("no number is synthesized: per-night segments still carry no total after enrichment", () => {
    const seg = segmentFor(result, "bkkzs")
    expect(seg.quoteBasis).toBe("per_night")
    expect(seg.pointsPerNight).toBe(4500)
    expect(seg.pointsTotal).toBeNull()                       // 4500 × 5 is never introduced
  })
})

describe("lookup paths", () => {
  it("an observation the caller did not hand over still resolves via the source lookup", () => {
    const fresh = createMemoryDb()
    insertHotelAwards(fresh, [fixtures()[0]])                // the gondola stay only
    const obs = listHotelAwards(fresh, { limit: 10 })
    const r = attachSegmentNavigation(fresh, buildStayPlan(obs, RANGE.start, RANGE.end), [])   // empty map → fallback
    const best = r.plans[0]                                  // the complete plan; the all-gap alternative follows
    expect(best.coveredNights).toBe(5)
    expect(best.segments).toHaveLength(1)
    expect(best.segments[0].navigation).toEqual({ quality: "SEARCH_REPLAY_LINK", url: GONDOLA_URL, observedAt: FETCHED_AT })
  })

  it("an observation with no locator row at all is UNAVAILABLE with a null observedAt", () => {
    const fresh = createMemoryDb()
    // In-memory rows that were never inserted — no locator exists for them.
    const ghost: StoredHotelAward = {
      ...award(), id: 900, dedupeKey: "k900", locatorId: null, createdAt: FETCHED_AT,
    }
    const r = attachSegmentNavigation(fresh, buildStayPlan([ghost], RANGE.start, RANGE.end), [ghost])
    const best = r.plans[0]
    expect(best.coveredNights).toBe(5)
    expect(best.segments).toHaveLength(1)
    expect(best.segments[0].navigation).toEqual({ quality: "UNAVAILABLE", url: null, observedAt: null })
  })
})

describe("module honesty", () => {
  it("the module only SELECTs: it never writes a locator and never reaches a provider", () => {
    const src = fs.readFileSync("providers/hotel-awards/stayplan-navigation.ts", "utf-8")
    expect(src).not.toContain("upsertLocator")
    expect(src).not.toContain("fetch(")
    // No URL construction or repair of any kind — stored values only.
    expect(src).not.toContain("new URL(")
    expect(src).not.toContain("buildQueryUrl")
    expect(src).not.toContain("safeProviderUrl")
    expect(src).not.toMatch(/from "\.\/(gondola|roame|discover|planner)\.js"/)
    // The doc comment states the after-ranking / read-only constraint.
    expect(src).toMatch(/AFTER buildStayPlan/)
    expect(src).toMatch(/plain SELECTs only/)
  })
})
