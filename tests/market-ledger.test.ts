import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  buildDiyLedger,
  buildPackageLedger,
  comparisonTotalFor,
  isComparisonRefusal,
  itemFor,
  unknownCategories,
} from "../market/ledger.js"
import { makeOffer } from "./package-mocks.js"
import { seedFx as seedFxShared, seedProperty, tripLiteral } from "./market-mocks.js"
import { recordPackageObservations, getPackageObservation } from "../packages/store.js"

function seedFx(db: DB, rate = 0.85874, providerDate = new Date().toISOString().slice(0, 10)): number {
  return seedFxShared(db, { rate, providerDate })
}

let db: DB

beforeEach(() => {
  db = createMemoryDb()
  seedProperty(db)
})

describe("DIY ledger", () => {
  it("maps stored cash components and named unknowns into categorized lines — UNKNOWN never zero", () => {
    const ledger = buildDiyLedger(tripLiteral())
    expect(itemFor(ledger, "airfare")).toMatchObject({ status: "KNOWN", nativeAmount: 1446, nativeCurrency: "USD" })
    expect(itemFor(ledger, "accommodation")).toMatchObject({ status: "KNOWN", nativeAmount: 3405 })
    expect(itemFor(ledger, "hotel_taxes_fees")).toMatchObject({ status: "INCLUDED", nativeAmount: null })
    expect(itemFor(ledger, "transfers")).toMatchObject({ status: "UNKNOWN", nativeAmount: null })
    expect(itemFor(ledger, "baggage")).toMatchObject({ status: "UNKNOWN" })
    expect(itemFor(ledger, "award_taxes")).toMatchObject({ status: "NOT_APPLICABLE" })
    expect(itemFor(ledger, "positioning")).toMatchObject({ status: "NOT_APPLICABLE" })
    expect(unknownCategories(ledger)).toContain("transfers")
    expect(ledger.construction).toBe("diy_cash")
  })

  it("keeps a KNOWN zero as a line — zero and absent are different facts", () => {
    const trip = tripLiteral({
      construction: "award",
      cashComponents: [
        { kind: "award_taxes", amount: 0, currency: "USD", detail: "carrier collects no taxes on this award" },
        { kind: "stay", amount: 3405, currency: "USD", detail: "5n" },
      ],
      milesComponents: [{ program: "LifeMiles", miles: 84000, legs: "outbound" }],
    })
    const ledger = buildDiyLedger(trip)
    expect(itemFor(ledger, "award_taxes")).toMatchObject({ status: "KNOWN", nativeAmount: 0 })
    expect(ledger.construction).toBe("diy_award")
    // Miles ride beside the ledger, never inside the cash lines.
    expect(ledger.milesComponents).toEqual([{ program: "LifeMiles", miles: 84000 }])
    expect(ledger.items.every(i => i.category !== "other" || i.status !== "KNOWN")).toBe(true)
  })

  it("a positioning construction carries its positioning cost as a KNOWN line", () => {
    const trip = tripLiteral({
      construction: "positioning_cash",
      cashComponents: [
        { kind: "airfare", amount: 1200, currency: "USD", detail: "BUD⇄MLE" },
        { kind: "positioning", amount: 54, currency: "USD", detail: "VIE→BUD train ×2" },
        { kind: "stay", amount: 3405, currency: "USD", detail: "5n" },
      ],
    })
    const ledger = buildDiyLedger(trip)
    expect(itemFor(ledger, "positioning")).toMatchObject({ status: "KNOWN", nativeAmount: 54 })
    expect(ledger.construction).toBe("diy_positioning")
  })

  it("stay tax status unknown becomes an UNKNOWN line, not a silent zero", () => {
    const ledger = buildDiyLedger(tripLiteral({ stayDetail: { taxStatus: "unknown" } }))
    expect(itemFor(ledger, "hotel_taxes_fees")).toMatchObject({ status: "UNKNOWN" })
  })
})

describe("package ledger — inclusion mapping, no double counting", () => {
  it("carries ONE known amount (the package total); inclusions carry none", () => {
    const [id] = recordPackageObservations(db, [makeOffer()], null)
    const pkg = getPackageObservation(db, id)!
    const ledger = buildPackageLedger(pkg)
    const known = ledger.items.filter(i => i.status === "KNOWN")
    expect(known).toHaveLength(1)
    expect(known[0]).toMatchObject({ category: "package_total", nativeAmount: 6628, nativeCurrency: "EUR" })
    expect(itemFor(ledger, "airfare")).toMatchObject({ status: "INCLUDED", nativeAmount: null })
    expect(itemFor(ledger, "accommodation")).toMatchObject({ status: "INCLUDED", nativeAmount: null })
    expect(itemFor(ledger, "transfers")).toMatchObject({ status: "INCLUDED" })
    expect(itemFor(ledger, "hotel_taxes_fees")).toMatchObject({ status: "INCLUDED" })
    expect(itemFor(ledger, "baggage")).toMatchObject({ status: "UNKNOWN" })

    // Double-count prevention is arithmetic, not narrative:
    const total = comparisonTotalFor(db, ledger, "EUR")
    expect(isComparisonRefusal(total)).toBe(false)
    if (!isComparisonRefusal(total)) {
      expect(total.total).toBe(6628)                       // exactly once
      expect(total.fxObservationIds).toEqual([])           // native EUR, no FX
    }
  })

  it("a transfer-excluded package carries transfers as UNKNOWN — a missing cost, never zero", () => {
    const [id] = recordPackageObservations(db, [makeOffer({ transfer: "not_included" })], null)
    const ledger = buildPackageLedger(getPackageObservation(db, id)!)
    expect(itemFor(ledger, "transfers")).toMatchObject({ status: "UNKNOWN" })
    expect(itemFor(ledger, "transfers")!.detail).toMatch(/NOT included/)
  })
})

describe("comparison totals through stored FX", () => {
  it("converts USD lines via the stored observation, preserving every native amount", () => {
    const fxId = seedFx(db)
    const ledger = buildDiyLedger(tripLiteral())
    const before = JSON.stringify(ledger.items)
    const total = comparisonTotalFor(db, ledger, "EUR")
    expect(isComparisonRefusal(total)).toBe(false)
    if (!isComparisonRefusal(total)) {
      expect(total.total).toBe(4165.75)                   // (1446+3405) × 0.85874 summed per line
      expect(total.fxObservationIds).toEqual([fxId])
    }
    expect(JSON.stringify(ledger.items)).toBe(before)     // native prices untouched
  })

  it("mixed native currencies sum correctly: EUR lines pass through, USD lines convert", () => {
    seedFx(db, 0.9)
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 1000, currency: "USD", detail: "" },
        { kind: "stay", amount: 2000, currency: "EUR", detail: "" },
      ],
    })
    const total = comparisonTotalFor(db, buildDiyLedger(trip), "EUR")
    if (isComparisonRefusal(total)) throw new Error(total.refusal)
    expect(total.total).toBe(2900)                        // 1000×0.9 + 2000
  })

  it("refuses the WHOLE total when any line cannot reach the comparison currency", () => {
    // No FX stored at all:
    const missing = comparisonTotalFor(db, buildDiyLedger(tripLiteral()), "EUR")
    expect(isComparisonRefusal(missing)).toBe(true)
    if (isComparisonRefusal(missing)) expect(missing.refusal).toMatch(/no stored FX observation/)
    // Stale FX:
    seedFx(db, 0.85874, "2026-07-01")
    const stale = comparisonTotalFor(db, buildDiyLedger(tripLiteral()), "EUR", new Date("2026-08-28T00:00:00Z"))
    expect(isComparisonRefusal(stale)).toBe(true)
    if (isComparisonRefusal(stale)) expect(stale.refusal).toMatch(/stale|older/)
  })

  it("a same-currency ledger needs no FX rows at all", () => {
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 1500, currency: "EUR", detail: "" },
        { kind: "stay", amount: 3000, currency: "EUR", detail: "" },
      ],
    })
    const total = comparisonTotalFor(db, buildDiyLedger(trip), "EUR")   // fx table empty
    if (isComparisonRefusal(total)) throw new Error(total.refusal)
    expect(total.total).toBe(4500)
    expect(total.fxObservationIds).toEqual([])
  })
})
