/**
 * Trip-market policy — config/market.json. Policy only; FX host overrides
 * come from the environment first (tests point them at an unroutable port).
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "market.json")

export interface MarketConfig {
  comparisonCurrency: string
  fx: {
    provider: string
    apiBase: string
    pairs: [string, string][]
    maxAgeDays: number
  }
  confidence: {
    tooCloseToCallPct: number
    materialCategories: string[]
    softCategories: string[]
  }
}

let cached: MarketConfig | null = null

export function loadMarketConfig(force = false): MarketConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as MarketConfig
  for (const key of ["comparisonCurrency", "fx", "confidence"] as const) {
    if (!raw[key]) throw new Error(`config/market.json is missing "${key}"`)
  }
  cached = raw
  return raw
}
