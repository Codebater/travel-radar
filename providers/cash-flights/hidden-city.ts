/**
 * Hidden-city engine, on top of the cash provider layer.
 *
 * Phase 2 left this as a Python script that called SerpAPI directly with its
 * own JSON counter — a pathway that could spend quota invisibly, outside the
 * budget guard, the reserve, the cache and provider_usage. This port closes
 * that: every price here comes through searchCashFlights, so it hits the free
 * provider first, shares the cash cache, respects the SerpAPI budget and
 * reserve, and lands in the same accounting as everything else. Repeating a
 * hidden-city search inside the cache TTL costs zero provider calls.
 *
 * The algorithm is the Python engine's, unchanged: price the direct flight,
 * then price flights to cities BEYOND the target and keep itineraries that
 * connect through the target for less than the direct fare.
 *
 * These are informational comparisons, not ordinary tickets. Every result
 * carries hiddenCity=true and explicit warnings; nothing here optimises for
 * evading airline enforcement.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { searchCashFlights, type CashSearchOptions } from "./index.js"
import type { NormalizedCashFlight } from "./types.js"

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const HUB_FILE = path.join(ROOT, "data", "hub-connections.json")

interface HubData {
  [iata: string]: { name: string; hub_airlines: string[]; beyond_cities: string[] }
}

export interface HiddenCityOpportunity {
  origin: string
  /** Where the traveller actually deplanes. */
  realDestination: string
  /** Where the ticket is booked to. */
  ticketedDestination: string
  directPrice: number
  hiddenCityPrice: number
  currency: string
  savings: number
  savingsPercent: number
  airlines: string[]
  flightNumbers: string[]
  departureTime: string | null
  arrivalAtLayover: string | null
  totalDurationMinutes: number | null
  stops: number
  riskLevel: "low" | "medium" | "high"
  warnings: string[]
  bookingUrl: string
  provider: string
  verificationLevel: string
  hiddenCity: true
}

export interface HiddenCityOutcome {
  opportunities: HiddenCityOpportunity[]
  searchesRun: number
  callsSpent: number
  notes: string[]
}

/** Warnings attached to every opportunity — ported from the Python engine. */
const BASE_WARNINGS = [
  "Book one-way only — later segments of a return would be cancelled",
  "No checked bags: they are routed to the ticketed destination",
  "Do not attach a frequent-flyer number you care about",
  "If the flight is cancelled or rerouted, rebooking targets the ticketed destination",
  "Airlines' contracts of carriage prohibit this; repeated use risks account action",
]

const LARGE_HUBS = new Set(["DEN", "ORD", "ATL", "LAX", "JFK", "DFW", "SEA", "SFO", "IAH", "MIA", "PHX", "MSP", "FRA", "AMS", "CDG", "IST", "VIE", "LHR"])
const STRICT_AIRLINES = ["United", "Delta", "American", "Lufthansa"]

function assessRisk(target: string, airlines: string[]): { level: HiddenCityOpportunity["riskLevel"]; warnings: string[] } {
  const warnings = [...BASE_WARNINGS]
  let level: HiddenCityOpportunity["riskLevel"] = LARGE_HUBS.has(target) ? "low" : "high"
  if (!LARGE_HUBS.has(target)) warnings.push("Smaller airport — deplaning mid-itinerary is more conspicuous")

  for (const airline of airlines) {
    if (STRICT_AIRLINES.some(strict => airline.includes(strict))) {
      if (level === "low") level = "medium"
      warnings.push(`${airline} is known to actively pursue hidden-city ticketing`)
      break
    }
  }
  return { level, warnings }
}

function loadHubs(): HubData {
  try {
    return JSON.parse(fs.readFileSync(HUB_FILE, "utf-8"))
  } catch {
    return {}
  }
}

function maxBeyondDefault(): number {
  const raw = Number(process.env.HIDDEN_CITY_MAX_BEYOND)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 10) : 5
}

function cheapest(flights: NormalizedCashFlight[]): NormalizedCashFlight | null {
  const priced = flights.filter(f => f.price.amount > 0)
  return priced.length ? priced.reduce((a, b) => (b.price.amount < a.price.amount ? b : a)) : null
}

/** Does this itinerary connect through `target` before its final stop? */
function connectsThrough(flight: NormalizedCashFlight, target: string): { arrivalAtTarget: string | null } | null {
  const segments = flight.segments
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i]!.destination === target) {
      return { arrivalAtTarget: segments[i]!.arrivalTime }
    }
  }
  return null
}

export interface HiddenCityQuery {
  origin: string
  destination: string
  departureDate: string
  currency: string
  maxBeyond?: number
  minSavings?: number
}

/**
 * Find hidden-city opportunities. Every price flows through searchCashFlights:
 * cache first, free provider next, SerpAPI only under its budget guard.
 */
export async function searchHiddenCity(
  query: HiddenCityQuery,
  options: CashSearchOptions = {},
): Promise<HiddenCityOutcome> {
  const notes: string[] = []
  const opportunities: HiddenCityOpportunity[] = []
  const maxBeyond = query.maxBeyond ?? maxBeyondDefault()
  const minSavings = query.minSavings ?? 30
  let searchesRun = 0
  let callsSpent = 0

  const cashOptions: CashSearchOptions = { ...options, source: options.source ?? "api" }

  // 1) Direct price — one cash search (cached like any other).
  const direct = await searchCashFlights({
    origin: query.origin, destination: query.destination, departureDate: query.departureDate,
    returnDate: null, cabin: "economy", adults: 1, currency: query.currency,
  }, cashOptions)
  searchesRun++
  callsSpent += direct.callsSpent

  const directCheapest = cheapest(direct.flights)
  if (!directCheapest) {
    notes.push(`no direct price available for ${query.origin}→${query.destination}; cannot compare`)
    return { opportunities, searchesRun, callsSpent, notes }
  }
  const directPrice = directCheapest.price.amount

  // 2) Beyond cities for the target, from the hub graph.
  const hubs = loadHubs()
  let beyond = hubs[query.destination]?.beyond_cities ?? []
  if (beyond.length === 0) {
    notes.push(`${query.destination} is not in the hub graph; using large-airport fallback`)
    beyond = ["LAX", "SFO", "SEA", "JFK", "ORD", "ATL", "DFW", "MIA"]
  }
  beyond = beyond.filter(c => c !== query.origin && c !== query.destination).slice(0, maxBeyond)

  // 3) Price each beyond city and keep itineraries connecting through target.
  for (const beyondCity of beyond) {
    const outcome = await searchCashFlights({
      origin: query.origin, destination: beyondCity, departureDate: query.departureDate,
      returnDate: null, cabin: "economy", adults: 1, currency: query.currency,
    }, cashOptions)
    searchesRun++
    callsSpent += outcome.callsSpent

    for (const flight of outcome.flights) {
      const via = connectsThrough(flight, query.destination)
      if (!via) continue
      if (flight.price.currency !== directCheapest.price.currency) continue  // never compare across currencies

      const savings = directPrice - flight.price.amount
      if (savings < minSavings) continue

      const { level, warnings } = assessRisk(query.destination, flight.airlines)
      opportunities.push({
        origin: query.origin,
        realDestination: query.destination,
        ticketedDestination: beyondCity,
        directPrice,
        hiddenCityPrice: flight.price.amount,
        currency: flight.price.currency,
        savings: Math.round(savings * 100) / 100,
        savingsPercent: Math.round((savings / directPrice) * 1000) / 10,
        airlines: flight.airlines,
        flightNumbers: flight.flightNumbers,
        departureTime: flight.departureTime,
        arrivalAtLayover: via.arrivalAtTarget,
        totalDurationMinutes: flight.durationMinutes,
        stops: flight.stops ?? 1,
        riskLevel: level,
        warnings,
        bookingUrl: flight.bookingUrl,
        provider: flight.provider,
        verificationLevel: flight.verificationLevel,
        hiddenCity: true,
      })
    }
  }

  opportunities.sort((a, b) => b.savings - a.savings)
  return { opportunities, searchesRun, callsSpent, notes }
}
