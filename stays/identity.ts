/**
 * Derived identity for stay opportunities.
 *
 * The observation row id IS durable here (append-only, never re-minted), so
 * candidates upsert on source_id. What still needs derivation is the
 * OPPORTUNITY: "Lily Beach, mid-November week, all-inclusive villa, retail" is
 * one thing however many observations see it. The key is price-free — a
 * re-priced opportunity must still be recognisable — and uses the flight
 * radar's fixed date grid, not any churning cluster boundary.
 */

import type { StayNightsBucket } from "./config.js"

/** Fixed 3-day grid, same construction as notifications/identity.ts. */
export function stayDateFamily(checkIn: string, windowDays = 3): string {
  const epochDays = Math.floor(Date.parse(`${checkIn}T00:00:00Z`) / 86_400_000)
  return `d${Math.floor(epochDays / windowDays) * windowDays}`
}

export function nightsBucketLabel(nights: number, buckets: StayNightsBucket[]): string {
  for (const b of buckets) {
    if (nights <= b.maxNights) return b.label
  }
  return "extended"
}

export interface StayOpportunityInput {
  propertyId: string
  checkIn: string
  nights: number
  board: string
  roomClass: string | null
  sourceClass: string
  currency: string
}

/** The opportunity, without its price. */
export function stayOpportunityKey(input: StayOpportunityInput, buckets: StayNightsBucket[]): string {
  return [
    input.propertyId,
    stayDateFamily(input.checkIn),
    nightsBucketLabel(input.nights, buckets),
    input.board,
    input.roomClass ?? "-",
    input.sourceClass,
    input.currency,
  ].join("|")
}
