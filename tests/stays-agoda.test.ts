import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { AgodaProvider, parseRoomGrid, resolveAgodaRef } from "../providers/stays/agoda.js"
import type { StayRateQuery } from "../providers/stays/types.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, "fixtures", "stays")

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8")) as Record<string, unknown>
}

function stubFetch(body: unknown, opts: { status?: number; text?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(opts.text ?? JSON.stringify(body), { status: opts.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

const QUERY: StayRateQuery = {
  propertyId: "lily-beach-resort",
  providerRef: "41483:17759:34",
  checkIn: "2026-11-10",
  checkOut: "2026-11-15",
  adults: 2,
  children: 0,
  currency: "USD",
}

describe("agoda room-grid parsing", () => {
  it("normalizes rooms × offers with board, cancellation, occupancy and tax-inclusive nightly prices", () => {
    const parsed = parseRoomGrid(fixture("agoda-room-grid-ok.json"), QUERY, 41483, 5, "agoda")
    if ("error" in parsed) throw new Error(parsed.error)
    // The unpriced "Mystery Deal" observes nothing; three priced offers remain.
    expect(parsed.rates).toHaveLength(3)

    const ai = parsed.rates.find(r => r.roomName === "Lagoon Villa" && r.board === "all_inclusive")!
    expect(ai.price).toEqual({ amount: 937, currency: "USD" })
    expect(ai.priceBasis).toBe("nightly_room")
    expect(ai.taxesFees).toBe("included")           // explicit "incl. taxes & fees"
    expect(ai.boardSource).toBe("structured")       // "All Inclusive" named benefit
    expect(ai.refundable).toBe(true)
    expect(ai.cancellationDeadline).toBe("2026-10-27")
    expect(ai.roomClass).toBe("villa")
    expect(ai.rateSource).toBe("Agoda")
    expect(ai.sourceClass).toBe("retail")
    expect(ai.verificationLevel).toBe("confirmed")
    expect(ai.adults).toBe(2)
    expect(ai.nights).toBe(5)
  })

  it("keeps a rate without a tax note at taxes UNKNOWN — missing is never inclusive", () => {
    const parsed = parseRoomGrid(fixture("agoda-room-grid-ok.json"), QUERY, 41483, 5, "agoda")
    if ("error" in parsed) throw new Error(parsed.error)
    const saver = parsed.rates.find(r => r.roomName === "Lagoon Villa" && r.board !== "all_inclusive")!
    // "per night before taxes" does not say included; the parser must not guess.
    expect(saver.taxesFees).toBe("unknown")
  })

  it("reads a non-refundable rate as refundable=false with no invented deadline", () => {
    const parsed = parseRoomGrid(fixture("agoda-room-grid-ok.json"), QUERY, 41483, 5, "agoda")
    if ("error" in parsed) throw new Error(parsed.error)
    const saver = parsed.rates.find(r => r.refundable === false)!
    expect(saver.refundable).toBe(false)
    expect(saver.cancellationDeadline).toBeNull()
    expect(saver.board).toBe("room_only")           // from the offer name text
  })

  it("leaves board unknown when nothing states it", () => {
    const payload = fixture("agoda-room-grid-ok.json")
    const rooms = payload.rooms as Record<string, unknown>[]
    const offer = ((rooms[1].offers as Record<string, unknown>[])[0])
    offer.name = "Special Rate"
    offer.benefits = []
    delete (offer.bookingDetails as Record<string, unknown>).isBreakfastIncluded
    const parsed = parseRoomGrid(payload, QUERY, 41483, 5, "agoda")
    if ("error" in parsed) throw new Error(parsed.error)
    const special = parsed.rates.find(r => r.roomName === "Deluxe Water Villa")!
    expect(special.board).toBe("unknown")
    expect(special.boardSource).toBe("unknown")
  })

  it("rejects a response for the wrong property", () => {
    const payload = fixture("agoda-room-grid-ok.json")
    payload.propertyId = 99999
    const parsed = parseRoomGrid(payload, QUERY, 41483, 5, "agoda")
    expect("error" in parsed && parsed.error).toContain("identity mismatch")
  })

  it("rejects a response priced for different dates", () => {
    const payload = fixture("agoda-room-grid-ok.json")
    payload.searchCriteriaDescription = "Sep 18 - Sep 19, 2 guests"
    const parsed = parseRoomGrid(payload, QUERY, 41483, 5, "agoda")
    expect("error" in parsed && parsed.error).toContain("date mismatch")
  })

  it("handles a year-wrapping stay description without a false mismatch", () => {
    const payload = fixture("agoda-room-grid-ok.json")
    payload.searchCriteriaDescription = "Dec 28 - Jan 02, 2 guests"
    const query = { ...QUERY, checkIn: "2026-12-28", checkOut: "2027-01-02" }
    const parsed = parseRoomGrid(payload, query, 41483, 5, "agoda")
    expect("error" in parsed).toBe(false)
  })

  it("rejects a response denominated in a currency we did not request", () => {
    const payload = fixture("agoda-room-grid-ok.json")
    const rooms = payload.rooms as Record<string, unknown>[]
    const offer = (rooms[0].offers as Record<string, unknown>[])[0]
    const price = offer.price as Record<string, Record<string, unknown>>
    price.final.currency = "Kč"
    const parsed = parseRoomGrid(payload, QUERY, 41483, 5, "agoda")
    expect("error" in parsed && parsed.error).toContain("currency mismatch")
  })

  it("classifies a sold-out property as no-results, not an error", () => {
    const payload = fixture("agoda-room-grid-ok.json")
    payload.isSoldOut = true
    const parsed = parseRoomGrid(payload, QUERY, 41483, 5, "agoda")
    expect("error" in parsed && parsed.reason).toBe("no-results")
  })

  it("survives a malformed/changed response shape without throwing", () => {
    for (const evil of [null, 42, "html", {}, { rooms: "not-an-array" }, { rooms: [{ offers: [{}] }] }]) {
      const parsed = parseRoomGrid(evil, QUERY, 41483, 5, "agoda")
      if ("error" in parsed) continue                 // classified failure is fine
      expect(parsed.rates).toEqual([])                // or an honest empty result
    }
  })
})

describe("agoda provider transport", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  it("performs one POST with date-parameterized body and the observed headers", async () => {
    const { impl, calls } = stubFetch(fixture("agoda-room-grid-ok.json"))
    const provider = new AgodaProvider({ fetchImpl: impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(true)
    expect(result.callsSpent).toBe(1)
    expect(calls).toHaveLength(1)

    const init = calls[0].init!
    const headers = init.headers as Record<string, string>
    expect(headers["ag-initiator-api-key"]).toBeTruthy()
    expect(headers["x-gate-meta"]).toBeTruthy()
    const body = JSON.parse(String(init.body)) as Record<string, any>
    expect(body.searchCriteria.checkIn).toBe("2026-11-10")
    expect(body.searchCriteria.checkOut).toBe("2026-11-15")
    expect(body.userContext.currencyId).toBe(7)      // USD's observed id
    expect(body.propertyId).toBe("41483")
  })

  it("refuses bad refs, bad dates and unmapped currencies BEFORE spending a request", async () => {
    const { impl, calls } = stubFetch(fixture("agoda-room-grid-ok.json"))
    const provider = new AgodaProvider({ fetchImpl: impl, db })
    expect((await provider.searchRates({ ...QUERY, providerRef: "g123-d456" })).callsSpent).toBe(0)
    expect((await provider.searchRates({ ...QUERY, checkIn: "soon" })).callsSpent).toBe(0)
    const thb = await provider.searchRates({ ...QUERY, currency: "THB" })
    expect(thb.reason).toBe("unconfigured")
    expect(thb.callsSpent).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("returns a failed result — never throws — on outage, garbage, or timeout", async () => {
    const dead = new AgodaProvider({ fetchImpl: stubFetch(null, { status: 503, text: "down" }).impl, db })
    expect((await dead.searchRates(QUERY)).reason).toBe("provider-error")

    const garbage = new AgodaProvider({ fetchImpl: stubFetch(null, { text: "<html>blocked</html>" }).impl, db })
    expect((await garbage.searchRates(QUERY)).error).toContain("not JSON")

    const hung = new AgodaProvider({
      fetchImpl: ((_u: unknown, init?: RequestInit) => new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      })) as unknown as typeof fetch,
      db,
    })
    expect((await hung.searchRates(QUERY, { timeoutMs: 25 })).reason).toBe("timeout")
  })
})

describe("agoda ref resolution", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  const SUGGEST = {
    ViewModelList: [
      { IsHotel: false, Name: "Lily Beach Resort", ObjectId: 11059833 },
      {
        IsHotel: true, Name: "Lily Beach Resort & Spa - All Inclusive",
        ObjectId: 41483, CityId: 17759, CountryId: 34, ObjectTypeId: 32,
        DisplayNames: { Name: "Lily Beach Resort & Spa - All Inclusive", GeoHierarchyName: "Maldive Islands, Maldives" },
      },
      { IsHotel: true, Name: "Blue Lily Beach Resort Puri", ObjectId: 84903227, CityId: 5063, CountryId: 35 },
    ],
  }

  it("resolves to the identity-checked hotel suggestion", async () => {
    const outcome = await resolveAgodaRef("Lily Beach Resort & Spa", { fetchImpl: stubFetch(SUGGEST).impl, db })
    if ("error" in outcome) throw new Error(outcome.error)
    expect(outcome.ref).toBe("41483:17759:34")
    expect(outcome.geo).toContain("Maldive")
  })

  it("does not match a similarly-named property in the wrong place", async () => {
    const withoutReal = { ViewModelList: SUGGEST.ViewModelList.filter(v => v.ObjectId !== 41483) }
    const outcome = await resolveAgodaRef("Lily Beach Resort & Spa", { fetchImpl: stubFetch(withoutReal).impl, db })
    // "Blue Lily Beach Resort Puri" contains extra identity words — no match.
    expect("error" in outcome).toBe(true)
  })

  it("reports malformed suggest responses instead of guessing", async () => {
    const outcome = await resolveAgodaRef("Anything", { fetchImpl: stubFetch({ nope: 1 }).impl, db })
    expect("error" in outcome && outcome.error).toContain("malformed")
  })
})
