/**
 * §Q - one itinerary, many loyalty programs.
 *
 * The same Austrian metal can be priced by Aeroplan, Flying Blue, Iberia Avios
 * and others at wildly different points AND wildly different surcharges. There
 * is no single winner: 55k + 600 EUR and 70k + 90 EUR are both defensible
 * answers depending on whose points you hold. So this returns a winner PER
 * DIMENSION and refuses to collapse them into one ranking.
 *
 * Bookability is included only when balances are actually available; it is
 * `null`, never `false`, when we simply do not know. Nothing here exposes a
 * balance figure - only whether an option is reachable and by how much it
 * falls short.
 */

import type { DB } from "../db/index.js"
import type { AnomalyConfig } from "./config.js"
import { buildComparabilityKey } from "./comparability.js"
import { awardBaselineRows, buildBaseline } from "./baseline.js"
import { computeCpp } from "./cpp.js"
import { canAfford } from "../transfer-partners.js"
import { latestBalanceSnapshot } from "../db/repositories.js"
import type { ProgramComparison, ProgramOffer } from "./types.js"

interface AwardRow {
  id: number
  loyalty_program: string
  points: number
  taxes_amount: number | null
  taxes_currency: string | null
  cabin: string
  origin: string
  destination: string
  departure_date: string
  return_date: string | null
  stops: number | null
  provider: string
  fetched_at: string
}

/**
 * Compare every program that priced this itinerary as of `asOf`.
 * Only the most recent observation per program is used - an older row for the
 * same program is history, not a competing offer.
 */
export function compareProgramsForItinerary(
  db: DB,
  itineraryHash: string,
  asOf: string,
  config: AnomalyConfig,
  options: { useBalances?: boolean } = {},
): ProgramComparison | null {
  const rows = db.prepare(`
    SELECT * FROM award_prices
    WHERE itinerary_hash = ? AND fetched_at <= ?
    ORDER BY fetched_at DESC
  `).all(itineraryHash, asOf) as AwardRow[]
  if (rows.length === 0) return null

  const latestPerProgram = new Map<string, AwardRow>()
  for (const r of rows) {
    if (!latestPerProgram.has(r.loyalty_program)) latestPerProgram.set(r.loyalty_program, r)
  }
  if (latestPerProgram.size === 0) return null

  // Balances are optional. When AwardWallet is unreachable the comparison still
  // works; it simply cannot answer "can I book this".
  let balances: { programKey: string; program: string; balance: number }[] | null = null
  if (options.useBalances !== false) {
    const snapshot = latestBalanceSnapshot(db)
    balances = snapshot ? snapshot.balances : null
  }

  const offers: ProgramOffer[] = []
  for (const row of latestPerProgram.values()) {
    const key = buildComparabilityKey({
      origin: row.origin, destination: row.destination, cabin: row.cabin,
      departureDate: row.departure_date, returnDate: row.return_date,
      stops: row.stops, loyaltyProgram: row.loyalty_program,
    }, config)

    const baselineRows = awardBaselineRows(db, key, row.fetched_at, config, row.id)
    const baseline = buildBaseline(baselineRows, key, row.points, row.fetched_at, config)

    const cpp = computeCpp(db, {
      key, departureDate: row.departure_date, points: row.points,
      taxesAmount: row.taxes_amount, taxesCurrency: row.taxes_currency, asOf: row.fetched_at,
    }, config)

    let bookable: boolean | null = null
    let shortfall: number | null = null
    if (balances) {
      const affordability = canAfford(row.loyalty_program, row.points, balances)
      bookable = affordability.affordable
      shortfall = affordability.shortfall
    }

    offers.push({
      loyaltyProgram: row.loyalty_program,
      points: row.points,
      taxesAmount: row.taxes_amount,
      taxesCurrency: row.taxes_currency,
      cpp: cpp.cpp,
      percentBelowMedian: baseline ? baseline.percentBelowMedian : null,
      provider: row.provider,
      bookable,
      pointsShortfall: shortfall,
    })
  }

  const best = <T>(list: ProgramOffer[], pick: (o: ProgramOffer) => T | null, better: (a: T, b: T) => boolean) => {
    let winner: ProgramOffer | null = null
    let value: T | null = null
    for (const o of list) {
      const v = pick(o)
      if (v === null || v === undefined) continue
      if (value === null || better(v, value)) { value = v; winner = o }
    }
    return winner?.loyaltyProgram ?? null
  }

  // Surcharges are only comparable inside one currency, so the taxes winner is
  // decided within the most common currency rather than across all of them.
  const currencyCounts = new Map<string, number>()
  for (const o of offers) if (o.taxesCurrency) currencyCounts.set(o.taxesCurrency, (currencyCounts.get(o.taxesCurrency) ?? 0) + 1)
  const mainCurrency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const sameCurrency = offers.filter(o => o.taxesCurrency === mainCurrency)

  return {
    itineraryHash,
    offers: offers.sort((a, b) => a.points - b.points),
    winners: {
      lowestPoints: best(offers, o => o.points, (a, b) => a < b),
      lowestTaxes: best(sameCurrency, o => o.taxesAmount, (a, b) => a < b),
      highestCpp: best(offers, o => o.cpp, (a, b) => a > b),
      bestVsBaseline: best(offers, o => o.percentBelowMedian, (a, b) => a > b),
      bookable: offers.filter(o => o.bookable === true).map(o => o.loyaltyProgram),
    },
    note: balances
      ? "bookability uses the local balance snapshot and published transfer ratios"
      : "no balance snapshot available - bookability unknown, not false",
  }
}
