/**
 * Consecutive-night stay optimizer V1 — a READ-ONLY projection over stored
 * hotel-award observations (Deal Radar precedent: nothing here searches,
 * spends, writes or creates observations).
 *
 * For a requested calendar range, real observations become plan EDGES and a
 * deterministic DP covers every night exactly once (or reports the best
 * partial coverage with the exact uncovered dates).
 *
 * Load-bearing evidence rules:
 *   - an edge is valid ONLY for its observation's exact [checkIn, checkOut)
 *     range — never extrapolated to neighboring dates;
 *   - Roame per-night averages stay per-night: a per_night segment
 *     contributes NO points total, ever (it is flagged per-night-only);
 *   - a source-stated full_stay pointsTotal is authoritative and may be
 *     summed with other stated totals OF THE SAME PROGRAM only;
 *   - points of different loyalty programs are NEVER added into one number —
 *     totals are reported per program, and no cross-program total exists
 *     anywhere in the output;
 *   - V1 plans points-only stays: no perk application, no cash mixing.
 *
 * Ranking doctrine (lexicographic, conservative):
 *   1. fewer uncovered nights — complete coverage always wins;
 *   2. fewer hotel switches (property changes between consecutive stay
 *      segments; a gap does not itself count as a switch);
 *   3. lower source-stated points ONLY where the comparison is actually
 *      valid: both plans cover the same program set, every segment of every
 *      program states a full-stay total, and one plan's per-program totals
 *      dominate the other's (≤ everywhere, < somewhere). Per-night-only
 *      programs make plans incomparable on points — the rule then skips;
 *   4. stable deterministic tie-break: the lexicographically smallest plan
 *      signature.
 */

import { type StoredHotelAward } from "./store.js"

export interface PlanSegment {
  observationId: number
  provider: string
  providerPropertyRef: string
  propertyName: string
  program: string
  checkIn: string
  checkOut: string
  nights: number
  quoteBasis: string
  pointsPerNight: number | null
  pointsTotal: number | null       // source-stated only — never synthesized
}

export interface ProgramTotal {
  program: string
  /** Sum of SOURCE-STATED full-stay totals for this program's segments —
   *  null when any of them is per-night-only (a partial sum would misread
   *  as a stay total). */
  statedTotal: number | null
  statedSegments: number
  perNightOnlySegments: number
}

export interface StayPlan {
  coveredNights: number
  requestedNights: number
  segments: PlanSegment[]          // date order, non-overlapping
  switches: number
  uncoveredDates: string[]         // exact nights with no segment (YYYY-MM-DD)
  programTotals: ProgramTotal[]
  signature: string                // deterministic identity/tie-break key
}

export interface StayPlanResult {
  rangeStart: string
  rangeEnd: string
  requestedNights: number
  observationsConsidered: number
  edges: number
  /** Best plan first; up to maxAlternatives further complete/near plans. */
  plans: StayPlan[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const dayMs = 86_400_000
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`)
const addDays = (d: string, n: number) => new Date(parse(d) + n * dayMs).toISOString().slice(0, 10)

interface Edge { fromIdx: number; toIdx: number; seg: PlanSegment }

/** Reduce append-only history to one representative edge per property/
 *  program/exact-range: newest observation wins; among same-id-set room
 *  variants the lowest stated points/night wins (deterministic). */
function buildEdges(observations: StoredHotelAward[], rangeStart: string, rangeEnd: string, nights: number): Edge[] {
  const byKey = new Map<string, StoredHotelAward>()
  for (const o of observations) {
    if (o.checkIn < rangeStart || o.checkOut > rangeEnd) continue    // exact-range edges only
    if (o.nights < 1) continue
    const key = `${o.provider}|${o.providerPropertyRef}|${o.program}|${o.checkIn}|${o.checkOut}`
    const cur = byKey.get(key)
    if (!cur) { byKey.set(key, o); continue }
    // Newest observation of this exact stay wins; on the same freshness the
    // lower stated per-night figure, then the lower id, keeps it stable.
    const newer = o.fetchedAt > cur.fetchedAt
      || (o.fetchedAt === cur.fetchedAt && (o.pointsPerNight ?? Infinity) < (cur.pointsPerNight ?? Infinity))
      || (o.fetchedAt === cur.fetchedAt && (o.pointsPerNight ?? Infinity) === (cur.pointsPerNight ?? Infinity) && o.id < cur.id)
    if (newer) byKey.set(key, o)
  }
  const edges: Edge[] = []
  for (const o of byKey.values()) {
    const fromIdx = Math.round((parse(o.checkIn) - parse(rangeStart)) / dayMs)
    const toIdx = fromIdx + o.nights
    if (fromIdx < 0 || toIdx > nights) continue
    edges.push({
      fromIdx, toIdx,
      seg: {
        observationId: o.id, provider: o.provider, providerPropertyRef: o.providerPropertyRef,
        propertyName: o.propertyName, program: o.program, checkIn: o.checkIn, checkOut: o.checkOut,
        nights: o.nights, quoteBasis: o.quoteBasis,
        pointsPerNight: o.pointsPerNight,
        pointsTotal: o.quoteBasis === "full_stay" ? o.pointsTotal : null,   // stated totals only
      },
    })
  }
  // Deterministic edge order: by start, then length, then identity.
  edges.sort((a, b) => a.fromIdx - b.fromIdx || a.toIdx - b.toIdx
    || (a.seg.provider + a.seg.providerPropertyRef + a.seg.program).localeCompare(b.seg.provider + b.seg.providerPropertyRef + b.seg.program))
  return edges
}

interface Label {
  uncovered: number
  switches: number
  lastProp: string | null          // provider|ref of the last STAY segment
  segments: PlanSegment[]
  signature: string
}

function segSig(s: PlanSegment): string {
  return `${s.checkIn}|${s.provider}|${s.providerPropertyRef}|${s.program}`
}

function better(a: Label, b: Label): boolean {
  if (a.uncovered !== b.uncovered) return a.uncovered < b.uncovered
  if (a.switches !== b.switches) return a.switches < b.switches
  return a.signature < b.signature
}

function programTotals(segments: PlanSegment[]): ProgramTotal[] {
  const byProg = new Map<string, ProgramTotal>()
  for (const s of segments) {
    const t = byProg.get(s.program) ?? { program: s.program, statedTotal: 0, statedSegments: 0, perNightOnlySegments: 0 }
    if (s.pointsTotal !== null) {
      t.statedTotal = (t.statedTotal ?? 0) + s.pointsTotal
      t.statedSegments++
    } else {
      // One per-night-only segment poisons the program total: a partial sum
      // would present itself as the program's stay cost. Null, flagged.
      t.statedTotal = null
      t.perNightOnlySegments++
    }
    byProg.set(s.program, t)
  }
  // A program whose total went null keeps counting stated segments for the
  // report, but its statedTotal stays null once any segment lacks a total.
  for (const t of byProg.values()) {
    if (t.perNightOnlySegments > 0) t.statedTotal = null
  }
  return [...byProg.values()].sort((a, b) => a.program.localeCompare(b.program))
}

function uncoveredDates(segments: PlanSegment[], rangeStart: string, nights: number): string[] {
  const covered = new Array<boolean>(nights).fill(false)
  for (const s of segments) {
    const from = Math.round((parse(s.checkIn) - parse(rangeStart)) / dayMs)
    for (let i = from; i < from + s.nights; i++) covered[i] = true
  }
  const out: string[] = []
  for (let i = 0; i < nights; i++) if (!covered[i]) out.push(addDays(rangeStart, i))
  return out
}

/** Points-dominance comparison — defined ONLY when both plans cover the same
 *  program set and every segment of every program states a full-stay total.
 *  Returns -1/1 when one strictly dominates, 0 when the comparison is not
 *  valid or neither dominates. */
export function comparePlansByStatedPoints(a: StayPlan, b: StayPlan): number {
  const progsA = a.programTotals, progsB = b.programTotals
  if (progsA.length !== progsB.length) return 0
  const mapB = new Map(progsB.map(t => [t.program, t]))
  let aBetter = false, bBetter = false
  for (const ta of progsA) {
    const tb = mapB.get(ta.program)
    if (!tb) return 0                                              // different program sets
    if (ta.statedTotal === null || tb.statedTotal === null) return 0   // per-night-only → incomparable
    if (ta.statedTotal < tb.statedTotal) aBetter = true
    if (tb.statedTotal < ta.statedTotal) bBetter = true
  }
  if (aBetter && !bBetter) return -1
  if (bBetter && !aBetter) return 1
  return 0
}

export function buildStayPlan(
  observations: StoredHotelAward[],
  rangeStart: string,
  rangeEnd: string,
  opts: { maxAlternatives?: number } = {},
): StayPlanResult {
  if (!DATE.test(rangeStart) || !DATE.test(rangeEnd) || Number.isNaN(parse(rangeStart)) || Number.isNaN(parse(rangeEnd))) {
    throw new Error(`range must be real YYYY-MM-DD dates (${rangeStart}..${rangeEnd})`)
  }
  const nights = Math.round((parse(rangeEnd) - parse(rangeStart)) / dayMs)
  if (nights < 1) throw new Error(`range end must follow range start (${rangeStart}..${rangeEnd})`)
  if (nights > 370) throw new Error(`range too long (${nights} nights) — plan at most 370`)
  const maxAlternatives = opts.maxAlternatives ?? 3

  const edges = buildEdges(observations, rangeStart, rangeEnd, nights)
  const edgesFrom: Edge[][] = Array.from({ length: nights + 1 }, () => [])
  for (const e of edges) edgesFrom[e.fromIdx].push(e)

  // Forward DP over date indices. State: (dateIdx, lastProp) → best label.
  // A 1-night GAP edge (uncovered+1) makes best-partial coverage fall out of
  // the same search; gaps preserve lastProp and never count as a switch.
  const states: Map<string, Label>[] = Array.from({ length: nights + 1 }, () => new Map())
  const start: Label = { uncovered: 0, switches: 0, lastProp: null, segments: [], signature: "" }
  states[0].set("", start)

  const consider = (idx: number, label: Label) => {
    const key = label.lastProp ?? ""
    const cur = states[idx].get(key)
    if (!cur || better(label, cur)) states[idx].set(key, label)
  }

  for (let idx = 0; idx < nights; idx++) {
    for (const label of states[idx].values()) {
      // Gap: this night stays uncovered.
      consider(idx + 1, { ...label, uncovered: label.uncovered + 1 })
      // Stay edges starting tonight.
      for (const e of edgesFrom[idx]) {
        const prop = `${e.seg.provider}|${e.seg.providerPropertyRef}`
        const switches = label.switches + (label.lastProp !== null && label.lastProp !== prop ? 1 : 0)
        consider(e.toIdx, {
          uncovered: label.uncovered,
          switches,
          lastProp: prop,
          segments: [...label.segments, e.seg],
          signature: label.signature + segSig(e.seg) + ";",
        })
      }
    }
  }

  // Final labels → plans (one per distinct signature), ranked by doctrine.
  const finals = [...states[nights].values()]
  const plans: StayPlan[] = finals.map(l => ({
    coveredNights: nights - l.uncovered,
    requestedNights: nights,
    segments: l.segments,
    switches: l.switches,
    uncoveredDates: uncoveredDates(l.segments, rangeStart, nights),
    programTotals: programTotals(l.segments),
    signature: l.signature,
  }))
  plans.sort((a, b) => {
    if (a.coveredNights !== b.coveredNights) return b.coveredNights - a.coveredNights
    if (a.switches !== b.switches) return a.switches - b.switches
    const byPoints = comparePlansByStatedPoints(a, b)
    if (byPoints !== 0) return byPoints
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0
  })

  return {
    rangeStart, rangeEnd, requestedNights: nights,
    observationsConsidered: observations.length,
    edges: edges.length,
    plans: plans.slice(0, 1 + maxAlternatives),
  }
}
