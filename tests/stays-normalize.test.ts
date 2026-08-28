import { describe, expect, it } from "vitest"
import {
  boardFor,
  checkStaySanity,
  classifyRoomText,
  isBaselineEligible,
  nightlyFor,
  normalizeBoardText,
  stayTotalFor,
  validateStayDates,
  type StaySanityConfig,
} from "../stays/normalize.js"
import { makeStayRate } from "./stay-mocks.js"

const NOW = new Date("2026-08-28T12:00:00Z")

const SANITY: StaySanityConfig = {
  nightly: { USD: { min: 10, max: 50000 }, default: { min: 10, max: 50000 } },
  maxNights: 30,
}

describe("stay date validation", () => {
  it("accepts a normal future stay and computes nights", () => {
    const r = validateStayDates("2026-11-10", "2026-11-15", NOW)
    expect(r).toEqual({ ok: true, nights: 5 })
  })

  it("rejects a check-in in the past", () => {
    const r = validateStayDates("2026-08-01", "2026-08-05", NOW)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("past")
  })

  it("rejects check-out on or before check-in", () => {
    expect(validateStayDates("2026-11-10", "2026-11-10", NOW).ok).toBe(false)
    expect(validateStayDates("2026-11-10", "2026-11-09", NOW).ok).toBe(false)
  })

  it("rejects malformed date strings", () => {
    expect(validateStayDates("10/11/2026", "2026-11-15", NOW).ok).toBe(false)
    expect(validateStayDates("2026-11-10", "tomorrow", NOW).ok).toBe(false)
  })

  it("rejects calendar-impossible dates that pass the format check", () => {
    // 2026-02-31 rolls over to March when parsed; the round-trip catches it.
    const r = validateStayDates("2026-02-31", "2026-03-05", NOW)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("calendar")
  })
})

describe("board basis", () => {
  it("maps meal-plan wording to board values", () => {
    expect(normalizeBoardText("All Inclusive package")).toBe("all_inclusive")
    expect(normalizeBoardText("all-in")).toBe("all_inclusive")
    expect(normalizeBoardText("Full board")).toBe("full_board")
    expect(normalizeBoardText("Half-board")).toBe("half_board")
    expect(normalizeBoardText("Includes 2 great breakfasts")).toBe("breakfast")
    expect(normalizeBoardText("Room only")).toBe("room_only")
    expect(normalizeBoardText("free parking")).toBe("unknown")
    expect(normalizeBoardText(null)).toBe("unknown")
  })

  it("prefers a structured board over any property default", () => {
    const r = boardFor({ allInclusive: "only", defaultBoard: "all_inclusive" }, "breakfast")
    expect(r).toEqual({ board: "breakfast", boardSource: "structured" })
  })

  it("applies the property default at an all-inclusive-only property", () => {
    const r = boardFor({ allInclusive: "only", defaultBoard: "all_inclusive" }, null)
    expect(r).toEqual({ board: "all_inclusive", boardSource: "property_default" })
  })

  it("stays unknown when neither the provider nor the property can say", () => {
    const r = boardFor({ allInclusive: "available", defaultBoard: "unknown" }, null)
    expect(r).toEqual({ board: "unknown", boardSource: "unknown" })
  })
})

describe("room classification", () => {
  it("buckets room names", () => {
    expect(classifyRoomText("Crusoe Villa with Pool")).toBe("villa")
    expect(classifyRoomText("Overwater Bungalow")).toBe("villa")
    expect(classifyRoomText("Fairmont Suite (Twin Beds)")).toBe("suite")
    expect(classifyRoomText("Deluxe King")).toBe("premium")
    expect(classifyRoomText("Superior Room")).toBe("entry")
    expect(classifyRoomText("Mystery Package")).toBe("unknown")
  })
})

describe("price basis — the teaser guard", () => {
  it("computes a stay total from a nightly room rate", () => {
    const rate = makeStayRate({ priceBasis: "nightly_room", price: { amount: 2000, currency: "USD" }, nights: 5 })
    expect(stayTotalFor(rate)).toBe(10000)
    expect(nightlyFor(rate)).toBe(2000)
  })

  it("divides a stay total back to a nightly figure", () => {
    const rate = makeStayRate({ priceBasis: "stay_room", price: { amount: 10000, currency: "USD" }, nights: 5 })
    expect(nightlyFor(rate)).toBe(2000)
    expect(stayTotalFor(rate)).toBe(10000)
  })

  it("refuses to produce ANY stay or nightly figure from a lead-in teaser", () => {
    // The classic bug: a "from $299" teaser multiplied by nights and presented
    // as a bookable total. Both derivations must return null, not a guess.
    const teaser = makeStayRate({ priceBasis: "lead_in", price: { amount: 299, currency: "USD" }, nights: 5 })
    expect(stayTotalFor(teaser)).toBeNull()
    expect(nightlyFor(teaser)).toBeNull()
  })
})

describe("sanity", () => {
  it("passes a plausible luxury rate", () => {
    const r = checkStaySanity(makeStayRate(), SANITY)
    expect(r.verdict).toBe("ok")
  })

  it("flags an absurdly low nightly as suspicious data, not a deal", () => {
    const r = checkStaySanity(makeStayRate({ price: { amount: 3, currency: "USD" } }), SANITY)
    expect(r.verdict).toBe("SUSPICIOUS_DATA")
    expect(r.reasons.join()).toContain("below floor")
  })

  it("keeps a genuinely great-but-plausible bargain OK — bargains are the point", () => {
    // A $250 night at a normally-$2400 property must survive sanity; judging
    // it exceptional is the anomaly engine's job, not the sanity filter's.
    const r = checkStaySanity(makeStayRate({ price: { amount: 250, currency: "USD" } }), SANITY)
    expect(r.verdict).toBe("ok")
  })

  it("flags a probable unit error above the ceiling", () => {
    const r = checkStaySanity(makeStayRate({ price: { amount: 2_400_000, currency: "USD" } }), SANITY)
    expect(r.verdict).toBe("SUSPICIOUS_DATA")
    expect(r.reasons.join()).toContain("above ceiling")
  })

  it("flags non-ISO currency and impossible nights", () => {
    const bad = makeStayRate({ price: { amount: 2000, currency: "$$" }, nights: 0 })
    const r = checkStaySanity(bad, SANITY)
    expect(r.verdict).toBe("SUSPICIOUS_DATA")
    expect(r.reasons.some(x => x.includes("ISO"))).toBe(true)
    expect(r.reasons.some(x => x.includes("nights"))).toBe(true)
  })

  it("falls back to the default scale for an unknown currency", () => {
    const r = checkStaySanity(makeStayRate({ price: { amount: 3, currency: "THB" } }), SANITY)
    expect(r.verdict).toBe("SUSPICIOUS_DATA")
  })
})

describe("baseline eligibility", () => {
  it("admits a sane date-specific rate", () => {
    const rate = makeStayRate()
    expect(isBaselineEligible(rate, checkStaySanity(rate, SANITY))).toBe(true)
  })

  it("excludes a lead-in even when its number is plausible", () => {
    const teaser = makeStayRate({ priceBasis: "lead_in" })
    expect(isBaselineEligible(teaser, checkStaySanity(teaser, SANITY))).toBe(false)
  })

  it("excludes suspicious rows", () => {
    const junk = makeStayRate({ price: { amount: 1, currency: "USD" } })
    expect(isBaselineEligible(junk, checkStaySanity(junk, SANITY))).toBe(false)
  })
})
