/**
 * Redemption comparison: for one physical itinerary, line up every loyalty
 * program that can book it and identify which is best by which measure.
 *
 * This is where PROGRAM ≠ AIRLINE pays off. One Austrian-operated VIE→BKK
 * business itinerary might carry:
 *
 *   Aeroplan       70,000 pts + $80    ← lowest surcharge
 *   LifeMiles      63,000 pts + $95
 *   Miles & More   56,000 pts + $420   ← cheapest points
 *
 * Which is "best" depends on the measure — cheapest points, lowest taxes,
 * best CPP, or the one the user can actually afford from balances and
 * transfers. This module reports each explicitly and never blends them.
 */

import type { ValueScoredFlight } from "./value-engine.js"

export interface RedemptionOption {
  /** Index of the flight in the DashboardResults.flights array. */
  flightIndex: number
  loyaltyProgram: string
  loyaltyProgramName: string | null
  points: number
  taxes: number
  taxesCurrency: string
  realCpp: number | null
  cppBasis: string | null
  canBook: boolean
  pointsShortfall: number | null
  /** "direct balance" / "transfer 55,000 Chase UR → …" summary, when bookable. */
  fundingSummary: string | null
  provider: string
  verificationLevel: string | null
  availableSeats: number | null
}

export interface RedemptionComparison {
  itineraryHash: string
  origin: string
  destination: string
  departureDate: string | null
  cabin: string
  airlines: string[]
  flightNumbers: string[]
  optionCount: number
  options: RedemptionOption[]
  /** Program keys, per measure. Explicitly separate — they often disagree. */
  cheapestPoints: string | null
  lowestTaxes: string | null
  bestCpp: string | null
  /** Best CPP among options the balances can actually cover. */
  bestAffordable: string | null
  /** How the best affordable option would be funded. */
  bestTransferRoute: string | null
}

function toOption(f: ValueScoredFlight, flightIndex: number): RedemptionOption {
  return {
    flightIndex,
    loyaltyProgram: f.pointsProgram || "unknown",
    loyaltyProgramName: f.loyaltyProgramName ?? null,
    points: f.points || 0,
    taxes: f.taxes || 0,
    taxesCurrency: f.currency || "USD",
    realCpp: f.realCpp,
    cppBasis: f.cppBasis,
    canBook: f.canAfford,
    pointsShortfall: f.pointsShortfall,
    fundingSummary: f.canAfford ? f.affordDetails || null : null,
    provider: f.provider || f.source,
    verificationLevel: f.verificationLevel ?? null,
    availableSeats: f.availableSeats,
  }
}

/**
 * Group scored award flights by physical itinerary and rank the programs.
 * Flights without an itineraryHash (pre-Phase-3 payloads) are skipped.
 */
export function buildRedemptionComparisons(flights: ValueScoredFlight[]): RedemptionComparison[] {
  const groups = new Map<string, { flight: ValueScoredFlight; index: number }[]>()

  flights.forEach((f, index) => {
    if (f.type !== "award" || !f.itineraryHash || !f.points) return
    if (!groups.has(f.itineraryHash)) groups.set(f.itineraryHash, [])
    groups.get(f.itineraryHash)!.push({ flight: f, index })
  })

  const comparisons: RedemptionComparison[] = []

  for (const [hash, members] of groups) {
    // One option per program: a program pricing the same flight twice keeps its
    // cheaper entry. Different programs are never collapsed.
    const byProgram = new Map<string, { flight: ValueScoredFlight; index: number }>()
    for (const m of members) {
      const program = m.flight.pointsProgram || "unknown"
      const existing = byProgram.get(program)
      if (!existing || (m.flight.points || Infinity) < (existing.flight.points || Infinity)) {
        byProgram.set(program, m)
      }
    }

    const options = [...byProgram.values()]
      .map(m => toOption(m.flight, m.index))
      .sort((a, b) => a.points - b.points)

    const first = members[0]!.flight
    const cheapestPoints = options[0]?.loyaltyProgram ?? null

    // Lowest taxes only within one currency; a mixed-currency group gets no winner.
    const currencies = new Set(options.map(o => o.taxesCurrency))
    const lowestTaxes = currencies.size === 1
      ? [...options].sort((a, b) => a.taxes - b.taxes)[0]?.loyaltyProgram ?? null
      : null

    const withCpp = options.filter(o => o.realCpp !== null)
    const bestCpp = withCpp.length
      ? [...withCpp].sort((a, b) => (b.realCpp || 0) - (a.realCpp || 0))[0]!.loyaltyProgram
      : null

    const affordable = options.filter(o => o.canBook)
    const bestAffordableOption = affordable.length
      ? [...affordable].sort((a, b) => (b.realCpp || 0) - (a.realCpp || 0))[0]!
      : null

    comparisons.push({
      itineraryHash: hash,
      origin: first.origin,
      destination: first.destination,
      departureDate: first.travelDate ?? null,
      cabin: first.cabinClass,
      airlines: first.operatingAirlines,
      flightNumbers: first.flightNumbers,
      optionCount: options.length,
      options,
      cheapestPoints,
      lowestTaxes,
      bestCpp,
      bestAffordable: bestAffordableOption?.loyaltyProgram ?? null,
      bestTransferRoute: bestAffordableOption?.fundingSummary ?? null,
    })
  }

  // Multi-program itineraries first — they are the interesting ones.
  return comparisons.sort((a, b) => b.optionCount - a.optionCount)
}
