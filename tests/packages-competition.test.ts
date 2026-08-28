import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, nowIso, type DB } from "../db/index.js"
import { assessComparability, hasNightsRelaxation } from "../packages/comparability.js"
import { judgeCompetition, packageCoversUnknown, runCompetition } from "../packages/competition.js"
import { latestComparisonsForTrip, recordPackageObservations } from "../packages/store.js"
import type { StoredTrip } from "../trips/store.js"
import type { StoredPackageObservation } from "../packages/store.js"
import { makeOffer } from "./package-mocks.js"

// ── Shape builders: the engines read plain fields, so literals suffice ──────

function trip(over: Partial<StoredTrip> = {}): StoredTrip {
  return {
    id: 1, tripKey: "VIE|MLE|lily-beach-resort|d20775|5n|all_inclusive|villa|cash|economy|cash|2a",
    origin: "VIE", destinationAirport: "MLE", destinationGroup: "maldives",
    propertyId: "lily-beach-resort", checkIn: "2026-11-19", checkOut: "2026-11-24",
    nights: 5, adults: 2, construction: "cash", cabin: "economy", roomClass: "villa",
    board: "all_inclusive", outboundDeparture: "2026-11-18", returnDeparture: "2026-11-24",
    flightDetail: {}, flightScore: 45, flightProvenance: [],
    stayWindowKey: "w", stayDetail: {}, stayScore: 60, stayProvenance: {},
    cashComponents: [], cashTotal: { amount: 4851, currency: "USD" },
    milesComponents: [], unknownCosts: ["Maldives seaplane/speedboat transfer not priced"],
    score: 71, scoreBreakdown: {}, tripAbsoluteTier: "interesting", tripAbsolutePath: "maldives|all_inclusive|economy",
    complexity: {}, evidence: {}, reasons: [], admissionGate: "STRONG_FLIGHT_STRONG_STAY",
    status: "interesting", rejectionReason: null, createdAt: nowIso(), evaluatedAt: nowIso(),
    ...over,
  }
}

function pkg(over: Partial<StoredPackageObservation> = {}): StoredPackageObservation {
  return {
    id: 10, packageKey: "pkg|tui_packages|g16356|VIE|d20775|medium|all_inclusive|economy|2a0c|EUR",
    provider: "tui_packages", tourOperator: "LTUR",
    propertyId: "lily-beach-resort", providerPropertyRef: "16356", giataId: 16356,
    hotelName: "Lily Beach Resort & Spa", origin: "VIE", destinationAirport: "MLE",
    checkIn: "2026-11-19", checkOut: "2026-11-24", nights: 5,
    tripDeparture: "2026-11-18T15:15:00.000+01:00", tripReturn: "2026-11-24T20:55:00.000+05:00",
    tripDays: 7, adults: 2, children: 0,
    roomName: "Beach Villa", roomClass: "villa", board: "all_inclusive", cabin: "economy",
    flightSegments: { outbound: [], return: [] },
    flightPricePerPerson: 909, hotelPricePerPerson: null, priceSplitSource: "provider",
    baggage: "unknown", transfer: "included", cancellation: "refundable",
    totalPrice: 6628, pricePerPerson: 3314, currency: "EUR", taxesFees: "included",
    unknownInclusions: [], verificationLevel: "confirmed", confidence: "medium",
    fetchedAt: nowIso(), searchRequestId: null, providerIds: {}, providerUrls: {},
    ...over,
  }
}

/** A same-currency world for verdict tests: trip priced in EUR. */
function eurTrip(over: Partial<StoredTrip> = {}): StoredTrip {
  return trip({ cashTotal: { amount: 7000, currency: "EUR" }, ...over })
}

// ── Comparability levels ─────────────────────────────────────────────────────

describe("comparability levels", () => {
  it("EXACT_MATCH: same hotel, occupancy, board, cabin, nights, check-in, transfer known", () => {
    const a = assessComparability(trip(), pkg())
    expect(a.level).toBe("EXACT_MATCH")
    expect(a.reasons.join(" ")).toMatch(/SAME_HOTEL/)
    expect(a.reasons.join(" ")).toMatch(/SAME_NIGHTS/)
    expect(a.reasons.join(" ")).toMatch(/SAME_CHECKIN/)
  })

  it("AI never compares as equivalent to HB — NOT_COMPARABLE, with the reason stored", () => {
    const a = assessComparability(trip(), pkg({ board: "half_board" }))
    expect(a.level).toBe("NOT_COMPARABLE")
    expect(a.reasons[0]).toMatch(/BOARD_MISMATCH/)
  })

  it("an unknown board compares to nothing", () => {
    expect(assessComparability(trip({ board: "unknown" }), pkg()).level).toBe("NOT_COMPARABLE")
    expect(assessComparability(trip(), pkg({ board: "unknown" })).level).toBe("NOT_COMPARABLE")
  })

  it("economy vs business is NOT_COMPARABLE", () => {
    const a = assessComparability(trip({ cabin: "business" }), pkg({ cabin: "economy" }))
    expect(a.level).toBe("NOT_COMPARABLE")
    expect(a.reasons[0]).toMatch(/CABIN_MISMATCH/)
  })

  it("occupancy matters: 2 adults vs 1 adult, and any children, are different products", () => {
    expect(assessComparability(trip(), pkg({ adults: 1 })).level).toBe("NOT_COMPARABLE")
    expect(assessComparability(trip(), pkg({ children: 1 })).level).toBe("NOT_COMPARABLE")
  })

  it("origin matters: a MUC package is no answer to a VIE trip", () => {
    expect(assessComparability(trip(), pkg({ origin: "MUC" })).level).toBe("NOT_COMPARABLE")
  })

  it("check-in shifted inside the 3-day family → CLOSE_MATCH, recorded", () => {
    const a = assessComparability(trip(), pkg({ checkIn: "2026-11-20", checkOut: "2026-11-25" }))
    expect(a.level).toBe("CLOSE_MATCH")
    expect(a.reasons.join(" ")).toMatch(/CHECKIN_SHIFTED_SAME_DATE_FAMILY/)
  })

  it("nights ±1 → CLOSE_MATCH with the relaxation named; further → DESTINATION_LEVEL_ONLY", () => {
    const close = assessComparability(trip(), pkg({ nights: 4, checkOut: "2026-11-23" }))
    expect(close.level).toBe("CLOSE_MATCH")
    expect(hasNightsRelaxation(close)).toBe(true)
    const far = assessComparability(trip(), pkg({ nights: 8, checkOut: "2026-11-27" }))
    expect(far.level).toBe("DESTINATION_LEVEL_ONLY")
  })

  it("a different date family is seasonal context only", () => {
    const a = assessComparability(trip(), pkg({ checkIn: "2026-12-15", checkOut: "2026-12-20" }))
    expect(a.level).toBe("DESTINATION_LEVEL_ONLY")
    expect(a.reasons.join(" ")).toMatch(/DATE_FAMILY_MISMATCH/)
  })

  it("an unknown package transfer caps EXACT to CLOSE — transfers must be reconciled", () => {
    const a = assessComparability(trip(), pkg({ transfer: "unknown" }))
    expect(a.level).toBe("CLOSE_MATCH")
    expect(a.reasons.join(" ")).toMatch(/TRANSFER_STATUS_UNKNOWN/)
  })

  it("weak hotel identity is never hotel-comparable: unmapped hotel → destination level, other destination → nothing", () => {
    const unmapped = assessComparability(trip(), pkg({ propertyId: null }))
    expect(unmapped.level).toBe("DESTINATION_LEVEL_ONLY")
    expect(unmapped.reasons.join(" ")).toMatch(/HOTEL_IDENTITY_UNMAPPED/)
    const elsewhere = assessComparability(trip(), pkg({ propertyId: null, destinationAirport: "CUN" }))
    expect(elsewhere.level).toBe("NOT_COMPARABLE")
  })

  it("a different known hotel in the same destination is market context", () => {
    const a = assessComparability(trip(), pkg({ propertyId: "soneva-fushi" }))
    expect(a.level).toBe("DESTINATION_LEVEL_ONLY")
  })

  it("room class differences cap to CLOSE_MATCH", () => {
    const a = assessComparability(trip({ roomClass: "villa" }), pkg({ roomClass: "suite", roomName: "Beach Suite" }))
    expect(a.level).toBe("CLOSE_MATCH")
    expect(a.reasons.join(" ")).toMatch(/ROOM_CLASS_DIFFERS/)
  })
})

// ── Verdicts ─────────────────────────────────────────────────────────────────

describe("BUILD-vs-BUY verdicts", () => {
  it("BUY_PACKAGE when the package decisively beats the known DIY total in the same currency", () => {
    const t = eurTrip({ unknownCosts: [] })
    const p = pkg({ totalPrice: 6000 })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("BUY_PACKAGE")
    expect(v.winner).toBe("package")
    expect(v.knownDifference).toBe(1000)
    expect(v.knownDifferencePct).toBeCloseTo(14.3, 1)
  })

  it("BUILD_YOURSELF when DIY decisively wins and carries no unknowns the package covers", () => {
    const t = eurTrip({ cashTotal: { amount: 5000, currency: "EUR" }, unknownCosts: [] })
    const p = pkg({ totalPrice: 6628 })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("BUILD_YOURSELF")
    expect(v.winner).toBe("diy")
    expect(v.knownDifference).toBe(-1628)
  })

  it("UNKNOWN_COSTS_PREVENT_VERDICT: DIY appears cheaper but the package includes the transfer DIY has not priced — the Lily case", () => {
    const t = eurTrip({ cashTotal: { amount: 5000, currency: "EUR" } })   // unknown transfer named by default
    const p = pkg({ totalPrice: 6000, transfer: "included" })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("UNKNOWN_COSTS_PREVENT_VERDICT")
    expect(v.winner).toBeNull()
    expect(v.knownDifference).toBe(-1000)                 // the known difference is still shown
    expect(v.verdictReasons.join(" ")).toMatch(/package includes what DIY has not priced/)
    expect(v.verdictReasons.join(" ")).toMatch(/NOT a final saving/)
  })

  it("a package win survives DIY unknowns: they could only widen the margin (floor reasoning)", () => {
    const t = eurTrip()                                    // transfer unknown on DIY side
    const p = pkg({ totalPrice: 6000, transfer: "included" })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("BUY_PACKAGE")
    expect(v.verdictReasons.join(" ")).toMatch(/SYNTHETIC_UNKNOWNS_ONLY_STRENGTHEN/)
  })

  it("symmetric unknowns do not block a DIY win when the package does not cover them either", () => {
    const t = eurTrip({ cashTotal: { amount: 5000, currency: "EUR" } })
    const p = pkg({ totalPrice: 6628, transfer: "not_included" })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("BUILD_YOURSELF")
    expect(v.verdictReasons.join(" ")).toMatch(/symmetric unknowns/)
  })

  it("cross-currency pairs never claim monetary savings — INSUFFICIENT_COMPARABILITY with both totals shown", () => {
    const t = trip()                                       // USD 4,851 DIY vs EUR package
    const p = pkg({ totalPrice: 6628 })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(v.knownDifference).toBeNull()
    expect(v.syntheticTotal).toBe(4851)
    expect(v.packageTotal).toBe(6628)
    expect(v.verdictReasons.join(" ")).toMatch(/CURRENCY_MISMATCH/)
    expect(v.verdictReasons.join(" ")).toMatch(/transfer/)   // the DIY unknown is also named
  })

  it("a mixed-currency DIY total (cashTotal null) cannot be compared", () => {
    const t = trip({ cashTotal: null })
    const p = pkg()
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(v.verdictReasons.join(" ")).toMatch(/SYNTHETIC_CASH_TOTAL_UNAVAILABLE/)
  })

  it("a cash package total cannot price an award construction", () => {
    const t = eurTrip({ milesComponents: [{ program: "LifeMiles", miles: 84000, legs: "outbound" }] })
    const p = pkg({ totalPrice: 1 })
    const v = judgeCompetition(t, p, assessComparability(t, p))
    expect(v.verdict).toBe("INSUFFICIENT_COMPARABILITY")
    expect(v.verdictReasons.join(" ")).toMatch(/SYNTHETIC_USES_MILES/)
  })

  it("a package apparently cheaper only because the products differ (4n vs 5n) is context, never a win", () => {
    const t = eurTrip({ unknownCosts: [] })
    const p = pkg({ nights: 4, checkOut: "2026-11-23", totalPrice: 5818 })
    const a = assessComparability(t, p)
    expect(a.level).toBe("CLOSE_MATCH")
    const v = judgeCompetition(t, p, a)
    expect(v.verdict).toBe("ROUGH_CONTEXT_ONLY")
    expect(v.winner).toBeNull()
    expect(v.verdictReasons.join(" ")).toMatch(/MONETARY_VERDICT_REQUIRES_EQUAL_NIGHTS/)
  })

  it("a margin inside the noise threshold is context, not a verdict — and a computed zero is stored, not dropped", () => {
    const t = eurTrip({ cashTotal: { amount: 6000, currency: "EUR" }, unknownCosts: [] })
    const near = judgeCompetition(t, pkg({ totalPrice: 5900 }), assessComparability(t, pkg({ totalPrice: 5900 })))
    expect(near.verdict).toBe("ROUGH_CONTEXT_ONLY")
    expect(near.verdictReasons.join(" ")).toMatch(/DIFFERENCE_WITHIN_NOISE/)
    const tie = judgeCompetition(t, pkg({ totalPrice: 6000 }), assessComparability(t, pkg({ totalPrice: 6000 })))
    expect(tie.knownDifference).toBe(0)                   // computed zero kept visible
    expect(tie.verdict).toBe("ROUGH_CONTEXT_ONLY")
  })

  it("DESTINATION_LEVEL_ONLY pairs get ROUGH_CONTEXT_ONLY; NOT_COMPARABLE pairs get INSUFFICIENT_COMPARABILITY", () => {
    const t = eurTrip()
    const context = pkg({ propertyId: "soneva-fushi" })
    expect(judgeCompetition(t, context, assessComparability(t, context)).verdict).toBe("ROUGH_CONTEXT_ONLY")
    const alien = pkg({ board: "breakfast" })
    expect(judgeCompetition(t, alien, assessComparability(t, alien)).verdict).toBe("INSUFFICIENT_COMPARABILITY")
  })

  it("packageCoversUnknown matches on evidence, not vibes", () => {
    expect(packageCoversUnknown("Maldives transfer not priced", pkg({ transfer: "included" }))).toBe(true)
    expect(packageCoversUnknown("Maldives transfer not priced", pkg({ transfer: "not_included" }))).toBe(false)
    expect(packageCoversUnknown("hotel taxes unknown", pkg({ taxesFees: "included" }))).toBe(true)
    expect(packageCoversUnknown("resort dress code", pkg())).toBe(false)
  })
})

// ── End-to-end over the database ─────────────────────────────────────────────

describe("runCompetition", () => {
  let db: DB

  function seedProperty(id: string): void {
    db.prepare(`
      INSERT INTO stay_properties (id, name, destination_group, country, nearest_airports, luxury_tier,
        all_inclusive, default_board, typical_stay_nights, priority, active, created_at, updated_at)
      VALUES (?, ?, 'maldives', 'Maldives', '["MLE"]', 'luxury', 'only', 'all_inclusive', '[5,7]', 1, 1, ?, ?)
    `).run(id, id, nowIso(), nowIso())
  }

  function insertTrip(over: Partial<Record<string, unknown>> = {}): void {
    const t = {
      trip_key: "k1", origin: "VIE", destination_airport: "MLE", destination_group: "maldives",
      property_id: "lily-beach-resort", check_in: "2026-11-19", check_out: "2026-11-24",
      nights: 5, adults: 2, construction: "cash", cabin: "economy", room_class: "villa",
      board: "all_inclusive", outbound_departure: "2026-11-18", return_departure: "2026-11-24",
      flight_detail: "{}", flight_score: 45, flight_provenance: "[]",
      stay_window_key: "w", stay_detail: "{}", stay_score: 60, stay_provenance: "{}",
      cash_components: "[]", cash_total_amount: 4851, cash_total_currency: "USD",
      miles_components: "[]", unknown_costs: JSON.stringify(["Maldives transfer not priced"]),
      score: 71, score_breakdown: "{}", trip_absolute_tier: null, trip_absolute_path: "none",
      complexity: "{}", evidence: "{}", reasons: "[]", admission_gate: "g", status: "interesting",
      rejection_reason: null, created_at: nowIso(), evaluated_at: nowIso(),
      ...over,
    }
    const cols = Object.keys(t)
    db.prepare(
      `INSERT INTO trip_opportunities (${cols.join(",")}) VALUES (${cols.map(c => "@" + c).join(",")})`,
    ).run(t)
  }

  beforeEach(() => {
    db = createMemoryDb()
    seedProperty("lily-beach-resort")
  })

  it("pairs stored trips with fresh package observations and appends auditable comparisons", () => {
    insertTrip()
    recordPackageObservations(db, [makeOffer()], null)
    const summary = runCompetition(db)
    expect(summary.tripsExamined).toBe(1)
    expect(summary.pairsEvaluated).toBe(1)
    expect(summary.comparisonsStored).toBe(1)
    expect(summary.byVerdict.INSUFFICIENT_COMPARABILITY).toBe(1)   // USD trip vs EUR package

    const stored = latestComparisonsForTrip(db, 1)
    expect(stored).toHaveLength(1)
    expect(stored[0].comparability).toBe("EXACT_MATCH")
    expect(stored[0].comparabilityReasons.length).toBeGreaterThan(0)
    expect(stored[0].verdictReasons.join(" ")).toMatch(/CURRENCY_MISMATCH/)
  })

  it("excludes stale package observations from verdicts and reports the exclusion", () => {
    insertTrip()
    recordPackageObservations(db, [makeOffer({ fetchedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })], null)
    const summary = runCompetition(db)
    expect(summary.pairsEvaluated).toBe(0)
    expect(summary.stalePackagesSkipped).toBe(1)
  })

  it("re-running appends new rows; the latest per pair wins the read", () => {
    insertTrip()
    recordPackageObservations(db, [makeOffer()], null)
    // Distinct injected clocks — same-millisecond runs must not share a batch.
    runCompetition(db, { now: new Date("2026-08-28T10:00:00.000Z") })
    runCompetition(db, { now: new Date("2026-08-28T11:00:00.000Z") })
    const all = db.prepare("SELECT COUNT(*) n FROM package_comparisons").get() as { n: number }
    expect(all.n).toBe(2)
    expect(latestComparisonsForTrip(db, 1)).toHaveLength(1)
  })
})
