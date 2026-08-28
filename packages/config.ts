/**
 * Package tier policy — config/packages.json. Policy only; provider host
 * overrides come from the environment first (tests point them at an
 * unroutable port), then this file, then nothing — a missing host is an
 * unconfigured provider, never a hardcoded fallback.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "packages.json")

export interface PackagesConfig {
  travellers: { adults: number }
  tui: {
    searchApiBase: string
    offerApiBase: string
    calendarApiBase: string
    tenant: string
    calendarTenant: string
    locale: string
    currency: string
    maxCallsPerRun: number
    maxCallsPerDay: number
  }
  check24: {
    apiBase: string
    currency: string
    maxSearchesPerRun: number
    maxSearchesPerDay: number
    pollIntervalMs: number
    maxPolls: number
  }
  comparability: {
    nightsToleranceCloseMatch: number
    dateFamilyWindowDays: number
  }
  competition: {
    minDecisiveDifferencePct: number
    maxPackageAgeDays: number
    maxCheckInDistanceDays: number
  }
  baselines: {
    minDistinctFetchDays: number
    minObservations: number
  }
}

let cached: PackagesConfig | null = null

export function loadPackagesConfig(force = false): PackagesConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as PackagesConfig
  for (const key of ["travellers", "tui", "check24", "comparability", "competition", "baselines"] as const) {
    if (!raw[key]) throw new Error(`config/packages.json is missing "${key}"`)
  }
  cached = raw
  return raw
}
