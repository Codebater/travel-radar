/**
 * §3/§4 - what a trip from a positioning airport really costs, and what that
 * cost does not capture.
 *
 * A €430 Budapest fare next to a €790 Vienna one is not a €360 saving. It is
 * a €360 saving MINUS the train, minus the hotel when the departure is early,
 * and minus the fact that a missed connection on a separate ticket is entirely
 * your problem. Two numbers come out of here and they are deliberately
 * separate:
 *
 *   trueTripStartCost - the honest money figure, with nothing hidden
 *   penalty           - the inconvenience money cannot express, 0..1
 *
 * Collapsing them into one "adjusted price" would let a big enough discount
 * bury an overnight bus at 4am. The scorer applies the penalty as its own
 * component so a reader can always see what was subtracted and why.
 */

import type { DB } from "../db/index.js"
import { loadDiscoveryConfig, amountFor, type DiscoveryConfig, type PositioningLeg } from "./config.js"
import type { PositioningAssessment } from "./types.js"

/**
 * The cheapest recently OBSERVED fare for a route, used both for the
 * positioning leg (when it is a flight) and for the home-airport comparison.
 * Only observations at or before `asOf` count — the same no-look-ahead rule
 * the anomaly baseline obeys.
 */
export function observedFare(
  db: DB,
  origin: string,
  destination: string,
  cabin: string,
  currency: string,
  asOf: string,
  opts: { maxAgeDays?: number; departureDate?: string; tripType?: "oneway" | "return" } = {},
): { price: number; observations: number; ageDays: number } | null {
  const maxAge = opts.maxAgeDays ?? 45
  const since = new Date(Date.parse(asOf) - maxAge * 86_400_000).toISOString()
  const where: string[] = [
    "origin = ?", "destination = ?", "cabin = ?", "price_currency = ?",
    "fetched_at <= ?", "fetched_at >= ?",
  ]
  const params: any[] = [
    origin.toUpperCase(), destination.toUpperCase(), cabin, currency, asOf, since,
  ]
  if (opts.departureDate) { where.push("departure_date = ?"); params.push(opts.departureDate) }
  if (opts.tripType) { where.push("(return_date IS NULL) = ?"); params.push(opts.tripType === "oneway" ? 1 : 0) }

  const row = db.prepare(`
    SELECT MIN(price_amount) price, COUNT(*) observations, MAX(fetched_at) newest
    FROM flight_prices WHERE ${where.join(" AND ")}
  `).get(...params) as { price: number | null; observations: number; newest: string | null }

  if (!row || row.price === null || row.observations === 0) return null
  return {
    price: row.price,
    observations: row.observations,
    ageDays: row.newest
      ? Math.round(((Date.parse(asOf) - Date.parse(row.newest)) / 86_400_000) * 10) / 10
      : maxAge,
  }
}

function departureHour(departureTime: string | null | undefined): number | null {
  if (!departureTime) return null
  const m = departureTime.match(/[T ](\d{2}):(\d{2})/)
  return m ? Number(m[1]) : null
}

/**
 * Assess a fare that departs from a positioning airport.
 *
 * `comparableHomeFare` is looked up from observations rather than passed in, so
 * the comparison is against what this radar has actually seen leaving from home
 * — not against a number somebody assumed.
 */
export function assessPositioning(
  db: DB,
  input: {
    positioningAirport: string
    destination: string
    departureDate: string
    departureTime?: string | null
    cabin: string
    mainFare: number
    currency: string
    asOf: string
    tripType?: "oneway" | "return"
    hasCheckedBaggage?: boolean
  },
  config: DiscoveryConfig = loadDiscoveryConfig(),
): PositioningAssessment {
  const airport = input.positioningAirport.toUpperCase()
  const leg: PositioningLeg | undefined = config.homeRegion.positioningLegs[airport]
  const p = config.positioning

  // Not a positioning airport at all: the trip simply starts at home.
  if (!leg) {
    return {
      required: false,
      positioningAirport: null, fromAirport: null, mode: null,
      mainFare: input.mainFare,
      positioningCost: 0, overnightCost: 0,
      trueTripStartCost: input.mainFare,
      currency: input.currency,
      costBasis: "ground-fixed",
      transferHours: 0,
      overnightRequired: false,
      separateTicket: false,
      penalty: 0,
      penaltyReasons: [],
      comparableHomeFare: null, savingVsHome: null, savingPercent: null,
      worthwhile: true,
      note: "departs from a home airport; no positioning needed",
    }
  }

  // ── The money ────────────────────────────────────────────────────────────
  let positioningCost = amountFor(leg.typicalCost, input.currency)
  let costBasis: PositioningAssessment["costBasis"] = leg.mode === "flight" ? "estimated" : "ground-fixed"

  if (leg.mode === "flight") {
    // A positioning FLIGHT has a real market price, so prefer a fare this
    // radar has actually seen over the configured guess. Both directions are
    // needed for a return trip; the one-way observation is doubled only when
    // no return observation exists, and that is recorded as an estimate.
    const observed = observedFare(db, leg.from, airport, "economy", input.currency, input.asOf, {
      tripType: input.tripType === "oneway" ? "oneway" : "return",
    })
    if (observed) {
      positioningCost = observed.price
      costBasis = "observed"
    }
  }

  const hour = departureHour(input.departureTime)
  const earlyDeparture = hour !== null && hour < 9
  // A long ground transfer to an early departure means sleeping there. The
  // hotel is part of the trip's cost, not a footnote.
  const overnightRequired =
    leg.hours >= p.overnight.requiredWhenLegHours && (hour === null || earlyDeparture)
  const overnightCost = overnightRequired ? amountFor(p.overnight.cost, input.currency) : 0

  const trueTripStartCost = Math.round((input.mainFare + positioningCost + overnightCost) * 100) / 100

  // ── The inconvenience ────────────────────────────────────────────────────
  const reasons: string[] = []
  let penalty = 0
  const add = (key: string, label: string) => {
    const value = p.penalties[key] ?? 0
    if (value > 0) { penalty += value; reasons.push(label) }
  }

  // Always true for positioning: the long-haul and the way there are two
  // contracts, and nobody rebooks you when the first one slips.
  add("separateTicket", `separate ticket (${leg.mode} to ${airport})`)
  if (overnightRequired) add("overnightRequired", "overnight stay required before departure")
  if (leg.mode === "flight") add("positioningByFlight", "positioning leg is itself a flight")
  if (input.hasCheckedBaggage) add("checkedBaggageRecheck", "checked baggage must be re-checked")
  if (earlyDeparture && !overnightRequired) add("earlyDeparture", "early departure from a non-home airport")
  if (leg.from !== airport) add("airportChange", `departs ${airport}, not ${leg.from}`)
  if (costBasis === "estimated") add("estimatedCostBasis", "positioning fare is an estimate, not an observed price")

  const groundPenalty = (p.penalties.perHourOfGroundTransfer ?? 0) * leg.hours
  if (groundPenalty > 0) {
    penalty += groundPenalty
    reasons.push(`${leg.hours}h transfer from ${leg.from}`)
  }
  penalty = Math.min(1, Math.round(penalty * 1000) / 1000)

  // ── Is it actually worth it? ─────────────────────────────────────────────
  const home = bestHomeFare(db, input.destination, input.cabin, input.currency, input.asOf, config, {
    tripType: input.tripType,
  })
  const savingVsHome = home === null ? null : Math.round((home - trueTripStartCost) * 100) / 100
  const savingPercent = home === null || home <= 0 || savingVsHome === null
    ? null
    : Math.round((savingVsHome / home) * 1000) / 10

  const minAbsolute = amountFor(p.minSavingAbsolute, input.currency)
  const worthwhile =
    penalty <= p.maxAcceptablePenalty &&
    savingVsHome !== null &&
    savingVsHome >= minAbsolute &&
    (savingPercent ?? 0) >= p.minSavingPercent

  return {
    required: true,
    positioningAirport: airport,
    fromAirport: leg.from,
    mode: leg.mode,
    mainFare: input.mainFare,
    positioningCost: Math.round(positioningCost * 100) / 100,
    overnightCost,
    trueTripStartCost,
    currency: input.currency,
    costBasis,
    transferHours: leg.hours,
    overnightRequired,
    separateTicket: true,
    penalty,
    penaltyReasons: reasons,
    comparableHomeFare: home,
    savingVsHome,
    savingPercent,
    worthwhile,
    note: home === null
      ? "no comparable home-airport fare observed yet, so the saving is unknown"
      : `${trueTripStartCost} ${input.currency} true start cost vs ${home} from home`,
  }
}

/**
 * The cheapest observed fare to this destination from ANY primary airport.
 * That is the number a positioning trip has to beat — not the most expensive
 * home fare, and not a fare to a different airport in the same country.
 */
export function bestHomeFare(
  db: DB,
  destination: string,
  cabin: string,
  currency: string,
  asOf: string,
  config: DiscoveryConfig = loadDiscoveryConfig(),
  opts: { tripType?: "oneway" | "return"; maxAgeDays?: number } = {},
): number | null {
  let best: number | null = null
  for (const origin of config.homeRegion.primary) {
    const fare = observedFare(db, origin, destination, cabin, currency, asOf, {
      maxAgeDays: opts.maxAgeDays ?? 45,
      tripType: opts.tripType,
    })
    if (fare && (best === null || fare.price < best)) best = fare.price
  }
  return best
}
