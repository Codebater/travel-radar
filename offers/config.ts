/**
 * Bookable-offer policy — config/offers.json.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "offers.json")

export interface OffersConfig {
  allowedDomains: Record<string, string[] | string>
  freshness: {
    verifiedRecentMinutes: number
    observedFreshHours: number
  }
  recheck: {
    staysPerDay: number
  }
}

let cached: OffersConfig | null = null

export function loadOffersConfig(force = false): OffersConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as OffersConfig
  for (const key of ["allowedDomains", "freshness", "recheck"] as const) {
    if (!raw[key]) throw new Error(`config/offers.json is missing "${key}"`)
  }
  cached = raw
  return raw
}

export function allowedDomainsFor(provider: string): string[] {
  const entry = loadOffersConfig().allowedDomains[provider]
  return Array.isArray(entry) ? entry : []
}
