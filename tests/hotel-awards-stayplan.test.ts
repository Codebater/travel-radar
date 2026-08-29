/**
 * Consecutive-night stay optimizer V1 — read-only planning over stored
 * observations.
 *
 * Pinned: exact 30-night coverage with no overlaps and no gaps; edges valid
 * only for their exact observed range; best-partial coverage with exact
 * uncovered dates; the ranking doctrine (coverage → switches → VALID
 * stated-points dominance → deterministic signature); mixed programs never
 * summed into one number; Roame per-night averages never synthesized into
 * stay totals; source-stated totals preserved and summed per-program only.
 */

import { describe, expect, it } from "vitest"
import { buildStayPlan, comparePlansByStatedPoints, type StayPlan } from "../providers/hotel-awards/stayplan.js"
import type { StoredHotelAward } from "../providers/hotel-awards/store.js"

let nextId = 1
function ob(checkIn: string, nights: number, over: Partial<StoredHotelAward> = {}): StoredHotelAward {
  const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)
  const id = nextId++
  return {
    id, dedupeKey: `k${id}`, locatorId: null, createdAt: "2026-08-29T00:00:00.000Z",
    provider: "roame_hotels", providerPropertyRef: "hyattp", propertyId: null,
    propertyName: "Hyatt Place Bangkok", chain: "PLACE",
    program: "WORLD_OF_HYATT", sourceProgramName: "HYATT",
    checkIn, checkOut, nights,
    quoteBasis: "per_night", roomClass: "GuestRoom", roomName: "1 King Bed",
    pointsTotal: null, pointsPerNight: 4500,
    taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
    awardType: "points", cashComparisonAmount: null, cashComparisonCurrency: null,
    availabilityState: "unknown", searchState: "complete", verificationLevel: "discovered",
    sourceFreshness: null, bookingUrl: null, fetchedAt: "2026-08-29T00:00:00.000Z",
    ...over,
  }
}

const NOV = { start: "2026-11-01", end: "2026-12-01" }   // 30 nights

/** Six back-to-back 5-night stays alternating between two hotels. */
function chain30(): StoredHotelAward[] {
  const rows: StoredHotelAward[] = []
  for (let i = 0; i < 6; i++) {
    const start = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 5 * 86_400_000).toISOString().slice(0, 10)
    rows.push(ob(start, 5, i % 2 === 0
      ? {}
      : { providerPropertyRef: "jwbkk", propertyName: "JW Marriott Bangkok", chain: "MC", program: "MARRIOTT_BONVOY", sourceProgramName: "MARRIOTT", pointsPerNight: 50000 }))
  }
  return rows
}

describe("complete coverage", () => {
  it("covers 30/30 nights with chained exact segments — no overlaps, no gaps", () => {
    const r = buildStayPlan(chain30(), NOV.start, NOV.end)
    const best = r.plans[0]
    expect(best.coveredNights).toBe(30)
    expect(best.requestedNights).toBe(30)
    expect(best.uncoveredDates).toEqual([])
    expect(best.segments).toHaveLength(6)
    // Segments chain exactly: each check-out is the next check-in.
    for (let i = 1; i < best.segments.length; i++) {
      expect(best.segments[i].checkIn).toBe(best.segments[i - 1].checkOut)
    }
    expect(best.segments[0].checkIn).toBe(NOV.start)
    expect(best.segments[5].checkOut).toBe(NOV.end)
    expect(best.switches).toBe(5)                            // alternating hotels
  })

  it("an edge is valid only for its exact observed range — an observation reaching past the range is never used", () => {
    const rows = [...chain30(), ob("2026-11-28", 5)]         // ends Dec 3, outside the range
    const r = buildStayPlan(rows, NOV.start, NOV.end)
    expect(r.plans[0].segments.every(s => s.checkOut <= NOV.end)).toBe(true)
    expect(r.plans.flatMap(p => p.segments).some(s => s.checkOut > NOV.end)).toBe(false)
  })

  it("complete coverage beats a partial plan even when the partial has fewer switches", () => {
    const rows = [
      ...chain30(),                                          // complete, 5 switches
      ob("2026-11-01", 25, { providerPropertyRef: "one", propertyName: "One Long Stay" }),  // 25n, 0 switches, 5 uncovered
    ]
    const best = buildStayPlan(rows, NOV.start, NOV.end).plans[0]
    expect(best.coveredNights).toBe(30)
  })

  it("fewer hotel switches wins among complete plans", () => {
    // Same hotel end-to-end vs alternating hotels — both complete.
    const sameHotel: StoredHotelAward[] = []
    for (let i = 0; i < 6; i++) {
      const start = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 5 * 86_400_000).toISOString().slice(0, 10)
      sameHotel.push(ob(start, 5))
    }
    const r = buildStayPlan([...chain30(), ...sameHotel], NOV.start, NOV.end)
    expect(r.plans[0].switches).toBe(0)
    expect(r.plans[0].segments.every(s => s.providerPropertyRef === "hyattp")).toBe(true)
  })
})

describe("partial coverage", () => {
  it("reports the best partial plan with the exact uncovered dates", () => {
    // Nov 1–6 and Nov 11–16 only: Nov 6–11 and Nov 16–Dec 1 have nothing.
    const rows = [ob("2026-11-01", 5), ob("2026-11-11", 5)]
    const best = buildStayPlan(rows, NOV.start, NOV.end).plans[0]
    expect(best.coveredNights).toBe(10)
    expect(best.uncoveredDates).toHaveLength(20)
    expect(best.uncoveredDates[0]).toBe("2026-11-06")
    expect(best.uncoveredDates[4]).toBe("2026-11-10")
    expect(best.uncoveredDates[5]).toBe("2026-11-16")
    expect(best.uncoveredDates[19]).toBe("2026-11-30")
  })

  it("an empty observation set yields one all-uncovered plan, never a throw", () => {
    const best = buildStayPlan([], "2026-11-01", "2026-11-04").plans[0]
    expect(best.coveredNights).toBe(0)
    expect(best.uncoveredDates).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"])
  })
})

describe("determinism", () => {
  it("identical inputs give byte-identical plans, and equal candidates resolve by the stable signature", () => {
    // Two different hotels offer the SAME single window — pure tie.
    const rows = [
      ob("2026-11-01", 3, { providerPropertyRef: "bbb", propertyName: "Hotel B" }),
      ob("2026-11-01", 3, { providerPropertyRef: "aaa", propertyName: "Hotel A" }),
    ]
    const a = buildStayPlan(rows, "2026-11-01", "2026-11-04")
    const b = buildStayPlan(rows, "2026-11-01", "2026-11-04")
    expect(a).toEqual(b)
    expect(a.plans[0].segments[0].providerPropertyRef).toBe("aaa")   // lexicographically smallest signature
  })
})

describe("points doctrine", () => {
  it("mixed programs are NEVER summed — totals stay per program and no cross-program number exists", () => {
    const rows = [
      ob("2026-11-01", 5, { provider: "gondola_hotels", quoteBasis: "full_stay", pointsTotal: 37500, pointsPerNight: 7500 }),
      ob("2026-11-06", 5, { provider: "gondola_hotels", providerPropertyRef: "jw", propertyName: "JW Marriott", program: "MARRIOTT_BONVOY", quoteBasis: "full_stay", pointsTotal: 250000, pointsPerNight: 50000 }),
    ]
    const best = buildStayPlan(rows, "2026-11-01", "2026-11-11").plans[0]
    expect(best.programTotals).toHaveLength(2)
    const map = Object.fromEntries(best.programTotals.map(t => [t.program, t.statedTotal]))
    expect(map.WORLD_OF_HYATT).toBe(37500)
    expect(map.MARRIOTT_BONVOY).toBe(250000)
    // No field anywhere carries 287500 (the forbidden cross-program sum).
    expect(JSON.stringify(best)).not.toContain("287500")
  })

  it("Roame per-night averages are never synthesized into stay totals — the program total goes null and is flagged", () => {
    const rows = [ob("2026-11-01", 5, { pointsPerNight: 4500 })]   // per_night, no stated total
    const best = buildStayPlan(rows, "2026-11-01", "2026-11-06").plans[0]
    expect(best.segments[0].pointsTotal).toBeNull()
    expect(best.segments[0].pointsPerNight).toBe(4500)
    const t = best.programTotals[0]
    expect(t.statedTotal).toBeNull()                          // 4500×5 never appears
    expect(t.perNightOnlySegments).toBe(1)
    expect(JSON.stringify(best)).not.toContain("22500")
  })

  it("source-stated full-stay totals are preserved and summed within one program only", () => {
    const rows = [
      ob("2026-11-01", 5, { provider: "gondola_hotels", quoteBasis: "full_stay", pointsTotal: 37500 }),
      ob("2026-11-06", 5, { provider: "gondola_hotels", quoteBasis: "full_stay", pointsTotal: 40000 }),
    ]
    const best = buildStayPlan(rows, "2026-11-01", "2026-11-11").plans[0]
    expect(best.programTotals).toEqual([{
      program: "WORLD_OF_HYATT", statedTotal: 77500, statedSegments: 2, perNightOnlySegments: 0,
    }])
  })

  it("one per-night-only segment poisons its program's total — a partial sum never poses as the stay cost", () => {
    const rows = [
      ob("2026-11-01", 5, { provider: "gondola_hotels", quoteBasis: "full_stay", pointsTotal: 37500 }),
      ob("2026-11-06", 5, {}),                                 // per-night only, same program
    ]
    const t = buildStayPlan(rows, "2026-11-01", "2026-11-11").plans[0].programTotals[0]
    expect(t.statedTotal).toBeNull()
    expect(t.statedSegments).toBe(1)
    expect(t.perNightOnlySegments).toBe(1)
  })

  it("stated-points dominance ranks plans only when the comparison is valid", () => {
    const mk = (total: number | null, program = "WORLD_OF_HYATT"): StayPlan => ({
      coveredNights: 5, requestedNights: 5, segments: [], switches: 0, uncoveredDates: [],
      programTotals: [{ program, statedTotal: total, statedSegments: total === null ? 0 : 1, perNightOnlySegments: total === null ? 1 : 0 }],
      signature: String(total),
    })
    expect(comparePlansByStatedPoints(mk(30000), mk(40000))).toBe(-1)   // valid: lower stated wins
    expect(comparePlansByStatedPoints(mk(30000), mk(null))).toBe(0)     // per-night-only → incomparable
    expect(comparePlansByStatedPoints(mk(30000), mk(30000, "MARRIOTT_BONVOY"))).toBe(0)  // different programs → incomparable
  })
})

describe("edge hygiene", () => {
  it("append-only history collapses to the newest observation per exact stay", () => {
    const rows = [
      ob("2026-11-01", 5, { pointsPerNight: 9000, fetchedAt: "2026-08-01T00:00:00.000Z" }),
      ob("2026-11-01", 5, { pointsPerNight: 4500, fetchedAt: "2026-08-29T00:00:00.000Z" }),   // newer
    ]
    const best = buildStayPlan(rows, "2026-11-01", "2026-11-06").plans[0]
    expect(best.segments[0].pointsPerNight).toBe(4500)
  })

  it("refuses malformed or absurd ranges loudly", () => {
    expect(() => buildStayPlan([], "2026-13-99", NOV.end)).toThrow(/YYYY-MM-DD/)
    expect(() => buildStayPlan([], NOV.end, NOV.start)).toThrow(/must follow/)
    expect(() => buildStayPlan([], "2026-01-01", "2028-01-01")).toThrow(/at most 370/)
  })
})
