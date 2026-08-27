/**
 * §5/§6/§7 - staged sampling. The part that decides whether this engine is
 * affordable or absurd.
 *
 * The naive version of "search flexibly" is a cross product: origins x
 * destinations x every date in the horizon x every trip length x cabins. For
 * the modest scope in config that is 5 x 15 x 180 x 7 x 2 = 189,000 searches
 * per cycle. So the engine never asks the whole question at once:
 *
 *   Stage 1 SPARSE   a handful of departures per route at one trip length.
 *                    Buys breadth, on the free provider, every cycle.
 *   Stage 2 DENSE    only around a sparse sample that came back unusually low
 *                    RELATIVE TO ITS OWN ROUTE. Buys resolution where there is
 *                    something to resolve.
 *   Stage 3 CONFIRM  award expansion and (rarely) metered verification, only
 *                    for a window that already scored well.
 *
 * The relative trigger matters: an absolute one would fire constantly on
 * structurally cheap routes and never on expensive ones, so the engine would
 * spend its whole budget re-measuring what it already knew.
 *
 * Everything here is deterministic on (anchor date, run index), so a dry-run
 * shows exactly what a real run would do, and repeats hit the cache.
 */

import type { CabinClass } from "../providers/cash-flights/types.js"
import type { DiscoveryConfig } from "./config.js"
import { groupForDestination, isPrimaryOrigin, originsFor } from "./config.js"
import type { DiscoveryJob, RouteTarget, SampleTarget } from "./types.js"

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** Every (origin, destination) pair a job covers. */
export function routesFor(job: DiscoveryJob, config: DiscoveryConfig): RouteTarget[] {
  const origins = originsFor(job.originGroup, config)
  const group = config.destinationGroups[job.destinationGroup]
  if (!group) return []

  // A job may be narrowed to the first N airports of its group. The arrays in
  // config are written in preference order, so "first N" means "the ones worth
  // the calls" rather than an arbitrary slice.
  const airports = job.maxDestinations && job.maxDestinations > 0
    ? group.airports.slice(0, job.maxDestinations)
    : group.airports

  const routes: RouteTarget[] = []
  for (const origin of origins) {
    for (const destination of airports) {
      routes.push({
        origin,
        destination,
        destinationGroup: job.destinationGroup,
        requiresPositioning: !isPrimaryOrigin(origin, config),
        desirability: group.desirability,
      })
    }
  }
  return routes
}

/**
 * Stage 1 departure dates for a route: `datesPerRoute` points spread evenly
 * across the horizon, rotated by the run index so consecutive runs land on
 * different days and the horizon fills in over a week rather than
 * re-measuring the same six dates forever.
 */
export function sparseDates(
  job: DiscoveryJob,
  runIndex: number,
  config: DiscoveryConfig,
  now: Date = new Date(),
): string[] {
  const s = config.sampling.stage1
  const first = s.firstDepartureOffsetDays
  const horizon = Math.min(job.horizonDays, s.horizonDays)
  const count = Math.max(1, job.datesPerRoute ?? s.datesPerRoute)
  const span = Math.max(1, horizon - first)
  const step = span / count

  const anchor = isoDay(now)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    // The rotation is a fraction of one step, so successive runs interleave
    // between the previous run's samples instead of repeating or drifting off
    // the end of the horizon.
    const offset = first + Math.round(i * step + ((runIndex % count) * step) / count)
    out.push(addDays(anchor, Math.min(offset, horizon)))
  }
  return [...new Set(out)]
}

/** Cabins to sample in stage 1 for this job's destination group. */
export function sparseCabins(job: DiscoveryJob, config: DiscoveryConfig): CabinClass[] {
  const group = config.destinationGroups[job.destinationGroup]
  const table = config.sampling.stage1.cabins
  const allowed = group && group.priority <= 1 ? table.priority : table.wildcard
  // The job's own cabin list is the ceiling; the stage-1 table only narrows it.
  return job.cabins.filter(c => allowed.includes(c))
}

/**
 * The full stage-1 plan for a job: every route x sparse date x cabin, at the
 * group's canonical trip length only.
 */
export function planStage1(
  job: DiscoveryJob,
  runIndex: number,
  config: DiscoveryConfig,
  now: Date = new Date(),
): SampleTarget[] {
  const routes = routesFor(job, config)
  const dates = sparseDates(job, runIndex, config, now)
  const cabins = sparseCabins(job, config)
  const lengths = job.tripLengths.slice(0, Math.max(1, config.sampling.stage1.tripLengthsPerRoute))

  const targets: SampleTarget[] = []
  for (const route of routes) {
    for (const departureDate of dates) {
      for (const cabin of cabins) {
        for (const nights of lengths) {
          targets.push({
            route,
            departureDate,
            returnDate: addDays(departureDate, nights),
            tripLengthNights: nights,
            cabin,
            stage: 1,
          })
        }
      }
    }
  }
  return targets
}

/**
 * §4/§5 - the one-way legs discovery collects so open jaws can be assembled.
 *
 * Until now open-jaw analysis lived off whatever one-way observations the fixed
 * observer happened to leave behind, which meant it usually had nothing to work
 * with: discovery samples return trips, so the legs an open jaw is made of were
 * never deliberately collected by the thing that needs them.
 *
 * This is deliberately the sparsest stage in the engine:
 *
 *   - only the configured groups (Thailand, Mexico), never wildcards. Blindly
 *     collecting one-ways for ten wildcard destinations would cost more than
 *     the entire sparse scan and find nothing, because an open jaw needs BOTH
 *     legs and a comparable round trip before it can say anything at all;
 *   - only the priority airports of those groups;
 *   - only a SUBSET of the dates stage 1 already chose, so no new date grid is
 *     introduced and the legs line up with fares the engine already has;
 *   - capped per run, and emitted as (outbound, inbound) COUPLES so that
 *     trimming to the cap never leaves an outbound leg with no partner - half
 *     a couple is a wasted call by construction.
 *
 * Successive runs rotate through the couples, so a week of cycles covers the
 * whole set at a fraction of the per-run cost.
 */
export function planOpenJawLegs(
  job: DiscoveryJob,
  runIndex: number,
  config: DiscoveryConfig,
  now: Date = new Date(),
): SampleTarget[] {
  const openJaw = config.openJaw
  const sampling = openJaw?.sampling
  if (!openJaw?.enabled || !sampling?.enabled) return []
  if (job.originGroup !== "primary") return []
  if (!sampling.groups.includes(job.destinationGroup)) return []

  const group = config.destinationGroups[job.destinationGroup]
  const airports = (sampling.airports?.[job.destinationGroup] ?? []).map(a => a.toUpperCase())
  const origins = sampling.origins
    .map(o => o.toUpperCase())
    .filter(o => config.homeRegion.primary.includes(o))
  if (airports.length === 0 || origins.length < 2) return []

  const cabins = job.cabins.filter(c => sampling.cabins.includes(c))
  if (cabins.length === 0) return []

  const dates = sparseDates(job, runIndex, config, now)
    .slice(0, Math.max(1, sampling.datesPerRoute))
  const nights = job.tripLengths[0] ?? 7

  const route = (origin: string, destination: string): RouteTarget => ({
    origin,
    destination,
    destinationGroup: job.destinationGroup,
    requiresPositioning: !isPrimaryOrigin(origin, config),
    desirability: group?.desirability ?? 0.8,
  })
  const leg = (origin: string, destination: string, departureDate: string, cabin: CabinClass): SampleTarget => ({
    route: route(origin, destination),
    departureDate,
    returnDate: null,
    tripLengthNights: null,
    cabin,
    stage: 1,
  })

  // One couple = the outbound into the destination, and the return home to the
  // OTHER home airport. That second airport is what makes it an open jaw at
  // all; both legs are useless without their partner.
  const couples: SampleTarget[][] = []
  for (const departureDate of dates) {
    for (const cabin of cabins) {
      for (const origin of origins) {
        const partner = origins.find(o => o !== origin)!
        for (const airport of airports) {
          couples.push([
            leg(origin, airport, departureDate, cabin),
            leg(airport, partner, addDays(departureDate, nights), cabin),
          ])
        }
      }
    }
  }
  if (couples.length === 0) return []

  const maxLegs = Math.max(2, sampling.maxLegSearchesPerRun)
  const rotated = couples.slice(runIndex % couples.length)
    .concat(couples.slice(0, runIndex % couples.length))

  const out: SampleTarget[] = []
  const seen = new Set<string>()
  for (const couple of rotated) {
    if (out.length + couple.length > maxLegs) break
    for (const target of couple) {
      const key = `${target.route.origin}-${target.route.destination}|${target.departureDate}|${target.cabin}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(target)
    }
  }
  return out
}

export interface SparseObservation {
  route: RouteTarget
  departureDate: string
  cabin: CabinClass
  tripLengthNights: number
  price: number
  currency: string
}

/**
 * §6 stage 2 - which sparse results deserve a closer look.
 *
 * A sample qualifies when it is `triggerPercentBelowSparseMedian` under the
 * median of the SAME route and cabin's other sparse samples. Comparing against
 * the route's own scan is what keeps an expensive route from being permanently
 * ignored and a cheap one from permanently triggering.
 */
export function selectStage2Windows(
  observations: SparseObservation[],
  config: DiscoveryConfig,
): { observation: SparseObservation; percentBelowSparseMedian: number }[] {
  const s = config.sampling.stage2
  const groups = new Map<string, SparseObservation[]>()
  for (const o of observations) {
    const key = `${o.route.origin}-${o.route.destination}|${o.cabin}|${o.currency}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  const selected: { observation: SparseObservation; percentBelowSparseMedian: number }[] = []
  for (const group of groups.values()) {
    // Two points cannot establish "unusual"; a median of one is the sample
    // itself and would trigger on every route, every time.
    if (group.length < 3) continue
    const prices = group.map(o => o.price).sort((a, b) => a - b)
    const mid = Math.floor(prices.length / 2)
    const median = prices.length % 2 === 0 ? (prices[mid - 1]! + prices[mid]!) / 2 : prices[mid]!
    if (median <= 0) continue

    for (const o of group) {
      const percentBelow = Math.round(((median - o.price) / median) * 1000) / 10
      if (percentBelow >= s.triggerPercentBelowSparseMedian) {
        selected.push({ observation: o, percentBelowSparseMedian: percentBelow })
      }
    }
  }

  // Deepest discounts first, capped: a run with twenty interesting windows
  // should resolve the six most interesting, not run out of budget on all of
  // them and finish none.
  return selected
    .sort((a, b) => b.percentBelowSparseMedian - a.percentBelowSparseMedian)
    .slice(0, Math.max(1, s.maxWindowsPerRun))
}

/**
 * The dense grid around one interesting sparse sample: neighbouring departure
 * days, and a few more trip lengths than stage 1 tried.
 */
export function planStage2(
  seed: SparseObservation,
  job: DiscoveryJob,
  config: DiscoveryConfig,
): SampleTarget[] {
  const s = config.sampling.stage2
  const half = Math.floor(s.windowDays / 2)
  const step = Math.max(1, s.stepDays)

  const lengths = job.tripLengths.slice(0, Math.max(1, s.extraTripLengths))
  const targets: SampleTarget[] = []

  for (let offset = -half; offset <= half; offset += step) {
    const departureDate = addDays(seed.departureDate, offset)
    // Never sample into the past: a horizon shifts under a long run.
    if (departureDate < isoDay(new Date())) continue
    for (const nights of lengths) {
      // The exact combination stage 1 already searched would only hit its own
      // cache entry; skipping it keeps the dense pass spending on new ground.
      if (offset === 0 && nights === seed.tripLengthNights) continue
      targets.push({
        route: seed.route,
        departureDate,
        returnDate: addDays(departureDate, nights),
        tripLengthNights: nights,
        cabin: seed.cabin,
        stage: 2,
      })
    }
  }
  return targets
}

/** Trip lengths a destination group is actually worth searching. */
export function tripLengthsFor(destinationGroup: string, config: DiscoveryConfig): number[] {
  return config.destinationGroups[destinationGroup]?.tripLengths ?? [7, 10, 14]
}

/** Destination group of a route, for scoring and grouping. */
export function destinationGroupOf(destination: string, config: DiscoveryConfig): string | null {
  return groupForDestination(destination, config)?.key ?? null
}
