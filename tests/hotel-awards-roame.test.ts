/**
 * Roame Hotels — provider #2 on the REAL authenticated Encore search.
 *
 * Fixtures mirror the live-verified response (2026-08-28):
 * HotelAvailablePeriods(input: HotelRoomPeriodWhereInput!) on /encore/graphql,
 * offerPeriods with per-night avgAwardPoints and USD avgSurchargeUsd/
 * avgCashPriceUsd.
 *
 * Under test: exact Encore request shape, server-dictated enum casing, bbox
 * requirement (no geocoding), per-night mapping with NO synthesized stay
 * total, USD units, zero-surcharge staying unknown, echo checks, pagination,
 * auth/session failure, that the obsolete /api/graphql path is unreachable,
 * and that Gondola is untouched.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { loadHotelAwardsConfig } from "../providers/hotel-awards/gondola.js"
import {
  RoameHotelAwardsProvider,
  buildEncoreInput,
  mapEncorePage,
  mapRoameOffer,
  resolveBbox,
  type RoameHotelAvailablePeriods,
} from "../providers/hotel-awards/roame.js"
import {
  hotelAwardDedupeKey,
  insertHotelAwards,
  listHotelAwards,
  validateHotelAward,
} from "../providers/hotel-awards/store.js"
import type { HotelAwardQuery } from "../providers/hotel-awards/types.js"

const CFG = loadHotelAwardsConfig(true)
const ROAME = CFG.roame!
const QUERY: HotelAwardQuery = { location: "Bangkok", checkIn: "2026-11-21", checkOut: "2026-11-26", adults: 2 }
const OPTS = { programMap: ROAME.hotelProgramMap, fetchedAt: "2026-08-28T21:00:00.000Z" }

// Live-verified first result (Hyatt Place Bangkok Sukhumvit 24).
function page(over: Partial<RoameHotelAvailablePeriods> = {}): RoameHotelAvailablePeriods {
  return {
    hasMore: false,
    endCursor: null,
    availableHotels: [
      {
        hotelDetail: { id: "bkkzs", name: "Hyatt Place Bangkok Sukhumvit 24", brand: "PLACE", mileageProgram: "HYATT", city: "Bangkok", country: "TH", url: "https://www.hyatt.com/hyatt-place/en-US/bkkzs-hyatt-place-bangkok-sukhumvit-24" },
        availableRooms: [
          {
            roomDetail: { roomCode: "KNGX", roomName: "1 King Bed", roomType: "GuestRoom" },
            offerPeriods: [
              { avgAwardPoints: 4500, avgSurchargeUsd: 0, avgCashPriceUsd: 104, avgCpp: 2.31, nights: 5, roomCode: "KNGX", roomType: "GuestRoom", startDate: "2026-11-21", mileageProgram: "HYATT", offerCode: "LPRM", createTime: "2026-08-28T04:21:19.997Z" },
            ],
          },
        ],
        availabilityPercent: 95,
        lastUpdated: "2026-08-28T04:21:19.997Z",
      },
    ],
    ...over,
  }
}

let db: DB
beforeEach(() => { db = createMemoryDb() })

describe("the real Encore request shape", () => {
  it("builds HotelRoomPeriodWhereInput with server-dictated enum casing, real bbox and mapped programs", () => {
    const bbox = resolveBbox(ROAME, "Bangkok")!
    const input = buildEncoreInput(ROAME, QUERY, bbox, 5, null) as Record<string, any>
    expect(input.roomType).toBe("All")                       // NOT "ALL"
    expect(input.sortBy).toBe("AwardPoints")                 // NOT "AWARD_POINTS"
    expect(input.stayDateRange).toEqual({ startDate: "2026-11-21", endDate: "2026-11-26" })
    expect(input.minNights).toBe(5)
    expect(input.awardPointsRange).toEqual({ start: 1000, end: 300000 })
    // Programs are the explicit source enum keys — never a guess.
    expect(input.mileagePrograms).toEqual(expect.arrayContaining(["HYATT", "HILTON", "MARRIOTT", "IHG", "WYNDHAM"]))
    // Location is a GeoJSON map box, not a string.
    expect(input.mapBoundInput.bounding.type).toBe("Point")
    expect(input.mapBoundInput.bounding.bbox).toEqual([100.3, 13.5, 100.9, 13.95])
    expect(input.mapBoundInput.enforce).toBe(true)
    expect(input.startCursorGT).toBeNull()
  })

  it("a location with no configured bbox resolves to null — never geocoded", () => {
    expect(resolveBbox(ROAME, "Bangkok")).not.toBeNull()
    expect(resolveBbox(ROAME, "Atlantis")).toBeNull()
    expect(resolveBbox(ROAME, "note")).toBeNull()            // the config note key is not a location
  })
})

describe("per-night mapping — no synthesized stay total", () => {
  const awards = mapEncorePage(page(), OPTS)

  it("avgAwardPoints becomes pointsPerNight; quoteBasis is per_night; NO stay total", () => {
    expect(awards).toHaveLength(1)
    const a = awards[0]
    expect(a.quoteBasis).toBe("per_night")
    expect(a.pointsPerNight).toBe(4500)
    expect(a.pointsTotal).toBeNull()                         // 4500 × 5 is NEVER computed
    expect(a.nights).toBe(5)
    expect(a.checkIn).toBe("2026-11-21")
    expect(a.checkOut).toBe("2026-11-26")                    // startDate + stated nights
  })

  it("program is mapped explicitly; property id, room and freshness preserved", () => {
    const a = awards[0]
    expect(a.program).toBe("WORLD_OF_HYATT")
    expect(a.sourceProgramName).toBe("HYATT")
    expect(a.providerPropertyRef).toBe("bkkzs")
    expect(a.propertyId).toBeNull()
    expect(a.roomClass).toBe("GuestRoom")
    expect(a.roomName).toBe("1 King Bed")
    expect(a.sourceFreshness).toBe("2026-08-28T04:21:19.997Z")
    expect(a.bookingUrl).toContain("hyatt.com")
  })

  it("cash comparison is USD and labelled; availability stays unknown (period data, not a live hold)", () => {
    const a = awards[0]
    expect(a.cashComparisonAmount).toBe(104)
    expect(a.cashComparisonCurrency).toBe("USD")
    expect(a.availabilityState).toBe("unknown")
  })

  it("a ZERO surcharge is NOT a stated zero tax — taxes remain unknown", () => {
    expect(awards[0].taxesFeesState).toBe("unknown")
    expect(awards[0].taxesFeesAmount).toBeNull()
  })

  it("a POSITIVE surcharge is stated in USD", () => {
    const withTax = page({ availableHotels: [{ ...page().availableHotels![0],
      availableRooms: [{ roomDetail: page().availableHotels![0].availableRooms![0].roomDetail,
        offerPeriods: [{ ...page().availableHotels![0].availableRooms![0].offerPeriods![0], avgSurchargeUsd: 38.5 }] }] }] })
    const a = mapEncorePage(withTax, OPTS)[0]
    expect(a.taxesFeesState).toBe("stated")
    expect(a.taxesFeesAmount).toBe(38.5)
    expect(a.taxesFeesCurrency).toBe("USD")
  })

  it("rows missing program / nights / points / startDate are dropped, never faked", () => {
    const base = page().availableHotels![0].availableRooms![0].offerPeriods![0]
    const detail = page().availableHotels![0].hotelDetail!
    expect(mapRoameOffer({ ...detail, mileageProgram: null }, [], { ...base, mileageProgram: null }, { ...OPTS, lastUpdated: null })).toBeNull()
    expect(mapRoameOffer(detail, [], { ...base, nights: null }, { ...OPTS, lastUpdated: null })).toBeNull()
    expect(mapRoameOffer(detail, [], { ...base, avgAwardPoints: null }, { ...OPTS, lastUpdated: null })).toBeNull()
    expect(mapRoameOffer(detail, [], { ...base, startDate: null }, { ...OPTS, lastUpdated: null })).toBeNull()
  })

  it("a mapped award passes the store's echo validation and persists per_night", () => {
    expect(validateHotelAward(awards[0])).toBeNull()
    const summary = insertHotelAwards(db, awards)
    expect(summary.inserted).toBe(1)
    const row = listHotelAwards(db)[0]
    expect(row.provider).toBe("roame_hotels")
    expect(row.quoteBasis).toBe("per_night")
    expect(row.pointsTotal).toBeNull()
    expect(row.pointsPerNight).toBe(4500)
  })
})

describe("provider — auth/session, bbox gate, pagination, never-throw", () => {
  function withCreds<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.HOTEL_AWARDS_ROAME_CREDS
    process.env.HOTEL_AWARDS_ROAME_CREDS = writeTempCreds()
    return fn().finally(() => {
      if (prev === undefined) delete process.env.HOTEL_AWARDS_ROAME_CREDS
      else process.env.HOTEL_AWARDS_ROAME_CREDS = prev
    })
  }

  it("a missing session is a structured unconfigured/blocked state, never a throw", async () => {
    const p = new RoameHotelAwardsProvider(CFG, (async () => { throw new Error("must not be called") }) as unknown as typeof fetch)
    const prev = process.env.HOTEL_AWARDS_ROAME_CREDS
    process.env.HOTEL_AWARDS_ROAME_CREDS = "/nonexistent/roame.json"
    try {
      const r = await p.search(QUERY)
      expect(r.ok).toBe(false)
      expect(r.reason).toBe("unconfigured")
      expect(r.callsSpent).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.HOTEL_AWARDS_ROAME_CREDS
      else process.env.HOTEL_AWARDS_ROAME_CREDS = prev
    }
  })

  it("a location with no bbox is unconfigured — the provider refuses to guess a box, spends nothing", async () => {
    await withCreds(async () => {
      const p = new RoameHotelAwardsProvider(CFG, (async () => { throw new Error("must not be called") }) as unknown as typeof fetch)
      const r = await p.search({ ...QUERY, location: "Atlantis" })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe("unconfigured")
      expect(r.error).toMatch(/refusing to geocode/)
      expect(r.callsSpent).toBe(0)
    })
  })

  it("a 401 maps to blocked with no retry storm", async () => {
    await withCreds(async () => {
      let calls = 0
      const fake = (async () => { calls++; return new Response("", { status: 401 }) }) as unknown as typeof fetch
      const r = await new RoameHotelAwardsProvider(CFG, fake).search(QUERY)
      expect(r.ok).toBe(false)
      expect(r.reason).toBe("blocked")
      expect(calls).toBe(1)
    })
  })

  it("hits /encore/graphql with the HotelAvailablePeriods operation — never /api/graphql", async () => {
    await withCreds(async () => {
      let seenUrl = ""
      let seenBody = ""
      const fake = (async (url: string, init: RequestInit) => {
        seenUrl = url; seenBody = String(init.body)
        return new Response(JSON.stringify({ data: { hotelAvailablePeriods: page() } }), { status: 200, headers: { "Content-Type": "application/json" } })
      }) as unknown as typeof fetch
      const r = await new RoameHotelAwardsProvider(CFG, fake).search(QUERY)
      expect(seenUrl).toBe("https://roame.travel/encore/graphql")
      expect(seenUrl).not.toContain("/api/graphql")
      expect(seenBody).toContain("HotelAvailablePeriods")
      expect(seenBody).not.toContain("pingHotelResult")
      expect(r.awards[0].program).toBe("WORLD_OF_HYATT")
      expect(r.callsSpent).toBe(1)
    })
  })

  it("walks pages via startCursorGT up to maxPages, recording an incomplete cap honestly", async () => {
    await withCreds(async () => {
      const cursors: (string | null)[] = []
      const fake = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        cursors.push(body.variables.input.startCursorGT)
        // Always hasMore → forces the maxPages cap (config maxPages=2).
        return new Response(JSON.stringify({ data: { hotelAvailablePeriods: page({ hasMore: true, endCursor: `cur-${cursors.length}` }) } }), { status: 200, headers: { "Content-Type": "application/json" } })
      }) as unknown as typeof fetch
      const r = await new RoameHotelAwardsProvider(CFG, fake).search(QUERY)
      expect(r.callsSpent).toBe(ROAME.search.maxPages)       // capped, not unbounded
      expect(cursors[0]).toBeNull()                          // first page: no cursor
      expect(cursors[1]).toBe("cur-1")                       // second page walked the cursor
      expect(r.searchState).toBe("incomplete")               // stopped at the cap with more available
    })
  })

  it("stops early (complete) when the source says no more pages", async () => {
    await withCreds(async () => {
      let calls = 0
      const fake = (async () => { calls++; return new Response(JSON.stringify({ data: { hotelAvailablePeriods: page({ hasMore: false }) } }), { status: 200, headers: { "Content-Type": "application/json" } }) }) as unknown as typeof fetch
      const r = await new RoameHotelAwardsProvider(CFG, fake).search(QUERY)
      expect(calls).toBe(1)
      expect(r.searchState).toBe("complete")
    })
  })
})

describe("cross-provider dedupe keeps source identity distinct", () => {
  it("Roame and Gondola observations never share a dedupe key or merge", () => {
    const roame = mapEncorePage(page(), OPTS)[0]
    const gondola = { ...roame, provider: "gondola_hotels", providerPropertyRef: "39678735" }
    expect(hotelAwardDedupeKey(roame)).not.toBe(hotelAwardDedupeKey(gondola))
    const summary = insertHotelAwards(db, [roame, gondola])
    expect(summary.inserted).toBe(2)
    const rows = listHotelAwards(db)
    expect(new Set(rows.map(r => r.provider))).toEqual(new Set(["roame_hotels", "gondola_hotels"]))
  })
})

let tempCredsCounter = 0
function writeTempCreds(): string {
  const p = path.join(os.tmpdir(), `roame-test-creds-${tempCredsCounter++}.json`)
  fs.writeFileSync(p, JSON.stringify({ session: "test-session", csrfSecret: "test-csrf" }))
  return p
}
