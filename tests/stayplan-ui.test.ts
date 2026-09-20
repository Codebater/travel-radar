/**
 * Life-Perk Stay Planner presentation models (stayplan-ui.js) — trip-length
 * presets, the calendar/timeline render model, and the honesty of every
 * formatted figure.
 *
 * Pinned: 7/14/30-day presets compute exact check-outs (month and year
 * boundaries included) and dates stay editable (a custom range simply has no
 * active preset); calendar blocks sit at EXACT segment boundaries; full
 * coverage produces no gap blocks; gaps stay visible with their exact dates;
 * per-night figures are never multiplied into totals; a per-night-only
 * program reads "Stay total unavailable"; no combined cross-program figure
 * can be produced; explanations claim no savings.
 */

import { describe, expect, it } from "vitest"
import {
  TRIP_PRESETS, activePreset, calendarModel, planExplanation, presetCheckout,
  programTotalText, segmentPriceText, summaryModel,
  evidenceAgeDays, evidenceText, payForText, perkAttribution, heldSummary, nothingDeclared,
  segmentWindows, gapWindows, bookingChecklist, heldForProgramTotal, BALANCE_KEYS_FOR_PROGRAM,
} from "../stayplan-ui.js"

const UI = {
  TRIP_PRESETS, activePreset, calendarModel, planExplanation, presetCheckout,
  programTotalText, segmentPriceText, summaryModel,
  evidenceAgeDays, evidenceText, payForText, perkAttribution, heldSummary, nothingDeclared,
  segmentWindows, gapWindows, bookingChecklist, heldForProgramTotal, BALANCE_KEYS_FOR_PROGRAM,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plan(over: Record<string, unknown> = {}): any {
  return {
    coveredNights: 10, requestedNights: 10, switches: 1,
    segments: [
      { propertyName: "JW Marriott Bangkok", program: "MARRIOTT_BONVOY", provider: "roame_hotels", providerPropertyRef: "jw",
        checkIn: "2026-11-01", checkOut: "2026-11-06", nights: 5, quoteBasis: "per_night", pointsPerNight: 50000, pointsTotal: null },
      { propertyName: "Grand Hyatt", program: "WORLD_OF_HYATT", provider: "gondola_hotels", providerPropertyRef: "gh",
        checkIn: "2026-11-06", checkOut: "2026-11-11", nights: 5, quoteBasis: "full_stay", pointsPerNight: 17500, pointsTotal: 87500 },
    ],
    uncoveredDates: [],
    programTotals: [
      { program: "MARRIOTT_BONVOY", statedTotal: null, statedSegments: 0, perNightOnlySegments: 1 },
      { program: "WORLD_OF_HYATT", statedTotal: 87500, statedSegments: 1, perNightOnlySegments: 0 },
    ],
    appliedPerkNights: 0,
    signature: "x",
    ...over,
  }
}

describe("quick trip-length presets", () => {
  it("7/14/30 days compute the exact check-out from check-in", () => {
    expect(UI.presetCheckout("2026-11-01", 7)).toBe("2026-11-08")
    expect(UI.presetCheckout("2026-11-01", 14)).toBe("2026-11-15")
    expect(UI.presetCheckout("2026-11-01", 30)).toBe("2026-12-01")
  })

  it("handles month and year boundaries exactly", () => {
    expect(UI.presetCheckout("2026-12-28", 7)).toBe("2027-01-04")
    expect(UI.presetCheckout("2026-02-27", 14)).toBe("2026-03-13")     // 2026 is not a leap year
    expect(UI.presetCheckout("2028-02-27", 14)).toBe("2028-03-12")     // 2028 is
  })

  it("only the fixed presets exist; malformed dates yield null, never a guess", () => {
    expect(UI.TRIP_PRESETS).toEqual([7, 14, 30])
    expect(UI.presetCheckout("2026-11-01", 9)).toBeNull()
    expect(UI.presetCheckout("not-a-date", 7)).toBeNull()
  })

  it("activePreset reflects the current dates and goes null for custom ranges — dates stay editable", () => {
    expect(UI.activePreset("2026-11-01", "2026-11-08")).toBe(7)
    expect(UI.activePreset("2026-11-01", "2026-12-01")).toBe(30)
    expect(UI.activePreset("2026-11-01", "2026-11-13")).toBeNull()     // 12 nights = custom
    expect(UI.activePreset("2026-11-01", "2026-10-01")).toBeNull()     // inverted
  })
})

describe("calendar render model", () => {
  it("renders every requested night as a column and blocks at EXACT segment boundaries", () => {
    const m = UI.calendarModel(plan(), "2026-11-01", 10)
    expect(m.days).toHaveLength(10)
    expect(m.days[0]).toMatchObject({ date: "2026-11-01", col: 1, dayOfMonth: 1, weekday: "Su", monthLabel: "November 2026" })
    expect(m.days[9].date).toBe("2026-11-10")
    const stays = m.blocks.filter((b: any) => b.kind === "stay")
    expect(stays).toHaveLength(2)
    expect(stays[0]).toMatchObject({ startCol: 1, span: 5, checkIn: "2026-11-01", checkOut: "2026-11-06" })
    expect(stays[1]).toMatchObject({ startCol: 6, span: 5, checkIn: "2026-11-06", checkOut: "2026-11-11" })
  })

  it("full coverage produces NO gap blocks", () => {
    const m = UI.calendarModel(plan(), "2026-11-01", 10)
    expect(m.blocks.filter((b: any) => b.kind === "gap")).toEqual([])
    // The stay blocks tile the whole range: 1..10 with no hole.
    const covered = new Set<number>()
    for (const b of m.blocks) for (let c = b.startCol; c < b.startCol + b.span; c++) covered.add(c)
    expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it("gaps stay visible as explicit blocks with their exact dates — never filled in", () => {
    const gappy = plan({
      coveredNights: 5,
      segments: [
        { propertyName: "JW Marriott Bangkok", program: "MARRIOTT_BONVOY", provider: "roame_hotels", providerPropertyRef: "jw",
          checkIn: "2026-11-01", checkOut: "2026-11-04", nights: 3, quoteBasis: "per_night", pointsPerNight: 50000, pointsTotal: null },
        { propertyName: "Grand Hyatt", program: "WORLD_OF_HYATT", provider: "gondola_hotels", providerPropertyRef: "gh",
          checkIn: "2026-11-07", checkOut: "2026-11-09", nights: 2, quoteBasis: "full_stay", pointsPerNight: 17500, pointsTotal: 35000 },
      ],
      uncoveredDates: ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"],
    })
    const gaps = UI.calendarModel(gappy, "2026-11-01", 10).blocks.filter((b: any) => b.kind === "gap")
    expect(gaps).toEqual([
      { kind: "gap", startCol: 4, span: 3, dates: ["2026-11-04", "2026-11-05", "2026-11-06"] },
      { kind: "gap", startCol: 9, span: 2, dates: ["2026-11-09", "2026-11-10"] },
    ])
  })

  it("marks month starts and weekends; a month boundary inside the range gets its label", () => {
    const m = UI.calendarModel(plan(), "2026-11-28", 6)                // Nov 28 → Dec 4
    const labels = m.days.filter((d: any) => d.monthLabel)
    expect(labels.map((d: any) => d.monthLabel)).toEqual(["November 2026", "December 2026"])
    expect(labels[1].col).toBe(4)                                      // Dec 1 is the 4th column
    expect(m.days.filter((d: any) => d.isWeekend).map((d: any) => d.date))
      .toEqual(["2026-11-28", "2026-11-29"])                           // Sa, Su
  })
})

describe("figure honesty", () => {
  it("a per-night segment shows per-night only — a 50,000 pts/night × 5n segment never shows 250,000", () => {
    const t = UI.segmentPriceText(plan().segments[0])
    expect(t.main).toBe("50,000 pts/night")
    expect(t.sub).toContain("no stay total stated")
    expect(JSON.stringify(t)).not.toContain("250,000")
  })

  it("a source-stated stay total is shown as such", () => {
    const t = UI.segmentPriceText(plan().segments[1])
    expect(t.main).toBe("87,500 pts total")
    expect(t.sub).toBe("source-stated stay total")
  })

  it('a program with per-night-only observations reads "Stay total unavailable"', () => {
    expect(UI.programTotalText(plan().programTotals[0])).toContain("Stay total unavailable")
    expect(UI.programTotalText(plan().programTotals[1])).toBe("87,500 pts (1 source-stated stay total)")
  })

  it("the summary keeps programs separate — there is no combined points field to render", () => {
    const s = UI.summaryModel(plan())
    expect(s.programLines).toHaveLength(2)
    expect(JSON.stringify(s)).not.toContain("337")                     // no 87,500 + 50,000×5 hybrid anywhere
    expect(s.coveredNights).toBe(10)
    expect(s.switches).toBe(1)
    expect(s.appliedFreeNights).toBe(0)                                // no perk summary → nothing assumed
  })

  it("explanations state coverage and perks without savings claims or invented values", () => {
    const withPerks = plan({
      perkSummary: {
        appliedFreeNights: 1,
        applied: [{ ruleId: "r", badgeLabel: "5TH NIGHT BENEFIT", program: "MARRIOTT_BONVOY", count: 1, freeNights: 1, annotationOnly: false }],
        annotations: [], qualifiesUnpriced: [], certificatesConsumed: [],
      },
    })
    const text = UI.planExplanation(withPerks, "life_perks").join(" ")
    expect(text).toContain("Covers all 10 nights")
    expect(text).toContain("1 verified free-night benefit")
    expect(text).toContain("No synthetic stay totals were used")
    expect(text).not.toMatch(/sav(e|ing)/i)
    expect(text).not.toMatch(/\$|worth/i)
    const bare = UI.planExplanation(plan(), "fewest_switches").join(" ")
    expect(bare).toContain("No verified perk currently applies — entitlements are declared, never assumed")
  })

  it("a partial plan's explanation names the uncovered nights problem instead of hiding it", () => {
    const partial = plan({ coveredNights: 7, uncoveredDates: ["2026-11-08", "2026-11-09", "2026-11-10"] })
    const text = UI.planExplanation(partial, "life_perks").join(" ")
    expect(text).toContain("Covers 7 of 10 nights")
    expect(text).toContain("full coverage is impossible with stored observations")
  })
})

const EVIDENCE = {
  fetchedAt: "2026-08-29T08:30:41.423Z", availabilityState: "unknown", searchState: "complete",
  verificationLevel: "discovered", sourceFreshness: null, taxesFeesState: "unknown",
  taxesFeesAmount: null, taxesFeesCurrency: null, roomName: "1 King Bed", roomClass: "GuestRoom",
  sourceProgramName: "MARRIOTT", awardType: "points", cashComparisonAmount: 104, cashComparisonCurrency: "USD",
}

describe("evidence text — facts, never a score", () => {
  it("counts whole days between observation and now", () => {
    expect(UI.evidenceAgeDays("2026-08-29T08:30:41.423Z", "2026-09-06T12:00:00Z")).toBe(8)
    expect(UI.evidenceAgeDays("garbage", "2026-09-06T12:00:00Z")).toBeNull()
  })

  it("renders unknown taxes as unknown, a stated amount only when stated, and never a '*'", () => {
    const seg = { ...plan().segments[0], evidence: EVIDENCE }
    const t = UI.evidenceText(seg, "2026-09-06T12:00:00Z")
    expect(t.ageDays).toBe(8)
    expect(t.line).toContain("observed 2026-08-29 · 8 days ago")
    expect(t.line).toContain("availability unknown")
    expect(t.line).toContain("taxes/fees unknown")
    expect(t.line).toContain("1 King Bed · GuestRoom")
    expect(t.line).not.toContain("*")
    const stated = UI.evidenceText({ ...seg, evidence: { ...EVIDENCE, taxesFeesState: "stated", taxesFeesAmount: 38.5, taxesFeesCurrency: "USD" } }, "2026-09-06T12:00:00Z")
    expect(stated.line).toContain("taxes/fees stated 38.5 USD")
    expect(UI.evidenceText(plan().segments[0]).line).toBe("provenance not available")
  })

  it("the explanation states evidence age and that nothing is a live hold — still no savings claim", () => {
    const p = plan({ evidence: { oldestFetchedAt: "2026-08-28T19:05:37.809Z", newestFetchedAt: "2026-08-29T08:30:41.423Z", availabilityUnknownSegments: 2, verificationLevels: { discovered: 2 } } })
    const text = UI.planExplanation(p, "life_perks", "2026-09-06T12:00:00Z").join(" ")
    expect(text).toContain("Evidence is 8 to 8 days old".replace("8 to 8 days old", "8 days old"))
    expect(text).toContain("nothing here is a live hold")
    expect(text).not.toMatch(/sav(e|ing)/i)
    expect(text).not.toMatch(/\$|worth/i)
  })
})

describe("perk truth on cards", () => {
  const applied = { ruleId: "r", badgeLabel: "5TH NIGHT BENEFIT", program: "MARRIOTT_BONVOY", state: "applied", reason: "applied",
    freeNights: 1, affectsArithmetic: true, bookingConditions: [], requires: [], satisfiedBy: ["membership:MARRIOTT_BONVOY"] }
  it("'Stay for N, pay for N−k' is a night-count subtraction and only for applied arithmetic perks", () => {
    expect(UI.payForText({ nights: 5 }, applied)).toBe("Stay for 5, pay for 4")
    expect(UI.payForText({ nights: 7 }, applied)).toBe("Stay for 7, pay for 6")
    expect(UI.payForText({ nights: 5 }, { ...applied, state: "qualifies_but_unpriced" })).toBeNull()
    expect(UI.payForText({ nights: 5 }, { ...applied, affectsArithmetic: false, freeNights: 0 })).toBeNull()
    expect(UI.payForText({ nights: 1 }, applied)).toBeNull()
  })

  it("attribution names the DECLARED key kind; nothing declared → null", () => {
    expect(UI.perkAttribution({ ...applied, satisfiedBy: ["card:IHG_PREMIER_CARD"] })).toBe("Card benefit")
    expect(UI.perkAttribution({ ...applied, satisfiedBy: ["status:HILTON_DIAMOND"] })).toBe("Hilton Diamond benefit")
    expect(UI.perkAttribution(applied)).toBe("Member benefit")
    expect(UI.perkAttribution({ ...applied, satisfiedBy: [] })).toBeNull()
  })

  it("heldSummary reads the declared lists per program and never emits '(via Card)'", () => {
    const held = { memberships: ["MARRIOTT_BONVOY"], statuses: ["HILTON_DIAMOND"], cards: ["IHG_PREMIER_CARD"] }
    expect(UI.heldSummary(held, "HILTON_HONORS")).toBe("Hilton Diamond")
    expect(UI.heldSummary(held, "IHG_ONE_REWARDS")).toBe("Card: IHG Premier Card")
    expect(UI.heldSummary(held, "MARRIOTT_BONVOY")).toBe("Member")
    expect(UI.heldSummary(held, "WORLD_OF_HYATT")).toBe("no entitlement declared")
    expect(UI.heldSummary(null, "HILTON_HONORS")).toBe("no entitlement declared")
    expect(UI.heldSummary(held, "IHG_ONE_REWARDS")).not.toContain("via Card")
  })

  it("nothingDeclared is true for the live empty config shape and false once anything is held", () => {
    expect(UI.nothingDeclared({ held: { memberships: [], statuses: [], cards: [] }, certificates: [] })).toBe(true)
    expect(UI.nothingDeclared(null)).toBe(true)
    expect(UI.nothingDeclared({ held: { memberships: ["MARRIOTT_BONVOY"], statuses: [], cards: [] }, certificates: [] })).toBe(false)
    expect(UI.nothingDeclared({ held: { memberships: [], statuses: [], cards: [] }, certificates: [{ key: "X", program: "P", quantity: 1 }] })).toBe(false)
  })
})

describe("explicit re-check windows come from the plan itself", () => {
  it("segmentWindows dedupes identical (checkIn, nights) pairs", () => {
    const p = plan({ segments: [...plan().segments, { ...plan().segments[0] }] })
    expect(UI.segmentWindows(p)).toEqual([{ checkIn: "2026-11-01", nights: 5 }, { checkIn: "2026-11-06", nights: 5 }])
  })

  it("gapWindows returns exactly the coalesced uncovered runs", () => {
    const gappy = plan({ coveredNights: 5, segments: [plan().segments[0]].map(s => ({ ...s, nights: 3, checkOut: "2026-11-04" })),
      uncoveredDates: ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"] })
    expect(UI.gapWindows(gappy, "2026-11-01", 10)).toEqual([{ checkIn: "2026-11-04", nights: 3 }, { checkIn: "2026-11-09", nights: 2 }])
  })
})

describe("booking checklist — one reservation per segment", () => {
  it("lists every segment with its honest price line, conditions and availability caveat; no cash, no combined figure", () => {
    const p = plan()
    p.segments[0].perks = [{ ruleId: "r", badgeLabel: "5TH NIGHT BENEFIT", program: "MARRIOTT_BONVOY", state: "applied", reason: "applied",
      freeNights: 1, affectsArithmetic: true, bookingConditions: ["book as ONE reservation", "standard room only"], requires: [] }]
    p.segments[0].evidence = EVIDENCE
    p.segments[1].navigation = { quality: "SEARCH_REPLAY_LINK", url: "https://gondola.ai/hotel/details/1?checkin=2026-11-06&checkout=2026-11-11", observedAt: "2026-08-28T19:05:37.809Z" }
    const m = UI.bookingChecklist(p)
    expect(m.lines).toHaveLength(2)
    expect(m.linked).toBe(1)
    expect(m.lines[0].priceMain).toBe("50,000 pts/night")
    expect(m.lines[0].conditions).toEqual(["book as ONE reservation", "standard room only"])
    expect(m.lines[0].noLink).toBe(true)
    expect(m.lines[0].availabilityText).toContain("not a live hold")
    expect(m.lines[1].noLink).toBe(false)
    expect(m.lines[1].sameHotelAsPrevious).toBe(false)
    expect(m.text).toContain("2 separate reservations")
    expect(m.text).toContain("no stay total")
    expect(m.text).toContain("Stay total unavailable")
    expect(m.text).not.toContain("$")
    expect(m.text).not.toContain("250,000")
    expect(m.text).not.toContain("337")
    expect(m.text).not.toMatch(/sav(e|ing)/i)
    expect(m.text).toContain("availability is not confirmed")
  })

  it("adjacent segments at the same hotel are flagged, never merged", () => {
    const s0 = plan().segments[0]
    const p = plan({ segments: [s0, { ...s0, checkIn: "2026-11-06", checkOut: "2026-11-11" }] })
    const m = UI.bookingChecklist(p)
    expect(m.lines).toHaveLength(2)
    expect(m.lines[1].sameHotelAsPrevious).toBe(true)
    expect(m.text).toContain("separate observed windows")
  })
})

describe("points held vs a SOURCE-STATED total", () => {
  const accounts = [
    { program: "Marriott Bonvoy", programKey: "marriott", balance: 1392260, displayBalance: "1,392,260" },
    { program: "Marriott Rewards", programKey: "marriott", balance: 12000, displayBalance: "12,000" },
    { program: "Hilton Honors", programKey: "hilton", balance: 187450, displayBalance: "187,450" },
  ]
  it("compares the LARGEST single account only — accounts are never summed", () => {
    const r = UI.heldForProgramTotal(accounts, { program: "MARRIOTT_BONVOY", statedTotal: 1400000, statedSegments: 1, perNightOnlySegments: 0 })
    expect(r.verdict).toBe("shortfall")
    expect(r.largest).toBe(1392260)
    expect(r.shortfall).toBe(7740)
    expect(r.text).toContain("not summed")
    expect(r.text).toContain("transfers not assumed")
    expect(JSON.stringify(r)).not.toContain("1404260")           // 1,392,260 + 12,000 never appears
  })

  it("covers when the largest account meets the stated total; no statement without a stated total; no account → not available", () => {
    expect(UI.heldForProgramTotal(accounts, { program: "MARRIOTT_BONVOY", statedTotal: 300000, statedSegments: 1, perNightOnlySegments: 0 }).verdict).toBe("covers")
    const none = UI.heldForProgramTotal(accounts, { program: "HILTON_HONORS", statedTotal: null, statedSegments: 0, perNightOnlySegments: 1 })
    expect(none.verdict).toBe("no-stated-total")
    expect(none.text).toContain("no affordability statement")
    expect(none.text).toContain("187,450")
    expect(UI.heldForProgramTotal(accounts, { program: "WORLD_OF_HYATT", statedTotal: 60000, statedSegments: 1, perNightOnlySegments: 0 }).verdict).toBe("no-balance")
    expect(UI.heldForProgramTotal([], { program: "MARRIOTT_BONVOY", statedTotal: 1, statedSegments: 1, perNightOnlySegments: 0 }).text).toBe("held: not available")
  })

  it("a merely name-derived account (e.g. a vacation club) never backs an affordability verdict", () => {
    const withClub = [
      { program: "Hilton Honors", programKey: "hilton", balance: 90000, displayBalance: "90,000" },
      { program: "Hilton Grand Vacations Club", programKey: "hilton", balance: 5000000, displayBalance: "5,000,000" },
    ]
    const r = UI.heldForProgramTotal(withClub, { program: "HILTON_HONORS", statedTotal: 400000, statedSegments: 1, perNightOnlySegments: 0 })
    expect(r.verdict).toBe("shortfall")                            // only the canonical 90,000 account counts
    expect(r.largest).toBe(90000)
    expect(r.text).not.toContain("5,000,000")
    const onlyClub = UI.heldForProgramTotal([withClub[1]], { program: "HILTON_HONORS", statedTotal: 400000, statedSegments: 1, perNightOnlySegments: 0 })
    expect(onlyClub.verdict).toBe("name-matched")
    expect(onlyClub.text).toContain("not an affordability statement")
    expect(onlyClub.text).not.toContain("covers")
  })

  it("the program bridge is a declared closed map, never name matching", () => {
    expect(UI.BALANCE_KEYS_FOR_PROGRAM).toEqual({
      MARRIOTT_BONVOY: ["marriott"], HILTON_HONORS: ["hilton"], WORLD_OF_HYATT: ["hyatt"], IHG_ONE_REWARDS: ["IHG"],
    })
  })
})
