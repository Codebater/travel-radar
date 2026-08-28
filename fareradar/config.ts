/**
 * Fare-radar policy — config/fare-radar.json.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "fare-radar.json")

/**
 * The trip shapes the radar can search. A hard dimension everywhere it
 * appears: a long-haul ONE_WAY is not half a ROUND_TRIP, so the two never
 * share candidates, baselines or rankings. (SPLIT_ROUND_TRIP / OPEN_JAW are
 * deliberately NOT here — later phases construct them from stored one-way
 * observations, never as a provider search shape.)
 */
export type TripType = "ROUND_TRIP" | "ONE_WAY"

export const TRIP_TYPES: readonly TripType[] = ["ROUND_TRIP", "ONE_WAY"]

/**
 * Strict parse at external boundaries (CLI flags, API params). Accepts the
 * canonical enum spelling and its kebab form — nothing else. Returns null for
 * anything unknown so the caller can reject with its own error shape.
 */
export function parseTripType(raw: string): TripType | null {
  switch (raw.trim().toUpperCase().replace(/-/g, "_")) {
    case "ROUND_TRIP": return "ROUND_TRIP"
    case "ONE_WAY": return "ONE_WAY"
    default: return null
  }
}

export interface FareRadarConfig {
  homeAirports: {
    primary: string[]
    extended: string[]
    extendedEnabled: boolean
  }
  watchlists: Record<string, string[] | string>
  window: {
    defaultNextDays: number
    minNights: number
    maxNights: number
    preferredNights: number[]
  }
  quality: {
    maxStops: number
    maxDurationHours: number
    longLayoverHours: number
    overnightConnectionStartHour: number
    overnightConnectionEndHour: number
  }
  scoring: {
    penalties: {
      businessUnverified: number
      businessMixed: number
      premiumEconomyAsResult: number
      perStop: number
      longLayover: number
      overnightConnection: number
      durationPerHourOverThreshold: number
      durationThresholdHours: number
      selfTransfer: number
      separateTicket: number
    }
  }
  budget: {
    maxSearchesPerRun: number
    sparseProbesPerRoute: number
    refineTopCells: number
    refineNightsVariants: number
    confirmFinalists: number
    currency: string
  }
  baselines: {
    minDistinctFetchDays: number
    minObservations: number
  }
}

let cached: FareRadarConfig | null = null

export function loadFareRadarConfig(force = false): FareRadarConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as FareRadarConfig
  for (const key of ["homeAirports", "watchlists", "window", "quality", "scoring", "budget", "baselines"] as const) {
    if (!raw[key]) throw new Error(`config/fare-radar.json is missing "${key}"`)
  }
  cached = raw
  return raw
}

/** The origin set for a run: primary always, extended only when enabled. */
export function homeAirports(cfg: FareRadarConfig, includeExtended?: boolean): string[] {
  const extended = includeExtended ?? cfg.homeAirports.extendedEnabled
  return [...cfg.homeAirports.primary, ...(extended ? cfg.homeAirports.extended : [])]
}

export function watchlist(cfg: FareRadarConfig, name: string): string[] | null {
  const entry = cfg.watchlists[name]
  return Array.isArray(entry) ? entry : null
}

/** ANYWHERE = the union of every configured watchlist — never invented. */
export function anywhereDestinations(cfg: FareRadarConfig): string[] {
  const all = new Set<string>()
  for (const entry of Object.values(cfg.watchlists)) {
    if (Array.isArray(entry)) for (const code of entry) all.add(code)
  }
  return [...all]
}
