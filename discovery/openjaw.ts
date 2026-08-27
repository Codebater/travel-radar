/**
 * §8 - open jaw: fly out of Prague, come back into Vienna. Or into Bangkok and
 * out of Phuket. Or both at once.
 *
 * ASSEMBLING an open jaw costs nothing: it is two one-way observations added
 * together, so this module is pure SQL and arithmetic. No provider is called
 * here and no budget is spent. What is NOT free is having the legs to add up,
 * which is why discovery now collects them deliberately (§4) instead of living
 * off whatever the fixed observer happened to leave behind.
 *
 * Four rules keep it honest:
 *
 *   - legs must be genuinely one-way observations, never halves of a return
 *     fare, because half a round trip is not a purchasable ticket;
 *   - each leg keeps its OWN price, provider and timestamp. Nothing here ever
 *     presents the pair as a single round trip quoted by one provider, because
 *     it is not one, and buying it means buying two tickets;
 *   - the comparison is against the best comparable ROUND TRIP, since that is
 *     the trip an open jaw actually competes with. Where no comparable round
 *     trip has been observed the saving is null - never zero, never invented;
 *   - a pairing has to be a trip somebody would want. Cross-city pairings must
 *     be configured to exist at all, so two cheap one-ways between unrelated
 *     cities cannot become a "deal" by coincidence.
 */

import type { DB } from "../db/index.js"
import {
  loadDiscoveryConfig, openJawPairsFor, homeTransferFor, amountFor, groupForDestination,
  type DiscoveryConfig, type DestinationPairRule,
} from "./config.js"
import type { OpenJawOption, OpenJawLeg } from "./types.js"

interface LegRow {
  id: number
  origin: string
  destination: string
  departure_date: string
  departure_time: string | null
  price_amount: number
  price_currency: string
  provider: string
  provider_confidence: string
  verification_level: string
  airline: string | null
  stops: number | null
  duration_minutes: number | null
  baggage: string | null
  itinerary_hash: string
  fetched_at: string
  cabin: string
}

const LEG_COLUMNS = `
  id, origin, destination, departure_date, departure_time,
  price_amount, price_currency, provider, provider_confidence, verification_level,
  airline, stops, duration_minutes, baggage, itinerary_hash, fetched_at, cabin
`

/**
 * The cheapest one-way observation per (route, departure date) at or before
 * `asOf` - and it is THE cheapest ROW, not a synthetic blend of one.
 *
 * Mixing MIN(price) with MAX(fetched_at) in a single GROUP BY forfeits the
 * bare-column guarantee, so the provider and timestamp came from an arbitrary
 * row: a 300 USD fare was once reported as having come from the provider that
 * quoted 900, at a time when it did not exist. In a module whose entire job is
 * provenance, that is worse than no answer.
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
    SELECT ${LEG_COLUMNS}
    FROM flight_prices f
    WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
      AND return_date IS NULL
      AND departure_date >= ? AND departure_date <= ?
      AND fetched_at <= ? AND fetched_at >= ?
      AND id = (
        SELECT id FROM flight_prices g
        WHERE g.origin = f.origin AND g.destination = f.destination
          AND g.cabin = f.cabin AND g.price_currency = f.price_currency
          AND g.return_date IS NULL AND g.departure_date = f.departure_date
          AND g.fetched_at <= ? AND g.fetched_at >= ?
        ORDER BY g.price_amount ASC, g.fetched_at DESC, g.id ASC LIMIT 1
      )
    ORDER BY departure_date
  `).all(
    origin.toUpperCase(), destination.toUpperCase(), cabin, currency,
    window.from, window.to, asOf, since,
    asOf, since,
  ) as LegRow[]
}

export interface ComparatorRow {
  priceId: number
  price: number
  currency: string
  origin: string
  destination: string
  departureDate: string
  returnDate: string
  nights: number
  provider: string
  observedAt: string
}

/**
 * §6 - the best comparable ordinary round trip: the trip this open jaw is
 * competing with, and the only honest thing to measure a saving against.
 *
 * "Comparable" is enforced, not assumed. A 21-night round trip is not the
 * comparator for a 7-night open jaw, so the trip length has to match within
 * tolerance. That makes comparators scarcer, and scarcer is correct: the
 * alternative is a saving computed against a different trip.
 *
 * The whole row is selected by ordering rather than MIN() with bare columns,
 * so the price shown and the observation it came from are the same row.
 */
export function bestComparableRoundTrip(
  db: DB,
  origin: string,
  destinations: string[],
  cabin: string,
  currency: string,
  asOf: string,
  window: { from: string; to: string },
  maxAgeDays: number,
  nights: number,
  toleranceDays: number,
): ComparatorRow | null {
  const since = new Date(Date.parse(asOf) - maxAgeDays * 86_400_000).toISOString()
  const codes = [...new Set(destinations.map(d => d.toUpperCase()))]
  if (codes.length === 0) return null
  const placeholders = codes.map(() => "?").join(", ")

  const row = db.prepare(`
    SELECT ${LEG_COLUMNS}, return_date
    FROM flight_prices
    WHERE origin = ? AND destination IN (${placeholders})
      AND cabin = ? AND price_currency = ?
      AND return_date IS NOT NULL
      AND departure_date >= ? AND departure_date <= ?
      AND fetched_at <= ? AND fetched_at >= ?
      AND ABS(julianday(return_date) - julianday(departure_date) - ?) <= ?
    ORDER BY price_amount ASC, fetched_at DESC, id ASC
    LIMIT 1
  `).get(
    origin.toUpperCase(), ...codes, cabin, currency,
    window.from, window.to, asOf, since,
    nights, toleranceDays,
  ) as (LegRow & { return_date: string }) | undefined

  if (!row) return null
  return {
    priceId: row.id,
    price: row.price_amount,
    currency: row.price_currency,
    origin: row.origin,
    destination: row.destination,
    departureDate: row.departure_date,
    returnDate: row.return_date,
    nights: daysBetween(row.departure_date, row.return_date),
    provider: row.provider,
    observedAt: row.fetched_at,
  }
}

export interface OpenJawSearchOptions {
  cabin: string
  currency: string
  /** The moment the search is made FROM. Each combination narrows this to its own legs. */
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

function toLeg(row: LegRow): OpenJawLeg {
  return {
    priceId: row.id,
    origin: row.origin,
    destination: row.destination,
    departureDate: row.departure_date,
    departureTime: row.departure_time,
    price: row.price_amount,
    currency: row.price_currency,
    provider: row.provider,
    providerConfidence: row.provider_confidence,
    verificationLevel: row.verification_level,
    airline: row.airline,
    stops: row.stops,
    durationMinutes: row.duration_minutes,
    baggage: row.baggage,
    itineraryHash: row.itinerary_hash,
    observedAt: row.fetched_at,
    cabin: row.cabin,
  }
}

/**
 * §7/§9 - what the two fares do not say.
 *
 * Money first: a cross-city pairing means paying to get between the two
 * destination cities, and landing at the home airport you did not leave from
 * means paying to get home. Both are real costs, both are added to the fares,
 * so the trip is never made to look cheaper than it is.
 *
 * Then inconvenience, which money does not capture: two separate tickets with
 * nothing connecting them, two different sellers, an internal flight to catch,
 * and two prices that may have been observed weeks apart.
 */
function assessFriction(
  outbound: LegRow,
  inbound: LegRow,
  pair: DestinationPairRule,
  currency: string,
  config: DiscoveryConfig,
): {
  friction: number
  reasons: string[]
  transferCost: number
  destinationTransferCost: number
  homeTransferCost: number
  homeTransfer: { mode: string; hours: number } | null
  mixedProvider: boolean
  legAgeSpreadDays: number
} {
  const p = config.openJaw.penalties
  const reasons: string[] = []
  let friction = 0

  // Always true of an open jaw assembled from two one-ways: nothing connects
  // the tickets, so a delay on one is not the other seller's problem, and bags
  // are not through-checked between them.
  friction += p.separateTickets ?? 0
  reasons.push("two separate one-way tickets - nothing connects them, and bags are not through-checked")

  const mixedProvider = outbound.provider !== inbound.provider
  if (mixedProvider) {
    friction += p.mixedProvider ?? 0
    reasons.push(`legs come from different sellers (${outbound.provider} / ${inbound.provider})`)
  }

  let destinationTransferCost = 0
  if (pair.transfer && pair.arrive !== pair.depart) {
    destinationTransferCost = amountFor(pair.transfer.typicalCost, currency)
    friction += (p.perHourOfDestinationTransfer ?? 0) * pair.transfer.hours
    if (pair.transfer.mode === "flight") {
      friction += p.destinationTransferByFlight ?? 0
      reasons.push(
        `getting from ${pair.arrive} to ${pair.depart} means another flight ` +
        `(${pair.transfer.hours}h, about ${destinationTransferCost} ${currency}) - a third ticket, and its own risk`,
      )
    } else {
      reasons.push(
        `${pair.transfer.hours}h ${pair.transfer.mode} from ${pair.arrive} to ${pair.depart}, ` +
        `about ${destinationTransferCost} ${currency}`,
      )
    }
  }

  let homeTransferCost = 0
  let homeTransfer: { mode: string; hours: number } | null = null
  if (outbound.origin !== inbound.destination) {
    const link = homeTransferFor(inbound.destination, outbound.origin, config)
    if (link) {
      homeTransferCost = amountFor(link.typicalCost, currency)
      homeTransfer = { mode: link.mode, hours: link.hours }
      friction += (p.perHourOfHomeReturnTransfer ?? 0) * link.hours
      reasons.push(
        `lands at ${inbound.destination}, not ${outbound.origin}: ${link.hours}h ${link.mode} home, ` +
        `about ${homeTransferCost} ${currency}`,
      )
    } else {
      // An unconfigured home link is not a free one. Charging for the unknown
      // rather than assuming zero is the only safe direction to be wrong in.
      friction += p.unlistedHomeTransfer ?? 0
      reasons.push(
        `lands at ${inbound.destination} rather than ${outbound.origin}, and no way home is ` +
        `configured between them - the cost of that leg is unknown`,
      )
    }
  }

  // Two prices observed a month apart are not two prices you can buy today.
  const legAgeSpreadDays = Math.abs(
    Date.parse(outbound.fetched_at) - Date.parse(inbound.fetched_at),
  ) / 86_400_000
  if (legAgeSpreadDays >= 1) {
    friction += (p.perDayOfLegAgeSpread ?? 0) * legAgeSpreadDays
    reasons.push(`the two legs were observed ${Math.round(legAgeSpreadDays)} days apart`)
  }

  return {
    friction: Math.max(0, Math.min(1, Math.round(friction * 1000) / 1000)),
    reasons,
    transferCost: Math.round((destinationTransferCost + homeTransferCost) * 100) / 100,
    destinationTransferCost,
    homeTransferCost,
    homeTransfer,
    mixedProvider,
    legAgeSpreadDays: Math.round(legAgeSpreadDays * 10) / 10,
  }
}

/** §9 - is the SHAPE of this trip sensible, separately from its price? */
function assessConvenience(
  nights: number,
  outbound: LegRow,
  inbound: LegRow,
  tripLengths: number[],
): { convenience: number; detail: string } {
  const wanted = tripLengths.length > 0 ? tripLengths : [7, 10, 14]
  const closest = wanted.reduce(
    (best, n) => Math.abs(n - nights) < Math.abs(best - nights) ? n : best, wanted[0]!,
  )
  const drift = Math.abs(closest - nights)
  const lengthFit = drift <= 1 ? 1 : drift <= 3 ? 0.85 : drift <= 6 ? 0.65 : 0.45

  const stops = [outbound.stops, inbound.stops]
  const known = stops.filter((s): s is number => s !== null)
  const directness = known.length === 0
    ? 0.9
    : known.every(s => s === 0) ? 1
    : known.every(s => s <= 1) ? 0.85
    : 0.65

  return {
    convenience: Math.round(lengthFit * directness * 1000) / 1000,
    detail:
      `${nights} nights against a wanted ${closest}` +
      (known.length === 0 ? ", stops unknown" : `, ${known.join(" and ")} stop(s)`),
  }
}

/**
 * Find open-jaw combinations arriving at one destination, across the
 * configured home pairs and destination pairings. Best first.
 */
export function findOpenJaws(
  db: DB,
  destination: string,
  options: OpenJawSearchOptions,
  config: DiscoveryConfig = loadDiscoveryConfig(),
): OpenJawOption[] {
  if (!config.openJaw.enabled) return []
  const maxAge = options.maxAgeDays ?? config.openJaw.maxLegAgeDays ?? 45
  const tolerance = options.tripLengthToleranceDays ?? 2
  const arrive = destination.toUpperCase()
  const group = groupForDestination(arrive, config)
  const pairs = openJawPairsFor(arrive, config, group?.key ?? null)
  const comparatorCache = new Map<string, ComparatorRow | null>()
  const out: OpenJawOption[] = []

  for (const [outboundOriginRaw, inboundDestinationRaw] of config.openJaw.originPairs) {
    const outboundOrigin = outboundOriginRaw.toUpperCase()
    const inboundDestination = inboundDestinationRaw.toUpperCase()

    for (const pair of pairs) {
      // Leaving from the airport you come back to AND flying in and out of the
      // same city is not an open jaw at either end - it is a round trip, and it
      // belongs to the ordinary engine.
      if (outboundOrigin === inboundDestination && pair.arrive === pair.depart) continue

      const outbounds = oneWayLegs(
        db, outboundOrigin, pair.arrive, options.cabin, options.currency,
        options.asOf, options.window, maxAge,
      )
      if (outbounds.length === 0) continue

      // The return leg departs the destination, so its window extends past the
      // outbound window by the longest trip length being considered.
      const maxNights = Math.max(...options.tripLengths, 0)
      const inbounds = oneWayLegs(
        db, pair.depart, inboundDestination, options.cabin, options.currency,
        options.asOf,
        { from: options.window.from, to: addDaysIso(options.window.to, maxNights + tolerance) },
        maxAge,
      )
      if (inbounds.length === 0) continue

      const forThisPair: OpenJawOption[] = []

      for (const outbound of outbounds) {
        for (const nights of options.tripLengths) {
          const wanted = addDaysIso(outbound.departure_date, nights)
          const inbound = inbounds.find(
            i => Math.abs(daysBetween(i.departure_date, wanted)) <= tolerance,
          )
          if (!inbound) continue

          // §Y the combination is only knowable once BOTH legs have been seen,
          // so that is the moment everything about it is judged from - the
          // round trip it is compared against included.
          const asOf = outbound.fetched_at > inbound.fetched_at
            ? outbound.fetched_at : inbound.fetched_at
          const actualNights = daysBetween(outbound.departure_date, inbound.departure_date)
          const totalPrice = Math.round((outbound.price_amount + inbound.price_amount) * 100) / 100

          const comparatorKey = [
            outboundOrigin, pair.arrive, pair.depart, options.cabin, options.currency,
            asOf, actualNights,
          ].join("|")
          let comparator = comparatorCache.get(comparatorKey)
          if (comparator === undefined) {
            comparator = bestComparableRoundTrip(
              db, outboundOrigin,
              // The trip you would otherwise have taken is a normal return to
              // one of the two cities. The CHEAPEST is the honest comparison:
              // picking the dearer one would flatter the open jaw.
              pair.arrive === pair.depart ? [pair.arrive] : [pair.arrive, pair.depart],
              options.cabin, options.currency, asOf, options.window, maxAge,
              actualNights, tolerance,
            )
            comparatorCache.set(comparatorKey, comparator)
          }

          const friction = assessFriction(outbound, inbound, pair, options.currency, config)
          const trueTripCost = Math.round((totalPrice + friction.transferCost) * 100) / 100
          const saving = comparator === null
            ? null
            : Math.round((comparator.price - totalPrice) * 100) / 100
          const netSaving = comparator === null
            ? null
            : Math.round((comparator.price - trueTripCost) * 100) / 100
          const savingPercent = comparator === null || comparator.price <= 0 || saving === null
            ? null
            : Math.round((saving / comparator.price) * 1000) / 10
          const netSavingPercent = comparator === null || comparator.price <= 0 || netSaving === null
            ? null
            : Math.round((netSaving / comparator.price) * 1000) / 10

          const convenience = assessConvenience(actualNights, outbound, inbound, options.tripLengths)

          // An open jaw that saves nothing is just a more awkward round trip.
          const qualifies = savingPercent !== null
            && savingPercent >= config.openJaw.minSavingPercent
            && friction.friction <= config.openJaw.maxAcceptableFriction

          forThisPair.push({
            qualifies,
            asOf,
            outbound: toLeg(outbound),
            inbound: toLeg(inbound),
            destinationPair: {
              group: pair.group || (group?.key ?? null),
              arrive: pair.arrive,
              depart: pair.depart,
              usefulness: pair.usefulness,
              transfer: pair.transfer,
              note: pair.note ?? null,
            },
            totalPrice,
            transferCost: friction.transferCost,
            destinationTransferCost: friction.destinationTransferCost,
            homeTransferCost: friction.homeTransferCost,
            homeTransfer: friction.homeTransfer,
            trueTripCost,
            currency: options.currency,
            cabin: options.cabin,
            tripLengthNights: actualNights,
            comparator,
            comparableRoundTrip: comparator?.price ?? null,
            saving,
            savingPercent,
            netSaving,
            netSavingPercent,
            friction: friction.friction,
            frictionReasons: friction.reasons,
            mixedProvider: friction.mixedProvider,
            legAgeSpreadDays: friction.legAgeSpreadDays,
            convenience: convenience.convenience,
            convenienceDetail: convenience.detail,
            note: qualifies
              ? `out of ${outbound.origin}, back into ${inbound.destination}` +
                (pair.arrive === pair.depart ? "" : `, ${pair.arrive} in and ${pair.depart} out`)
              : `out of ${outbound.origin}, back into ${inbound.destination} - rejected: ` +
                (savingPercent === null
                  ? "no comparable round trip has been observed to measure it against"
                  : friction.friction > config.openJaw.maxAcceptableFriction
                    ? `friction ${friction.friction} is above the ${config.openJaw.maxAcceptableFriction} ceiling`
                    : `only ${savingPercent}% against the best comparable round trip`),
          })
        }
      }

      // Capped per pairing, best first: one interesting combination and its
      // near-identical neighbours must not crowd out every other pairing.
      forThisPair.sort(compareOptions)
      out.push(...forThisPair.slice(0, Math.max(1, config.openJaw.maxCombinationsPerPair ?? 6)))
    }
  }

  return out
    .filter(o => o.qualifies || options.includeNonQualifying === true)
    .sort(compareOptions)
}

/** Best first: qualifying before rejected, then by saving, then by price. */
function compareOptions(a: OpenJawOption, b: OpenJawOption): number {
  if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1
  const aSaving = a.savingPercent ?? -Infinity
  const bSaving = b.savingPercent ?? -Infinity
  if (aSaving !== bSaving) return bSaving - aSaving
  return a.totalPrice - b.totalPrice
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
