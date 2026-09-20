/**
 * Explicit-window re-check — building a WindowPlan from exact (checkIn,
 * nights) pairs and running it through the EXISTING executor.
 *
 * Pinned: the builder is pure date math (server-computed checkOut, client
 * checkOut ignored, dedupe, chronological order, deterministic budget
 * reduction with dropped windows reported, loud refusal naming the bad
 * entry); executeWindowPlan consumes the explicit plan unchanged — one exact
 * query per window, minNights = nights, checkOut = computed; re-running the
 * same windows APPENDS history rows sharing the dedupe key with a newer
 * fetchedAt, and buildStayPlan's newest-wins edge reduction then rests on the
 * fresh observation. No live providers anywhere — the provider is a canned
 * fake; per-night quotes are never multiplied into stay totals.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { executeWindowPlan } from "../providers/hotel-awards/discover.js"
import { buildExplicitWindowPlan } from "../providers/hotel-awards/explicit-windows.js"
import { buildStayPlan } from "../providers/hotel-awards/stayplan.js"
import { listHotelAwards } from "../providers/hotel-awards/store.js"
import type {
  HotelAwardProvider, HotelAwardQuery, HotelAwardSearchResult, NormalizedHotelAward,
} from "../providers/hotel-awards/types.js"

const FIRST_FETCH = "2026-08-29T00:00:00.000Z"
const RECHECK_FETCH = "2026-09-06T00:00:00.000Z"

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
    sourceFreshness: null, bookingUrl: null, fetchedAt: FIRST_FETCH,
    ...over,
  }
}

/** Canned provider: answers each window from a script, records what it was
 *  asked. Never touches the network. */
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

/** The two back-to-back 5-night segments of a Nov 1–11 stay plan. */
const TWO_SEGMENTS = [{ checkIn: "2026-11-01", nights: 5 }, { checkIn: "2026-11-06", nights: 5 }]
const OPTS = { location: "Bangkok", adults: 2, politenessMs: 0 }

describe("buildExplicitWindowPlan", () => {
  it("turns exact pairs into planned windows with a SERVER-computed checkOut and honest plan fields", () => {
    const plan = buildExplicitWindowPlan(TWO_SEGMENTS, { maxWindows: 8 })
    expect(plan.windows).toEqual([
      { checkIn: "2026-11-01", checkOut: "2026-11-06", nights: 5, anchor: "start" },
      { checkIn: "2026-11-06", checkOut: "2026-11-11", nights: 5, anchor: "start" },
    ])
    expect(plan.dropped).toEqual([])
    expect(plan.rangeStart).toBe("2026-11-01")
    expect(plan.rangeEnd).toBe("2026-11-11")
    expect(plan.totalNights).toBe(10)
    expect(plan.candidateNights).toEqual([5])
    expect(plan.budget).toBe(8)
    // Date math is UTC day arithmetic — month and year boundaries roll correctly.
    const edges = buildExplicitWindowPlan([{ checkIn: "2026-02-27", nights: 3 }, { checkIn: "2026-12-30", nights: 4 }], { maxWindows: 8 })
    expect(edges.windows.map(w => w.checkOut)).toEqual(["2026-03-02", "2027-01-03"])
    expect(edges.rangeEnd).toBe("2027-01-03")
    expect(edges.candidateNights).toEqual([3, 4])
  })

  it("ignores a client-supplied checkOut — the check-out is always checkIn + nights", () => {
    // A body may carry a checkOut that disagrees with its nights; it is never read.
    const lying: { checkIn: string; nights: number; checkOut?: string }[] = [
      { checkIn: "2026-11-01", nights: 5, checkOut: "2099-01-01" },
      { checkIn: "2026-11-06", nights: 5, checkOut: "2026-11-07" },
    ]
    const plan = buildExplicitWindowPlan(lying, { maxWindows: 8 })
    expect(plan.windows.map(w => w.checkOut)).toEqual(["2026-11-06", "2026-11-11"])
    expect(plan.rangeEnd).toBe("2026-11-11")
    for (const w of plan.windows) {
      expect(Math.round((Date.parse(w.checkOut) - Date.parse(w.checkIn)) / 86_400_000)).toBe(w.nights)
    }
  })

  it("collapses duplicate (checkIn, nights) pairs and keeps same-date windows of different lengths distinct", () => {
    const plan = buildExplicitWindowPlan([
      { checkIn: "2026-11-01", nights: 5 }, { checkIn: "2026-11-01", nights: 5 }, { checkIn: "2026-11-01", nights: 5 },
      { checkIn: "2026-11-01", nights: 2 },
    ], { maxWindows: 8 })
    expect(plan.windows.map(w => `${w.checkIn}|${w.nights}`)).toEqual(["2026-11-01|2", "2026-11-01|5"])
    expect(plan.dropped).toEqual([])
    expect(plan.candidateNights).toEqual([2, 5])
  })

  it("keeps the first maxWindows in chronological order and REPORTS the rest as dropped", () => {
    // Ten distinct 3-night windows, handed over shuffled.
    const starts = ["2026-11-19", "2026-11-01", "2026-11-13", "2026-11-25", "2026-11-07", "2026-11-04", "2026-11-22", "2026-11-10", "2026-11-28", "2026-11-16"]
    const plan = buildExplicitWindowPlan(starts.map(checkIn => ({ checkIn, nights: 3 })), { maxWindows: 8 })
    expect(plan.windows).toHaveLength(8)
    expect(plan.dropped).toHaveLength(2)
    const sorted = [...starts].sort()
    expect(plan.windows.map(w => w.checkIn)).toEqual(sorted.slice(0, 8))
    expect(plan.dropped.map(w => w.checkIn)).toEqual(["2026-11-25", "2026-11-28"])
    expect(plan.budget).toBe(8)
    // The range still describes everything submitted — dropped windows are not hidden from it.
    expect(plan.rangeStart).toBe("2026-11-01")
    expect(plan.rangeEnd).toBe("2026-12-01")
    expect(plan.totalNights).toBe(30)
    // Same input, same plan — and (checkIn, nights) order is the execution order.
    expect(buildExplicitWindowPlan(starts.map(checkIn => ({ checkIn, nights: 3 })), { maxWindows: 8 })).toEqual(plan)
  })

  it("refuses a bad entry loudly, naming it — never repaired or guessed", () => {
    const ok = { checkIn: "2026-11-01", nights: 5 }
    expect(() => buildExplicitWindowPlan([ok, { checkIn: "2026-13-01", nights: 5 }], { maxWindows: 8 }))
      .toThrow(/window #2 \(checkIn=2026-13-01, nights=5\): checkIn must be a real YYYY-MM-DD date/)
    expect(() => buildExplicitWindowPlan([{ checkIn: "2026-1-5", nights: 5 }], { maxWindows: 8 })).toThrow(/window #1.*2026-1-5.*YYYY-MM-DD/)
    expect(() => buildExplicitWindowPlan([ok, { checkIn: "2026-11-06", nights: 0 }], { maxWindows: 8 }))
      .toThrow(/window #2 \(checkIn=2026-11-06, nights=0\): nights must be an integer between 1 and 370/)
    expect(() => buildExplicitWindowPlan([{ checkIn: "2026-11-01", nights: 2.5 }], { maxWindows: 8 })).toThrow(/window #1.*nights=2\.5.*integer/)
    expect(() => buildExplicitWindowPlan([{ checkIn: "2026-11-01", nights: 371 }], { maxWindows: 8 })).toThrow(/window #1.*nights=371/)
    // Defensive against untyped bodies: a non-object entry is named by index.
    expect(() => buildExplicitWindowPlan([ok, null as unknown as { checkIn: string; nights: number }], { maxWindows: 8 })).toThrow(/window #2 \(null\)/)
  })

  it("refuses an empty list and a non-positive or fractional budget", () => {
    expect(() => buildExplicitWindowPlan([], { maxWindows: 8 })).toThrow(/must not be empty/)
    expect(() => buildExplicitWindowPlan(TWO_SEGMENTS, { maxWindows: 0 })).toThrow(/maxWindows must be an integer ≥ 1 \(got 0\)/)
    expect(() => buildExplicitWindowPlan(TWO_SEGMENTS, { maxWindows: 1.5 })).toThrow(/maxWindows/)
  })
})

describe("re-check execution through the existing executor", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  it("runs exactly one exact-window query per explicit window — minNights is the window's nights, checkOut the computed one", async () => {
    const p = fakeProvider(q => okResult(q, [award(q.checkIn, q.minNights!)]))
    const plan = buildExplicitWindowPlan(TWO_SEGMENTS, { maxWindows: 8 })
    const s = await executeWindowPlan(db, p, plan, OPTS)
    expect(p.queries).toHaveLength(2)
    expect(p.queries.map(q => [q.location, q.adults, q.checkIn, q.checkOut, q.minNights])).toEqual([
      ["Bangkok", 2, "2026-11-01", "2026-11-06", 5],
      ["Bangkok", 2, "2026-11-06", "2026-11-11", 5],
    ])
    for (const [i, q] of p.queries.entries()) expect(q.minNights).toBe(plan.windows[i].nights)
    expect(s.windowsPlanned).toBe(2)
    expect(s.windowsCompleted).toBe(2)
    expect(s.providerCalls).toBe(2)
    expect(s.observationsStored).toBe(2)
    expect(s.stoppedOnBlock).toBe(false)
  })

  it("re-running the same windows APPENDS history sharing the dedupe key, and the stay plan rests on the newer observation", async () => {
    const plan = buildExplicitWindowPlan(TWO_SEGMENTS, { maxWindows: 8 })
    // First observation round, then the re-check a week later with a changed nightly price.
    await executeWindowPlan(db, fakeProvider(q => okResult(q, [award(q.checkIn, q.minNights!)])), plan, OPTS)
    await executeWindowPlan(db, fakeProvider(q => okResult(q, [award(q.checkIn, q.minNights!, { fetchedAt: RECHECK_FETCH, pointsPerNight: 4800 })])), plan, OPTS)

    const rows = listHotelAwards(db, { limit: 50 })
    expect(rows).toHaveLength(4)                              // 2 windows × 2 rounds — nothing rewritten
    const byKey = new Map<string, typeof rows>()
    for (const r of rows) byKey.set(r.dedupeKey, [...(byKey.get(r.dedupeKey) ?? []), r])
    expect(byKey.size).toBe(2)                                // one price-free identity per window
    for (const group of byKey.values()) {
      expect(group).toHaveLength(2)
      expect(new Set(group.map(r => r.fetchedAt))).toEqual(new Set([FIRST_FETCH, RECHECK_FETCH]))
    }

    const result = buildStayPlan(rows, "2026-11-01", "2026-11-11")
    expect(result.filters).toEqual({ programs: [], excludeProperties: [] })
    expect(result.observationsConsidered).toBe(4)
    expect(result.edges).toBe(2)                              // newest-wins reduced 4 rows to 2 edges
    const best = result.plans[0]
    expect(best.coveredNights).toBe(10)
    expect(best.uncoveredDates).toEqual([])
    expect(best.segments).toHaveLength(2)
    for (const seg of best.segments) {
      expect(seg.pointsPerNight).toBe(4800)
      expect(seg.evidence.fetchedAt).toBe(RECHECK_FETCH)
    }
    expect(best.evidence?.newestFetchedAt).toBe(RECHECK_FETCH)
    expect(best.evidence?.oldestFetchedAt).toBe(RECHECK_FETCH)   // the stale round is not in the plan at all
  })

  it("never synthesizes a stay total from re-checked per-night quotes", async () => {
    const plan = buildExplicitWindowPlan(TWO_SEGMENTS, { maxWindows: 8 })
    await executeWindowPlan(db, fakeProvider(q => okResult(q, [award(q.checkIn, q.minNights!)])), plan, OPTS)
    const rows = listHotelAwards(db, { limit: 50 })
    for (const row of rows) {
      expect(row.quoteBasis).toBe("per_night")
      expect(row.pointsTotal).toBeNull()
    }
    const best = buildStayPlan(rows, "2026-11-01", "2026-11-11").plans[0]
    expect(best.segments.every(s => s.pointsTotal === null)).toBe(true)
    expect(best.programTotals).toEqual([{ program: "WORLD_OF_HYATT", statedTotal: null, statedSegments: 0, perNightOnlySegments: 2 }])
  })
})
