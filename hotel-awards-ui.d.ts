/**
 * Types for hotel-awards-ui.js — the Hotel Award Radar's shared presentation
 * sorting and buy-points acquisition math (page + tests, one impl).
 */

import type { MilesPromo } from "./providers/promos/awardwallet-blog.js"

export interface SortableObservation {
  program: string
  pointsPerNight: number | null
  cashComparisonAmount: number | null
  cashComparisonCurrency: string | null
  [key: string]: unknown
}

export type HotelAwardSortMode = "newest" | "points" | "cash" | "buypoints"
export const SORT_MODES: readonly HotelAwardSortMode[]

/** Cents to BUY `points` at an EXPLICIT promo rate (¢/point) — null without one. */
export function buyPointsCostCents(points: unknown, cpmCents: unknown): number | null
/** Per-night acquisition cost (cents) — stated points/night × explicit rate; never × nights. */
export function acquisitionPerNightCents(
  observation: SortableObservation | null | undefined,
  promoIndex: Record<string, MilesPromo> | null | undefined,
): number | null
export function centsToDollars(cents: number | null | undefined): string | null
/** Returns a sorted COPY; unknown modes and "newest" preserve the input order. */
export function sortObservations<T extends SortableObservation>(
  rows: T[] | null | undefined,
  mode: string,
  promoIndex: Record<string, MilesPromo> | null | undefined,
): T[]
