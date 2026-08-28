/**
 * Cabin truth + quality flags + the deterministic deal score.
 *
 * Cabin is a HARD dimension. Google's free path never states per-segment
 * cabins, so a business request it answers is BUSINESS_UNVERIFIED — labelled,
 * penalized in the value ranking, never silently promoted to full business.
 * SerpAPI states per-segment travel classes, so its itineraries classify as
 * BUSINESS_FULL or BUSINESS_MIXED on evidence.
 *
 * The deal score is arithmetic from config — price dominates, every penalty
 * is named in the breakdown, and the raw CHEAPEST ordering always survives
 * beside it untouched.
 */

import type { NormalizedCashFlight } from "../providers/cash-flights/types.js"
import type { FareRadarConfig } from "./config.js"

export type CabinMix =
  | "BUSINESS_FULL"
  | "BUSINESS_MIXED"
  | "BUSINESS_UNVERIFIED"
  | "PREMIUM_ECONOMY"
  | "ECONOMY"

export interface CabinClassification {
  mix: CabinMix
  detail: string
}

export function classifyCabinMix(flight: NormalizedCashFlight, requested: string): CabinClassification {
  if (flight.cabin !== requested) {
    // The provider echoed a DIFFERENT cabin than requested — label it as what
    // it is; it never competes as business.
    const mix: CabinMix = flight.cabin === "premium_economy" ? "PREMIUM_ECONOMY" : "ECONOMY"
    return { mix, detail: `provider echoed cabin "${flight.cabin}" for a "${requested}" request` }
  }
  if (requested !== "business") {
    return { mix: flight.cabin === "premium_economy" ? "PREMIUM_ECONOMY" : "ECONOMY", detail: `requested cabin ${requested}` }
  }
  const stated = flight.segments.filter(s => s.cabin !== null)
  if (stated.length === 0) {
    return {
      mix: "BUSINESS_UNVERIFIED",
      detail: "provider states no per-segment cabin — requested business, segment mix unknown",
    }
  }
  const businessSegments = stated.filter(s => /business|first/i.test(s.cabin!))
  if (businessSegments.length === stated.length && stated.length === flight.segments.length) {
    return { mix: "BUSINESS_FULL", detail: `all ${stated.length} segments state business` }
  }
  if (businessSegments.length === stated.length) {
    return {
      mix: "BUSINESS_UNVERIFIED",
      detail: `${stated.length} of ${flight.segments.length} segments state business, the rest state nothing`,
    }
  }
  return {
    mix: "BUSINESS_MIXED",
    detail: `segment cabins: ${flight.segments.map(s => s.cabin ?? "?").join(" / ")}`,
  }
}

// ── Quality flags ────────────────────────────────────────────────────────────

export interface QualityAssessment {
  flags: string[]
  dropped: string | null       // reason this itinerary is excluded entirely
}

function parseNaive(time: string | null): number | null {
  if (!time) return null
  const t = Date.parse(time)
  return Number.isFinite(t) ? t : null
}

export function assessQuality(flight: NormalizedCashFlight, cfg: FareRadarConfig): QualityAssessment {
  const flags: string[] = []
  if (flight.stops !== null && flight.stops > cfg.quality.maxStops) {
    return { flags, dropped: `MORE_THAN_${cfg.quality.maxStops}_STOPS` }
  }
  if (flight.durationMinutes !== null && flight.durationMinutes > cfg.quality.maxDurationHours * 60) {
    return { flags, dropped: `LONGER_THAN_${cfg.quality.maxDurationHours}H` }
  }
  // Layovers, computed only where segment times exist — never guessed.
  for (let i = 0; i + 1 < flight.segments.length; i++) {
    const arrive = parseNaive(flight.segments[i].arrivalTime)
    const departNext = parseNaive(flight.segments[i + 1].departureTime)
    if (arrive === null || departNext === null) continue
    const layoverMinutes = (departNext - arrive) / 60_000
    if (layoverMinutes > cfg.quality.longLayoverHours * 60 && !flags.includes("LONG_LAYOVER")) {
      flags.push("LONG_LAYOVER")
    }
    const arriveHour = new Date(arrive).getUTCHours()
    const departHour = new Date(departNext).getUTCHours()
    const crossesNight = departNext - arrive > 4 * 3600_000
      && (arriveHour >= cfg.quality.overnightConnectionStartHour || departHour <= cfg.quality.overnightConnectionEndHour)
    if (crossesNight && !flags.includes("OVERNIGHT_CONNECTION")) flags.push("OVERNIGHT_CONNECTION")
    if (flight.segments[i].destination && flight.segments[i + 1].origin
      && flight.segments[i].destination !== flight.segments[i + 1].origin
      && !flags.includes("AIRPORT_CHANGE")) {
      flags.push("AIRPORT_CHANGE")
    }
  }
  // Self-transfer / separate tickets: our providers quote single-ticket
  // itineraries only, so these flags exist in the vocabulary but cannot fire
  // from today's data — carried as schema, never guessed.
  return { flags, dropped: null }
}

// ── The deal score ───────────────────────────────────────────────────────────

export interface ScoredValue {
  dealScore: number
  breakdown: Record<string, number | string>
}

export function scoreCandidate(
  price: number,
  cheapestQualifying: number,
  mix: CabinMix,
  stops: number | null,
  durationMinutes: number | null,
  flags: string[],
  cfg: FareRadarConfig,
): ScoredValue {
  const p = cfg.scoring.penalties
  const priceComponent = price > 0 ? Math.round(100 * cheapestQualifying / price * 10) / 10 : 0
  const breakdown: Record<string, number | string> = { priceComponent, cheapestQualifying, price }
  let score = priceComponent

  const penalize = (name: string, amount: number) => {
    if (amount === 0) return
    score -= amount
    breakdown[name] = -amount
  }
  if (mix === "BUSINESS_UNVERIFIED") penalize("businessUnverified", p.businessUnverified)
  if (mix === "BUSINESS_MIXED") penalize("businessMixed", p.businessMixed)
  if (mix === "PREMIUM_ECONOMY" || mix === "ECONOMY") penalize("nonBusinessResult", p.premiumEconomyAsResult)
  if (stops !== null && stops > 0) penalize("stops", stops * p.perStop)
  if (durationMinutes !== null && durationMinutes > p.durationThresholdHours * 60) {
    const hoursOver = (durationMinutes - p.durationThresholdHours * 60) / 60
    penalize("durationOverThreshold", Math.round(hoursOver * p.durationPerHourOverThreshold * 10) / 10)
  }
  if (flags.includes("LONG_LAYOVER")) penalize("longLayover", p.longLayover)
  if (flags.includes("OVERNIGHT_CONNECTION")) penalize("overnightConnection", p.overnightConnection)
  if (flags.includes("SELF_TRANSFER")) penalize("selfTransfer", p.selfTransfer)
  if (flags.includes("SEPARATE_TICKET")) penalize("separateTicket", p.separateTicket)

  return { dealScore: Math.round(Math.max(0, score) * 10) / 10, breakdown }
}
