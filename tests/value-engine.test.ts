/**
 * Credential-free smoke tests for the scoring path.
 *
 * These cover the parts of the pipeline that run without any provider
 * credentials — value engine, sweet spots and transfer paths — so the core
 * logic can be verified without spending SerpAPI or ATF budget.
 */

import { describe, it, expect } from "vitest"
import { scoreFlights } from "../value-engine.js"
import { matchSweetSpots, getSweetSpotsForRoute } from "../sweet-spots.js"
import { findFundingPaths, canAfford } from "../transfer-partners.js"
import type { UnifiedFlightResult } from "../roame-scraper.js"

const base: UnifiedFlightResult = {
  id: "test-0",
  source: "roame",
  type: "award",
  origin: "LAX",
  destination: "CDG",
  airline: "AF",
  operatingAirlines: ["AF"],
  flightNumbers: ["AF 65"],
  stops: 0,
  durationMinutes: 660,
  departureTime: "2026-06-01T15:00:00-07:00",
  arrivalTime: "2026-06-02T11:00:00+02:00",
  airports: ["LAX", "CDG"],
  cabinClass: "business",
  equipment: ["77W"],
  points: 50000,
  pointsProgram: "FLYING_BLUE",
  cashPrice: null,
  taxes: 200,
  currency: "USD",
  cppValue: null,
  roameScore: 80,
  availableSeats: 2,
  bookingUrl: "https://example.invalid",
  fareClass: "BUSINESS",
  travelDate: "2026-06-01",
}

const cashFare: UnifiedFlightResult = {
  ...base,
  id: "test-cash",
  source: "google",
  type: "cash",
  points: null,
  pointsProgram: null,
  cashPrice: 4200,
  taxes: 0,
  roameScore: null,
  availableSeats: null,
}

const balances = [
  { programKey: "chase-ur", program: "Chase UR", balance: 200000 },
  { programKey: "FLYING_BLUE", program: "Flying Blue", balance: 10000 },
]

describe("value engine", () => {
  it("computes real CPP against the cash fare in the same result set", () => {
    const { scored } = scoreFlights([base, cashFare], balances, "LAX", "CDG")
    const award = scored.find(f => f.id === "test-0")!

    expect(award.cashSource).toBe("exact-match")
    expect(award.cashComparable).toBe(4200)
    // (4200 - 200) / (50000 / 100) = 8.0 cents per point
    expect(award.realCpp).toBe(8)
    expect(award.cppRating).toBe("exceptional")
  })

  it("falls back to a cabin estimate when no cash fares are present", () => {
    const { scored } = scoreFlights([base], balances, "LAX", "CDG")
    const award = scored[0]!
    expect(award.cashSource).toBe("estimated")
    expect(award.realCpp).not.toBeNull()
  })

  it("flags the Flying Blue US-Europe business sweet spot", () => {
    const { scored, insights } = scoreFlights([base, cashFare], balances, "LAX", "CDG")
    const award = scored.find(f => f.id === "test-0")!

    expect(award.sweetSpotMatch?.spot.id).toBe("fb-us-europe-j")
    expect(insights.some(i => i.type === "sweet-spot-available")).toBe(true)
  })

  it("caps cash fares below awards and keeps every score in 0-100", () => {
    const { scored } = scoreFlights([base, cashFare], balances, "LAX", "CDG")
    for (const f of scored) {
      expect(f.valueScore).toBeGreaterThanOrEqual(0)
      expect(f.valueScore).toBeLessThanOrEqual(100)
    }
    expect(scored.find(f => f.id === "test-cash")!.valueScore).toBeLessThanOrEqual(50)
  })

  it("survives malformed provider rows without throwing", () => {
    const broken = { ...base, id: "broken", points: null, cabinClass: "", operatingAirlines: [] } as UnifiedFlightResult
    expect(() => scoreFlights([broken, cashFare], balances, "LAX", "CDG")).not.toThrow()
  })

  it("returns empty results for an empty search", () => {
    const { scored, insights } = scoreFlights([], balances, "XXX", "YYY")
    expect(scored).toEqual([])
    expect(Array.isArray(insights)).toBe(true)
  })
})

describe("sweet spots", () => {
  it("does not match when the award costs more than the threshold", () => {
    expect(matchSweetSpots("LAX", "CDG", "FLYING_BLUE", "business", 90000, 4200)).toHaveLength(0)
  })

  it("lists route sweet spots even with no matching fare", () => {
    const spots = getSweetSpotsForRoute("LAX", "CDG")
    expect(spots.length).toBeGreaterThan(0)
    expect(spots.every(s => s.maxPoints > 0)).toBe(true)
  })
})

describe("transfer partners", () => {
  it("funds a Flying Blue award from Chase UR when the direct balance is short", () => {
    const result = canAfford("FLYING_BLUE", 50000, balances)
    expect(result.affordable).toBe(true)
    expect(result.bestPath).toBe("transfer")
    expect(result.details).toContain("Chase UR")
  })

  it("reports insufficient points when nothing can cover the award", () => {
    const result = canAfford("FLYING_BLUE", 5000000, balances)
    expect(result.affordable).toBe(false)
    expect(result.bestPath).toBe("insufficient")
  })

  it("puts the direct balance first among funding paths", () => {
    const paths = findFundingPaths("FLYING_BLUE", 50000, balances)
    expect(paths[0]!.transferTime).toBe("already have")
  })

  it("returns no path for a program with no balance and no partner", () => {
    expect(findFundingPaths("NONEXISTENT_PROGRAM", 1000, balances)).toHaveLength(0)
  })
})
