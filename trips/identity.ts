/**
 * Durable trip identity — price-free, on the fixed 3-day date grid shared
 * with the stay and notification layers. Re-pricing either component must
 * not mint a new trip; a different construction, cabin, board, room class or
 * mileage program IS a different trip.
 */

import { stayDateFamily } from "../stays/identity.js"
import type { ComposedTrip, FlightSide, StaySide } from "./types.js"

export function tripKey(flight: FlightSide, stay: StaySide, adults: number): string {
  const programs = [...new Set(flight.legs
    .map(l => l.points?.program)
    .filter((p): p is string => Boolean(p)))].sort()
  return [
    flight.origin,
    flight.destinationAirport,
    stay.propertyId,
    stayDateFamily(stay.checkIn),
    `${stay.nights}n`,
    stay.board,
    stay.roomClass ?? "-",
    flight.construction,
    flight.cabin,
    programs.length ? programs.join("+") : "cash",
    `${adults}a`,
  ].join("|")
}

export function reasonsFor(trip: Omit<ComposedTrip, "reasons" | "tripKey">): string[] {
  const reasons: string[] = []
  const f = trip.flight
  const s = trip.stay

  if (f.candidateScore !== null && f.candidateScore >= 70) reasons.push("FLIGHT_CANDIDATE")
  if (f.quality >= 0.6) {
    reasons.push(f.legs.some(l => l.points)
      ? `${f.cabin.toUpperCase()}_AWARD_ANOMALY`
      : `${f.cabin.toUpperCase()}_FARE_EXCEPTIONAL`)
  }
  if (s.quality >= 0.6) reasons.push("STAY_EXCEPTIONAL")
  else if (s.quality >= 0.35) reasons.push("STAY_BELOW_PROPERTY_NORMAL")
  if (s.board === "all_inclusive") reasons.push("ALL_INCLUSIVE")
  if (s.verificationStatus === "verified") reasons.push("VERIFIED_STAY")
  if (s.taxStatus === "included") reasons.push("STAY_TAX_INCLUDED")
  if (trip.dateCompatibility.value >= 0.9) reasons.push("DATES_ALIGN")
  if (trip.tripAbsolute.tier) reasons.push(`TRIP_${trip.tripAbsolute.tier.toUpperCase()}_VALUE`)
  if (s.persistence === "sustained") reasons.push("FLEXIBLE_STAY_WINDOW")
  if (s.refundable === true) reasons.push("REFUNDABLE_STAY")
  for (const flag of trip.complexity.flags) reasons.push(`COMPLEXITY_${flag.toUpperCase()}`)
  if (trip.cost.unknownCosts.length > 0) reasons.push("UNKNOWN_COSTS_REMAIN")
  return reasons
}
