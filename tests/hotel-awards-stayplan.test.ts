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
      appliedPerkNights: 0,
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

describe("evidence pass-through", () => {
  it("every segment carries its observation's provenance verbatim — and it never enters ranking or signatures", () => {
    const rows = [
      ob("2026-11-01", 5, { fetchedAt: "2026-08-28T19:05:37.809Z", taxesFeesState: "stated", taxesFeesAmount: 38.5, taxesFeesCurrency: "USD", cashComparisonAmount: 104, cashComparisonCurrency: "USD" }),
      ob("2026-11-06", 5, { fetchedAt: "2026-08-29T08:30:41.423Z" }),
    ]
    const r = buildStayPlan(rows, "2026-11-01", "2026-11-11")
    const best = r.plans[0]
    expect(best.segments[0].evidence).toMatchObject({
      fetchedAt: "2026-08-28T19:05:37.809Z", availabilityState: "unknown", searchState: "complete",
      verificationLevel: "discovered", taxesFeesState: "stated", taxesFeesAmount: 38.5, taxesFeesCurrency: "USD",
      roomName: "1 King Bed", roomClass: "GuestRoom", cashComparisonAmount: 104, cashComparisonCurrency: "USD",
    })
    expect(best.evidence).toEqual({
      oldestFetchedAt: "2026-08-28T19:05:37.809Z", newestFetchedAt: "2026-08-29T08:30:41.423Z",
      availabilityUnknownSegments: 2, verificationLevels: { discovered: 2 },
    })
    // Same plans, same order, same signatures when evidence is stripped away.
    const stripped = buildStayPlan(rows.map(o => ({ ...o, taxesFeesState: "unknown" as const, taxesFeesAmount: null, taxesFeesCurrency: null, cashComparisonAmount: null, cashComparisonCurrency: null })), "2026-11-01", "2026-11-11")
    expect(stripped.plans.map(p => p.signature)).toEqual(r.plans.map(p => p.signature))
    // Cash context is echoed, never turned into a number elsewhere: no
    // per-night × nights (22500/250000) and no cash-points blend anywhere.
    expect(JSON.stringify(best)).not.toContain("22500")
    expect(JSON.stringify(best)).not.toContain("250000")
  })
})

describe("read-only edge filters", () => {
  it("excludeProperties removes a hotel from every plan and the result turns honestly partial", () => {
    const rows = chain30()                                       // alternating hyattp / jwbkk
    const r = buildStayPlan(rows, NOV.start, NOV.end, { filters: { excludeProperties: ["roame_hotels|hyattp"] } })
    expect(r.plans.flatMap(p => p.segments).some(s => s.providerPropertyRef === "hyattp")).toBe(false)
    expect(r.plans[0].coveredNights).toBe(15)
    expect(r.plans[0].uncoveredDates[0]).toBe("2026-11-01")     // the Hyatt windows are gone, not filled
    expect(r.filters).toEqual({ programs: [], excludeProperties: ["roame_hotels|hyattp"] })
  })

  it("programs keeps only the named programs — other programs' segments disappear", () => {
    const r = buildStayPlan(chain30(), NOV.start, NOV.end, { filters: { programs: ["MARRIOTT_BONVOY"] } })
    expect(r.plans.flatMap(p => p.segments).every(s => s.program === "MARRIOTT_BONVOY")).toBe(true)
    expect(r.filters.programs).toEqual(["MARRIOTT_BONVOY"])
  })

  it("empty or omitted filters change nothing — filters only ever remove evidence", () => {
    const a = buildStayPlan(chain30(), NOV.start, NOV.end)
    const b = buildStayPlan(chain30(), NOV.start, NOV.end, { filters: {} })
    expect(b.plans.map(p => p.signature)).toEqual(a.plans.map(p => p.signature))
    expect(a.filters).toEqual({ programs: [], excludeProperties: [] })
  })

  it("filters are pure subtraction: subset of ids, edges never grow, unknown program is NOT a fallback to all, programs+exclude intersect", () => {
    const rows = chain30()
    const all = buildStayPlan(rows, NOV.start, NOV.end, { maxAlternatives: 20 })
    const allIds = new Set(all.plans.flatMap(p => p.segments.map(s => s.observationId)))
    for (const filters of [
      { programs: ["MARRIOTT_BONVOY"] },
      { excludeProperties: ["roame_hotels|hyattp"] },
      { programs: ["MARRIOTT_BONVOY"], excludeProperties: ["roame_hotels|jwbkk"] },
      { excludeProperties: ["roame_hotels|does-not-exist"] },
    ]) {
      const r = buildStayPlan(rows, NOV.start, NOV.end, { filters, maxAlternatives: 20 })
      expect(r.edges).toBeLessThanOrEqual(all.edges)
      for (const id of r.plans.flatMap(p => p.segments.map(s => s.observationId))) expect(allIds.has(id)).toBe(true)
    }
    const both = buildStayPlan(rows, NOV.start, NOV.end, { filters: { programs: ["MARRIOTT_BONVOY"], excludeProperties: ["roame_hotels|jwbkk"] } })
    expect(both.edges).toBe(0)                                     // intersection, never union
    expect(both.plans[0].coveredNights).toBe(0)
    const unknown = buildStayPlan(rows, NOV.start, NOV.end, { filters: { programs: ["ACCOR_ALL"] } })
    expect(unknown.edges).toBe(0)                                  // never "no match → all programs"
    expect(unknown.plans[0].uncoveredDates).toHaveLength(30)
    const noop = buildStayPlan(rows, NOV.start, NOV.end, { filters: { excludeProperties: ["roame_hotels|does-not-exist"] } })
    expect(noop.plans.map(p => p.signature)).toEqual(buildStayPlan(rows, NOV.start, NOV.end).plans.map(p => p.signature))
  })
})

describe("stated-points prefixes survive the search", () => {
  const mc = { provider: "gondola_hotels", program: "MARRIOTT_BONVOY", sourceProgramName: "MARRIOTT", chain: "MC", quoteBasis: "full_stay" as const }

  it("a stated-points-cheaper prefix is never pruned before the final points_cost ranking", () => {
    const rows = [
      ob("2026-11-01", 5, { ...mc, providerPropertyRef: "aaa", propertyName: "Dear", pointsTotal: 200000, pointsPerNight: 40000 }),
      ob("2026-11-01", 5, { ...mc, providerPropertyRef: "zzz", propertyName: "Cheap", pointsTotal: 100000, pointsPerNight: 20000 }),
      ob("2026-11-06", 5, { ...mc, providerPropertyRef: "yyy", propertyName: "Tail", pointsTotal: 100000, pointsPerNight: 20000 }),
    ]
    const r = buildStayPlan(rows, "2026-11-01", "2026-11-11", { goal: "points_cost", maxAlternatives: 20 })
    expect(r.plans[0].segments.map(s => s.providerPropertyRef)).toEqual(["zzz", "yyy"])
    expect(r.plans[0].programTotals).toEqual([{ program: "MARRIOTT_BONVOY", statedTotal: 200000, statedSegments: 2, perNightOnlySegments: 0 }])
  })

  it("a cheaper complete plan with ONE MORE switch beats a dearer single-hotel plan under points_cost — and still ranks second under fewest_switches, never lost", () => {
    const rows = [
      ob("2026-11-01", 5, { ...mc, providerPropertyRef: "A", propertyName: "Hotel A", pointsTotal: 100000, pointsPerNight: 20000 }),
      ob("2026-11-01", 2, { ...mc, providerPropertyRef: "B", propertyName: "Hotel B", pointsTotal: 20000, pointsPerNight: 10000 }),
      ob("2026-11-03", 3, { ...mc, providerPropertyRef: "A", propertyName: "Hotel A", pointsTotal: 20000, pointsPerNight: 6667 }),
    ]
    const pc = buildStayPlan(rows, "2026-11-01", "2026-11-06", { goal: "points_cost", maxAlternatives: 5 })
    expect(pc.plans[0].segments.map(s => s.providerPropertyRef)).toEqual(["B", "A"])
    expect(pc.plans[0].programTotals[0].statedTotal).toBe(40000)
    const fw = buildStayPlan(rows, "2026-11-01", "2026-11-06", { goal: "fewest_switches", maxAlternatives: 5 })
    expect(fw.plans[0].segments.map(s => s.providerPropertyRef)).toEqual(["A"])          // 0 switches wins
    expect(fw.plans.some(p => p.programTotals[0]?.statedTotal === 40000)).toBe(true)      // the cheaper plan is an alternative, not lost
  })

  it("per-night-only (poisoned) prefixes stay equal on points — the search keeps only coverage/switch trade-offs and the complete plan still wins", () => {
    const r = buildStayPlan(chain30(), NOV.start, NOV.end, { maxAlternatives: 50 })
    expect(r.plans[0].coveredNights).toBe(30)
    expect(r.plans[0].switches).toBe(5)
    // Finalists are bounded by the coverage/switch trade-offs per end-hotel
    // (never an explosion of equal-points per-night variants).
    expect(r.plans.length).toBeLessThanOrEqual(31)
    // Coverage still ranks first — every complete plan precedes every partial one.
    const firstPartial = r.plans.findIndex(p => p.coveredNights < 30)
    expect(r.plans.slice(0, firstPartial === -1 ? r.plans.length : firstPartial).every(p => p.coveredNights === 30)).toBe(true)
  })
})

describe("evidence is ranking- and signature-neutral", () => {
  it("availability, verification level, room and freshness never reorder tied candidates and never appear in signatures", () => {
    const rows = [
      ob("2026-11-01", 3, { providerPropertyRef: "bbb", availabilityState: "available", verificationLevel: "verified", roomName: "Suite", sourceFreshness: "2026-08-30T00:00:00Z" }),
      ob("2026-11-01", 3, { providerPropertyRef: "aaa", availabilityState: "unknown", verificationLevel: "discovered", roomName: null, sourceFreshness: null }),
    ]
    const r = buildStayPlan(rows, "2026-11-01", "2026-11-04")
    expect(r.plans[0].segments[0].providerPropertyRef).toBe("aaa")          // signature, not "available", decides
    expect(r.plans.map(p => p.signature).join("")).not.toMatch(/available|verified|Suite|discovered|2026-08-30/)
    const swapped = buildStayPlan([
      { ...rows[0], availabilityState: "unknown", verificationLevel: "discovered" },
      { ...rows[1], availabilityState: "available", verificationLevel: "verified" },
    ], "2026-11-01", "2026-11-04")
    expect(swapped.plans.map(p => p.signature)).toEqual(r.plans.map(p => p.signature))
  })
})
