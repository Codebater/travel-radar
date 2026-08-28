/**
 * Fare-radar policy — config/fare-radar.json.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "fare-radar.json")

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
