/**
 * Package ↔ synthetic-trip comparability.
 *
 * The single rule above all others: two fundamentally different products must
 * never be compared as though they were equivalent. A 7-night AI economy
 * package is NOT an alternative to a 5-night AI business trip, whatever the
 * totals say. Every level therefore records WHY it was assigned — the caps
 * that demoted it and the confirmations that held.
 *
 * Levels (ordered):
 *   EXACT_MATCH             same hotel, occupancy, board, cabin, nights,
 *                           check-in day; package tax-inclusive; transfer
 *                           status known
 *   CLOSE_MATCH             same product, one recorded relaxation (check-in
 *                           shifted within the 3-day date family, nights ±1,
 *                           transfer status unknown, room class differs)
 *   DESTINATION_LEVEL_ONLY  market context only (different hotel in the same
 *                           destination, different date family, nights out of
 *                           tolerance) — never a per-trip monetary verdict
 *   NOT_COMPARABLE          a hard dimension differs: board, cabin,
 *                           occupancy, origin, or identity is too weak
 */

import { stayDateFamily } from "../stays/identity.js"
import type { StoredTrip } from "../trips/store.js"
import { loadPackagesConfig } from "./config.js"
import type { StoredPackageObservation } from "./store.js"

export type ComparabilityLevel =
  | "EXACT_MATCH"
  | "CLOSE_MATCH"
  | "DESTINATION_LEVEL_ONLY"
  | "NOT_COMPARABLE"

const LEVEL_RANK: Record<ComparabilityLevel, number> = {
  EXACT_MATCH: 3, CLOSE_MATCH: 2, DESTINATION_LEVEL_ONLY: 1, NOT_COMPARABLE: 0,
}

export interface ComparabilityAssessment {
  level: ComparabilityLevel
  /** Every reason that shaped the level — demotions AND load-bearing holds. */
  reasons: string[]
}

export function assessComparability(
  trip: StoredTrip, pkg: StoredPackageObservation,
): ComparabilityAssessment {
  const cfg = loadPackagesConfig().comparability
  const reasons: string[] = []
  let level: ComparabilityLevel = "EXACT_MATCH"
  const capTo = (target: ComparabilityLevel, reason: string) => {
    reasons.push(reason)
    if (LEVEL_RANK[target] < LEVEL_RANK[level]) level = target
  }

  // ── Hard dimensions: a mismatch is NOT_COMPARABLE, full stop ──────────────

  if (trip.board === "unknown" || pkg.board === "unknown") {
    return { level: "NOT_COMPARABLE", reasons: ["BOARD_UNKNOWN: a product with an unknown board basis compares to nothing"] }
  }
  if (trip.board !== pkg.board) {
    return { level: "NOT_COMPARABLE", reasons: [`BOARD_MISMATCH: trip is ${trip.board}, package is ${pkg.board} — AI never compares to HB/BB/RO`] }
  }
  const tripCabin = trip.cabin ?? "unknown"
  if (tripCabin === "unknown" || pkg.cabin === "unknown") {
    return { level: "NOT_COMPARABLE", reasons: ["CABIN_UNKNOWN: flight cabin unestablished on one side"] }
  }
  if (tripCabin !== pkg.cabin) {
    return { level: "NOT_COMPARABLE", reasons: [`CABIN_MISMATCH: trip flies ${tripCabin}, package flies ${pkg.cabin}`] }
  }
  if (trip.adults !== pkg.adults || pkg.children !== 0) {
    return { level: "NOT_COMPARABLE", reasons: [`OCCUPANCY_MISMATCH: trip is ${trip.adults} adults, package is ${pkg.adults} adults + ${pkg.children} children`] }
  }
  if (trip.origin !== pkg.origin) {
    return { level: "NOT_COMPARABLE", reasons: [`ORIGIN_MISMATCH: trip departs ${trip.origin}, package departs ${pkg.origin}`] }
  }

  // ── Hotel identity: strong enough for hotel-specific comparison? ──────────

  if (pkg.propertyId === null || pkg.propertyId !== trip.propertyId) {
    if (pkg.propertyId !== null && pkg.propertyId !== trip.propertyId) {
      // A different KNOWN hotel is market context in the same destination.
      if (pkg.destinationAirport && pkg.destinationAirport === trip.destinationAirport) {
        return {
          level: "DESTINATION_LEVEL_ONLY",
          reasons: [`DIFFERENT_HOTEL: package hotel ${pkg.propertyId} ≠ trip hotel ${trip.propertyId} — market context only`],
        }
      }
      return { level: "NOT_COMPARABLE", reasons: ["DIFFERENT_HOTEL_DIFFERENT_DESTINATION"] }
    }
    // Unmapped hotel: identity is too weak for hotel-specific claims.
    if (pkg.destinationAirport && pkg.destinationAirport === trip.destinationAirport) {
      return {
        level: "DESTINATION_LEVEL_ONLY",
        reasons: ["HOTEL_IDENTITY_UNMAPPED: package hotel is not linked to the registry — destination context only"],
      }
    }
    return { level: "NOT_COMPARABLE", reasons: ["HOTEL_IDENTITY_UNMAPPED_AND_DESTINATION_MISMATCH"] }
  }
  reasons.push(`SAME_HOTEL: ${trip.propertyId} on both sides (registry-linked identity)`)

  // ── Nights: the comparable unit is HOTEL nights ───────────────────────────

  const nightsDelta = Math.abs(trip.nights - pkg.nights)
  if (nightsDelta === 0) {
    reasons.push(`SAME_NIGHTS: ${trip.nights} hotel nights on both sides`)
  } else if (nightsDelta <= cfg.nightsToleranceCloseMatch) {
    capTo("CLOSE_MATCH",
      `NIGHTS_DIFFER: trip ${trip.nights}n vs package ${pkg.nights}n (within ±${cfg.nightsToleranceCloseMatch} tolerance — context, never a monetary verdict)`)
  } else {
    capTo("DESTINATION_LEVEL_ONLY",
      `NIGHTS_MISMATCH: trip ${trip.nights}n vs package ${pkg.nights}n — different products`)
  }

  // ── Dates: same day, same 3-day family, or seasonal context only ──────────

  if (trip.checkIn === pkg.checkIn) {
    reasons.push(`SAME_CHECKIN: ${trip.checkIn}`)
  } else if (stayDateFamily(trip.checkIn, cfg.dateFamilyWindowDays) === stayDateFamily(pkg.checkIn, cfg.dateFamilyWindowDays)) {
    capTo("CLOSE_MATCH", `CHECKIN_SHIFTED_SAME_DATE_FAMILY: trip ${trip.checkIn} vs package ${pkg.checkIn}`)
  } else {
    capTo("DESTINATION_LEVEL_ONLY",
      `DATE_FAMILY_MISMATCH: trip ${trip.checkIn} vs package ${pkg.checkIn} — seasonal context only`)
  }

  // ── Inclusions and softer dimensions ──────────────────────────────────────

  if (pkg.transfer === "unknown") {
    capTo("CLOSE_MATCH", "TRANSFER_STATUS_UNKNOWN: package does not state transfer inclusion")
  } else {
    reasons.push(`TRANSFER_${pkg.transfer.toUpperCase()}: package states transfer status`)
  }
  if (pkg.taxesFees !== "included") {
    capTo("CLOSE_MATCH", `PACKAGE_TAX_STATUS_${pkg.taxesFees.toUpperCase()}: package total not confirmed tax-inclusive`)
  }
  if (trip.roomClass && pkg.roomClass && trip.roomClass !== pkg.roomClass) {
    capTo("CLOSE_MATCH", `ROOM_CLASS_DIFFERS: trip ${trip.roomClass} vs package ${pkg.roomClass}`)
  } else if (!trip.roomClass || !pkg.roomClass || pkg.roomClass === "unknown") {
    reasons.push("ROOM_COMPARABILITY_UNVERIFIED: room class not established on both sides")
  }

  return { level, reasons }
}

/** Reasons that mark a nights relaxation — monetary verdicts refuse these. */
export function hasNightsRelaxation(assessment: ComparabilityAssessment): boolean {
  return assessment.reasons.some(r => r.startsWith("NIGHTS_DIFFER") || r.startsWith("NIGHTS_MISMATCH"))
}
