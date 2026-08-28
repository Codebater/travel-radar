/**
 * Types for promo-enrich.js — the shared presentation-layer join between the
 * Miles Promo Feed and award result cards (dashboard + tests, one impl).
 */

import type { MilesPromo, MilesPromoFeed } from "./providers/promos/awardwallet-blog.js"

/** Defensive by design: any malformed/failed feed yields an empty index. */
export function activePromoIndex(feed: unknown): Record<string, MilesPromo>
export function qualifies(
  flight: { type?: string; pointsProgram?: string | null } | null | undefined,
  index: Record<string, MilesPromo>,
): boolean
export function promoBadgeText(promo: Pick<MilesPromo, "bonusPercent" | "discountPercent" | "upTo">): string
export function promoEndsText(promo: Pick<MilesPromo, "validUntil">): string | null
