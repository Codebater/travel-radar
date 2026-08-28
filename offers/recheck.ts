/**
 * Offer verification — "is this still real, at what price".
 *
 * A recheck resolves the stored locator through the corresponding provider
 * and echo-checks the important dimensions. Any important difference is
 * RECORDED as a change, never silently treated as the same offer. The
 * verification is a NEW append-only observation: the historical price, the
 * original observation and the locator survive every outcome.
 *
 * Statuses: verified | changed | unavailable | blocked | expired | unsupported.
 * Never throws — provider failures are results, and a blocked provider ends
 * the recheck immediately (no retries, ever).
 */

import { nowIso, type DB } from "../db/index.js"
import { reservePackageSearch } from "../packages/budget.js"
import { recordPackageObservations, recordPackageRaw } from "../packages/store.js"
import { getPackageProvider, runPackageOfferSearch } from "../providers/packages/index.js"
import { getStayProvider, runStayRateSearch } from "../providers/stays/index.js"
import type { NormalizedPackageOffer, PackageProvider } from "../providers/packages/types.js"
import type { StayProvider } from "../providers/stays/types.js"
import { loadOffersConfig } from "./config.js"
import { getLocator, type StoredLocator } from "./locators.js"

export type VerificationStatus =
  | "verified" | "changed" | "unavailable" | "blocked" | "expired" | "unsupported"

/** The user-facing offer state, derived from the latest verification. */
export type OfferState =
  | "OBSERVED" | "VERIFIED" | "CHANGED" | "UNAVAILABLE" | "BLOCKED" | "EXPIRED" | "UNKNOWN"

export interface DimensionChange {
  dimension: string
  observed: string | number | null
  current: string | number | null
}

export interface RecheckResult {
  locatorId: number
  status: VerificationStatus
  observedPrice: number | null
  observedCurrency: string | null
  currentPrice: number | null
  currentCurrency: string | null
  changes: DimensionChange[]
  newObservationIds: number[]
  detail: string
  checkedAt: string
}

export interface StoredVerification extends RecheckResult {
  id: number
}

export function recordVerification(db: DB, result: RecheckResult): number {
  const insert = db.prepare(`
    INSERT INTO offer_verifications (
      locator_id, status, observed_price, observed_currency,
      current_price, current_currency, changes, new_observation_ids, detail, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.locatorId, result.status, result.observedPrice, result.observedCurrency,
    result.currentPrice, result.currentCurrency,
    JSON.stringify(result.changes), JSON.stringify(result.newObservationIds),
    result.detail, result.checkedAt,
  )
  return Number(insert.lastInsertRowid)
}

export function latestVerification(db: DB, locatorId: number): StoredVerification | null {
  const r = db.prepare(`
    SELECT * FROM offer_verifications WHERE locator_id = ? ORDER BY id DESC LIMIT 1
  `).get(locatorId) as Record<string, unknown> | undefined
  if (!r) return null
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    locatorId: r.locator_id as number,
    status: r.status as VerificationStatus,
    observedPrice: (r.observed_price as number) ?? null,
    observedCurrency: (r.observed_currency as string) ?? null,
    currentPrice: (r.current_price as number) ?? null,
    currentCurrency: (r.current_currency as string) ?? null,
    changes: parse(r.changes, []),
    newObservationIds: parse(r.new_observation_ids, []),
    detail: (r.detail as string) ?? "",
    checkedAt: r.checked_at as string,
  }
}

export function offerStateFor(verification: StoredVerification | null): OfferState {
  if (!verification) return "OBSERVED"
  switch (verification.status) {
    case "verified": return "VERIFIED"
    case "changed": return "CHANGED"
    case "unavailable": return "UNAVAILABLE"
    case "blocked": return "BLOCKED"
    case "expired": return "EXPIRED"
    case "unsupported": return "OBSERVED"   // an unsupported recheck teaches nothing
    default: return "UNKNOWN"
  }
}

// ── The recheck itself ───────────────────────────────────────────────────────

export interface RecheckOptions {
  /** Test seams — production resolves from the registries. */
  packageProvider?: PackageProvider
  stayProvider?: StayProvider
  now?: Date
}

export async function recheckOffer(db: DB, locatorId: number, options: RecheckOptions = {}): Promise<RecheckResult> {
  const locator = getLocator(db, locatorId)
  const base = (status: VerificationStatus, detail: string): RecheckResult => ({
    locatorId, status,
    observedPrice: locator?.nativePrice ?? null,
    observedCurrency: locator?.nativeCurrency ?? null,
    currentPrice: null, currentCurrency: null,
    changes: [], newObservationIds: [], detail,
    checkedAt: nowIso(),
  })
  if (!locator) {
    // Nothing to persist against — return a named result only.
    return { ...base("unsupported", `no locator with id ${locatorId}`), locatorId }
  }

  const now = options.now ?? new Date()
  if (locator.expiresAt && locator.expiresAt < now.toISOString()) {
    const result = base("expired", `provider-stated expiry ${locator.expiresAt} has passed`)
    recordVerification(db, result)
    return result
  }

  let result: RecheckResult
  if (locator.kind === "package") {
    result = await recheckPackage(db, locator, options)
  } else if (locator.kind === "stay" && locator.provider === "xotelo") {
    result = await recheckStayXotelo(db, locator, options)
  } else {
    result = base("unsupported",
      `${locator.kind}/${locator.provider} has no recheck resolver — a named limitation, not a guess`)
  }
  recordVerification(db, result)
  return result
}

function diffDimensions(locator: StoredLocator, current: {
  price: number; currency: string; checkIn: string; nights: number; adults: number
  board: string; transfer: string; operator: string | null; roomName: string | null
}): DimensionChange[] {
  const changes: DimensionChange[] = []
  const check = (dimension: string, observed: string | number | null, now: string | number | null) => {
    if (observed !== null && now !== null && observed !== now) changes.push({ dimension, observed, current: now })
  }
  check("price", locator.nativePrice, current.price)
  check("currency", locator.nativeCurrency, current.currency)
  check("checkIn", locator.checkIn, current.checkIn)
  check("nights", locator.nights, current.nights)
  check("adults", locator.adults, current.adults)
  check("board", locator.board, current.board)
  check("transfer", locator.transferStatus, current.transfer)
  check("operator", locator.operator, current.operator)
  check("roomName", locator.roomName, current.roomName)
  return changes
}

/**
 * Package recheck = one budget-reserved provider search for the locator's own
 * window, then a match on the offer's identity dimensions (operator + room)
 * and an echo-diff of everything important. All offers the search returned
 * are stored as ordinary NEW observations — a recheck is also an observation.
 */
async function recheckPackage(db: DB, locator: StoredLocator, options: RecheckOptions): Promise<RecheckResult> {
  const base = (status: VerificationStatus, detail: string): RecheckResult => ({
    locatorId: locator.id, status,
    observedPrice: locator.nativePrice, observedCurrency: locator.nativeCurrency,
    currentPrice: null, currentCurrency: null,
    changes: [], newObservationIds: [], detail, checkedAt: nowIso(),
  })

  const provider = options.packageProvider ?? getPackageProvider(locator.provider)
  if (!provider || !provider.capabilities.datedOffers) {
    return base("unsupported", `${locator.provider} is not available for rechecks`)
  }
  if (!locator.checkIn || !locator.nights || !locator.adults || !locator.origin || !locator.board) {
    return base("unsupported", "locator lacks the dimensions a provider search needs")
  }

  const reservation = reservePackageSearch(db, {
    provider: locator.provider, kind: "confirmation",
    propertyId: null, origin: locator.origin,
    rangeStart: locator.checkIn, rangeEnd: locator.checkOut,
    nights: locator.nights, adults: locator.adults, children: locator.children ?? 0,
    currency: locator.nativeCurrency ?? "EUR", source: "cli",
  }, 0)
  if (!reservation.ok) return base("blocked", `budget refused: ${reservation.reason}`)

  const propertyId = db.prepare(
    "SELECT property_id FROM package_offer_observations WHERE id = ?",
  ).get(locator.sourceId) as { property_id: string | null } | undefined

  const result = await runPackageOfferSearch(provider, {
    propertyId: propertyId?.property_id ?? "",
    providerRef: providerRefFor(locator),
    origin: locator.origin,
    checkInFrom: locator.checkIn,
    checkInTo: locator.checkIn,
    nights: locator.nights,
    tripDeparture: locator.outboundDate ?? undefined,
    tripReturn: locator.returnDate ?? undefined,
    adults: locator.adults,
    children: locator.children ?? 0,
    board: locator.board as never,
    currency: locator.nativeCurrency ?? "EUR",
  }, { captureRaw: true })

  if (!result.ok) {
    if (result.reason === "blocked") return base("blocked", result.error ?? "provider blocked")
    if (result.reason === "no-results") return base("unavailable", "provider returned no offers for these exact dimensions")
    return base("unavailable", `provider search failed: ${result.error ?? result.reason}`)
  }

  if (result.raw !== undefined) {
    recordPackageRaw(db, locator.provider, "confirmation", propertyId?.property_id ?? null,
      reservation.searchRequestId, result.raw)
  }
  const newIds = recordPackageObservations(db, result.offers, reservation.searchRequestId)

  const match = pickMatchingOffer(locator, result.offers)
  if (!match) {
    return {
      ...base("unavailable",
        `offer not found: no ${locator.operator ?? "?"} / ${locator.roomName ?? locator.roomClass ?? "?"} offer for ${locator.checkIn} — historical observation stands`),
      newObservationIds: newIds,
    }
  }

  const changes = diffDimensions(locator, {
    price: match.totalPrice.amount, currency: match.totalPrice.currency,
    checkIn: match.checkIn, nights: match.nights, adults: match.adults,
    board: match.board, transfer: match.transfer,
    operator: match.tourOperator, roomName: match.roomName,
  })
  return {
    locatorId: locator.id,
    status: changes.length === 0 ? "verified" : "changed",
    observedPrice: locator.nativePrice, observedCurrency: locator.nativeCurrency,
    currentPrice: match.totalPrice.amount, currentCurrency: match.totalPrice.currency,
    changes, newObservationIds: newIds,
    detail: changes.length === 0
      ? "offer re-resolved: every checked dimension matches"
      : `offer re-resolved with ${changes.length} changed dimension(s): ${changes.map(c => c.dimension).join(", ")}`,
    checkedAt: nowIso(),
  }
}

function providerRefFor(locator: StoredLocator): string {
  // The seller-native hotel ref was retained on the locator at build time
  // (giata id for TUI, hotel id for CHECK24).
  return locator.providerIds.hotelRef ?? ""
}

/**
 * Identity match: same seller (locator.provider), same operator, same
 * check-in, and the same room (name preferred, class as fallback). Among
 * matches, the cheapest — the provider's best current quote for that product.
 */
function pickMatchingOffer(locator: StoredLocator, offers: NormalizedPackageOffer[]): NormalizedPackageOffer | null {
  const candidates = offers.filter(o =>
    o.checkIn === locator.checkIn
    && (locator.operator === null || o.tourOperator === locator.operator)
    && (locator.roomName !== null
      ? o.roomName === locator.roomName
      : locator.roomClass === null || o.roomClass === locator.roomClass))
  if (candidates.length === 0 && locator.roomName !== null) {
    // Room names drift between batches; fall back to room class.
    const byClass = offers.filter(o =>
      o.checkIn === locator.checkIn
      && (locator.operator === null || o.tourOperator === locator.operator)
      && (locator.roomClass === null || o.roomClass === locator.roomClass))
    return byClass.sort((a, b) => a.totalPrice.amount - b.totalPrice.amount)[0] ?? null
  }
  return candidates.sort((a, b) => a.totalPrice.amount - b.totalPrice.amount)[0] ?? null
}

/** Stay recheck through Xotelo: free, keyless, politeness-capped per day. */
async function recheckStayXotelo(db: DB, locator: StoredLocator, options: RecheckOptions): Promise<RecheckResult> {
  const base = (status: VerificationStatus, detail: string): RecheckResult => ({
    locatorId: locator.id, status,
    observedPrice: locator.nativePrice, observedCurrency: locator.nativeCurrency,
    currentPrice: null, currentCurrency: null,
    changes: [], newObservationIds: [], detail, checkedAt: nowIso(),
  })
  const cap = loadOffersConfig().recheck.staysPerDay
  const today = (db.prepare(`
    SELECT COUNT(*) n FROM offer_verifications v
    JOIN offer_locators l ON l.id = v.locator_id
    WHERE l.kind = 'stay' AND v.checked_at >= ?
  `).get(`${new Date().toISOString().slice(0, 10)}T00:00:00`) as { n: number }).n
  if (today >= cap) return base("blocked", `stay recheck ceiling reached (${today}/${cap} today) — scope reduced`)

  const provider = options.stayProvider ?? getStayProvider("xotelo")
  if (!provider) return base("unsupported", "xotelo provider not registered")
  if (!locator.checkIn || !locator.checkOut || !locator.adults) {
    return base("unsupported", "locator lacks stay dimensions")
  }
  const propertyId = db.prepare(
    "SELECT property_id FROM stay_rate_observations WHERE id = ?",
  ).get(locator.sourceId) as { property_id: string } | undefined
  if (!propertyId) return base("unsupported", "source observation no longer resolvable")

  const result = await runStayRateSearch(provider, {
    propertyId: propertyId.property_id,
    providerRef: locator.providerIds.propertyRef ?? "",
    checkIn: locator.checkIn, checkOut: locator.checkOut,
    adults: locator.adults, children: 0,
    currency: locator.nativeCurrency ?? "EUR",
  })
  if (!result.ok) {
    if (result.reason === "no-results") return base("unavailable", "no priced OTA rates for these dates any more")
    return base("unavailable", `provider search failed: ${result.error ?? result.reason}`)
  }
  // Match the same OTA channel (rate_source is the stay seller identity).
  const match = result.rates.find(r => r.rateSource === locator.seller)
    ?? null
  if (!match) {
    return base("unavailable", `channel "${locator.seller}" no longer quotes these dates — other channels do`)
  }
  const changes: DimensionChange[] = []
  if (locator.nativePrice !== null && match.price.amount !== locator.nativePrice) {
    changes.push({ dimension: "price", observed: locator.nativePrice, current: match.price.amount })
  }
  if (locator.nativeCurrency !== null && match.price.currency !== locator.nativeCurrency) {
    changes.push({ dimension: "currency", observed: locator.nativeCurrency, current: match.price.currency })
  }
  return {
    locatorId: locator.id,
    status: changes.length === 0 ? "verified" : "changed",
    observedPrice: locator.nativePrice, observedCurrency: locator.nativeCurrency,
    currentPrice: match.price.amount, currentCurrency: match.price.currency,
    changes, newObservationIds: [],
    detail: changes.length === 0
      ? `channel "${locator.seller}" still quotes the observed nightly rate`
      : `channel "${locator.seller}" re-quoted with changes: ${changes.map(c => c.dimension).join(", ")}`,
    checkedAt: nowIso(),
  }
}

// ── Freshness (UI text is derived, never invented) ───────────────────────────

export interface Freshness {
  observedAgoMinutes: number
  verifiedAgoMinutes: number | null
  recentlyVerified: boolean
  staleObservation: boolean
}

export function freshnessFor(locator: StoredLocator, verification: StoredVerification | null, now = new Date()): Freshness {
  const cfg = loadOffersConfig().freshness
  const observedAgoMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(locator.observedAt)) / 60_000))
  const verifiedAgoMinutes = verification && (verification.status === "verified" || verification.status === "changed")
    ? Math.max(0, Math.round((now.getTime() - Date.parse(verification.checkedAt)) / 60_000))
    : null
  return {
    observedAgoMinutes,
    verifiedAgoMinutes,
    recentlyVerified: verifiedAgoMinutes !== null && verifiedAgoMinutes <= cfg.verifiedRecentMinutes,
    staleObservation: observedAgoMinutes > cfg.observedFreshHours * 60,
  }
}
