/**
 * The stay OPPORTUNITY: the trip-ready object a future Trip Composer (and a
 * human) consumes. One opportunity = one window family + its best decision +
 * everything needed to act on it: property and airports, the usable
 * flexible-date range, product identity, honest pricing with tax status,
 * per-source prices kept SEPARATE (a meta sighting, a retail room and a
 * verified panel are different facts, never one number), cancellation
 * evidence, and the full score decomposition.
 *
 * Read-only assembly over stored decisions — builds nothing, spends nothing.
 */

import type { DB } from "../db/index.js"
import { getStayCandidate } from "./candidates.js"
import { listStayWindows, type StayWindowRow } from "./windows.js"
import { getStayProperty } from "./registry.js"

export interface StaySourcePrice {
  provider: string
  sourceClass: string
  rateSource: string | null
  verificationLevel: string
  nightly: number
  beforeTaxNightly: number | null
  taxStatus: string
  board: string
  roomName: string | null
  checkIn: string
  fetchedAt: string
}

export interface StayOpportunity {
  windowKey: string
  property: {
    id: string
    name: string
    destinationGroup: string
    country: string
    nearestAirports: string[]
    luxuryTier: string
  }
  /** The best member's concrete stay. */
  checkIn: string
  checkOut: string
  nights: number
  /** The usable flexibility around it, measured, not assumed. */
  flexWindow: {
    earliestCheckIn: string
    latestCheckIn: string
    distinctCheckIns: number
    spanDays: number
    persistence: string
    nightsOptions: number[]
  }
  product: {
    roomClass: string | null
    roomName: string | null
    board: string
    boardSource: string
    sourceClass: string
  }
  pricing: {
    nightly: number
    cheapestNightlyInWindow: number | null
    stayTotal: number | null
    currency: string
    taxStatus: string
  }
  /** Every source's own number, separately. Never collapsed. */
  sourcePrices: StaySourcePrice[]
  evidence: {
    verificationStatus: string
    verificationGateReason: string | null
    confirmationState: string
    baselineConfidence: string
    sampleSize: number
    percentBelowMedian: number | null
    observedMedian: number | null
    cancellation: { refundable: boolean | null; deadline: string | null; source: string } | null
    crossSource: Record<string, unknown>
  }
  scores: {
    final: number
    relative: number | null
    absoluteValue: number | null
    evidence: number | null
    actionability: number | null
  }
  reasons: string[]
}

export function buildStayOpportunities(
  db: DB,
  opts: { limit?: number; minScore?: number } = {},
): StayOpportunity[] {
  const windows = listStayWindows(db, { limit: opts.limit ?? 15 })
    .filter(w => w.bestScore >= (opts.minScore ?? 35))

  const opportunities: StayOpportunity[] = []
  for (const w of windows) {
    const best = w.bestCandidateId !== null ? getStayCandidate(db, w.bestCandidateId) : null
    if (!best) continue
    const property = getStayProperty(db, w.propertyId)
    if (!property) continue

    opportunities.push({
      windowKey: w.windowKey,
      property: {
        id: property.id,
        name: property.name,
        destinationGroup: property.destinationGroup,
        country: property.country,
        nearestAirports: property.nearestAirports,
        luxuryTier: property.luxuryTier,
      },
      checkIn: best.checkIn,
      checkOut: best.checkOut,
      nights: best.nights,
      flexWindow: {
        earliestCheckIn: w.firstCheckIn,
        latestCheckIn: w.lastCheckIn,
        distinctCheckIns: w.distinctCheckIns,
        spanDays: w.spanDays,
        persistence: w.persistence,
        nightsOptions: w.nightsMin === w.nightsMax ? [w.nightsMin] : [w.nightsMin, w.nightsMax],
      },
      product: {
        roomClass: best.roomClass,
        roomName: best.roomName,
        board: best.board,
        boardSource: best.boardSource,
        sourceClass: best.sourceClass,
      },
      pricing: {
        nightly: best.nightlyAmount,
        cheapestNightlyInWindow: w.cheapestNightly,
        stayTotal: best.stayTotal,
        currency: best.priceCurrency,
        taxStatus: best.taxesFees,
      },
      sourcePrices: gatherSourcePrices(db, w),
      evidence: {
        verificationStatus: best.verificationStatus,
        verificationGateReason: best.verificationGateReason,
        confirmationState: best.confirmationState,
        baselineConfidence: best.baselineConfidence,
        sampleSize: best.sampleSize,
        percentBelowMedian: best.percentBelowMedian,
        observedMedian: best.observedMedian,
        cancellation: gatherCancellation(db, w),
        crossSource: (best.evidence.crossSource as Record<string, unknown>) ?? {},
      },
      scores: {
        final: best.score,
        relative: best.relativeScore,
        absoluteValue: best.absoluteValueScore,
        evidence: best.evidenceScore,
        actionability: best.actionabilityScore,
      },
      reasons: best.reasons,
    })
  }
  return opportunities
}

/**
 * The cheapest observation per (provider, source class, tax status) inside
 * the window's date range — each source's own answer, labelled, separate.
 */
function gatherSourcePrices(db: DB, w: StayWindowRow): StaySourcePrice[] {
  const rows = db.prepare(`
    SELECT o.provider, o.source_class, o.rate_source, o.verification_level,
           o.price_amount, o.price_basis, o.nights, o.before_tax_nightly,
           o.taxes_fees, o.board, o.room_name, o.check_in, o.fetched_at
    FROM stay_rate_observations o
    WHERE o.property_id = ? AND o.price_currency = ?
      AND o.sanity = 'ok' AND o.price_basis != 'lead_in'
      AND o.check_in >= ? AND o.check_in <= ?
    ORDER BY o.price_amount ASC
  `).all(w.propertyId, w.currency, w.firstCheckIn, w.lastCheckIn) as {
    provider: string; source_class: string; rate_source: string | null
    verification_level: string; price_amount: number; price_basis: string
    nights: number; before_tax_nightly: number | null; taxes_fees: string
    board: string; room_name: string | null; check_in: string; fetched_at: string
  }[]

  const seen = new Set<string>()
  const prices: StaySourcePrice[] = []
  for (const r of rows) {
    const key = `${r.provider}|${r.source_class}|${r.taxes_fees}`
    if (seen.has(key)) continue
    seen.add(key)
    const nightly = r.price_basis === "nightly_room" ? r.price_amount
      : r.nights > 0 ? Math.round((r.price_amount / r.nights) * 100) / 100 : null
    if (nightly === null) continue
    prices.push({
      provider: r.provider,
      sourceClass: r.source_class,
      rateSource: r.rate_source,
      verificationLevel: r.verification_level,
      nightly,
      beforeTaxNightly: r.before_tax_nightly,
      taxStatus: r.taxes_fees,
      board: r.board,
      roomName: r.room_name,
      checkIn: r.check_in,
      fetchedAt: r.fetched_at,
    })
  }
  return prices
}

/** The best cancellation evidence in the window: retail rows carry it. */
function gatherCancellation(db: DB, w: StayWindowRow): StayOpportunity["evidence"]["cancellation"] {
  const row = db.prepare(`
    SELECT refundable, cancellation_deadline, provider
    FROM stay_rate_observations
    WHERE property_id = ? AND check_in >= ? AND check_in <= ?
      AND refundable IS NOT NULL AND sanity = 'ok'
    ORDER BY refundable DESC, cancellation_deadline DESC
    LIMIT 1
  `).get(w.propertyId, w.firstCheckIn, w.lastCheckIn) as
    { refundable: number; cancellation_deadline: string | null; provider: string } | undefined
  if (!row) return null
  return {
    refundable: row.refundable === 1,
    deadline: row.cancellation_deadline,
    source: row.provider,
  }
}
