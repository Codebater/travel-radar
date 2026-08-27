/**
 * Discovery configuration loader.
 *
 * Everything that decides WHERE the engine looks and HOW MUCH it may spend
 * lives in config/discovery.json, so widening the search is an edit to a data
 * file rather than a code change — and so the exact scope that produced a run
 * is recorded rather than implied.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { CabinClass } from "../providers/cash-flights/types.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "discovery.json")

export type OriginGroup = "primary" | "positioning"
export type PositioningMode = "train" | "bus" | "flight" | "car"

export interface PositioningLeg {
  from: string
  mode: PositioningMode
  typicalCost: Record<string, number>
  hours: number
  note?: string
}

export interface DestinationGroup {
  label: string
  airports: string[]
  priority: number
  tripLengths: number[]
  desirability: number
  /**
   * False for a group that is a SEARCH SCOPE rather than a kind of
   * destination. Such a group can be searched, but never decides what a
   * destination "is" - otherwise a narrow validation scope would silently
   * reclassify every airport in it and change how those candidates score.
   */
  classification?: boolean
  note?: string
}

/** §7/§8 - a pairing of arrival and departure city that is a real itinerary. */
export interface TransferLeg {
  mode: PositioningMode
  hours: number
  typicalCost: Record<string, number>
  note?: string
}

export interface DestinationPairRule {
  group: string
  arrive: string
  depart: string
  /** 0..1 - is this a trip somebody would actually want, or just two cheap fares? */
  usefulness: number
  transfer: TransferLeg | null
  note?: string
}

export interface HomeTransferRule extends TransferLeg {
  between: [string, string]
}

export interface DiscoveryJobConfig {
  name: string
  originGroup: OriginGroup
  destinationGroup: string
  horizonDays: number
  cabins: CabinClass[]
  frequencyHours: number
  priority: number
  enabled: boolean
  /** Narrow a job to the first N airports of its group (they are ordered by preference). */
  maxDestinations?: number
  /** Override the global sparse grid for this job. */
  datesPerRoute?: number
}

export interface DiscoveryConfig {
  homeRegion: {
    primary: string[]
    positioning: string[]
    positioningLegs: Record<string, PositioningLeg>
  }
  positioning: {
    overnight: {
      requiredWhenLegHours: number
      requiredWhenDepartureBefore: string
      cost: Record<string, number>
    }
    connectionBufferHours: number
    penalties: Record<string, number>
    maxAcceptablePenalty: number
    minSavingPercent: number
    minSavingAbsolute: Record<string, number>
  }
  destinationGroups: Record<string, DestinationGroup>
  sampling: {
    stage1: {
      horizonDays: number
      firstDepartureOffsetDays: number
      datesPerRoute: number
      tripLengthsPerRoute: number
      cabins: { priority: CabinClass[]; wildcard: CabinClass[] }
    }
    stage2: {
      triggerPercentBelowSparseMedian: number
      windowDays: number
      stepDays: number
      extraTripLengths: number
      maxWindowsPerRun: number
    }
    stage3: {
      awardExpansionMinScore: number
      maxAwardWindowsPerRun: number
    }
  }
  verification: {
    minScore: number
    minPercentBelowMedian: number
    minBaselineConfidence: string
    maxVerificationsPerRun: number
    pools: { automatedShare: number }
  }
  budgets: {
    maxFreeCallsPerRun: number
    maxAwardCallsPerRun: number
    maxMeteredCallsPerRun: number
    maxRuntimeMs: number
  }
  concurrency: {
    maxConcurrentFreeSearches: number
    maxConcurrentAwardSearches: number
  }
  openJaw: {
    enabled: boolean
    /** Home airport out, home airport back. A same-home pair is only used when the destination cities differ. */
    originPairs: [string, string][]
    minSavingPercent: number
    maxCombinationsPerPair: number
    maxLegAgeDays: number
    /** §8 cross-city pairings must be listed to exist. Same-city is always allowed. */
    destinationPairs: DestinationPairRule[]
    /** Getting home from the home airport you did not leave from. */
    homeTransfers: HomeTransferRule[]
    penalties: Record<string, number>
    maxAcceptableFriction: number
    sampling: {
      enabled: boolean
      groups: string[]
      airports: Record<string, string[]>
      origins: string[]
      datesPerRoute: number
      cabins: CabinClass[]
      maxLegSearchesPerRun: number
    }
  }
  cadence: { sparseScanHours: number }
  jobs: DiscoveryJobConfig[]
  alerts: { enabled: boolean }
}

let cached: DiscoveryConfig | null = null

export function loadDiscoveryConfig(force = false): DiscoveryConfig {
  if (cached && !force) return cached
  cached = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as DiscoveryConfig
  return cached
}

/** Airports for an origin group. */
export function originsFor(group: OriginGroup, config: DiscoveryConfig): string[] {
  return group === "primary" ? config.homeRegion.primary : config.homeRegion.positioning
}

/** Is this airport one I can simply leave from, or does it need positioning? */
export function isPrimaryOrigin(airport: string, config: DiscoveryConfig): boolean {
  return config.homeRegion.primary.includes(airport.toUpperCase())
}

/** Which configured group contains this destination, if any. */
export function groupForDestination(
  destination: string, config: DiscoveryConfig,
): { key: string; group: DestinationGroup } | null {
  const code = destination.toUpperCase()
  // Priority order: a code in two groups (DXB is both wildcard and citybreak)
  // belongs to the more important one for scoring purposes.
  const entries = Object.entries(config.destinationGroups)
    .filter(([, g]) => g.classification !== false && g.airports.includes(code))
    .sort((a, b) => a[1].priority - b[1].priority)
  return entries.length > 0 ? { key: entries[0]![0], group: entries[0]![1] } : null
}

/**
 * §8 - the destination-side pairings allowed for one arrival airport.
 *
 * The same-city pairing is always present and needs no configuration: flying
 * into Bangkok and out of Bangkok, but home to a different airport, is an open
 * jaw at the HOME end only and carries no destination transfer. Every
 * cross-city pairing must be listed, because "two cheap one-ways exist" is not
 * the same statement as "this is a trip".
 */
export function openJawPairsFor(
  arrive: string, config: DiscoveryConfig, group: string | null = null,
): DestinationPairRule[] {
  const code = arrive.toUpperCase()
  const sameCity: DestinationPairRule = {
    group: group ?? groupForDestination(code, config)?.key ?? "",
    arrive: code, depart: code,
    usefulness: 1,
    transfer: null,
    note: "in and out of the same city, home to a different airport",
  }
  const configured = (config.openJaw.destinationPairs ?? [])
    .filter(p => p.arrive.toUpperCase() === code && p.depart.toUpperCase() !== code)
  return [sameCity, ...configured]
}

/** The ground/air link between two home airports, when one is configured. */
export function homeTransferFor(
  from: string, to: string, config: DiscoveryConfig,
): HomeTransferRule | null {
  if (from.toUpperCase() === to.toUpperCase()) return null
  const pair = [from.toUpperCase(), to.toUpperCase()].sort().join("|")
  return (config.openJaw.homeTransfers ?? []).find(
    h => [...h.between].map(a => a.toUpperCase()).sort().join("|") === pair,
  ) ?? null
}

/** Currency-keyed value with a sane fallback — never a silent zero. */
export function amountFor(table: Record<string, number>, currency: string): number {
  if (table[currency] !== undefined) return table[currency]!
  if (table.USD !== undefined) return table.USD
  return Object.values(table)[0] ?? 0
}
