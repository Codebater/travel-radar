/**
 * Deal Radar (Phase 8l-a): a READ-ONLY discovery layer over decisions the
 * radar has already made — "what are the best deals already in our data?"
 *
 * Nothing here searches, spends, re-scores or invents a number:
 *   - package cards carry their trip's CURRENT market verdict with the
 *     reasons (including bounded statements) passed through VERBATIM;
 *   - fare cards get their only "deal" evidence from typicalFareFor, which is
 *     maturity-gated — below maturity a card says "cheapest observed", never
 *     "deal", and ROUND_TRIP / ONE_WAY never share a section or a comparison;
 *   - stay and DIY cards surface the scores their own engines stored.
 *
 * The only writes are locator upserts — deterministic local work, the same
 * precedent as /api/offers (offers/assemble.ts). No provider is contacted.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { type DB } from "../db/index.js"
import { candidatesForRun, typicalFareFor, type StoredFareCandidate } from "../fareradar/store.js"
import { type TripType } from "../fareradar/config.js"
import { leadVerdict, type StoredMarketVerdict } from "../market/verdict.js"
import { listTrips, type StoredTrip } from "../trips/store.js"
import { listStayCandidates, type StayCandidateRow } from "../stays/candidates.js"
import { assembleTripOffers, type InspectableOffer, type PackageAlternative } from "../offers/assemble.js"
import {
  buildStayLocator,
  getLocator,
  locatorForSource,
  upsertLocator,
  type StayRateRow,
  type StoredLocator,
} from "../offers/locators.js"
import { freshnessFor, latestVerification, offerStateFor, type Freshness, type OfferState } from "../offers/recheck.js"

// ── Config ───────────────────────────────────────────────────────────────────

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "deal-radar.json")

export interface DealRadarConfig {
  sections: {
    packages: { limit: number; allInclusiveMinNights: number }
    fares: { limit: number; businessFamilyOnly: boolean }
    stays: { limit: number; minScore: number }
    diy: { limit: number; minScore: number }
  }
}

let cached: DealRadarConfig | null = null

export function loadDealRadarConfig(force = false): DealRadarConfig {
  if (cached && !force) return cached
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as DealRadarConfig
  if (!raw.sections) throw new Error('config/deal-radar.json is missing "sections"')
  cached = raw
  return raw
}

// ── Card shapes ──────────────────────────────────────────────────────────────

/** The evidence line of a fare card. "deal" language exists ONLY when the
 *  maturity-gated typical fare produced a number. */
export interface FareEvidence {
  kind: "typical" | "cheapest_observed"
  label: string
  median?: number
  samples?: number
  distinctFetchDays?: number
  percentVsTypical?: number   // negative = below typical
}

export interface FareDealCard {
  candidateId: number
  tripType: TripType
  origin: string
  destination: string
  departureDate: string
  returnDate: string | null
  nights: number | null
  airline: string | null
  airlines: string[]
  stops: number | null
  durationMinutes: number | null
  cabin: string
  cabinMix: string
  cabinMixDetail: string
  qualityFlags: string[]
  priceAmount: number
  priceCurrency: string
  dealScore: number
  evidence: FareEvidence
  locator: StoredLocator | null
  state: OfferState | null
  freshness: Freshness | null
}

export interface FareSection {
  runId: number | null
  windowStart: string | null
  windowEnd: string | null
  cards: FareDealCard[]
}

export interface PackageDealCard {
  tripId: number
  tripKey: string
  origin: string
  destinationAirport: string
  propertyId: string
  propertyName: string | null
  checkIn: string
  checkOut: string
  nights: number
  board: string
  tripScore: number
  /** The trip's lead verdict, reasons VERBATIM — bounded statements included. */
  verdict: StoredMarketVerdict
  bestExact: PackageAlternative | null
  bestClose: PackageAlternative | null
  /**
   * Same discovery (property × origin × destination × nights × board), other
   * stored date windows. Grouping is a PROJECTION for the page — every
   * underlying trip/observation survives untouched inside the variants.
   */
  variants: PackageDealCard[]
}

export interface StayDealCard {
  candidate: StayCandidateRow
  locator: StoredLocator | null
  state: OfferState | null
  freshness: Freshness | null
  /** Same product (property × board × source class × tax basis), other stored
   *  windows — projection only, nothing merged or dropped. */
  variants: StayDealCard[]
}

export interface DiyDealCard {
  tripId: number
  tripKey: string
  origin: string
  destinationAirport: string
  propertyId: string
  propertyName: string | null
  checkIn: string
  checkOut: string
  nights: number
  construction: string
  cabin: string | null
  board: string
  score: number
  cashTotal: { amount: number; currency: string } | null
  /** Named unknowns, verbatim — an absent cost is never zero. */
  unknownCosts: string[]
  reasons: string[]
  flights: InspectableOffer[]
  stays: InspectableOffer[]
  /** Same construction target, other stored date windows — projection only. */
  variants: DiyDealCard[]
}

export interface DealRadarFeed {
  generatedAt: string
  disclaimer: string
  packages: PackageDealCard[]
  faresRoundTrip: FareSection
  faresOneWay: FareSection
  oneWayNote: string
  stays: StayDealCard[]
  diy: DiyDealCard[]
}

// ── Fares ────────────────────────────────────────────────────────────────────

function latestRunIdForTripType(db: DB, tripType: TripType): { id: number; windowStart: string; windowEnd: string } | null {
  const r = db.prepare(`
    SELECT id, window_start, window_end FROM fare_radar_runs
    WHERE finished_at IS NOT NULL AND trip_type = ?
    ORDER BY id DESC LIMIT 1
  `).get(tripType) as { id: number; window_start: string; window_end: string } | undefined
  return r ? { id: r.id, windowStart: r.window_start, windowEnd: r.window_end } : null
}

function fareEvidence(db: DB, c: StoredFareCandidate): FareEvidence {
  const typical = typicalFareFor(db, {
    tripType: c.tripType, origin: c.origin, destination: c.destination,
    nights: c.nights, cabin: c.cabin, currency: c.priceCurrency,
  })
  if (!typical.mature) {
    return {
      kind: "cheapest_observed",
      label: `cheapest observed — typical-fare baseline not yet mature (${typical.reason})`,
    }
  }
  const pct = Math.round((c.priceAmount / typical.median - 1) * 1000) / 10
  return {
    kind: "typical",
    label: pct < 0
      ? `${Math.abs(pct)}% below typical ${c.priceCurrency} ${typical.median} (${typical.samples} obs over ${typical.distinctFetchDays} days)`
      : `${pct}% above typical ${c.priceCurrency} ${typical.median} (${typical.samples} obs over ${typical.distinctFetchDays} days)`,
    median: typical.median,
    samples: typical.samples,
    distinctFetchDays: typical.distinctFetchDays,
    percentVsTypical: pct,
  }
}

function fareSection(db: DB, tripType: TripType, cfg: DealRadarConfig, now: Date): FareSection {
  const run = latestRunIdForTripType(db, tripType)
  if (!run) return { runId: null, windowStart: null, windowEnd: null, cards: [] }
  let candidates = candidatesForRun(db, run.id)   // already cheapest-first
  if (cfg.sections.fares.businessFamilyOnly) {
    candidates = candidates.filter(c => c.cabinMix.startsWith("BUSINESS"))
  }
  const cards = candidates.slice(0, cfg.sections.fares.limit).map((c): FareDealCard => {
    const locator = c.locatorId !== null ? getLocator(db, c.locatorId) : null
    const verification = locator ? latestVerification(db, locator.id) : null
    return {
      candidateId: c.id,
      tripType: c.tripType,
      origin: c.origin, destination: c.destination,
      departureDate: c.departureDate, returnDate: c.returnDate, nights: c.nights,
      airline: c.airline, airlines: c.airlines, stops: c.stops, durationMinutes: c.durationMinutes,
      cabin: c.cabin, cabinMix: c.cabinMix, cabinMixDetail: c.cabinMixDetail,
      qualityFlags: c.qualityFlags,
      priceAmount: c.priceAmount, priceCurrency: c.priceCurrency,
      dealScore: c.dealScore,
      evidence: fareEvidence(db, c),
      locator,
      state: locator ? offerStateFor(verification) : null,
      freshness: locator ? freshnessFor(locator, verification, now) : null,
    }
  })
  return { runId: run.id, windowStart: run.windowStart, windowEnd: run.windowEnd, cards }
}

// ── Packages ─────────────────────────────────────────────────────────────────

function cheapestByComparability(packages: PackageAlternative[], comparability: string): PackageAlternative | null {
  const matching = packages
    .filter(p => p.verdict.comparability === comparability && p.locator.nativePrice !== null)
    .sort((a, b) => (a.locator.nativePrice ?? Infinity) - (b.locator.nativePrice ?? Infinity))
  return matching[0] ?? null
}

function propertyName(db: DB, propertyId: string): string | null {
  const r = db.prepare("SELECT name FROM stay_properties WHERE id = ?").get(propertyId) as { name: string } | undefined
  return r?.name ?? null
}

/**
 * Group near-identical discoveries into one top-level card with variants.
 * The key uses only existing hard identity dimensions — nothing looser — and
 * the projection keeps every grouped card intact inside `variants`.
 */
function groupCards<T>(cards: T[], keyOf: (c: T) => string, better: (a: T, b: T) => number, attach: (primary: T, variants: T[]) => T): T[] {
  const groups = new Map<string, T[]>()
  for (const card of cards) {
    const key = keyOf(card)
    const list = groups.get(key) ?? []
    list.push(card)
    groups.set(key, list)
  }
  return [...groups.values()].map(list => {
    const sorted = [...list].sort(better)
    return attach(sorted[0], sorted.slice(1))
  })
}

function packageSection(db: DB, cfg: DealRadarConfig, now: Date): PackageDealCard[] {
  // Trips ordered by their EXISTING score; a card exists only when the trip
  // has current-batch verdicts (assembleTripOffers reads the newest batch).
  const trips = listTrips(db, { minScore: 0, limit: 30, status: "interesting" })
  const cards: PackageDealCard[] = []
  for (const trip of trips) {
    const bundle = assembleTripOffers(db, trip, now)
    if (bundle.packages.length === 0) continue
    const lead = leadVerdict(bundle.packages.map(p => p.verdict))
    if (!lead) continue
    cards.push({
      tripId: trip.id,
      tripKey: trip.tripKey,
      origin: trip.origin,
      destinationAirport: trip.destinationAirport,
      propertyId: trip.propertyId,
      propertyName: propertyName(db, trip.propertyId),
      checkIn: trip.checkIn, checkOut: trip.checkOut, nights: trip.nights,
      board: trip.board,
      tripScore: trip.score,
      verdict: lead,
      bestExact: cheapestByComparability(bundle.packages, "EXACT_MATCH"),
      bestClose: cheapestByComparability(bundle.packages, "CLOSE_MATCH"),
      variants: [],
    })
  }
  // All-inclusive package DISCOVERY is holiday-length only: shorter AI trips
  // are excluded from this section (projection only — the observations stay,
  // and the trips/market pages still show them). Other boards are untouched.
  const holidayLength = cards.filter(c =>
    c.board !== "all_inclusive" || c.nights >= cfg.sections.packages.allInclusiveMinNights)
  // One discovery per (property × origin × destination × nights × board);
  // the primary is the cheapest best-package price (EXACT preferred), other
  // date windows become its variants.
  const priceOf = (c: PackageDealCard) =>
    c.bestExact?.locator.nativePrice ?? c.bestClose?.locator.nativePrice ?? Infinity
  return groupCards(
    holidayLength,
    c => [c.propertyId, c.origin, c.destinationAirport, c.nights, c.board].join("|"),
    (a, b) => priceOf(a) - priceOf(b) || b.tripScore - a.tripScore,
    (primary, variants) => ({ ...primary, variants }),
  ).slice(0, cfg.sections.packages.limit)
}

// ── Stays ────────────────────────────────────────────────────────────────────

function stayCard(db: DB, candidate: StayCandidateRow, now: Date): StayDealCard {
  // Same locator precedent as offers/assemble.ts: deterministic local build
  // for the candidate's own source observation. No provider contact.
  const row = db.prepare(`
    SELECT o.id, o.provider, o.provider_property_ref, o.property_id, o.rate_source, o.room_name,
           o.room_class, o.board, o.check_in, o.check_out, o.nights, o.adults,
           o.price_amount, o.price_currency, o.fetched_at, p.name AS property_name
    FROM stay_rate_observations o
    JOIN stay_properties p ON p.id = o.property_id
    WHERE o.id = ?
  `).get(candidate.sourceId) as (StayRateRow & { property_name: string }) | undefined
  let locator: StoredLocator | null = null
  if (row) {
    upsertLocator(db, buildStayLocator(row, row.property_name))
    locator = locatorForSource(db, "stay_rate_observations", row.id)
  }
  const verification = locator ? latestVerification(db, locator.id) : null
  return {
    candidate,
    locator,
    state: locator ? offerStateFor(verification) : null,
    freshness: locator ? freshnessFor(locator, verification, now) : null,
    variants: [],
  }
}

// ── The feed ─────────────────────────────────────────────────────────────────

export function buildDealRadarFeed(db: DB, now = new Date()): DealRadarFeed {
  const cfg = loadDealRadarConfig()

  // Fetch a wider slice, group near-identical windows, then apply the
  // section limit to GROUPS — variants keep every underlying row reachable.
  const stayCards = listStayCandidates(db, { minScore: cfg.sections.stays.minScore, limit: cfg.sections.stays.limit * 5 })
    .filter(c => c.status !== "suspicious")
    .map(c => stayCard(db, c, now))
  const stays = groupCards(
    stayCards,
    s => [s.candidate.propertyId, s.candidate.board, s.candidate.sourceClass, s.candidate.taxesFees, s.candidate.priceCurrency].join("|"),
    (a, b) => b.candidate.score - a.candidate.score || a.candidate.nightlyAmount - b.candidate.nightlyAmount,
    (primary, variants) => ({ ...primary, variants }),
  ).slice(0, cfg.sections.stays.limit)

  const diyCards = listTrips(db, { minScore: cfg.sections.diy.minScore, limit: cfg.sections.diy.limit * 5, status: "interesting" })
    .map((trip): DiyDealCard => {
      const bundle = assembleTripOffers(db, trip, now)
      return {
        tripId: trip.id,
        tripKey: trip.tripKey,
        origin: trip.origin,
        destinationAirport: trip.destinationAirport,
        propertyId: trip.propertyId,
        propertyName: propertyName(db, trip.propertyId),
        checkIn: trip.checkIn, checkOut: trip.checkOut, nights: trip.nights,
        construction: trip.construction,
        cabin: trip.cabin,
        board: trip.board,
        score: trip.score,
        cashTotal: trip.cashTotal,
        unknownCosts: trip.unknownCosts,
        reasons: trip.reasons,
        flights: bundle.diy.flights,
        stays: bundle.diy.stays,
        variants: [],
      }
    })
  // Currency discipline: within a group, prefer the cheapest total only when
  // every total shares one currency — otherwise the existing score decides.
  const diy = groupCards(
    diyCards,
    c => [c.propertyId, c.origin, c.destinationAirport, c.nights, c.board, c.construction, c.cabin ?? "-"].join("|"),
    (a, b) => {
      if (a.cashTotal && b.cashTotal && a.cashTotal.currency === b.cashTotal.currency) {
        return a.cashTotal.amount - b.cashTotal.amount || b.score - a.score
      }
      return b.score - a.score
    },
    (primary, variants) => ({ ...primary, variants }),
  ).slice(0, cfg.sections.diy.limit)

  return {
    generatedAt: now.toISOString(),
    disclaimer: "Discovery over this radar's OWN stored observations and decisions — no seller claims, no live searches. "
      + "Verdicts, scores, comparability, confidence and maturity refusals come verbatim from their owning modules. "
      + "Recheck before booking.",
    packages: packageSection(db, cfg, now),
    faresRoundTrip: fareSection(db, "ROUND_TRIP", cfg, now),
    faresOneWay: fareSection(db, "ONE_WAY", cfg, now),
    oneWayNote: "One-way and round-trip fares are different products — they are never compared and a difference between them is never a saving.",
    stays,
    diy,
  }
}
