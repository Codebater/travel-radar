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
 *   - perk-aware V2: a VERIFIED, DECLARED-entitlement perk may contribute its
 *     rule-supported free-night COUNT (planperks.ts) — never a points value,
 *     never a discounted total. Unverified rules and QUALIFIES_BUT_UNPRICED
 *     resolutions never affect ranking. No cash mixing.
 *
 * Ranking doctrine (lexicographic, conservative) by optimization goal:
 *   life_perks (default): 1. fewer uncovered nights — complete coverage
 *      always wins; 2. MORE applied verified free nights (rankable count —
 *      applied arithmetic non-certificate perks only); 3. fewer hotel
 *      switches; 4. valid stated-points dominance; 5. signature.
 *   fewest_switches (the V1 ordering): coverage → switches → valid
 *      stated-points dominance → signature.
 *   points_cost: coverage → valid stated-points dominance → switches →
 *      signature.
 *   "Valid stated-points dominance" = lower source-stated points ONLY where
 *   the comparison is actually valid: both plans cover the same program set,
 *   every segment of every program states a full-stay total, and one plan's
 *   per-program totals dominate the other's (≤ everywhere, < somewhere).
 *   Per-night-only programs make plans incomparable on points — the rule
 *   then skips. Tie-break is always the lexicographically smallest plan
 *   signature, so every goal is deterministic.
 */

import { type StoredHotelAward } from "./store.js"
import {
  rankablePerkNights, resolvePlanPerks,
  type PlanPerkSummary, type SegmentPerkResolution,
} from "./planperks.js"
import type { EntitlementsConfig, HotelPerkRulesConfig } from "./perks.js"

/** Provenance of the observation behind a segment — copied VERBATIM from the
 *  stored row. Facts for the reader, never inputs to ranking or signatures. */
export interface SegmentEvidence {
  fetchedAt: string
  availabilityState: string
  searchState: string
  verificationLevel: string
  sourceFreshness: string | null
  taxesFeesState: string
  taxesFeesAmount: number | null
  taxesFeesCurrency: string | null
  roomName: string | null
  roomClass: string | null
  sourceProgramName: string
  awardType: string
  /** Labelled cash CONTEXT from the same response — never a comparison,
   *  never summed, never converted; the basis differs by provider. */
  cashComparisonAmount: number | null
  cashComparisonCurrency: string | null
}

/** Booking navigation resolved from the observation's stored locator (the
 *  same honesty ladder /api/hotel-awards uses). Attached AFTER ranking by
 *  stayplan-navigation.ts — stayplan.ts itself stays DB-free. */
export interface SegmentNavigation {
  quality: "EXACT_DEEP_LINK" | "SEARCH_REPLAY_LINK" | "PROVIDER_LANDING_LINK" | "UNAVAILABLE"
  url: string | null
  observedAt: string | null
}

export interface PlanSegment {
  observationId: number
  provider: string
  providerPropertyRef: string
  propertyName: string
  chain: string | null
  program: string
  checkIn: string
  checkOut: string
  nights: number
  quoteBasis: string
  pointsPerNight: number | null
  pointsTotal: number | null       // source-stated only — never synthesized
  evidence: SegmentEvidence
  navigation?: SegmentNavigation
  /** Perk resolutions for this segment (planperks.ts) — present only when a
   *  perk context was supplied. Counts nights, never invents points. */
  perks?: SegmentPerkResolution[]
}

/** Plan-level provenance roll-up — computed from the plan's own segments. */
export interface PlanEvidence {
  oldestFetchedAt: string | null
  newestFetchedAt: string | null
  availabilityUnknownSegments: number
  verificationLevels: Record<string, number>
}

/** Read-only edge filters — they only REMOVE observations before the search;
 *  coverage still wins and uncovered nights stay visible. Never a search. */
export interface StayPlanFilters {
  /** Keep only these program keys (empty/omitted = all programs). */
  programs?: string[]
  /** Drop these `provider|providerPropertyRef` identities ("swap this hotel"). */
  excludeProperties?: string[]
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
  /** RANKABLE applied free-night count (applied arithmetic non-certificate
   *  perks — see planperks.ts). 0 without a perk context. A COUNT of nights,
   *  never a points figure. */
  appliedPerkNights: number
  /** Full plan-level perk resolution summary — only with a perk context. */
  perkSummary?: PlanPerkSummary
  /** Provenance roll-up of this plan's segments (facts, not ranking inputs). */
  evidence?: PlanEvidence
  signature: string                // deterministic identity/tie-break key
}

export type StayPlanGoal = "life_perks" | "points_cost" | "fewest_switches"
export const STAY_PLAN_GOALS: StayPlanGoal[] = ["life_perks", "points_cost", "fewest_switches"]

/** Verified rules + declared entitlements — filtered by the caller's
 *  "include in plan" choices before it gets here. */
export interface StayPlanPerkContext {
  rules: HotelPerkRulesConfig
  entitlements: EntitlementsConfig
}

export interface StayPlanResult {
  rangeStart: string
  rangeEnd: string
  requestedNights: number
  goal: StayPlanGoal
  /** The edge filters that were applied (empty arrays when none). */
  filters: { programs: string[]; excludeProperties: string[] }
  observationsConsidered: number
  edges: number
  /** Best plan first; up to maxAlternatives further complete/near plans. */
  plans: StayPlan[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const dayMs = 86_400_000
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`)
const addDays = (d: string, n: number) => new Date(parse(d) + n * dayMs).toISOString().slice(0, 10)

interface Edge { fromIdx: number; toIdx: number; seg: PlanSegment; perkNights: number }

/** Reduce append-only history to one representative edge per property/
 *  program/exact-range: newest observation wins; among same-id-set room
 *  variants the lowest stated points/night wins (deterministic). */
function buildEdges(
  observations: StoredHotelAward[], rangeStart: string, rangeEnd: string, nights: number,
  filters: { programs: string[]; excludeProperties: string[] },
): Edge[] {
  const byKey = new Map<string, StoredHotelAward>()
  const programSet = new Set(filters.programs)
  const excluded = new Set(filters.excludeProperties)
  for (const o of observations) {
    if (o.checkIn < rangeStart || o.checkOut > rangeEnd) continue    // exact-range edges only
    if (o.nights < 1) continue
    // Filters only REMOVE evidence from the search — they never add any.
    if (programSet.size > 0 && !programSet.has(o.program)) continue
    if (excluded.has(`${o.provider}|${o.providerPropertyRef}`)) continue
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
      fromIdx, toIdx, perkNights: 0,                        // filled after edge dedupe
      seg: {
        observationId: o.id, provider: o.provider, providerPropertyRef: o.providerPropertyRef,
        propertyName: o.propertyName, chain: o.chain, program: o.program, checkIn: o.checkIn, checkOut: o.checkOut,
        nights: o.nights, quoteBasis: o.quoteBasis,
        pointsPerNight: o.pointsPerNight,
        pointsTotal: o.quoteBasis === "full_stay" ? o.pointsTotal : null,   // stated totals only
        evidence: {
          fetchedAt: o.fetchedAt, availabilityState: o.availabilityState, searchState: o.searchState,
          verificationLevel: o.verificationLevel, sourceFreshness: o.sourceFreshness,
          taxesFeesState: o.taxesFeesState, taxesFeesAmount: o.taxesFeesAmount, taxesFeesCurrency: o.taxesFeesCurrency,
          roomName: o.roomName, roomClass: o.roomClass, sourceProgramName: o.sourceProgramName, awardType: o.awardType,
          cashComparisonAmount: o.cashComparisonAmount, cashComparisonCurrency: o.cashComparisonCurrency,
        },
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
  /** Sum of the plan's edges' RANKABLE applied perk free-night counts —
   *  applied arithmetic non-certificate perks only (planperks.ts). */
  perkNights: number
  lastProp: string | null          // provider|ref of the last STAY segment
  segments: PlanSegment[]
  signature: string
  /** Running per-program sums of SOURCE-STATED stay totals; null = poisoned
   *  by a per-night-only segment (that program can never state a total). */
  points: Map<string, number | null>
}

function segSig(s: PlanSegment): string {
  return `${s.checkIn}|${s.provider}|${s.providerPropertyRef}|${s.program}`
}

/** Points dimension for pruning, mirroring comparePlansByStatedPoints:
 *  true = a is at least as cheap as b on every program (or both are poisoned,
 *  in which case the final sort can never separate them on points anyway);
 *  false = b is strictly cheaper somewhere; null = incomparable (different
 *  program sets, or exactly one side poisoned) — such labels must BOTH live. */
function pointsAtLeastAsGood(a: Label, b: Label): boolean | null {
  const poisonedA = [...a.points.values()].some(v => v === null)
  const poisonedB = [...b.points.values()].some(v => v === null)
  if (poisonedA && poisonedB) return true
  if (poisonedA !== poisonedB) return null
  if (a.points.size !== b.points.size) return null
  for (const [prog, va] of a.points) {
    const vb = b.points.get(prog)
    if (vb === undefined || vb === null || va === null) return null
    if (va > vb) return false
  }
  return true
}

/**
 * Pareto dominance between two labels at the same (date, lastProp) state —
 * the DP may drop `b` only when `a` is at least as good on EVERY dimension the
 * goal's final ordering uses (coverage, rankable perk nights under life_perks,
 * switches, valid stated-points dominance). On a complete tie the
 * lexicographically smaller signature survives. Labels that are incomparable
 * on points are both kept, so a stated-points-cheaper prefix can never be
 * pruned before the goal sort sees it.
 */
function dominates(a: Label, b: Label, goal: StayPlanGoal): boolean {
  if (a.uncovered > b.uncovered) return false
  if (goal === "life_perks" && a.perkNights < b.perkNights) return false
  if (a.switches > b.switches) return false
  if (pointsAtLeastAsGood(a, b) !== true) return false
  const tie = a.uncovered === b.uncovered && a.switches === b.switches
    && (goal !== "life_perks" || a.perkNights === b.perkNights)
    && pointsAtLeastAsGood(b, a) === true
  return !tie || a.signature < b.signature
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

function planEvidence(segments: PlanSegment[]): PlanEvidence {
  const levels: Record<string, number> = {}
  let oldest: string | null = null, newest: string | null = null, unknown = 0
  for (const s of segments) {
    const e = s.evidence
    if (oldest === null || e.fetchedAt < oldest) oldest = e.fetchedAt
    if (newest === null || e.fetchedAt > newest) newest = e.fetchedAt
    if (e.availabilityState === "unknown") unknown++
    levels[e.verificationLevel] = (levels[e.verificationLevel] ?? 0) + 1
  }
  return { oldestFetchedAt: oldest, newestFetchedAt: newest, availabilityUnknownSegments: unknown, verificationLevels: levels }
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
  opts: { maxAlternatives?: number; goal?: StayPlanGoal; perkContext?: StayPlanPerkContext; filters?: StayPlanFilters } = {},
): StayPlanResult {
  if (!DATE.test(rangeStart) || !DATE.test(rangeEnd) || Number.isNaN(parse(rangeStart)) || Number.isNaN(parse(rangeEnd))) {
    throw new Error(`range must be real YYYY-MM-DD dates (${rangeStart}..${rangeEnd})`)
  }
  const nights = Math.round((parse(rangeEnd) - parse(rangeStart)) / dayMs)
  if (nights < 1) throw new Error(`range end must follow range start (${rangeStart}..${rangeEnd})`)
  if (nights > 370) throw new Error(`range too long (${nights} nights) — plan at most 370`)
  const maxAlternatives = opts.maxAlternatives ?? 3
  const goal = opts.goal ?? "life_perks"
  if (!STAY_PLAN_GOALS.includes(goal)) throw new Error(`unknown optimization goal "${goal}"`)
  const perkContext = opts.perkContext ?? null
  const filters = {
    programs: [...(opts.filters?.programs ?? [])].sort(),
    excludeProperties: [...(opts.filters?.excludeProperties ?? [])].sort(),
  }

  const edges = buildEdges(observations, rangeStart, rangeEnd, nights, filters)
  // Rankable perk free-night counts are a static edge property (certificate
  // rules excluded — their consumption is plan-order-dependent and resolves
  // after the search). Without a perk context every edge counts 0 and the
  // life_perks ordering degrades exactly to the V1 ordering.
  if (perkContext) {
    for (const e of edges) e.perkNights = rankablePerkNights(e.seg, perkContext.rules, perkContext.entitlements)
  }
  const edgesFrom: Edge[][] = Array.from({ length: nights + 1 }, () => [])
  for (const e of edges) edgesFrom[e.fromIdx].push(e)

  // Forward DP over date indices. State: (dateIdx, lastProp) → the PARETO SET
  // of non-dominated labels (see dominates()). A 1-night GAP edge
  // (uncovered+1) makes best-partial coverage fall out of the same search;
  // gaps preserve lastProp and never count as a switch.
  const states: Map<string, Label[]>[] = Array.from({ length: nights + 1 }, () => new Map())
  const start: Label = { uncovered: 0, switches: 0, perkNights: 0, lastProp: null, segments: [], signature: "", points: new Map() }
  states[0].set("", [start])

  const consider = (idx: number, label: Label) => {
    const key = label.lastProp ?? ""
    const list = states[idx].get(key)
    if (!list) { states[idx].set(key, [label]); return }
    for (const cur of list) if (dominates(cur, label, goal)) return
    const kept = list.filter(cur => !dominates(label, cur, goal))
    kept.push(label)
    states[idx].set(key, kept)
  }

  for (let idx = 0; idx < nights; idx++) {
    for (const list of states[idx].values()) for (const label of list) {
      // Gap: this night stays uncovered.
      consider(idx + 1, { ...label, uncovered: label.uncovered + 1 })
      // Stay edges starting tonight.
      for (const e of edgesFrom[idx]) {
        const prop = `${e.seg.provider}|${e.seg.providerPropertyRef}`
        const switches = label.switches + (label.lastProp !== null && label.lastProp !== prop ? 1 : 0)
        // Stated totals sum within one program; a per-night-only segment
        // poisons its program for good (no partial sum ever poses as a total).
        const points = new Map(label.points)
        const prev = points.get(e.seg.program)
        points.set(e.seg.program, e.seg.pointsTotal === null || prev === null ? null : (prev ?? 0) + e.seg.pointsTotal)
        consider(e.toIdx, {
          uncovered: label.uncovered,
          switches,
          perkNights: label.perkNights + e.perkNights,
          lastProp: prop,
          segments: [...label.segments, e.seg],
          signature: label.signature + segSig(e.seg) + ";",
          points,
        })
      }
    }
  }

  // Final labels → plans (one per distinct signature), ranked by doctrine.
  const finals = [...states[nights].values()].flat()
  const plans: StayPlan[] = finals.map(l => {
    const plan: StayPlan = {
      coveredNights: nights - l.uncovered,
      requestedNights: nights,
      segments: l.segments,
      switches: l.switches,
      uncoveredDates: uncoveredDates(l.segments, rangeStart, nights),
      programTotals: programTotals(l.segments),
      appliedPerkNights: l.perkNights,
      evidence: planEvidence(l.segments),
      signature: l.signature,
    }
    if (perkContext) {
      // Full plan-level resolution (certificate ledger included) — attaches
      // per-segment states and the summary; changes NO plan numbers.
      const resolved = resolvePlanPerks(l.segments, perkContext.rules, perkContext.entitlements)
      plan.segments = l.segments.map((s, i) => ({ ...s, perks: resolved.segments[i] }))
      plan.perkSummary = resolved.summary
    }
    return plan
  })
  plans.sort((a, b) => {
    if (a.coveredNights !== b.coveredNights) return b.coveredNights - a.coveredNights
    if (goal === "life_perks" && a.appliedPerkNights !== b.appliedPerkNights) return b.appliedPerkNights - a.appliedPerkNights
    if (goal === "points_cost") {
      const byPoints = comparePlansByStatedPoints(a, b)
      if (byPoints !== 0) return byPoints
      if (a.switches !== b.switches) return a.switches - b.switches
    } else {
      if (a.switches !== b.switches) return a.switches - b.switches
      const byPoints = comparePlansByStatedPoints(a, b)
      if (byPoints !== 0) return byPoints
    }
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0
  })

  return {
    rangeStart, rangeEnd, requestedNights: nights, goal, filters,
    observationsConsidered: observations.length,
    edges: edges.length,
    plans: plans.slice(0, 1 + maxAlternatives),
  }
}
