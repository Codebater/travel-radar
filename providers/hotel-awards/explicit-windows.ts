/**
 * Explicit window builder — turns arbitrary exact (checkIn, nights) pairs
 * into the same WindowPlan shape the sparse planner (planner.ts) produces, so
 * the EXISTING executor (discover.ts executeWindowPlan) re-checks them
 * unchanged. Typical inputs: a winning stay plan's own segments (re-verify
 * what the plan rests on) or its uncovered gap runs (probe exactly the
 * nights nothing covers).
 *
 * Why a separate builder: the sparse planner derives windows from a range
 * and anchor vocabulary. A re-check has no range to derive from — the caller
 * already knows the exact stays it wants observed — so the plan is built
 * from those pairs verbatim, with nothing added.
 *
 * Honesty constraints the code alone cannot show:
 *   - PURE: no DB, no provider, no network. Building a plan spends nothing;
 *     only the explicit execution step (discover.ts) touches a provider.
 *   - checkOut is ALWAYS computed here as checkIn + nights (the planner's UTC
 *     ms arithmetic). A client-supplied checkOut is never read, so a body
 *     that lies about its check-out cannot make the executor search a window
 *     whose dates and night count disagree.
 *   - each window is one independent exact-window observation, exactly like
 *     a planned one — windows never blend, and nothing here computes across
 *     them; per-night quotes stay per-night downstream.
 *   - the budget is stated BEFORE execution; over-budget windows are DROPPED
 *     deterministically (chronological order, latest first to go) and
 *     reported in `dropped` — never silently discarded.
 *   - invalid input is refused with a message naming the offending entry,
 *     never repaired, clamped or guessed.
 */

import { type PlannedWindow, type WindowAnchor, type WindowPlan } from "./planner.js"

/** One exact stay the caller wants observed. Any other property (a
 *  checkOut, for instance) is ignored — see the header. */
export interface ExplicitWindowInput {
  checkIn: string                  // YYYY-MM-DD
  nights: number                   // exact stay length, 1..370
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const dayMs = 86_400_000
/** Longest stay the stay optimizer plans (stayplan.ts) — the same ceiling
 *  keeps a single explicit window from exceeding any plannable range. */
const MAX_NIGHTS = 370

/** Identical to planner.ts: UTC midnight ms arithmetic, never local time. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10)
}

/** Anchor vocabulary is the planner's (start/middle/end) and describes WHERE
 *  in a range a window was derived from. Explicit windows are not derived
 *  from anything, so the anchor carries no meaning here; "start" is used
 *  uniformly because the type requires a value and the executor never reads
 *  it. Consumers must not infer range position from it. */
const EXPLICIT_ANCHOR: WindowAnchor = "start"

function describeEntry(index: number, w: unknown): string {
  if (typeof w !== "object" || w === null) return `window #${index + 1} (${String(w)})`
  const { checkIn, nights } = w as { checkIn?: unknown; nights?: unknown }
  return `window #${index + 1} (checkIn=${String(checkIn)}, nights=${String(nights)})`
}

export function buildExplicitWindowPlan(
  windows: { checkIn: string; nights: number }[],
  opts: { maxWindows: number },
): WindowPlan {
  if (!Array.isArray(windows) || windows.length === 0) throw new Error("explicit windows must not be empty")
  const budget = opts.maxWindows
  if (!Number.isInteger(budget) || budget < 1) throw new Error(`maxWindows must be an integer ≥ 1 (got ${String(budget)})`)

  // Validate every entry loudly, then dedupe on the exact (checkIn, nights)
  // identity — the same key the planner uses. Dedupe keeps the FIRST
  // occurrence; since duplicates are identical windows, order is irrelevant.
  const seen = new Set<string>()
  const planned: PlannedWindow[] = []
  windows.forEach((w, i) => {
    const label = describeEntry(i, w)
    if (typeof w !== "object" || w === null) throw new Error(`${label}: each window must be an object with checkIn and nights`)
    const { checkIn, nights } = w
    if (typeof checkIn !== "string" || !DATE.test(checkIn) || !Number.isFinite(Date.parse(`${checkIn}T00:00:00Z`))) {
      throw new Error(`${label}: checkIn must be a real YYYY-MM-DD date`)
    }
    if (!Number.isInteger(nights) || nights < 1 || nights > MAX_NIGHTS) {
      throw new Error(`${label}: nights must be an integer between 1 and ${MAX_NIGHTS}`)
    }
    const key = `${checkIn}|${nights}`
    if (seen.has(key)) return
    seen.add(key)
    // checkOut is computed here, never copied from the input (see header).
    planned.push({ checkIn, checkOut: addDays(checkIn, nights), nights, anchor: EXPLICIT_ANCHOR })
  })

  // Deterministic order: chronological by checkIn, then by nights — the same
  // execution order the planner emits. Budget reduction keeps the earliest.
  planned.sort((a, b) => a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : a.nights - b.nights)
  const retained = planned.slice(0, budget)
  const dropped = planned.slice(budget)

  // Range fields describe the ENVELOPE of everything submitted (retained and
  // dropped alike) — the dropped windows are part of the request even though
  // they will not execute, and hiding them from the range would misstate it.
  let rangeStart = planned[0].checkIn
  let rangeEnd = planned[0].checkOut
  for (const w of planned) {
    if (w.checkIn < rangeStart) rangeStart = w.checkIn
    if (w.checkOut > rangeEnd) rangeEnd = w.checkOut
  }
  const totalNights = Math.round((Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${rangeStart}T00:00:00Z`)) / dayMs)
  const candidateNights = [...new Set(planned.map(w => w.nights))].sort((a, b) => a - b)

  return { rangeStart, rangeEnd, totalNights, candidateNights, budget, windows: retained, dropped }
}
