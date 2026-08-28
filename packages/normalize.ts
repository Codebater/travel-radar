/**
 * Shared normalization for package sellers: board-code dialects, cabin
 * labels, and date plumbing. Room-class text classification is reused from
 * the stay radar so "Beach Villa" means the same thing on both sides of a
 * comparison.
 */

import type { BoardBasis, FlightCabin } from "../providers/packages/types.js"

/**
 * TUI's GT06 board dialect (offer + calendar endpoints). The search endpoint
 * uses the bare suffix ("AI") — boardCodeForSearch strips the prefix.
 * Measured live 2026-08-28: breakfast is GT06-BR (not BB), and "AI plus"
 * offers still carry GT06-AI plus a marketing boardDescription.
 */
const TUI_BOARD_TO_CODE: Record<string, string> = {
  all_inclusive: "GT06-AI",
  full_board: "GT06-FB",
  half_board: "GT06-HB",
  breakfast: "GT06-BR",
  room_only: "GT06-AO",
}

const TUI_CODE_TO_BOARD: Record<string, BoardBasis> = {
  "GT06-AI": "all_inclusive",
  "GT06-FB": "full_board",
  "GT06-HB": "half_board",
  "GT06-BR": "breakfast",
  "GT06-AO": "room_only",
}

export function tuiBoardCode(board: BoardBasis): string | null {
  return TUI_BOARD_TO_CODE[board] ?? null
}

/** The hotel-offer-cards search endpoint's bare dialect ("AI", "FB", …). */
export function tuiSearchBoardCode(board: BoardBasis): string | null {
  const code = TUI_BOARD_TO_CODE[board]
  return code ? code.replace(/^GT06-/, "").replace("BR", "BB") : null
}

export function boardFromTuiCode(code: string | null | undefined): BoardBasis {
  if (!code) return "unknown"
  return TUI_CODE_TO_BOARD[code.trim()] ?? "unknown"
}

/**
 * CHECK24's mealType vocabulary ("AllInclusive", "AllInclusivePlus", …).
 * "Plus" variants normalize to the base board — the plus is an amenity level,
 * not a different board basis — and anything unrecognized stays unknown.
 */
export function boardFromCheck24MealType(mealType: string | null | undefined): BoardBasis {
  if (!mealType) return "unknown"
  const t = mealType.trim().toLowerCase()
  if (t.startsWith("allinclusive")) return "all_inclusive"
  if (t.startsWith("fullboard")) return "full_board"
  if (t.startsWith("halfboard")) return "half_board"
  if (t.startsWith("breakfast")) return "breakfast"
  if (t === "none" || t === "noboard" || t === "accommodationonly") return "room_only"
  return "unknown"
}

/** CHECK24's board filter param: the requested level or better. */
export function check24CateringList(board: BoardBasis): string | null {
  switch (board) {
    case "all_inclusive": return "allinclusive,allinclusivePlus"
    case "full_board": return "fullboard,fullboardPlus,allinclusive,allinclusivePlus"
    case "half_board": return "halfboard,halfboardPlus,fullboard,fullboardPlus,allinclusive,allinclusivePlus"
    case "breakfast": return "breakfast,halfboard,halfboardPlus,fullboard,fullboardPlus,allinclusive,allinclusivePlus"
    default: return null
  }
}

/** "economy" / "EconomyClass" / "BusinessClass" → the contract vocabulary. */
export function normalizeCabin(text: string | null | undefined): FlightCabin {
  if (!text) return "unknown"
  const t = text.trim().toLowerCase()
  if (t.startsWith("premium")) return "premium_economy"
  if (t.startsWith("econom")) return "economy"
  if (t.startsWith("business")) return "business"
  if (t.startsWith("first")) return "first"
  return "unknown"
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/

/** First 10 chars of a provider datetime, when they look like a date. */
export function dateOnly(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const head = value.slice(0, 10)
  return DATE_PATTERN.test(head) ? head : null
}

/** Inclusive door-to-door days between two provider datetimes, when derivable. */
export function tripDaysBetween(departure: string | null, returnArrival: string | null): number | null {
  const dep = dateOnly(departure)
  const arr = dateOnly(returnArrival)
  if (!dep || !arr) return null
  const days = Math.round((Date.parse(arr) - Date.parse(dep)) / 86_400_000) + 1
  return days > 0 ? days : null
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000)
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
}
