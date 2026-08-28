/**
 * Types for promo-enrich.js — the shared presentation-layer join between the
 * Miles Promo Feed and award result cards (dashboard + tests, one impl).
 */

import type { MilesPromo, MilesPromoFeed } from "./providers/promos/awardwallet-blog.js"

/** Defensive by design: any malformed/failed feed yields an empty index.
 *  category defaults to "airline" — the original contract. */
export function activePromoIndex(feed: unknown, category?: "airline" | "hotel"): Record<string, MilesPromo>
export function qualifies(
  flight: { type?: string; pointsProgram?: string | null } | null | undefined,
  index: Record<string, MilesPromo>,
): boolean
export function promoBadgeText(promo: Pick<MilesPromo, "bonusPercent" | "discountPercent" | "upTo">): string
export function hotelPromoBadgeText(promo: Pick<MilesPromo, "bonusPercent" | "discountPercent" | "upTo">): string
export function promoRateText(promo: Pick<MilesPromo, "effectiveCostPerMile">): string | null
export function promoEndsText(promo: Pick<MilesPromo, "validUntil">): string | null
