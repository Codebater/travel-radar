/**
 * Sparse long-stay window planner — turns one long requested range into a
 * DETERMINISTIC set of exact Roame sub-window queries.
 *
 * Why it exists (live-verified 2026-08-29): Roame's HotelAvailablePeriods is
 * an EXACT-WINDOW quote engine. It always returns the requested check-in and
 * the exact requested night count; minNights only filters and NEVER
 * enumerates shorter periods, and the same hotel's per-night average
 * genuinely differs between adjacent windows. Long-range coverage therefore
 * has to come from client-side sub-window queries — each an independent
 * exact-window observation, never extrapolated onto another window, never
 * totalled (per-night averages stay per-night).
 *
 * The plan is sparse by design: not every start date is searched. For each
 * candidate stay length that fits the range, three ANCHORS are planned —
 * the range start, the middle, and the latest start that still fits — giving
 * useful coverage near the beginning, middle and end of the period without
 * exploding provider calls.
 *
 * Budget: the window budget is explicit BEFORE execution. Over-budget plans
 * are reduced deterministically by anchor round — all start anchors first
 * (in configured length order), then all end anchors, then middles — so
 * beginning/end coverage survives reduction first, and the dropped windows
 * are reported, never silently discarded.
 */

export type WindowAnchor = "start" | "middle" | "end"

export interface PlannedWindow {
  checkIn: string                  // YYYY-MM-DD, always inside the range
  checkOut: string
  nights: number                   // exact requested length — Roame echoes it
  anchor: WindowAnchor
}

export interface WindowPlan {
  rangeStart: string
  rangeEnd: string
  totalNights: number
  candidateNights: number[]
  /** Maximum windows that may execute — stated before any provider call. */
  budget: number
  /** Retained windows in deterministic execution order (checkIn, nights). */
  windows: PlannedWindow[]
  /** Deterministically dropped to meet the budget — reported, not hidden. */
  dropped: PlannedWindow[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

export function planStayWindows(
  rangeStart: string,
  rangeEnd: string,
  opts: { candidateNights?: number[]; maxWindows?: number } = {},
): WindowPlan {
  const parseable = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
  if (!parseable(rangeStart) || !parseable(rangeEnd)) throw new Error(`range must be real YYYY-MM-DD dates (${rangeStart}..${rangeEnd})`)
  const totalNights = Math.round((Date.parse(rangeEnd) - Date.parse(rangeStart)) / 86_400_000)
  if (totalNights < 1) throw new Error(`range end must follow range start (${rangeStart}..${rangeEnd})`)

  // Perk-relevant defaults: 2 (Ambassador weekend minimum), 4 (IHG card 4th
  // night), 5 (Marriott/Hilton 5th night), 7 (a plain week).
  const candidateNights = opts.candidateNights ?? [2, 4, 5, 7]
  if (candidateNights.length === 0) throw new Error("candidateNights must not be empty")
  for (const n of candidateNights) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`candidate stay length must be an integer ≥ 1 (got ${String(n)})`)
  }
  if (new Set(candidateNights).size !== candidateNights.length) throw new Error("candidateNights must not contain duplicates")
  const budget = opts.maxWindows ?? 8
  if (!Number.isInteger(budget) || budget < 1) throw new Error(`maxWindows must be an integer ≥ 1 (got ${String(budget)})`)

  // Anchor rounds in retention priority: starts, then ends, then middles.
  // Within a round, configured length order. Fully deterministic.
  const seen = new Set<string>()
  const prioritized: PlannedWindow[] = []
  const push = (offsetNights: number, nights: number, anchor: WindowAnchor) => {
    const checkIn = addDays(rangeStart, offsetNights)
    const key = `${checkIn}|${nights}`
    if (seen.has(key)) return                      // anchors that coincide plan once
    seen.add(key)
    prioritized.push({ checkIn, checkOut: addDays(checkIn, nights), nights, anchor })
  }
  const fitting = candidateNights.filter(n => n <= totalNights)
  for (const n of fitting) push(0, n, "start")
  for (const n of fitting) push(totalNights - n, n, "end")
  for (const n of fitting) push(Math.floor((totalNights - n) / 2), n, "middle")

  // A range too short for every candidate still gets one honest exact-window
  // probe covering the whole range — never a clamped or invented length.
  if (prioritized.length === 0) push(0, totalNights, "start")

  const retained = prioritized.slice(0, budget)
  const dropped = prioritized.slice(budget)
  // Execution order is chronological and stable: checkIn, then nights.
  const byWindow = (a: PlannedWindow, b: PlannedWindow) =>
    a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : a.nights - b.nights
  retained.sort(byWindow)
  dropped.sort(byWindow)

  return { rangeStart, rangeEnd, totalNights, candidateNights, budget, windows: retained, dropped }
}

/** One-line human rendering of a planned window, for plan print-outs. */
export function describeWindow(w: PlannedWindow): string {
  return `${w.checkIn} → ${w.checkOut} (${w.nights}n, ${w.anchor})`
}
