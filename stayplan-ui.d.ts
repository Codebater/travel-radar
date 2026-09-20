/**
 * Types for stayplan-ui.js — the Life-Perk Stay Planner's presentation
 * models (page + tests, one impl). Pure projections of the stay-plan API
 * response; nothing here fetches, ranks or writes, and no function can
 * multiply a per-night figure into a stay total.
 */

export interface SegmentEvidenceLike {
  fetchedAt: string
  availabilityState: string
  searchState?: string
  verificationLevel: string
  sourceFreshness?: string | null
  taxesFeesState: string
  taxesFeesAmount: number | null
  taxesFeesCurrency: string | null
  roomName: string | null
  roomClass: string | null
  [key: string]: unknown
}

export interface SegmentNavigationLike { quality: string; url: string | null; observedAt: string | null }

export interface SegmentPerkResolutionLike {
  ruleId: string
  badgeLabel: string
  program: string
  state: string
  reason: string
  freeNights: number
  affectsArithmetic: boolean
  bookingConditions: string[]
  requires: string[]
  satisfiedBy?: string[]
  minNights?: number | null
  acquisition?: unknown
  [key: string]: unknown
}

export interface PlanSegmentLike {
  propertyName: string
  program: string
  provider: string
  providerPropertyRef: string
  checkIn: string
  checkOut: string
  nights: number
  quoteBasis: string
  pointsPerNight: number | null
  pointsTotal: number | null
  evidence?: SegmentEvidenceLike
  navigation?: SegmentNavigationLike
  perks?: SegmentPerkResolutionLike[]
  [key: string]: unknown
}

export interface ProgramTotalLike {
  program: string
  statedTotal: number | null
  statedSegments: number
  perNightOnlySegments: number
}

export interface StayPlanLike {
  coveredNights: number
  requestedNights: number
  segments: PlanSegmentLike[]
  switches: number
  uncoveredDates: string[]
  programTotals: ProgramTotalLike[]
  appliedPerkNights: number
  perkSummary?: {
    appliedFreeNights: number
    applied: { ruleId: string; badgeLabel: string; program: string; count: number; freeNights: number; annotationOnly: boolean }[]
    annotations: { ruleId: string; badgeLabel: string; program: string; count: number; freeNights: number; annotationOnly: boolean }[]
    qualifiesUnpriced: { ruleId: string; badgeLabel: string; program: string; count: number; reason: string }[]
    certificatesConsumed: { type: string; quantity: number }[]
  }
  evidence?: {
    oldestFetchedAt: string | null
    newestFetchedAt: string | null
    availabilityUnknownSegments: number
    verificationLevels: Record<string, number>
  }
  [key: string]: unknown
}

export interface HeldEntitlementsLike {
  held: { memberships: string[]; statuses: string[]; cards: string[] }
  certificates: { key: string; program: string; quantity: number }[]
}

export interface BalanceAccountLike { program: string; programKey: string; balance: number; displayBalance?: string }

export interface BookingChecklistLine {
  index: number
  dates: string
  nights: number
  propertyName: string
  program: string
  priceMain: string
  priceSub: string
  conditions: string[]
  availabilityText: string
  observedAt: string | null
  navigation: SegmentNavigationLike
  sameHotelAsPrevious: boolean
  noLink: boolean
}

export interface CalendarDay {
  date: string
  col: number
  dayOfMonth: number
  weekday: string
  isWeekend: boolean
  monthLabel: string | null
}

export type CalendarBlock =
  | { kind: "stay"; segmentIndex: number; startCol: number; span: number; checkIn: string; checkOut: string; nights: number; propertyName: string; program: string }
  | { kind: "gap"; startCol: number; span: number; dates: string[] }

export const TRIP_PRESETS: readonly number[]
export const GOAL_LABELS: Record<string, string>

export function addDays(date: string, n: number): string | null
export function presetCheckout(checkIn: string, days: number): string | null
export function nightsBetween(checkIn: string, checkOut: string): number | null
export function activePreset(checkIn: string, checkOut: string): number | null
export function calendarModel(plan: StayPlanLike, rangeStart: string, requestedNights: number): { days: CalendarDay[]; blocks: CalendarBlock[] }
export function programClass(program: string): string
export function perkStateLabel(state: string): string
export function segmentPriceText(seg: PlanSegmentLike): { main: string; sub: string }
export function programTotalText(t: ProgramTotalLike): string
export function summaryModel(plan: StayPlanLike): {
  coveredNights: number
  requestedNights: number
  complete: boolean
  segments: number
  switches: number
  appliedFreeNights: number
  appliedPerks: unknown[]
  annotations: unknown[]
  qualifiesUnpriced: unknown[]
  certificatesConsumed: unknown[]
  programLines: { program: string; text: string }[]
  uncoveredDates: string[]
}
export function planExplanation(plan: StayPlanLike, goal: string, nowIso?: string): string[]
export function humanizeKey(key: string): string
export function evidenceAgeDays(fetchedAt: string | null | undefined, nowIso: string | null | undefined): number | null
export function evidenceText(seg: PlanSegmentLike, nowIso?: string): { ageDays: number | null; line: string }
export function payForText(seg: { nights: number }, res: SegmentPerkResolutionLike | null | undefined): string | null
export function perkAttribution(res: SegmentPerkResolutionLike | null | undefined): string | null
export function heldSummary(held: HeldEntitlementsLike["held"] | null | undefined, program: string): string
export function nothingDeclared(heldEntitlements: HeldEntitlementsLike | null | undefined): boolean
export function segmentWindows(plan: StayPlanLike): { checkIn: string; nights: number }[]
export function gapWindows(plan: StayPlanLike, rangeStart: string, requestedNights: number): { checkIn: string; nights: number }[]
export function bookingChecklist(plan: StayPlanLike): { lines: BookingChecklistLine[]; linked: number; text: string }
export const BALANCE_KEYS_FOR_PROGRAM: Record<string, string[]>
export const BALANCE_ACCOUNT_NAMES: Record<string, string[]>
export const PROGRAM_KEY_PREFIXES: Record<string, string[]>
export function heldForProgramTotal(accounts: BalanceAccountLike[] | null | undefined, programTotal: ProgramTotalLike): {
  accounts: { program: string; balance: number; displayBalance: string; canonical: boolean }[]
  largest: number | null
  verdict: "covers" | "shortfall" | "no-stated-total" | "no-balance" | "name-matched"
  shortfall: number | null
  text: string
}
