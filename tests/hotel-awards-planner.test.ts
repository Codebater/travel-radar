/**
 * Sparse long-stay window planner — deterministic exact sub-window plans.
 *
 * Live-verified premise (2026-08-29): Roame is an exact-window quote engine,
 * so long-range coverage must come from planned sub-window queries. Pinned
 * here: perk-relevant default lengths (2/4/5/7), start/middle/end anchoring,
 * strict in-bounds windows, dedupe, deterministic ordering AND deterministic
 * budget reduction with dropped windows reported, short-range fallback, and
 * that the legacy single-window shape is expressible. No live providers are
 * touched — the planner is pure date math.
 */

import { describe, expect, it } from "vitest"
import { describeWindow, planStayWindows, type WindowPlan } from "../providers/hotel-awards/planner.js"

const NOV = { start: "2026-11-01", end: "2026-12-01" }   // the 30-day Bangkok example

function keys(plan: WindowPlan): string[] {
  return plan.windows.map(w => `${w.checkIn}|${w.nights}`)
}

describe("the 30-day range plan", () => {
  it("plans start/middle/end anchors for each perk-relevant length (2/4/5/7)", () => {
    const plan = planStayWindows(NOV.start, NOV.end, { maxWindows: 50 })
    expect(plan.totalNights).toBe(30)
    expect(plan.candidateNights).toEqual([2, 4, 5, 7])
    expect(plan.windows).toHaveLength(12)                  // 4 lengths × 3 anchors, all distinct
    expect(plan.dropped).toEqual([])
    // Every length is anchored at the range start, the middle, and the last fitting start.
    for (const [n, endStart, midStart] of [
      [2, "2026-11-29", "2026-11-15"],
      [4, "2026-11-27", "2026-11-14"],
      [5, "2026-11-26", "2026-11-13"],
      [7, "2026-11-24", "2026-11-12"],
    ] as const) {
      expect(keys(plan)).toContain(`2026-11-01|${n}`)
      expect(keys(plan)).toContain(`${endStart}|${n}`)
      expect(keys(plan)).toContain(`${midStart}|${n}`)
    }
  })

  it("every planned window lies fully inside the requested range and states its exact dates", () => {
    const plan = planStayWindows(NOV.start, NOV.end, { maxWindows: 50 })
    for (const w of [...plan.windows, ...plan.dropped]) {
      expect(w.checkIn >= NOV.start).toBe(true)
      expect(w.checkOut <= NOV.end).toBe(true)
      expect(Math.round((Date.parse(w.checkOut) - Date.parse(w.checkIn)) / 86_400_000)).toBe(w.nights)
    }
  })

  it("is fully deterministic — identical inputs give identical plans, in chronological execution order", () => {
    const a = planStayWindows(NOV.start, NOV.end, {})
    const b = planStayWindows(NOV.start, NOV.end, {})
    expect(a).toEqual(b)
    const order = a.windows.map(w => `${w.checkIn}|${String(w.nights).padStart(2, "0")}`)
    expect([...order].sort()).toEqual(order)               // sorted by (checkIn, nights)
  })

  it("plans no duplicate windows", () => {
    const plan = planStayWindows(NOV.start, NOV.end, { maxWindows: 50 })
    const all = [...plan.windows, ...plan.dropped].map(w => `${w.checkIn}|${w.nights}`)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("the explicit window budget", () => {
  it("the default budget of 8 keeps all start and end anchors and drops the middles — reported, not hidden", () => {
    const plan = planStayWindows(NOV.start, NOV.end, {})
    expect(plan.budget).toBe(8)
    expect(plan.windows).toHaveLength(8)
    expect(plan.windows.every(w => w.anchor === "start" || w.anchor === "end")).toBe(true)
    expect(plan.dropped).toHaveLength(4)
    expect(plan.dropped.every(w => w.anchor === "middle")).toBe(true)
  })

  it("reduction is deterministic by anchor round then configured length order (starts, then ends, then middles)", () => {
    const plan = planStayWindows(NOV.start, NOV.end, { maxWindows: 5 })
    expect(plan.windows).toHaveLength(5)
    // All four starts survive, plus the first end anchor in length order (2 nights).
    expect(keys(plan).sort()).toEqual(["2026-11-01|2", "2026-11-01|4", "2026-11-01|5", "2026-11-01|7", "2026-11-29|2"].sort())
    expect(plan.dropped).toHaveLength(7)
    expect(planStayWindows(NOV.start, NOV.end, { maxWindows: 5 })).toEqual(plan)   // same again
  })

  it("a budget of 1 still yields exactly one honest window", () => {
    const plan = planStayWindows(NOV.start, NOV.end, { maxWindows: 1 })
    expect(plan.windows).toEqual([{ checkIn: "2026-11-01", checkOut: "2026-11-03", nights: 2, anchor: "start" }])
  })
})

describe("short overall ranges", () => {
  it("a 5-night range dedupes coinciding anchors instead of inventing windows", () => {
    const plan = planStayWindows("2026-11-01", "2026-11-06", { maxWindows: 50 })
    // 7 nights does not fit and is skipped, never clamped; coinciding anchors plan once.
    expect(keys(plan).sort()).toEqual([
      "2026-11-01|2", "2026-11-01|4", "2026-11-01|5",
      "2026-11-02|2", "2026-11-02|4", "2026-11-04|2",
    ].sort())
    expect(plan.windows.some(w => w.nights === 7)).toBe(false)
  })

  it("a range too short for every candidate length falls back to one exact full-range window", () => {
    const plan = planStayWindows("2026-11-01", "2026-11-02", { maxWindows: 50 })
    expect(plan.windows).toEqual([{ checkIn: "2026-11-01", checkOut: "2026-11-02", nights: 1, anchor: "start" }])
  })

  it("the legacy single-window shape is exactly expressible — one length equal to the range plans one window", () => {
    const plan = planStayWindows("2026-11-21", "2026-11-26", { candidateNights: [5] })
    expect(plan.windows).toEqual([{ checkIn: "2026-11-21", checkOut: "2026-11-26", nights: 5, anchor: "start" }])
    expect(plan.dropped).toEqual([])
  })
})

describe("input validation — refused loudly, never guessed", () => {
  it("rejects bad dates, inverted ranges, empty/duplicate/invalid lengths and bad budgets", () => {
    expect(() => planStayWindows("2026-13-99", NOV.end, {})).toThrow(/YYYY-MM-DD/)
    expect(() => planStayWindows(NOV.end, NOV.start, {})).toThrow(/must follow/)
    expect(() => planStayWindows(NOV.start, NOV.end, { candidateNights: [] })).toThrow(/not be empty/)
    expect(() => planStayWindows(NOV.start, NOV.end, { candidateNights: [2, 2] })).toThrow(/duplicates/)
    expect(() => planStayWindows(NOV.start, NOV.end, { candidateNights: [0] })).toThrow(/integer ≥ 1/)
    expect(() => planStayWindows(NOV.start, NOV.end, { maxWindows: 0 })).toThrow(/maxWindows/)
  })

  it("describeWindow renders the exact dates, nights and anchor", () => {
    const [w] = planStayWindows(NOV.start, NOV.end, { maxWindows: 1 }).windows
    expect(describeWindow(w)).toBe("2026-11-01 → 2026-11-03 (2n, start)")
  })
})
