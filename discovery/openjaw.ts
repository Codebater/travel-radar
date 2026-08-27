/**
 * §8 - open jaw: fly out of Prague, come back into Vienna.
 *
 * The cheap insight here is that discovering an open jaw costs NOTHING. Since
 * Phase 5 the radar collects one-way cash observations alongside return ones,
 * so every open-jaw combination is already sitting in flight_prices waiting to
 * be added up. This module is pure SQL and arithmetic: no provider is called,
 * no budget is spent, and a live search only ever happens later, for a
 * combination that already looks worth confirming.
 *
 * Two rules keep it honest:
 *   - legs must be genuinely one-way observations, never halves of a return
 *     fare, because half a round trip is not a purchasable ticket;
 *   - the comparison is against the best same-airport ROUND TRIP, since that
 *     is the trip an open jaw actually competes with.
 */

import type { DB } from "../db/index.js"
import { loadDiscoveryConfig, type DiscoveryConfig } from "./config.js"
import type { OpenJawOption } from "./types.js"

interface LegRow {
  origin: string
  destination: string
  departure_date: string
  price_amount: number
  price_currency: string
  provider: string
  fetched_at: string
  cabin: string
}

/**
 * Cheapest one-way observation per (route, departure date) at or before
 * `asOf`. MIN() over a group rather than a per-row scan: an open jaw is built
 * from the best available leg, not from an arbitrary one.
 */
function oneWayLegs(
  db: DB,
  origin: string,
  destination: string,
  cabin: string,
  currency: string,
  asOf: string,
  window: { from: string; to: string },
  maxAgeDays: number,
): LegRow[] {
  const since = new Date(Date.parse(asOf) - maxAgeDays * 86_400_000).toISOString()
  return db.prepare(`
    SELECT origin, destination, departure_date, MIN(price_amount) price_amount,
           price_currency, provider, MAX(fetched_at) fetched_at, cabin
    FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
      AND return_date IS NULL
      AND departure_date >= ? AND departure_date <= ?
      AND fetched_at <= ? AND fetched_at >= ?
    GROUP BY departure_date
    ORDER BY departure_date
  `).all(
    origin.toUpperCase(), destination.toUpperCase(), cabin, currency,
    window.from, window.to, asOf, since,
  ) as LegRow[]
}

/** Best same-airport round trip for the comparison, from observations. */
function bestRoundTrip(
  db: DB,
  origin: string,
  destination: string,
  cabin: string,
  currency: string,
  asOf: string,
  window: { from: string; to: string },
  maxAgeDays: number,
): number | null {
  const since = new Date(Date.parse(asOf) - maxAgeDays * 86_400_000).toISOString()
  const row = db.prepare(`
    SELECT MIN(price_amount) price FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
      AND return_date IS NOT NULL
      AND departure_date >= ? AND departure_date <= ?
      AND fetched_at <= ? AND fetched_at >= ?
  `).get(
    origin.toUpperCase(), destination.toUpperCase(), cabin, currency,
    window.from, window.to, asOf, since,
  ) as { price: number | null }
  return row?.price ?? null
}

export interface OpenJawSearchOptions {
  cabin: string
  currency: string
  asOf: string
  /** Departure window to consider, inclusive. */
  window: { from: string; to: string }
  tripLengths: number[]
  /** How stale a leg observation may be before it stops counting. */
  maxAgeDays?: number
  /** Tolerance when matching the return leg to a wanted trip length. */
  tripLengthToleranceDays?: number
  /**
   * Return combinations that do NOT clear the saving floor as well.
   *
   * "No open jaw found" is an unhelpful answer on its own: it could mean no
   * legs are stored, or that the arithmetic was done and came out against the
   * idea. Showing the best rejected combination makes the difference visible.
   */
  includeNonQualifying?: boolean
}

/**
 * Find open-jaw combinations for one destination across the configured origin
 * pairs. Returns every combination that clears the configured saving floor,
 * best first.
 */
export function findOpenJaws(
  db: DB,
  destination: string,
  options: OpenJawSearchOptions,
  config: DiscoveryConfig = loadDiscoveryConfig(),
): OpenJawOption[] {
  if (!config.openJaw.enabled) return []
  const maxAge = options.maxAgeDays ?? 45
  const tolerance = options.tripLengthToleranceDays ?? 2
  const out: OpenJawOption[] = []

  for (const [outboundOrigin, inboundDestination] of config.openJaw.originPairs) {
    // A "pair" where you come home to the airport you left from is just a
    // round trip; it belongs to the ordinary engine, not here.
    if (outboundOrigin === inboundDestination) continue

    const outbounds = oneWayLegs(
      db, outboundOrigin, destination, options.cabin, options.currency,
      options.asOf, options.window, maxAge,
    )
    if (outbounds.length === 0) continue

    // The return leg departs the destination, so its window extends past the
    // outbound window by the longest trip length being considered.
    const maxNights = Math.max(...options.tripLengths, 0)
    const inbounds = oneWayLegs(
      db, destination, inboundDestination, options.cabin, options.currency,
      options.asOf,
      { from: options.window.from, to: addDaysIso(options.window.to, maxNights + tolerance) },
      maxAge,
    )
    if (inbounds.length === 0) continue

    for (const outbound of outbounds) {
      for (const nights of options.tripLengths) {
        const wanted = addDaysIso(outbound.departure_date, nights)
        const inbound = inbounds.find(
          i => Math.abs(daysBetween(i.departure_date, wanted)) <= tolerance,
        )
        if (!inbound) continue

        const totalPrice = Math.round((outbound.price_amount + inbound.price_amount) * 100) / 100
        const comparable = bestRoundTrip(
          db, outboundOrigin, destination, options.cabin, options.currency,
          options.asOf, options.window, maxAge,
        )
        const saving = comparable === null ? null : Math.round((comparable - totalPrice) * 100) / 100
        const savingPercent = comparable === null || comparable <= 0 || saving === null
          ? null
          : Math.round((saving / comparable) * 1000) / 10

        // An open jaw that saves nothing is just a more awkward round trip.
        const qualifies = savingPercent !== null && savingPercent >= config.openJaw.minSavingPercent
        if (!qualifies && !options.includeNonQualifying) continue

        out.push({
          qualifies,
          outbound: {
            origin: outbound.origin, destination: outbound.destination,
            departureDate: outbound.departure_date,
            price: outbound.price_amount, currency: outbound.price_currency,
            provider: outbound.provider, observedAt: outbound.fetched_at,
          },
          inbound: {
            origin: inbound.origin, destination: inbound.destination,
            departureDate: inbound.departure_date,
            price: inbound.price_amount, currency: inbound.price_currency,
            provider: inbound.provider, observedAt: inbound.fetched_at,
          },
          totalPrice,
          currency: options.currency,
          cabin: options.cabin,
          tripLengthNights: daysBetween(outbound.departure_date, inbound.departure_date),
          comparableRoundTrip: comparable,
          saving,
          savingPercent,
          note: qualifies
            ? `out of ${outbound.origin}, back into ${inbound.destination}`
            : `out of ${outbound.origin}, back into ${inbound.destination} - rejected: ` +
              `${savingPercent === null ? "no round trip to compare against" : `only ${savingPercent}% against the best round trip`}`,
        })
      }
    }
  }

  return out.sort((a, b) => (b.savingPercent ?? 0) - (a.savingPercent ?? 0))
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  )
}
