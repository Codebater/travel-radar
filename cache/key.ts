/**
 * Deterministic cache keys and stable itinerary identity.
 *
 * Both are pure functions of their inputs — the same query always produces the
 * same key, in any process, in any order.
 */

import crypto from "crypto"
import type { CashFlightQuery } from "../providers/cash-flights/types.js"

/**
 * Cache key for a provider search.
 *
 *   PRG:BKK:2026-11-10:2026-11-20:business:1:fast_flights
 *
 * One-way searches use "oneway" rather than an empty segment so that
 * PRG:BKK:2026-11-10::economy:1:x cannot collide with a malformed return date.
 * Every component is normalised and sanitised, so a stray colon in a provider
 * name cannot shift the meaning of later fields.
 */
export function cacheKey(query: CashFlightQuery, provider: string): string {
  const part = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "_")
  return [
    part(query.origin.toUpperCase()),
    part(query.destination.toUpperCase()),
    part(query.departureDate),
    query.returnDate ? part(query.returnDate) : "oneway",
    part(query.cabin),
    String(Math.max(1, Math.trunc(query.adults || 1))),
    part(provider),
  ].join(":")
}

/**
 * Stable identity for an itinerary across providers.
 *
 * Two providers describing the same flights must produce the same hash, so the
 * hash is built only from fields every provider supplies:
 *
 *   route, departure and arrival timestamps, cabin, carriers, stop count.
 *
 * Price is deliberately excluded — two providers disagreeing on the price of
 * one itinerary is exactly the observation we are collecting.
 *
 * Flight numbers are excluded too, even though they identify a flight
 * precisely: fast_flights does not expose them, so including them would mean a
 * SerpAPI result could never match the fast_flights result for the same flight,
 * defeating cross-provider deduplication. They are stored on the row as
 * metadata instead.
 *
 * Arrival time matters. Without it, two same-carrier itineraries leaving at the
 * same minute with the same stop count collapse into one — which cost a real
 * €3,276 Lufthansa option its slot next to a €5,155 one during Phase 2 testing.
 */
export function itineraryHash(input: {
  origin: string
  destination: string
  departureDate: string
  departureTime?: string | null
  arrivalTime?: string | null
  returnDate?: string | null
  cabin: string
  airlines?: string[]
  airline?: string | null
  stops?: number | null
  durationMinutes?: number | null
}): string {
  const airlines = (input.airlines?.length ? input.airlines : [input.airline].filter(Boolean) as string[])
    .map(a => a.trim().toLowerCase())
    .filter(Boolean)
    .sort()

  // Minute-level timestamps; providers do not agree below that.
  const depTime = input.departureTime ? normaliseTime(input.departureTime) : ""
  const arrTime = input.arrivalTime ? normaliseTime(input.arrivalTime) : ""

  const parts = [
    input.origin.toUpperCase(),
    input.destination.toUpperCase(),
    input.departureDate,
    depTime,
    arrTime,
    input.returnDate || "",
    input.cabin.toLowerCase(),
    airlines.join(","),
    input.stops != null ? `s${input.stops}` : "",
    // Only used to separate itineraries that are otherwise indistinguishable
    // because a provider gave no arrival time.
    !arrTime && input.durationMinutes != null ? `d${input.durationMinutes}` : "",
  ]

  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16)
}

/** "2026-11-10T14:55:00" / "2026-11-10 14:55" → "2026-11-10T14:55" */
function normaliseTime(value: string): string {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/)
  return m ? `${m[1]}T${m[2]}:${m[3]}` : value.trim()
}
