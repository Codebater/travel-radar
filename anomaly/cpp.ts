/**
 * §P — cents per point, and how much that number is worth trusting.
 *
 * CPP = (comparable cash fare − award surcharge) ÷ points × 100.
 *
 * The subtraction matters: an award costing 55k + €600 is not "worth" the full
 * cash fare, because €600 is paid either way. It also means the two figures
 * must share a currency — no exchange rate is invented here, so a mismatch
 * yields no CPP rather than a plausible-looking one.
 *
 * The rule that keeps this honest is §P's: an award is never called exceptional
 * on the strength of a weak cash comparable. `basis` and `confidence` travel
 * with every CPP figure, and the scorer caps the CPP component when the cash
 * side is thin, stale or discovery-only.
 */

import type { DB } from "../db/index.js"
import type { AnomalyConfig } from "./config.js"
import { confidenceFor } from "./config.js"
import type { CppResult, ComparabilityKey } from "./types.js"

interface CashRow {
  price: number
  currency: string
  provider: string
  verification: string
  fetchedAt: string
  exactDate: number
}

/**
 * Comparable cash observations recorded BEFORE `asOf` (§Y). Same-departure-date
 * rows are preferred; when too few exist the window widens to the same route
 * and cabin, which is recorded as a weaker basis rather than hidden.
 */
function comparableCashRows(
  db: DB, key: ComparabilityKey, departureDate: string, asOf: string, config: AnomalyConfig,
): CashRow[] {
  const since = new Date(
    Date.parse(asOf) - config.award.cpp.maxCashComparableAgeDays * 86_400_000,
  ).toISOString()
  return db.prepare(`
    SELECT price_amount price, price_currency currency, provider,
           verification_level verification, fetched_at fetchedAt,
           CASE WHEN departure_date = ? THEN 1 ELSE 0 END exactDate
    FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ?
      AND (return_date IS NULL) = ?
      AND fetched_at < ? AND fetched_at >= ?
    ORDER BY exactDate DESC, fetched_at DESC
  `).all(
    departureDate, key.origin, key.destination, key.cabin,
    key.tripType === "oneway" ? 1 : 0, asOf, since,
  ) as CashRow[]
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

export function computeCpp(
  db: DB,
  input: {
    key: ComparabilityKey
    departureDate: string
    points: number
    taxesAmount: number | null
    taxesCurrency: string | null
    asOf: string
  },
  config: AnomalyConfig,
): CppResult {
  const none: CppResult = {
    cpp: null, basis: "none", confidence: "INSUFFICIENT",
    cashProvenance: { provider: null, verificationLevel: null, samples: 0, medianPrice: null, currency: null, ageDays: null },
  }
  if (input.points <= 0) return none

  const all = comparableCashRows(db, input.key, input.departureDate, input.asOf, config)
  if (all.length === 0) return none

  // Prefer the exact departure date; fall back to the route window.
  const exact = all.filter(r => r.exactDate === 1)
  const pool = exact.length >= config.award.cpp.minCashSamples ? exact : all

  // One currency only — the most represented one. Mixing is not arithmetic.
  const counts = new Map<string, number>()
  for (const r of pool) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1)
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]!
  const rows = pool.filter(r => r.currency === currency)

  const cashMedian = median(rows.map(r => r.price))
  const newest = rows.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b))
  const ageDays = Math.round(((Date.parse(input.asOf) - Date.parse(newest.fetchedAt)) / 86_400_000) * 10) / 10

  // Surcharges only subtract when they are in the same currency as the fare.
  let surcharge = 0
  if (input.taxesAmount !== null) {
    if (input.taxesCurrency && input.taxesCurrency !== currency) {
      return {
        ...none,
        cashProvenance: {
          provider: newest.provider, verificationLevel: newest.verification,
          samples: rows.length, medianPrice: Math.round(cashMedian * 100) / 100,
          currency, ageDays,
        },
      }
    }
    surcharge = input.taxesAmount
  }

  const net = cashMedian - surcharge
  const anyVerified = rows.some(r => r.verification === "verified")
  const tier = confidenceFor(rows.length, config)

  return {
    // A surcharge above the cash fare means the redemption destroys value;
    // that is a real (negative) answer, not an error.
    cpp: Math.round((net / input.points) * 100 * 1000) / 1000,
    basis: anyVerified ? "verified" : "discovered",
    confidence: tier.label,
    cashProvenance: {
      provider: anyVerified ? "serpapi" : newest.provider,
      verificationLevel: anyVerified ? "verified" : newest.verification,
      samples: rows.length,
      medianPrice: Math.round(cashMedian * 100) / 100,
      currency,
      ageDays,
    },
  }
}

/** §P — is this CPP strong enough to call an award exceptional on its own? */
export function cppIsTrustworthy(cpp: CppResult, config: AnomalyConfig): boolean {
  if (cpp.cpp === null) return false
  if (cpp.cashProvenance.samples < config.award.cpp.minCashSamples) return false
  if ((cpp.cashProvenance.ageDays ?? Infinity) > config.award.cpp.maxCashComparableAgeDays) return false
  return true
}
