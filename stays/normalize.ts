/**
 * Provider-independent normalization for stay observations.
 *
 * Everything here operates on the contract shapes only — no function in this
 * file may know which provider produced a rate. This is where the two rules
 * that keep hotel data honest live:
 *
 *   1. A teaser is not a total. `stayTotalFor` refuses to produce a stay
 *      total from a lead_in price, and `isBaselineEligible` keeps lead-ins
 *      and suspicious rows out of every future baseline.
 *   2. Board basis is product identity. A bare price at an all-inclusive-only
 *      property means something different from the same number at a
 *      room-only city hotel; `boardFor` applies the property's metadata when
 *      the provider had no structured board, and records that it did so.
 */

import type {
  BoardBasis,
  BoardSource,
  NormalizedStayRate,
  RoomClass,
} from "../providers/stays/types.js"
import type { StayPropertyConfig } from "./registry.js"

// ── Dates ────────────────────────────────────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface StayDateCheck {
  ok: boolean
  nights: number
  reason?: string
}

/**
 * Validate a requested stay window. `now` is injectable so tests are
 * deterministic; the default is the wall clock.
 */
export function validateStayDates(checkIn: string, checkOut: string, now: Date = new Date()): StayDateCheck {
  if (!DATE_PATTERN.test(checkIn)) return { ok: false, nights: 0, reason: `check-in is not YYYY-MM-DD: ${checkIn}` }
  if (!DATE_PATTERN.test(checkOut)) return { ok: false, nights: 0, reason: `check-out is not YYYY-MM-DD: ${checkOut}` }
  const inMs = Date.parse(`${checkIn}T00:00:00Z`)
  const outMs = Date.parse(`${checkOut}T00:00:00Z`)
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
    return { ok: false, nights: 0, reason: `not a real date: ${checkIn}..${checkOut}` }
  }
  // Calendar-invalid strings like 2026-02-31 survive the regex but roll over
  // when parsed; round-tripping catches them.
  if (isoDay(inMs) !== checkIn || isoDay(outMs) !== checkOut) {
    return { ok: false, nights: 0, reason: `not a real calendar date: ${checkIn}..${checkOut}` }
  }
  const nights = Math.round((outMs - inMs) / 86_400_000)
  if (nights <= 0) return { ok: false, nights, reason: "check-out must be after check-in" }
  const today = isoDay(now.getTime())
  if (checkIn < today) return { ok: false, nights, reason: `check-in ${checkIn} is in the past` }
  return { ok: true, nights }
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ── Board basis ──────────────────────────────────────────────────────────────

/**
 * Map free-text meal-plan wording to a board basis. Built for the later
 * room-level providers; kept here so their parsers share one vocabulary.
 * Order matters: "all inclusive" must win over its substring "inclusive",
 * and "half board" over "board".
 */
export function normalizeBoardText(text: string | null | undefined): BoardBasis {
  if (!text) return "unknown"
  const t = text.toLowerCase()
  if (/all[\s-]?inclusive|all[\s-]?in\b/.test(t)) return "all_inclusive"
  if (/full[\s-]?board|pension complète|vollpension/.test(t)) return "full_board"
  if (/half[\s-]?board|demi-pension|halbpension/.test(t)) return "half_board"
  if (/breakfast|petit déjeuner|frühstück|\bbb\b/.test(t)) return "breakfast"
  if (/room[\s-]?only|no meals|ohne verpflegung/.test(t)) return "room_only"
  return "unknown"
}

/**
 * Resolve the board for an observation: a structured provider value wins;
 * otherwise a property that can ONLY be bought one way tells us what a bare
 * price means there. The source is recorded alongside so a later phase can
 * distrust inferred boards wholesale if they prove unreliable.
 */
export function boardFor(
  property: Pick<StayPropertyConfig, "allInclusive" | "defaultBoard">,
  structured: BoardBasis | null,
): { board: BoardBasis; boardSource: BoardSource } {
  if (structured && structured !== "unknown") return { board: structured, boardSource: "structured" }
  if (property.allInclusive === "only") return { board: "all_inclusive", boardSource: "property_default" }
  if (property.defaultBoard !== "unknown") return { board: property.defaultBoard, boardSource: "property_default" }
  return { board: "unknown", boardSource: "unknown" }
}

// ── Room class ───────────────────────────────────────────────────────────────

/** Bucket a provider's room name. Built for the room-level providers. */
export function classifyRoomText(text: string | null | undefined): RoomClass {
  if (!text) return "unknown"
  // Providers append promo copy after a dash ("Beach Suite With Jacuzzi -
  // Complimentary In-Villa Dining Breakfast …"), and that copy false-matched
  // "villa" in 8b. Classify on the room-name segment before the first " - ",
  // and strip "in-villa"/"in-room" phrasing defensively besides.
  const t = text.toLowerCase().split(" - ")[0].replace(/in-(villa|room|suite)/g, "")
  if (/villa|bungalow|overwater|residence/.test(t)) return "villa"
  if (/suite/.test(t)) return "suite"
  if (/deluxe|premium|club|executive|premier/.test(t)) return "premium"
  if (/standard|superior|classic|guest\s?room|king room|queen room/.test(t)) return "entry"
  return "unknown"
}

// ── Price semantics ──────────────────────────────────────────────────────────

/** The slice of a rate that price arithmetic actually needs. */
export type PricedStay = Pick<NormalizedStayRate, "priceBasis" | "price" | "nights">

/**
 * The stay total this observation supports, or null when the basis cannot
 * honestly produce one. A lead-in price has no stay semantics AT ALL — the
 * temptation to multiply it by nights is exactly the teaser-as-total bug
 * this function exists to make impossible.
 */
export function stayTotalFor(rate: PricedStay): number | null {
  switch (rate.priceBasis) {
    case "lead_in": return null
    case "nightly_room": return round2(rate.price.amount * rate.nights)
    case "stay_room":
    case "stay_total": return round2(rate.price.amount)
  }
}

/** Per-night figure, or null when the basis cannot honestly produce one. */
export function nightlyFor(rate: PricedStay): number | null {
  switch (rate.priceBasis) {
    case "lead_in": return null
    case "nightly_room": return round2(rate.price.amount)
    case "stay_room":
    case "stay_total": return rate.nights > 0 ? round2(rate.price.amount / rate.nights) : null
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Sanity ───────────────────────────────────────────────────────────────────

export interface StaySanityConfig {
  /** Per-currency nightly bounds; "default" is the fallback scale. */
  nightly: Record<string, { min: number; max: number }>
  maxNights: number
}

export interface StaySanityResult {
  verdict: "ok" | "SUSPICIOUS_DATA"
  reasons: string[]
}

/**
 * Implausible values are flagged, never discarded: a flagged row is stored,
 * visible, and excluded from baselines. The floor exists to catch data errors
 * ($0, $3), NOT good deals — a genuinely absurd bargain at a real property is
 * the entire point of this system and must survive sanity. Hence the floor is
 * far below any plausible luxury rate.
 */
export function checkStaySanity(rate: NormalizedStayRate, config: StaySanityConfig): StaySanityResult {
  const reasons: string[] = []
  const bounds = config.nightly[rate.price.currency] ?? config.nightly.default
  const nightly = nightlyFor(rate)

  if (rate.priceBasis === "lead_in") {
    // Not an error — but a lead-in can't be sanity-judged per night either.
    if (rate.price.amount <= 0) reasons.push(`non-positive lead-in price ${rate.price.amount}`)
  } else if (nightly === null) {
    reasons.push("no nightly figure computable")
  } else if (bounds) {
    if (nightly < bounds.min) reasons.push(`nightly ${nightly} ${rate.price.currency} below floor ${bounds.min}`)
    if (nightly > bounds.max) reasons.push(`nightly ${nightly} ${rate.price.currency} above ceiling ${bounds.max}`)
  }

  if (rate.nights > config.maxNights) reasons.push(`${rate.nights} nights exceeds max ${config.maxNights}`)
  if (rate.nights <= 0) reasons.push(`non-positive nights ${rate.nights}`)
  if (!/^[A-Z]{3}$/.test(rate.price.currency)) reasons.push(`not an ISO currency: ${rate.price.currency}`)

  return { verdict: reasons.length ? "SUSPICIOUS_DATA" : "ok", reasons }
}

// ── Baseline eligibility ─────────────────────────────────────────────────────

/**
 * May this observation ever enter a baseline? One place, one answer — the
 * future anomaly engine imports this rather than re-deriving it. A lead-in
 * teaser and a suspicious row are observations worth keeping but evidence of
 * nothing.
 */
export function isBaselineEligible(rate: NormalizedStayRate, sanity: StaySanityResult): boolean {
  return rate.priceBasis !== "lead_in" && sanity.verdict === "ok"
}
