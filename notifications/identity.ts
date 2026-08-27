/**
 * §13 - what makes two alerts "the same opportunity".
 *
 * This is the hardest part of the phase, and every obvious answer is wrong on
 * this database. Measured, not assumed:
 *
 *   cluster_id      rebuildClusters does DELETE + re-INSERT into an
 *                   AUTOINCREMENT pk on every discovery run - 1,503 live rows
 *                   behind sequence 16,275 - and is NULL for any open jaw
 *                   assembled after the rebuild within a tick.
 *   candidate_id    sequence 36,190 for 4,928 rows.
 *   open-jaw pair   pair_key is "<outboundPriceId>:<inboundPriceId>", so
 *                   re-observing EITHER leg mints a new pair, a new source_id
 *                   and a new candidate for an identical trip. Sequence 226 for
 *                   10 surviving rows.
 *   any timestamp   evaluateOpenJaws has no cursor and re-derives every pair on
 *                   every tick, so a timestamp in the key mints a fresh
 *                   identity once a minute, forever.
 *   score           a function of weightsVersion. One `anomaly:backfill` would
 *                   re-notify the entire backlog.
 *   airline/provider upstream free text. "LOT" on Monday and "LOT Polish
 *                   Airlines" on Tuesday is two identities for one fare, and
 *                   the day's two slots are gone.
 *
 * So identity is DERIVED, and split into three keys because there are three
 * different questions:
 *
 *   opportunityKey  the trip without its price. Survives re-pricing, which is
 *                   what makes re-alert possible at all: a key containing the
 *                   price can never match the previous notification, because
 *                   the price is precisely what changed.
 *   fingerprint     the trip WITH its bucketed economics. Dedup.
 *   cooldownKey     the route without dates or price. Stops one volatile route
 *                   owning the whole daily allowance across date families.
 */

import type { StoredCandidate } from "../anomaly/store.js"

/** Trip-length buckets, matching the vocabulary the baseline already uses. */
function nightsBucket(nights: number | null): string {
  if (nights === null) return "n/a"
  if (nights <= 4) return "short"
  if (nights <= 9) return "medium"
  if (nights <= 16) return "long"
  return "extended"
}

/**
 * A three-letter airport code, or null.
 *
 * This matters more than it looks. The SerpAPI normaliser takes airport ids
 * straight from the provider response (`arrival_airport?.id || query.destination`),
 * so `origin` and `destination` are upstream-authored strings - and `route` is
 * the field most likely to end up in a notification title. Anything that is not
 * three letters is a provider bug, and the eligibility gate treats it as
 * SUSPICIOUS_DATA rather than notifying about a trip to "undefined".
 */
export function validIata(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null
  const trimmed = code.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null
}

/**
 * The date family a departure belongs to: a fixed grid, in whole days since the
 * epoch, quantised to `windowDays`.
 *
 * Deliberately NOT candidate_clusters.earliest_departure. That column moves as
 * family membership churns, and it is simply unavailable for the candidates
 * that matter most - evaluateOpenJaws runs AFTER rebuildClusters in the tick,
 * so a freshly assembled open jaw has cluster_id NULL until the next discovery
 * run a day later.
 *
 * The cost of a fixed grid is that a family straddling a boundary can yield one
 * extra alert; the cooldown key absorbs that. The cost of the alternative is
 * losing the previous notification every time a family reshapes, which breaks
 * re-alert silently.
 */
export function dateFamily(departureDate: string, windowDays = 3): string {
  const days = Math.floor(Date.parse(`${departureDate}T00:00:00Z`) / 86_400_000)
  if (!Number.isFinite(days)) return "invalid"
  return String(Math.floor(days / windowDays) * windowDays)
}

/** Round to a bucket, so a one-unit move is not a new identity. */
function bucket(value: number, size: number): string {
  return String(Math.round(value / size) * size)
}

export interface IdentityInput {
  candidate: StoredCandidate
  /** The live open-jaw economics, read from open_jaw_pairs rather than the candidate JSON. */
  openJawTotal?: number | null
}

function structure(c: StoredCandidate): string {
  return c.isOpenJaw ? "oj" : "rt"
}

function positioning(c: StoredCandidate): string {
  // The origin is part of it: leaving from Budapest and leaving from Munich are
  // different trips even at the same price.
  return c.requiresPositioning ? `pos:${validIata(c.origin) ?? "??"}` : "home"
}

function routeOf(c: StoredCandidate): string {
  const origin = validIata(c.origin) ?? "???"
  const destination = validIata(c.destination) ?? "???"
  // For an open jaw the four airports are the trip, so all four are the route.
  if (c.isOpenJaw && c.openJaw) {
    const inOrigin = validIata(c.openJaw.inbound.origin) ?? "???"
    const inDestination = validIata(c.openJaw.inbound.destination) ?? "???"
    return `${origin}-${destination}/${inOrigin}-${inDestination}`
  }
  return `${origin}-${destination}`
}

/**
 * The trip, with no economics in it at all.
 *
 * This is the key a re-alert looks up. It has to survive the price changing,
 * because the price changing is the entire reason a re-alert exists.
 */
export function opportunityKey(input: IdentityInput): string {
  const c = input.candidate
  return [
    c.type,
    routeOf(c),
    c.cabin,
    c.loyaltyProgram ?? "-",
    c.priceCurrency ?? c.taxesCurrency ?? "-",
    structure(c),
    positioning(c),
    dateFamily(c.departureDate),
    nightsBucket(c.tripLengthNights),
  ].join("|")
}

/**
 * The trip WITH its economics, bucketed.
 *
 * Bucketing is not cosmetic. One LIFEMILES VIE-DXB 24,000-point seat exists in
 * this database as five candidate rows differing only in the surcharge (63.8,
 * 55.9, …) and the source id. Unbucketed that is five fingerprints for one
 * seat, and the day's two immediate slots both go to one award.
 *
 * verification_status is deliberately excluded: an upgrade from unverified to
 * verified is a REASON TO RE-ALERT, not a different opportunity, and putting it
 * in the identity would make the improvement look like a brand-new deal.
 */
export function fingerprint(input: IdentityInput): string {
  const c = input.candidate
  const parts = [opportunityKey(input)]

  if (c.isOpenJaw) {
    // The COMBINED total, which is the number that decides whether the trip is
    // worth taking. One leg being re-observed at the same price must not move
    // this at all.
    const total = input.openJawTotal ?? c.openJaw?.trueTripCost ?? c.priceAmount ?? 0
    parts.push(`ojtotal:${bucket(total, 5)}`)
  } else if (c.type === "award") {
    parts.push(`pts:${bucket(c.points ?? 0, 500)}`)
    parts.push(`tax:${bucket(c.taxesAmount ?? 0, 10)}`)
  } else {
    // The effective cost, not the headline fare: a positioning trip's identity
    // is what it costs to begin, which is the same principle the score uses.
    const effective = c.trueTripStartCost ?? c.priceAmount ?? 0
    parts.push(`cost:${bucket(effective, 5)}`)
  }
  return parts.join("|")
}

/**
 * The route, with neither dates nor price.
 *
 * Broader than the opportunity key on purpose: without it, one route that
 * moves a lot could take both of the day's slots with two different date
 * families and crowd out everything else the radar found.
 */
export function cooldownKey(candidate: StoredCandidate): string {
  const c = candidate
  return [
    c.type,
    routeOf(c),
    c.cabin,
    c.loyaltyProgram ?? "-",
    structure(c),
    positioning(c),
  ].join("|")
}

/** All three at once, since every call site wants all three. */
export function identityFor(input: IdentityInput): {
  opportunityKey: string
  fingerprint: string
  cooldownKey: string
} {
  return {
    opportunityKey: opportunityKey(input),
    fingerprint: fingerprint(input),
    cooldownKey: cooldownKey(input.candidate),
  }
}
