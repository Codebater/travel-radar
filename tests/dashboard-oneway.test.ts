/**
 * Explicit ONE_WAY on the main Cash vs Award dashboard.
 *
 * The flow was already two one-way searches merged (awards price per leg;
 * the reversed return-leg search exists only for round trips). Under test:
 * the strict tripType contract, the legacy inference for omitted tripType,
 * that ONE_WAY plans exactly one search with a null return end to end, that
 * RT/OW identities can never collide in cache or history, and that one-way
 * replays keep their one-way semantics (the Phase 8k locator behavior).
 */

import fs from "fs"
import { describe, expect, it } from "vitest"
import { planSearchLegs, resolveTripSearch } from "../search.js"
import { awardCacheKey, cacheKey } from "../cache/key.js"
import { buildFlightLocator, type FlightPriceRow } from "../offers/locators.js"
import { makeQuery } from "./mocks.js"

describe("tripType validation matrix (/api/search contract)", () => {
  it("an invalid tripType is a clean error naming the valid values", () => {
    const r = resolveTripSearch("BANANA", "")
    expect(r.tripType).toBeNull()
    expect(r.error).toMatch(/unknown tripType "BANANA"/)
    expect(r.error).toMatch(/ROUND_TRIP, ONE_WAY/)
  })

  it("ONE_WAY with a return date is rejected — a return can never ride along", () => {
    const r = resolveTripSearch("ONE_WAY", "2026-10-20")
    expect(r.tripType).toBeNull()
    expect(r.error).toMatch(/does not take a return date/)
  })

  it("explicit ROUND_TRIP without a return date is rejected", () => {
    const r = resolveTripSearch("ROUND_TRIP", "")
    expect(r.tripType).toBeNull()
    expect(r.error).toMatch(/requires a return date/)
  })

  it("omitted tripType keeps the legacy contract: return present = round trip, absent = one way", () => {
    expect(resolveTripSearch(null, "2026-10-20")).toEqual({ tripType: "ROUND_TRIP", error: null })
    expect(resolveTripSearch(null, "")).toEqual({ tripType: "ONE_WAY", error: null })
    expect(resolveTripSearch("", "")).toEqual({ tripType: "ONE_WAY", error: null })
  })

  it("explicit valid combinations resolve, including the kebab spelling (Phase 8k parser reused)", () => {
    expect(resolveTripSearch("ONE_WAY", "")).toEqual({ tripType: "ONE_WAY", error: null })
    expect(resolveTripSearch("one-way", "")).toEqual({ tripType: "ONE_WAY", error: null })
    expect(resolveTripSearch("ROUND_TRIP", "2026-10-20")).toEqual({ tripType: "ROUND_TRIP", error: null })
  })
})

describe("leg planning — ONE_WAY is exactly one outbound search", () => {
  it("a one-way plan has a null return date and NO reversed return-leg search", () => {
    const plan = planSearchLegs("ONE_WAY", "VIE", "MEX", "2026-09-03", "")
    expect(plan.outbound).toEqual({ origin: "VIE", destination: "MEX", departureDate: "2026-09-03", returnDate: undefined })
    // No second search means a one-way payload can never contain a
    // return-direction flight — which is exactly what the dashboard's rtMode
    // keys on, so the return-selection step is structurally unreachable.
    expect(plan.returnLeg).toBeNull()
  })

  it("a round-trip plan is unchanged: outbound carries the return date, the reversed leg is searched", () => {
    const plan = planSearchLegs("ROUND_TRIP", "VIE", "MEX", "2026-09-03", "2026-09-17")
    expect(plan.outbound).toEqual({ origin: "VIE", destination: "MEX", departureDate: "2026-09-03", returnDate: "2026-09-17" })
    expect(plan.returnLeg).toEqual({ origin: "MEX", destination: "VIE", departureDate: "2026-09-17" })
  })
})

describe("cache/history identity — RT and OW can never collide", () => {
  it("cash cache keys use the explicit oneway token and differ from every round trip", () => {
    const ow = cacheKey(makeQuery({ returnDate: null }), "fast_flights")
    const rt = cacheKey(makeQuery({ returnDate: "2026-11-20" }), "fast_flights")
    expect(ow).toContain(":oneway:")
    expect(rt).toContain(":2026-11-20:")
    expect(ow).not.toBe(rt)
  })

  it("award cache keys carry the same oneway token — cash and award describe the SAME one-way market", () => {
    const base = { origin: "VIE", destination: "MEX", departureDate: "2026-09-03", searchClass: "ECON" as const, adults: 1 }
    const ow = awardCacheKey({ ...base, returnDate: null }, "roame")
    const rt = awardCacheKey({ ...base, returnDate: "2026-09-17" }, "roame")
    expect(ow).toContain(":oneway:")
    expect(ow).not.toBe(rt)
  })
})

describe("one-way navigation — replay keeps its trip shape (Phase 8k behavior reused)", () => {
  const row = (returnDate: string | null): FlightPriceRow => ({
    id: 1, provider: "fast_flights", airline: "Finnair", flight_numbers: null,
    origin: "VIE", destination: "MEX", departure_date: "2026-09-03", return_date: returnDate,
    cabin: "business", adults: 1, price_amount: 3646, price_currency: "EUR",
    booking_url: null, fetched_at: "2026-08-28T10:00:00Z",
  })

  it("a one-way observation replays as an explicit one-way search with no return date", () => {
    const locator = buildFlightLocator(row(null))
    const human = decodeURIComponent(locator.searchReplayUrl!).replace(/\+/g, " ")
    expect(locator.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    expect(human).toContain("one way")
    expect(human).not.toContain("returning")
  })

  it("a round-trip observation still replays with its return date — unchanged", () => {
    const locator = buildFlightLocator(row("2026-09-17"))
    const human = decodeURIComponent(locator.searchReplayUrl!).replace(/\+/g, " ")
    expect(human).toContain("returning 2026-09-17")
    expect(human).not.toContain("one way")
  })
})

describe("dashboard single-step guarantee", () => {
  it("the UI ships the one-way controls and derives the step flow from the payload", () => {
    // The dashboard enters its two-step flow only when the payload has a
    // return date AND return-direction flights (initRtFlow). planSearchLegs
    // guarantees a ONE_WAY payload has neither — asserted above — so this
    // pins the UI wiring: the selector exists, the return field is hideable,
    // and the header labels one-way results.
    const html = fs.readFileSync("dashboard.html", "utf-8")
    expect(html).toContain('id="inputTripType"')
    expect(html).toContain('value="ONE_WAY"')
    expect(html).toContain('id="returnField"')
    expect(html).toContain("tripTypeChanged")
    expect(html).toContain("' · ONE WAY'")
    expect(html).toMatch(/tripType === 'ONE_WAY' \? '' :/)   // one-way never sends a return
  })
})
