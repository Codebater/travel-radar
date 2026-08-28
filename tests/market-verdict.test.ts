import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { assessComparability } from "../packages/comparability.js"
import {
  getPackageObservation,
  latestComparisonsForTrip,
  latestPackageObservations,
  createPackageSearchRequest,
  recordPackageComparison,
  recordPackageObservations,
} from "../packages/store.js"
import {
  currentMarketVerdictsForTrip,
  decideMarketVerdict,
  leadVerdict,
  runMarket,
} from "../market/verdict.js"
import type { StoredPackageObservation } from "../packages/store.js"
import type { StoredTrip } from "../trips/store.js"
import { makeOffer } from "./package-mocks.js"
import { insertTripRow, seedFx, seedProperty, tripLiteral } from "./market-mocks.js"

let db: DB

function storedPkg(over: Parameters<typeof makeOffer>[0] = {}): StoredPackageObservation {
  const [id] = recordPackageObservations(db, [makeOffer(over)], null)
  return getPackageObservation(db, id)!
}

function decide(trip: StoredTrip, pkg: StoredPackageObservation) {
  return decideMarketVerdict({ db, trip, pkg, assessment: assessComparability(trip, pkg) })
}

beforeEach(() => {
  db = createMemoryDb()
  seedProperty(db)
})

describe("market verdicts — currency, comparability, asymmetry", () => {
  it("cross-currency USD trip vs EUR package works through fresh stored FX, with the FX row referenced", () => {
    const fxId = seedFx(db)                                // 0.85874, fresh
    const trip = tripLiteral()                             // USD 4,851, transfer unknown
    const pkg = storedPkg()                                // EUR 6,628, transfer included, EXACT
    const d = decide(trip, pkg)
    expect(d.diyKnownTotal).toBe(4165.75)
    expect(d.packageTotal).toBe(6628)
    expect(d.fxObservationIds).toEqual([fxId])
    // DIY leads but its own transfer is unknown → bounded statement, no winner.
    expect(d.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(d.confidence).toBe("LOW")
    expect(d.winner).toBeNull()
    expect(d.absoluteDifference).toBe(-2462.25)
    expect(d.reasons.join(" ")).toMatch(/DIY is currently EUR 2462.25 lower BEFORE the unknown transfers/)
    expect(d.reasons.join(" ")).toMatch(/NOT a saving/)
    expect(d.reasons.join(" ")).toMatch(/recomputes automatically/)
  })

  it("recomputes to a real winner once the unknown transfer becomes a KNOWN ledger line", () => {
    seedFx(db)
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 1446, currency: "USD", detail: "" },
        { kind: "stay", amount: 3405, currency: "USD", detail: "" },
        { kind: "transfer", amount: 350, currency: "USD", detail: "Lily speedboat ×2, priced" },
      ],
      unknownCosts: [],
    })
    const d = decide(trip, storedPkg())
    expect(d.verdict).toBe("BUILD_YOURSELF")
    expect(d.winner).toBe("diy")
    expect(d.confidence).toBe("HIGH")                     // EXACT, no material asymmetry
    expect(d.diyKnownTotal).toBe(4466.31)                 // transfer now inside the total
  })

  it("stale FX refuses numbers entirely — no totals, no winner, the staleness named", () => {
    seedFx(db, { providerDate: "2026-07-01" })
    const d = decide(tripLiteral(), storedPkg())
    expect(d.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(d.confidence).toBe("INSUFFICIENT")
    expect(d.diyKnownTotal).toBeNull()
    expect(d.absoluteDifference).toBeNull()
    expect(d.reasons.join(" ")).toMatch(/stale|older/)
  })

  it("missing FX refuses likewise — a rate is never invented", () => {
    const d = decide(tripLiteral(), storedPkg())
    expect(d.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(d.reasons.join(" ")).toMatch(/no stored FX observation/)
  })

  it("a same-currency pair needs no FX at all", () => {
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 1500, currency: "EUR", detail: "" },
        { kind: "stay", amount: 3000, currency: "EUR", detail: "" },
        { kind: "transfer", amount: 300, currency: "EUR", detail: "priced" },
      ],
      unknownCosts: [],
    })
    const d = decide(trip, storedPkg())                    // fx table EMPTY
    expect(d.verdict).toBe("BUILD_YOURSELF")
    expect(d.fxObservationIds).toEqual([])
    expect(d.diyKnownTotal).toBe(4800)
  })

  it("BUY_PACKAGE stands when the package leads — trailing DIY unknowns are a floor, not a blocker", () => {
    seedFx(db)
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 3000, currency: "USD", detail: "expensive fares" },
        { kind: "stay", amount: 6000, currency: "USD", detail: "" },
      ],
    })                                                     // DIY ≈ €7,728, transfer unknown
    const d = decide(trip, storedPkg())                    // package €6,628 transfer INCLUDED
    expect(d.verdict).toBe("BUY_PACKAGE")
    expect(d.winner).toBe("package")
    expect(d.reasons.join(" ")).toMatch(/floor/)
  })

  it("a leading package with its own unknown transfer is blocked the same way — symmetry of scepticism", () => {
    seedFx(db)
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 3000, currency: "USD", detail: "" },
        { kind: "stay", amount: 6000, currency: "USD", detail: "" },
        { kind: "transfer", amount: 350, currency: "USD", detail: "priced" },
      ],
      unknownCosts: [],
    })
    const d = decide(trip, storedPkg({ transfer: "not_included" }))
    expect(d.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(d.winner).toBeNull()
    expect(d.reasons.join(" ")).toMatch(/package is currently EUR .* lower BEFORE the unknown transfers/)
  })

  it("TOO_CLOSE_TO_CALL inside the noise band — numbers shown, no winner", () => {
    seedFx(db, { rate: 0.85874 })
    const trip = tripLiteral({
      cashComponents: [
        { kind: "airfare", amount: 3000, currency: "EUR", detail: "" },
        { kind: "stay", amount: 3500, currency: "EUR", detail: "" },
        { kind: "transfer", amount: 300, currency: "EUR", detail: "priced" },
      ],
      unknownCosts: [],
    })                                                     // DIY €6,800 vs pkg €6,628 → 2.5%
    const d = decide(trip, storedPkg())
    expect(d.verdict).toBe("TOO_CLOSE_TO_CALL")
    expect(d.winner).toBeNull()
    expect(d.absoluteDifference).toBe(172)
  })

  it("award constructions never get a cash verdict — miles stay beside, not inside", () => {
    seedFx(db)
    const trip = tripLiteral({ milesComponents: [{ program: "LifeMiles", miles: 84000, legs: "out" }] })
    const d = decide(trip, storedPkg())
    expect(d.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(d.reasons.join(" ")).toMatch(/SYNTHETIC_USES_MILES/)
  })

  it("low/insufficient confidence never carries a winner or a savings claim", () => {
    seedFx(db)
    // Destination-level: known different hotel.
    seedProperty(db, "soneva-fushi")
    const context = decide(tripLiteral(), storedPkg({ propertyId: "soneva-fushi" }))
    expect(context.confidence).toBe("LOW")
    expect(context.winner).toBeNull()
    // Bounded-statement case (from the first test) is LOW with winner null too —
    // every non-HIGH/MEDIUM outcome in this suite carries winner === null.
    const bounded = decide(tripLiteral(), storedPkg())
    expect(["LOW", "INSUFFICIENT"]).toContain(bounded.confidence)
    expect(bounded.winner).toBeNull()
  })
})

describe("variant preservation and lead selection", () => {
  it("a cheaper transfer-unknown CLOSE variant must not hide the transfer-included EXACT variant", () => {
    seedFx(db)
    const requestId = createPackageSearchRequest(db, {
      provider: "check24_packages", kind: "confirmation", propertyId: "lily-beach-resort",
      origin: "VIE", rangeStart: "2026-11-19", rangeEnd: "2026-11-24", nights: 5,
      adults: 2, children: 0, currency: "EUR", source: "cli",
    })
    recordPackageObservations(db, [
      makeOffer({ provider: "check24_packages", transfer: "unknown", totalPrice: { amount: 6094, currency: "EUR" }, tourOperator: "AurumTours" }),
      makeOffer({ provider: "check24_packages", transfer: "included", totalPrice: { amount: 6908, currency: "EUR" }, tourOperator: "L'TUR" }),
    ], requestId)

    // BOTH variants survive the current view:
    const current = latestPackageObservations(db)
    expect(current).toHaveLength(2)

    insertTripRow(db)
    const summary = runMarket(db)
    expect(summary.pairsEvaluated).toBe(2)

    const verdicts = currentMarketVerdictsForTrip(db, 1)
    expect(verdicts).toHaveLength(2)
    const lead = leadVerdict(verdicts)!
    const leadPkg = getPackageObservation(db, lead.packageObservationId)!
    // The EXACT (transfer-included, dearer) variant leads; the cheaper CLOSE
    // variant is preserved beside it, not silently discarded.
    expect(lead.comparability).toBe("EXACT_MATCH")
    expect(leadPkg.totalPrice).toBe(6908)
    expect(verdicts.some(v => v.comparability === "CLOSE_MATCH" && v.packageTotal === 6094)).toBe(true)
  })
})

describe("batch supersession — history stays, rankings stay clean", () => {
  it("pre-batch NULL comparison rows are superseded by the first stamped batch", () => {
    insertTripRow(db)
    const pkg = storedPkg()
    // Legacy row without a batch (the ~2.1k pre-filter noise):
    recordPackageComparison(db, {
      tripId: 1, tripKey: "k1", packageObservationId: pkg.id, packageKey: pkg.packageKey,
      comparability: "NOT_COMPARABLE", comparabilityReasons: ["legacy noise"],
      verdict: "INSUFFICIENT_COMPARABILITY", verdictReasons: ["legacy"],
      syntheticTotal: null, syntheticCurrency: null,
      packageTotal: 1, packageCurrency: "EUR",
      knownDifference: null, knownDifferencePct: null, winner: null,
    }, null)
    expect(latestComparisonsForTrip(db, 1)).toHaveLength(1)   // fallback view still shows it

    seedFx(db)
    runMarket(db)
    const current = latestComparisonsForTrip(db, 1)
    expect(current).toHaveLength(1)
    expect(current[0].comparabilityReasons.join(" ")).not.toMatch(/legacy/)
    // The legacy row still EXISTS — append-only history, just not current.
    const all = db.prepare("SELECT COUNT(*) n FROM package_comparisons WHERE trip_id = 1").get() as { n: number }
    expect(all.n).toBe(2)
  })

  it("an FX change does not mutate a historical verdict — a new run creates a new batch instead", () => {
    insertTripRow(db)
    storedPkg({ transfer: "included" })
    seedFx(db, { rate: 0.9 })
    runMarket(db)
    const first = currentMarketVerdictsForTrip(db, 1)
    expect(first[0].diyKnownTotal).toBe(4365.9)           // 4851 × 0.9

    seedFx(db, { rate: 0.8 })                             // the rate moves
    const firstRowAfter = db.prepare("SELECT diy_known_total FROM market_verdicts WHERE id = ?").get(first[0].id) as { diy_known_total: number }
    expect(firstRowAfter.diy_known_total).toBe(4365.9)    // history untouched

    runMarket(db)
    const second = currentMarketVerdictsForTrip(db, 1)
    expect(second[0].diyKnownTotal).toBe(3880.8)          // new batch, new arithmetic (1446×0.8 + 3405×0.8)
    expect(second[0].id).not.toBe(first[0].id)
    // Current view returns ONLY the newest batch:
    expect(second.every(v => v.computeBatch === second[0].computeBatch)).toBe(true)
  })

  it("market observations accumulate as trip-market baseline substrate with strict slot dimensions", () => {
    insertTripRow(db)
    storedPkg()
    seedFx(db)
    runMarket(db)
    const rows = db.prepare("SELECT * FROM trip_market_observations").all() as Record<string, unknown>[]
    expect(rows.length).toBe(2)                            // one DIY + one package construction
    const diy = rows.find(r => (r.construction as string).startsWith("diy_"))!
    const pkg = rows.find(r => (r.construction as string).startsWith("package:"))!
    expect(diy.slot_key).toBe(pkg.slot_key)
    expect(String(diy.slot_key)).toMatch(/^VIE\|lily-beach-resort\|d\d+\|5n\|all_inclusive\|economy\|2a\|EUR$/)
    expect(JSON.parse(diy.unknown_categories as string)).toContain("transfers")
    expect(pkg.known_total_native).toBe(6628)
    expect(pkg.comparison_total).toBe(6628)
    // Sellers/operators are not collapsed:
    expect(String(pkg.construction)).toBe("package:tui_packages:LTUR")
  })
})
