/**
 * Offer assembly: one trip → its inspectable constructions.
 *
 * Package alternatives come from the trip's CURRENT market verdicts (newest
 * batch only); DIY components come from the trip's own provenance links.
 * Building locators is deterministic local work — no provider is contacted.
 */

import { type DB } from "../db/index.js"
import { currentMarketVerdictsForTrip, type StoredMarketVerdict } from "../market/verdict.js"
import { getPackageObservation } from "../packages/store.js"
import { listTrips, type StoredTrip } from "../trips/store.js"
import {
  buildFlightLocator,
  buildPackageLocator,
  buildStayLocator,
  locatorForSource,
  upsertLocator,
  type FlightPriceRow,
  type StayRateRow,
  type StoredLocator,
} from "./locators.js"
import { freshnessFor, latestVerification, offerStateFor, type Freshness, type OfferState, type StoredVerification } from "./recheck.js"

export interface InspectableOffer {
  locator: StoredLocator
  state: OfferState
  verification: StoredVerification | null
  freshness: Freshness
}

export interface PackageAlternative extends InspectableOffer {
  verdict: StoredMarketVerdict
  hotelName: string | null
  observationId: number
}

export interface TripOfferBundle {
  tripId: number
  tripKey: string
  packages: PackageAlternative[]
  diy: {
    flights: InspectableOffer[]
    stays: InspectableOffer[]
    unknownCosts: string[]
    cashTotal: { amount: number; currency: string } | null
  }
}

function inspect(db: DB, locator: StoredLocator, now: Date): InspectableOffer {
  const verification = latestVerification(db, locator.id)
  return {
    locator,
    verification,
    state: offerStateFor(verification),
    freshness: freshnessFor(locator, verification, now),
  }
}

/** Build (or refresh) the locator for one package observation and inspect it. */
function inspectPackage(db: DB, observationId: number, now: Date): InspectableOffer | null {
  const obs = getPackageObservation(db, observationId)
  if (!obs) return null
  const id = upsertLocator(db, buildPackageLocator(obs))
  const locator = locatorForSource(db, "package_offer_observations", obs.id)
  if (!locator) return null
  void id
  return inspect(db, locator, now)
}

export function assembleTripOffers(db: DB, trip: StoredTrip, now = new Date()): TripOfferBundle {
  // ── Packages: the trip's current comparable alternatives ──────────────────
  const verdicts = currentMarketVerdictsForTrip(db, trip.id)
    .filter(v => v.comparability !== "NOT_COMPARABLE")
  const packages: PackageAlternative[] = []
  for (const verdict of verdicts) {
    const inspected = inspectPackage(db, verdict.packageObservationId, now)
    if (!inspected) continue
    const obs = getPackageObservation(db, verdict.packageObservationId)
    packages.push({
      ...inspected,
      verdict,
      hotelName: obs?.hotelName ?? null,
      observationId: verdict.packageObservationId,
    })
  }

  // ── DIY flight components (provenance links, verbatim) ────────────────────
  const flights: InspectableOffer[] = []
  const flightRefs = Array.isArray(trip.flightProvenance) ? trip.flightProvenance as { table: string; id: number }[] : []
  for (const ref of flightRefs) {
    if (ref.table !== "flight_prices") continue           // award rows have no cash link semantics yet
    const row = db.prepare(`
      SELECT id, provider, airline, flight_numbers, origin, destination, departure_date,
             return_date, cabin, adults, price_amount, price_currency, booking_url, fetched_at
      FROM flight_prices WHERE id = ?
    `).get(ref.id) as FlightPriceRow | undefined
    if (!row) continue
    upsertLocator(db, buildFlightLocator(row))
    const locator = locatorForSource(db, "flight_prices", row.id)
    if (locator) flights.push(inspect(db, locator, now))
  }

  // ── DIY stay components: latest observation per provider among provenance ──
  const stays: InspectableOffer[] = []
  const stayProv = trip.stayProvenance as { observationIds?: number[] } | undefined
  const observationIds = Array.isArray(stayProv?.observationIds) ? stayProv!.observationIds! : []
  if (observationIds.length > 0) {
    const placeholders = observationIds.map(() => "?").join(",")
    const rows = db.prepare(`
      SELECT o.id, o.provider, o.provider_property_ref, o.property_id, o.rate_source, o.room_name,
             o.room_class, o.board, o.check_in, o.check_out, o.nights, o.adults,
             o.price_amount, o.price_currency, o.fetched_at, p.name AS property_name
      FROM stay_rate_observations o
      JOIN stay_properties p ON p.id = o.property_id
      WHERE o.id IN (${placeholders})
      ORDER BY o.id DESC
    `).all(...observationIds) as (StayRateRow & { property_name: string })[]
    const seenProviders = new Set<string>()
    for (const row of rows) {
      if (seenProviders.has(row.provider)) continue        // latest per provider
      seenProviders.add(row.provider)
      upsertLocator(db, buildStayLocator(row, row.property_name))
      const locator = locatorForSource(db, "stay_rate_observations", row.id)
      if (locator) stays.push(inspect(db, locator, now))
    }
  }

  return {
    tripId: trip.id,
    tripKey: trip.tripKey,
    packages,
    diy: {
      flights,
      stays,
      unknownCosts: trip.unknownCosts,
      cashTotal: trip.cashTotal,
    },
  }
}

export function assembleAllTripOffers(db: DB, opts: { limit?: number } = {}): TripOfferBundle[] {
  const trips = listTrips(db, { minScore: 0, limit: opts.limit ?? 30, status: "interesting" })
  const now = new Date()
  return trips.map(trip => assembleTripOffers(db, trip, now))
}
