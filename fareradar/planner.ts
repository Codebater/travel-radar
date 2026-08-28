/**
 * The search-space optimizer: a flexible window is a PLAN, not an explosion.
 *
 * No cash provider we use offers a flexible calendar or date grid (their
 * capability profile below says so explicitly), so Tier 0 "calendar
 * discovery" is a SPARSE probe grid: a few evenly-spaced departure dates per
 * route at one representative trip length. Tier 1 refines only the most
 * promising cells (neighbouring dates, alternative trip lengths); Tier 2
 * re-confirms only finalists. The whole plan — including every reduction the
 * budget forced — is computed BEFORE the first request and stored with the
 * run, so "what did this cost and why" is always answerable.
 */

import { type FareRadarConfig } from "./config.js"

/** Capability profile per cash provider — data, never special-cased names. */
export interface ProviderPlanProfile {
  name: string
  flexibleCalendar: boolean
  dateGrid: boolean
  fixedDateOnly: boolean
  maxDateRangeDays: number | null
  metered: boolean
}

export const PROVIDER_PROFILES: ProviderPlanProfile[] = [
  { name: "fast_flights", flexibleCalendar: false, dateGrid: false, fixedDateOnly: true, maxDateRangeDays: null, metered: false },
  { name: "serpapi", flexibleCalendar: false, dateGrid: false, fixedDateOnly: true, maxDateRangeDays: null, metered: true },
]

export interface PlanParams {
  origins: string[]
  destinations: string[]
  windowStart: string          // YYYY-MM-DD
  windowEnd: string
  minNights: number
  maxNights: number
  maxSearches?: number
}

export interface SparseProbe {
  origin: string
  destination: string
  departureDate: string
  nights: number
}

export interface SearchPlan {
  origins: string[]
  destinations: string[]
  windowStart: string
  windowEnd: string
  minNights: number
  maxNights: number
  representativeNights: number
  probesPerRoute: number
  sparse: SparseProbe[]
  sparseCalls: number
  refineReserve: number
  confirmReserve: number
  callsPlanned: number
  cap: number
  reductions: string[]
  lines: string[]              // the human-readable plan, printed and stored
}

export function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export function nightsBetweenDates(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

/** The preferred trip length closest to the middle of [min, max]. */
export function representativeNights(cfg: FareRadarConfig, minNights: number, maxNights: number): number {
  const inRange = cfg.window.preferredNights.filter(n => n >= minNights && n <= maxNights)
  const pool = inRange.length ? inRange : [Math.round((minNights + maxNights) / 2)]
  const middle = (minNights + maxNights) / 2
  return pool.reduce((best, n) => Math.abs(n - middle) < Math.abs(best - middle) ? n : best)
}

/** Trip-length variants for refinement: nearest preferred lengths first. */
export function nightsVariants(cfg: FareRadarConfig, minNights: number, maxNights: number, count: number): number[] {
  const representative = representativeNights(cfg, minNights, maxNights)
  const inRange = cfg.window.preferredNights.filter(n => n >= minNights && n <= maxNights)
  const pool = inRange.length ? inRange : [representative]
  return [...pool]
    .sort((a, b) => Math.abs(a - representative) - Math.abs(b - representative) || a - b)
    .slice(0, Math.max(1, count))
}

function evenOffsets(windowDays: number, probes: number): number[] {
  if (probes <= 1) return [0]
  const offsets = new Set<number>()
  for (let i = 0; i < probes; i++) {
    offsets.add(Math.round(i * (windowDays - 1) / (probes - 1)))
  }
  return [...offsets].sort((a, b) => a - b)
}

export function buildSearchPlan(cfg: FareRadarConfig, params: PlanParams): SearchPlan {
  const cap = Math.max(3, params.maxSearches ?? cfg.budget.maxSearchesPerRun)
  const reductions: string[] = []
  const windowDays = Math.max(1, nightsBetweenDates(params.windowStart, params.windowEnd) + 1)
  const repNights = representativeNights(cfg, params.minNights, params.maxNights)

  const destinations = [...params.destinations]
  let probes = Math.min(cfg.budget.sparseProbesPerRoute, windowDays)
  let refineCells = cfg.budget.refineTopCells
  const refinePerCell = cfg.budget.refineNightsVariants
  const confirm = cfg.budget.confirmFinalists

  const total = () =>
    params.origins.length * destinations.length * probes + refineCells * refinePerCell + confirm

  // Reduce breadth INTELLIGENTLY, in declared order, each step named.
  while (total() > cap && probes > 2) {
    probes--
    reductions.push(`probes per route reduced to ${probes} (cap ${cap})`)
  }
  while (total() > cap && refineCells > 2) {
    refineCells--
    reductions.push(`refinement cells reduced to ${refineCells} (cap ${cap})`)
  }
  while (total() > cap && destinations.length > 1) {
    const dropped = destinations.pop()!
    reductions.push(`destination ${dropped} dropped from this run (cap ${cap}) — rotate it into the next run`)
  }

  const sparse: SparseProbe[] = []
  const offsets = evenOffsets(windowDays, probes)
  for (const origin of params.origins) {
    for (const destination of destinations) {
      for (const offset of offsets) {
        sparse.push({
          origin, destination,
          departureDate: shiftDate(params.windowStart, offset),
          nights: repNights,
        })
      }
    }
  }

  const plan: SearchPlan = {
    origins: params.origins,
    destinations,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    minNights: params.minNights,
    maxNights: params.maxNights,
    representativeNights: repNights,
    probesPerRoute: offsets.length,
    sparse,
    sparseCalls: sparse.length,
    refineReserve: refineCells * refinePerCell,
    confirmReserve: confirm,
    callsPlanned: sparse.length + refineCells * refinePerCell + confirm,
    cap,
    reductions,
    lines: [],
  }
  plan.lines = [
    `Search plan: ${params.origins.length} origins × ${destinations.length} destinations, ` +
      `${windowDays}-day window, ${params.minNights}–${params.maxNights} nights (representative ${repNights})`,
    `  Tier 0 sparse discovery: ${plan.sparseCalls} searches (${offsets.length} probe dates/route)`,
    `  Tier 1 refinement reserve: ${plan.refineReserve} searches (${refineCells} cells × ${refinePerCell} variants)`,
    `  Tier 2 confirmation reserve: ${plan.confirmReserve} searches`,
    `  Total planned: ${plan.callsPlanned} (cap ${cap}) — free provider only, metered NEVER touched`,
    ...reductions.map(r => `  REDUCED: ${r}`),
  ]
  return plan
}

export interface RefinementCell {
  origin: string
  destination: string
  departureDate: string
  cheapestObserved: number
}

/** Refinement probes for the winning cells: length variants + one neighbour date. */
export function refinementProbes(
  cfg: FareRadarConfig,
  plan: SearchPlan,
  cells: RefinementCell[],
): SparseProbe[] {
  const perCell = cfg.budget.refineNightsVariants
  const variants = nightsVariants(cfg, plan.minNights, plan.maxNights, perCell + 1)
  const windowDays = nightsBetweenDates(plan.windowStart, plan.windowEnd) + 1
  const halfStride = Math.max(1, Math.round(windowDays / Math.max(1, plan.probesPerRoute) / 2))

  const probes: SparseProbe[] = []
  const seen = new Set<string>()
  const push = (p: SparseProbe) => {
    const key = `${p.origin}|${p.destination}|${p.departureDate}|${p.nights}`
    if (seen.has(key)) return
    seen.add(key)
    probes.push(p)
  }
  for (const cell of cells) {
    let added = 0
    for (const nights of variants) {
      if (added >= perCell) break
      if (nights === plan.representativeNights) {
        // Already probed at this length — spend the slot on a neighbour date.
        const neighbour = shiftDate(cell.departureDate, halfStride)
        if (neighbour <= plan.windowEnd) {
          push({ origin: cell.origin, destination: cell.destination, departureDate: neighbour, nights })
          added++
        }
        continue
      }
      push({ origin: cell.origin, destination: cell.destination, departureDate: cell.departureDate, nights })
      added++
    }
  }
  return probes
}
