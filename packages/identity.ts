/**
 * Durable package identity — price-free, so a re-priced package is the same
 * product, not a new one.
 *
 * The seller is IN the key, deliberately: a TUI quote and a CHECK24 quote for
 * the same underlying product are separate observation streams (different
 * contracted inventory, different operators behind them) and must never share
 * a baseline — the same reasoning that keeps meta and retail apart in stays.
 * Cross-seller comparison happens in the comparison layer, on purpose and
 * with its level recorded, never silently inside identity.
 */

import { loadStaysConfig } from "../stays/config.js"
import { nightsBucketLabel, stayDateFamily } from "../stays/identity.js"
import type { NormalizedPackageOffer } from "../providers/packages/types.js"

export interface PackageKeyInput {
  provider: string
  /** GIATA id when known, else the seller-native hotel ref. */
  hotelIdentity: string
  origin: string
  checkIn: string
  nights: number
  board: string
  cabin: string
  adults: number
  children: number
  currency: string
}

export function packageKey(input: PackageKeyInput): string {
  const buckets = loadStaysConfig().anomaly.baseline.nightsBuckets
  return [
    "pkg",
    input.provider,
    input.hotelIdentity,
    input.origin,
    stayDateFamily(input.checkIn),
    nightsBucketLabel(input.nights, buckets),
    input.board,
    input.cabin,
    `${input.adults}a${input.children}c`,
    input.currency,
  ].join("|")
}

export function packageKeyForOffer(offer: NormalizedPackageOffer): string {
  return packageKey({
    provider: offer.provider,
    hotelIdentity: offer.giataId !== null ? `g${offer.giataId}` : `ref:${offer.providerPropertyRef}`,
    origin: offer.origin,
    checkIn: offer.checkIn,
    nights: offer.nights,
    board: offer.board,
    cabin: offer.cabin,
    adults: offer.adults,
    children: offer.children,
    currency: offer.totalPrice.currency,
  })
}

/**
 * The baseline family: the key without its date family — every observation of
 * this product across the season, for curves and relative judgement.
 */
export function packageBaselineFamily(key: string): string {
  const parts = key.split("|")
  // ["pkg", provider, hotel, origin, dateFamily, bucket, board, cabin, pax, ccy]
  return [...parts.slice(0, 4), ...parts.slice(5)].join("|")
}
