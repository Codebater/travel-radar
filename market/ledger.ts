/**
 * Cost-inclusion ledgers — the normalization that makes constructions
 * comparable at all.
 *
 * Every trip construction (DIY or package) gets one ledger with a line per
 * cost category. A line is KNOWN (a number with a currency), INCLUDED
 * (covered by another KNOWN line — carries NO amount, so nothing can be
 * double-counted), UNKNOWN (named, never zero), or NOT_APPLICABLE. Miles ride
 * beside the ledger, never inside it — a cash ledger cannot price miles.
 *
 * Comparison totals are derived VIEWS: each KNOWN line converts to the
 * comparison currency through a stored FX observation (identity when the
 * currency already matches), and the ids of every FX row used are returned
 * so the arithmetic stays reproducible.
 */

import { type DB } from "../db/index.js"
import type { StoredPackageObservation } from "../packages/store.js"
import type { StoredTrip } from "../trips/store.js"
import { convertVia, isFxRefusal } from "./fx.js"

export type LedgerStatus = "KNOWN" | "INCLUDED" | "UNKNOWN" | "NOT_APPLICABLE"

export type LedgerCategory =
  | "airfare"
  | "award_taxes"
  | "accommodation"
  | "hotel_taxes_fees"
  | "transfers"
  | "baggage"
  | "positioning"
  | "package_total"
  | "other"

export interface LedgerItem {
  category: LedgerCategory
  status: LedgerStatus
  /** Present exactly when status is KNOWN. Native, never converted in place. */
  nativeAmount: number | null
  nativeCurrency: string | null
  detail: string
}

export interface CostLedger {
  construction: string
  items: LedgerItem[]
  /** Miles per program — shown beside cash, never blended into it. */
  milesComponents: { program: string; miles: number }[]
}

export function unknownCategories(ledger: CostLedger): LedgerCategory[] {
  return ledger.items.filter(i => i.status === "UNKNOWN").map(i => i.category)
}

export function itemFor(ledger: CostLedger, category: LedgerCategory): LedgerItem | undefined {
  return ledger.items.find(i => i.category === category)
}

/** DIY construction labels from the trip's stored construction. */
export function diyConstructionLabel(construction: string): string {
  switch (construction) {
    case "cash": return "diy_cash"
    case "award": return "diy_award"
    case "positioning_cash": return "diy_positioning"
    case "open_jaw": return "diy_open_jaw"
    default: return `diy_${construction}`
  }
}

export function packageConstructionLabel(pkg: StoredPackageObservation): string {
  return `package:${pkg.provider}:${pkg.tourOperator ?? "?"}`
}

interface RawCashComponent { kind?: unknown; amount?: unknown; currency?: unknown; detail?: unknown }

const COMPONENT_CATEGORY: Record<string, LedgerCategory> = {
  airfare: "airfare",
  award_taxes: "award_taxes",
  positioning: "positioning",
  stay: "accommodation",
  transfer: "transfers",
}

export function buildDiyLedger(trip: StoredTrip): CostLedger {
  const items: LedgerItem[] = []
  const have = new Set<LedgerCategory>()

  for (const raw of trip.cashComponents as RawCashComponent[]) {
    const category = COMPONENT_CATEGORY[String(raw?.kind)]
    if (!category) continue
    const amount = typeof raw.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : null
    const currency = typeof raw.currency === "string" ? raw.currency : null
    if (amount === null || !currency) continue           // an unpriced component observes nothing
    items.push({
      category, status: "KNOWN", nativeAmount: amount, nativeCurrency: currency,
      detail: typeof raw.detail === "string" ? raw.detail : `${category} (stored trip component)`,
    })
    have.add(category)
  }

  // Hotel taxes: the stay side's stated tax status, unless a KNOWN line exists.
  const taxStatus = String((trip.stayDetail as Record<string, unknown>).taxStatus ?? "unknown")
  if (!have.has("hotel_taxes_fees")) {
    if (taxStatus === "included") {
      items.push({
        category: "hotel_taxes_fees", status: "INCLUDED", nativeAmount: null, nativeCurrency: null,
        detail: "included in the accommodation amount (provider-stated tax-inclusive rate)",
      })
    } else {
      items.push({
        category: "hotel_taxes_fees", status: "UNKNOWN", nativeAmount: null, nativeCurrency: null,
        detail: `stay tax status is "${taxStatus}" — amount not established`,
      })
    }
    have.add("hotel_taxes_fees")
  }

  // Named unknowns from the composer, deduped against lines already present.
  for (const unknown of trip.unknownCosts) {
    const category: LedgerCategory =
      /transfer/i.test(unknown) ? "transfers"
      : /tax|fee/i.test(unknown) ? "hotel_taxes_fees"
      : /baggage|luggage/i.test(unknown) ? "baggage"
      : "other"
    if (have.has(category)) continue
    items.push({ category, status: "UNKNOWN", nativeAmount: null, nativeCurrency: null, detail: unknown })
    have.add(category)
  }

  if (!have.has("transfers")) {
    items.push({
      category: "transfers", status: "UNKNOWN", nativeAmount: null, nativeCurrency: null,
      detail: "ground/sea transfer need not established for this destination",
    })
  }
  if (!have.has("baggage")) {
    items.push({
      category: "baggage", status: "UNKNOWN", nativeAmount: null, nativeCurrency: null,
      detail: "fare baggage allowance not tracked by the radar",
    })
  }
  if (!have.has("award_taxes")) {
    items.push({
      category: "award_taxes",
      status: trip.milesComponents.length > 0 ? "UNKNOWN" : "NOT_APPLICABLE",
      nativeAmount: null, nativeCurrency: null,
      detail: trip.milesComponents.length > 0
        ? "award construction without a stored taxes component"
        : "cash construction",
    })
  }
  if (!have.has("positioning")) {
    items.push({
      category: "positioning",
      status: trip.construction === "positioning_cash" ? "UNKNOWN" : "NOT_APPLICABLE",
      nativeAmount: null, nativeCurrency: null,
      detail: trip.construction === "positioning_cash"
        ? "positioning construction without a stored positioning component"
        : "no positioning leg in this construction",
    })
  }

  return {
    construction: diyConstructionLabel(trip.construction),
    items,
    milesComponents: trip.milesComponents.map(m => ({ program: m.program, miles: m.miles })),
  }
}

export function buildPackageLedger(pkg: StoredPackageObservation): CostLedger {
  const items: LedgerItem[] = [
    {
      category: "package_total", status: "KNOWN",
      nativeAmount: pkg.totalPrice, nativeCurrency: pkg.currency,
      detail: `${pkg.provider}${pkg.tourOperator ? `/${pkg.tourOperator}` : ""} package total, ${pkg.adults} adults`,
    },
    // The mapping of what the total already contains — INCLUDED lines carry
    // no amount, so the total can never be double-counted.
    { category: "airfare", status: "INCLUDED", nativeAmount: null, nativeCurrency: null, detail: "flights inside the package total" },
    { category: "accommodation", status: "INCLUDED", nativeAmount: null, nativeCurrency: null, detail: `${pkg.nights} hotel nights (${pkg.board}) inside the package total` },
    pkg.taxesFees === "included"
      ? { category: "hotel_taxes_fees", status: "INCLUDED", nativeAmount: null, nativeCurrency: null, detail: "final-price package total (tax-inclusive)" }
      : { category: "hotel_taxes_fees", status: "UNKNOWN", nativeAmount: null, nativeCurrency: null, detail: `package tax status is "${pkg.taxesFees}"` },
    pkg.transfer === "included"
      ? { category: "transfers", status: "INCLUDED", nativeAmount: null, nativeCurrency: null, detail: "transfer inside the package total" }
      : {
          category: "transfers", status: "UNKNOWN", nativeAmount: null, nativeCurrency: null,
          detail: pkg.transfer === "not_included"
            ? "transfer NOT included in the package; its cost is unknown"
            : "transfer inclusion not stated by the seller",
        },
    pkg.baggage === "included"
      ? { category: "baggage", status: "INCLUDED", nativeAmount: null, nativeCurrency: null, detail: "baggage inside the package total" }
      : { category: "baggage", status: "UNKNOWN", nativeAmount: null, nativeCurrency: null, detail: "baggage allowance not stated" },
    { category: "award_taxes", status: "NOT_APPLICABLE", nativeAmount: null, nativeCurrency: null, detail: "cash package" },
    { category: "positioning", status: "NOT_APPLICABLE", nativeAmount: null, nativeCurrency: null, detail: "no positioning leg" },
  ]
  return { construction: packageConstructionLabel(pkg), items, milesComponents: [] }
}

// ── Comparison totals (derived views, FX-referenced) ─────────────────────────

export interface ComparisonTotal {
  total: number
  currency: string
  /** Ids of every FX observation used; [] when everything was native. */
  fxObservationIds: number[]
}

export interface ComparisonRefusal {
  refusal: string
}

/**
 * Sum the KNOWN lines in the comparison currency. Any line that cannot reach
 * it (missing pair, no observation, stale observation) refuses the whole
 * total — a partial total would silently treat the unconvertible part as
 * zero, which is exactly the lie this module exists to prevent.
 */
export function comparisonTotalFor(
  db: DB, ledger: CostLedger, comparisonCurrency: string, now = new Date(),
): ComparisonTotal | ComparisonRefusal {
  const known = ledger.items.filter(i => i.status === "KNOWN")
  if (known.length === 0) return { refusal: "no KNOWN cost lines" }
  let total = 0
  const fxIds = new Set<number>()
  for (const item of known) {
    const converted = convertVia(db, item.nativeAmount!, item.nativeCurrency!, comparisonCurrency, now)
    if (isFxRefusal(converted)) {
      return { refusal: `${item.category}: ${converted.detail}` }
    }
    total += converted.amount
    if (converted.fxObservationId !== 0) fxIds.add(converted.fxObservationId)
  }
  return { total: Math.round(total * 100) / 100, currency: comparisonCurrency, fxObservationIds: [...fxIds] }
}

export function isComparisonRefusal(v: ComparisonTotal | ComparisonRefusal): v is ComparisonRefusal {
  return (v as ComparisonRefusal).refusal !== undefined
}
