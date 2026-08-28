/**
 * Trip Composer policy — config/trips.json. Policy only; the flight and stay
 * radars keep their own configs and the composer reads all three.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "trips.json")

export interface TripAbsoluteThresholds {
  interesting: number
  extreme: number
  wtf: number
}

export interface TripsConfig {
  travellers: { adults: number }
  origins: string[]
  matching: {
    maxArrivalLeadDays: number
    maxReturnLagDays: number
    maxFlightAgeDays: number
    maxStayWindows: number
    maxFlightsPerStay: number
    maxTripsPerCompose: number
  }
  admission: {
    exceptionalComponent: number
    reasonableComponent: number
    strongPair: number
    tripAbsoluteAlone: number
  }
  scoring: {
    weights: {
      strongestComponent: number
      weakerComponent: number
      tripAbsolute: number
      dateCompatibility: number
      evidence: number
      usability: number
    }
    complexityPenalties: {
      positioning: number
      openJaw: number
      airportChange: number
      longLayover: number
      maxTotal: number
    }
    overpricedKill: {
      multipleOfMedian: number
      capScore: number
    }
  }
  absolute: {
    currency: string
    rules: Record<string, TripAbsoluteThresholds>
  }
}

let cached: TripsConfig | null = null

export function loadTripsConfig(force = false): TripsConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as TripsConfig
  for (const key of ["travellers", "origins", "matching", "admission", "scoring", "absolute"] as const) {
    if (!raw[key]) throw new Error(`config/trips.json is missing "${key}"`)
  }
  cached = raw
  return raw
}
