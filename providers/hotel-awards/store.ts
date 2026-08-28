/**
 * Hotel award observation persistence — append-only, echo-checked at the door.
 *
 * A row that fails validation (date arithmetic, missing program/property,
 * quote-basis dishonesty) never enters history; the schema CHECKs are the
 * second lock on the same door. Duplicates are APPENDED (same dedupe key,
 * new fetched_at) — price history is the point, and nothing is ever mutated.
 */

import crypto from "crypto"
import { nowIso, type DB } from "../../db/index.js"
import { safeProviderUrl } from "../../offers/urls.js"
import { locatorForSource, upsertLocator, type BuiltLocator } from "../../offers/locators.js"
import type { NormalizedHotelAward } from "./types.js"

/** Price-free identity of the quoted product — the dedupe/history key. */
export function hotelAwardDedupeKey(a: {
  provider: string; providerPropertyRef: string; program: string
  checkIn: string; nights: number; roomClass: string | null; quoteBasis: string
}): string {
  const parts = [a.provider, a.providerPropertyRef, a.program, a.checkIn, `${a.nights}n`, a.roomClass ?? "-", a.quoteBasis]
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16)
}

/** Echo/honesty validation. Returns the FIRST problem, or null when clean. */
export function validateHotelAward(a: NormalizedHotelAward): string | null {
  const nights = Math.round((Date.parse(a.checkOut) - Date.parse(a.checkIn)) / 86_400_000)
  if (!Number.isFinite(nights) || nights < 1) return `invalid stay window ${a.checkIn}..${a.checkOut}`
  if (nights !== a.nights) return `nights mismatch: dates say ${nights}, row says ${a.nights}`
  if (!a.propertyName.trim() || !a.providerPropertyRef.trim()) return "property identity missing"
  if (!a.program.trim() || !a.sourceProgramName.trim()) return "loyalty program missing"
  if (a.quoteBasis === "full_stay" && a.pointsTotal === null) {
    return "full_stay quote without a source-stated points total"
  }
  if (a.quoteBasis === "per_night" && a.pointsTotal !== null) {
    return "per_night quote carrying a stay total — a nightly price is never multiplied into a stay"
  }
  if (a.quoteBasis === "per_night" && a.pointsPerNight === null) {
    return "per_night quote without a stated nightly price"
  }
  if (a.taxesFeesState === "stated" && (a.taxesFeesAmount === null || !a.taxesFeesCurrency)) {
    return "stated taxes need an amount and a currency"
  }
  if (a.taxesFeesState !== "stated" && a.taxesFeesAmount !== null) {
    return `taxes state "${a.taxesFeesState}" cannot carry an amount`
  }
  return null
}

/**
 * Booking navigation via the existing honesty ladder: a provider URL that
 * survives the allowlist AND carries the stay's dates is a SEARCH_REPLAY
 * (dates pre-filled, rooms still to choose — never EXACT); a bare surviving
 * URL is a landing page; anything else is UNAVAILABLE. URLs never repaired.
 */
export function buildHotelAwardLocator(a: NormalizedHotelAward, sourceId: number): BuiltLocator {
  const safe = safeProviderUrl(a.provider, a.bookingUrl)
  const datesEncoded = safe !== null && safe.includes(a.checkIn) && safe.includes(a.checkOut)
  return {
    kind: "hotel_award",
    sourceTable: "hotel_award_observations",
    sourceId,
    provider: a.provider,
    seller: a.provider,
    operator: a.program,
    navigationQuality: safe === null ? "UNAVAILABLE" : datesEncoded ? "SEARCH_REPLAY_LINK" : "PROVIDER_LANDING_LINK",
    landingUrl: safe !== null && !datesEncoded ? safe : null,
    deepLinkUrl: null,                       // no rate token exists — EXACT is never faked
    bookingUrl: null,
    searchReplayUrl: datesEncoded ? safe : null,
    searchReplayParams: datesEncoded ? { checkIn: a.checkIn, checkOut: a.checkOut } : {},
    providerIds: { hotelId: a.providerPropertyRef },
    rawResponseRef: null,
    origin: null,
    destination: null,
    outboundDate: null,
    returnDate: null,
    checkIn: a.checkIn,
    checkOut: a.checkOut,
    nights: a.nights,
    adults: null,
    children: null,
    cabin: null,
    board: null,
    roomClass: a.roomClass,
    roomName: a.roomName,
    transferStatus: null,
    nativeCurrency: null,                    // the award price is points, never cash
    nativePrice: null,
    observedAt: a.fetchedAt,
    expiresAt: null,
  }
}

export interface HotelAwardInsertSummary {
  inserted: number
  rejected: { propertyName: string; reason: string }[]
}

export function insertHotelAwards(db: DB, awards: NormalizedHotelAward[]): HotelAwardInsertSummary {
  const stmt = db.prepare(`
    INSERT INTO hotel_award_observations (
      dedupe_key, provider, provider_property_ref, property_id, property_name, chain,
      program, source_program_name, check_in, check_out, nights,
      quote_basis, room_class, room_name, points_total, points_per_night,
      taxes_fees_amount, taxes_fees_currency, taxes_fees_state, award_type,
      cash_comparison_amount, cash_comparison_currency,
      availability_state, search_state, verification_level, source_freshness,
      locator_id, raw_ref, fetched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const summary: HotelAwardInsertSummary = { inserted: 0, rejected: [] }
  const tx = db.transaction(() => {
    for (const a of awards) {
      const problem = validateHotelAward(a)
      if (problem !== null) {
        summary.rejected.push({ propertyName: a.propertyName, reason: problem })
        continue
      }
      const r = stmt.run(
        hotelAwardDedupeKey(a), a.provider, a.providerPropertyRef, a.propertyId, a.propertyName, a.chain,
        a.program, a.sourceProgramName, a.checkIn, a.checkOut, a.nights,
        a.quoteBasis, a.roomClass, a.roomName, a.pointsTotal, a.pointsPerNight,
        a.taxesFeesAmount, a.taxesFeesCurrency, a.taxesFeesState, a.awardType,
        a.cashComparisonAmount, a.cashComparisonCurrency,
        a.availabilityState, a.searchState, a.verificationLevel, a.sourceFreshness,
        null, null, a.fetchedAt, nowIso(),
      )
      const id = Number(r.lastInsertRowid)
      // Locator: deterministic local work through the shared ladder.
      upsertLocator(db, buildHotelAwardLocator(a, id))
      const locator = locatorForSource(db, "hotel_award_observations", id)
      if (locator) db.prepare("UPDATE hotel_award_observations SET locator_id = ? WHERE id = ?").run(locator.id, id)
      summary.inserted++
    }
  })
  tx()
  return summary
}

export interface StoredHotelAward extends NormalizedHotelAward {
  id: number
  dedupeKey: string
  locatorId: number | null
  createdAt: string
}

export function listHotelAwards(db: DB, opts: { limit?: number; program?: string } = {}): StoredHotelAward[] {
  const rows = db.prepare(`
    SELECT * FROM hotel_award_observations
    ${opts.program ? "WHERE program = @program" : ""}
    ORDER BY id DESC LIMIT @limit
  `).all({ limit: opts.limit ?? 50, ...(opts.program ? { program: opts.program } : {}) }) as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as number,
    dedupeKey: r.dedupe_key as string,
    provider: r.provider as string,
    providerPropertyRef: r.provider_property_ref as string,
    propertyId: (r.property_id as string) ?? null,
    propertyName: r.property_name as string,
    chain: (r.chain as string) ?? null,
    program: r.program as string,
    sourceProgramName: r.source_program_name as string,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    nights: r.nights as number,
    quoteBasis: r.quote_basis as StoredHotelAward["quoteBasis"],
    roomClass: (r.room_class as string) ?? null,
    roomName: (r.room_name as string) ?? null,
    pointsTotal: (r.points_total as number) ?? null,
    pointsPerNight: (r.points_per_night as number) ?? null,
    taxesFeesAmount: (r.taxes_fees_amount as number) ?? null,
    taxesFeesCurrency: (r.taxes_fees_currency as string) ?? null,
    taxesFeesState: r.taxes_fees_state as StoredHotelAward["taxesFeesState"],
    awardType: r.award_type as StoredHotelAward["awardType"],
    cashComparisonAmount: (r.cash_comparison_amount as number) ?? null,
    cashComparisonCurrency: (r.cash_comparison_currency as string) ?? null,
    availabilityState: r.availability_state as StoredHotelAward["availabilityState"],
    searchState: r.search_state as StoredHotelAward["searchState"],
    verificationLevel: r.verification_level as StoredHotelAward["verificationLevel"],
    sourceFreshness: (r.source_freshness as string) ?? null,
    bookingUrl: null,
    locatorId: (r.locator_id as number) ?? null,
    fetchedAt: r.fetched_at as string,
    createdAt: r.created_at as string,
  }))
}
