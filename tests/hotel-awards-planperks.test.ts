/**
 * Perk-aware stay planning — the verified perk layer applied to stay-plan
 * segments, and the optimization goals built on it.
 *
 * Pinned: the three resolution states (applied / qualifies_but_unpriced /
 * not_eligible) and their honest reasons; missing DECLARED entitlement is
 * never assumed; unverified rules can never affect ranking; certificate
 * stock is consumed once per plan and never reused; a per-night-only
 * observation still cannot create a stay total (an applied perk counts a
 * free NIGHT, never a points value); programs are never combined into one
 * points total; each optimization goal is deterministic; entitlement saving
 * refuses invalid declarations.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, it } from "vitest"
import {
  filterRulesByInclude, newCertificateLedger, perkIncludeCategory,
  rankablePerkNights, resolvePlanPerks, resolveSegmentPerks,
  type PerkIncludeCategory, type PerkPlanSegment,
} from "../providers/hotel-awards/planperks.js"
import {
  entitlementKeyCatalog, loadEntitlements, saveEntitlements,
  type EntitlementsConfig, type HotelPerkRule, type HotelPerkRulesConfig,
} from "../providers/hotel-awards/perks.js"
import { buildStayPlan } from "../providers/hotel-awards/stayplan.js"
import type { StoredHotelAward } from "../providers/hotel-awards/store.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function rule(over: Partial<HotelPerkRule> = {}): HotelPerkRule {
  return {
    id: "test-5th-night",
    program: "MARRIOTT_BONVOY",
    perkType: "nth_night_award_benefit",
    badgeLabel: "5TH NIGHT BENEFIT",
    displayBenefit: "5th night free on award stays of 5+ nights.",
    appliesTo: "award",
    eligibility: { anyOf: ["membership:MARRIOTT_BONVOY"] },
    stayPattern: { minNights: 5 },
    brandRestrictions: null,
    bookingChannel: "Direct redemptions.",
    effectiveFrom: null,
    effectiveTo: null,
    sourceUrl: "https://example.com/terms",
    verifiedAt: "2026-08-28",
    verification: "source_page",
    affectsArithmetic: true,
    repetition: "once_per_stay",
    requiresCertificate: null,
    requiredRateName: null,
    constraints: [],
    exclusions: [],
    ...over,
  }
}

function rulesConfig(rules: HotelPerkRule[]): HotelPerkRulesConfig {
  return { rules }
}

function ents(over: Partial<EntitlementsConfig> = {}): EntitlementsConfig {
  return {
    held: { memberships: [], statuses: [], cards: [] },
    purchasable: [],
    certificates: [],
    ...over,
  }
}

const MEMBER = ents({ held: { memberships: ["MARRIOTT_BONVOY"], statuses: [], cards: [] } })

function seg(over: Partial<PerkPlanSegment> = {}): PerkPlanSegment {
  return {
    program: "MARRIOTT_BONVOY", chain: "Marriott", nights: 5,
    checkIn: "2026-11-01", checkOut: "2026-11-06", quoteBasis: "per_night",
    ...over,
  }
}

let nextId = 1
function ob(checkIn: string, nights: number, over: Partial<StoredHotelAward> = {}): StoredHotelAward {
  const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)
  const id = nextId++
  return {
    id, dedupeKey: `k${id}`, locatorId: null, createdAt: "2026-08-29T00:00:00.000Z",
    provider: "roame_hotels", providerPropertyRef: "jwbkk", propertyId: null,
    propertyName: "JW Marriott Bangkok", chain: "Marriott",
    program: "MARRIOTT_BONVOY", sourceProgramName: "MARRIOTT",
    checkIn, checkOut, nights,
    quoteBasis: "per_night", roomClass: "GuestRoom", roomName: "1 King Bed",
    pointsTotal: null, pointsPerNight: 50000,
    taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
    awardType: "points", cashComparisonAmount: null, cashComparisonCurrency: null,
    availabilityState: "unknown", searchState: "complete", verificationLevel: "discovered",
    sourceFreshness: null, bookingUrl: null, fetchedAt: "2026-08-29T00:00:00.000Z",
    ...over,
  }
}

// ── Attribution fields (declared-key truth on cards) ─────────────────────────

describe("attribution fields", () => {
  it("an applied resolution names the DECLARED key that satisfied it, in the rule's anyOf order", () => {
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule()]), MEMBER, new Map())
    expect(r.satisfiedBy).toEqual(["membership:MARRIOTT_BONVOY"])
    expect(r.minNights).toBe(5)
    expect(r.acquisition).toBeNull()
  })

  it("two declared satisfiers both appear, rule order kept; not_eligible carries none", () => {
    const two = rule({ eligibility: { anyOf: ["status:MARRIOTT_PLATINUM", "membership:MARRIOTT_BONVOY"] } })
    const both = ents({ held: { memberships: ["MARRIOTT_BONVOY"], statuses: ["MARRIOTT_PLATINUM"], cards: [] } })
    const [r] = resolveSegmentPerks(seg(), rulesConfig([two]), both, new Map())
    expect(r.satisfiedBy).toEqual(["status:MARRIOTT_PLATINUM", "membership:MARRIOTT_BONVOY"])
    const [none] = resolveSegmentPerks(seg(), rulesConfig([two]), ents(), new Map())
    expect(none.state).toBe("not_eligible")
    expect(none.satisfiedBy).toEqual([])
  })

  it("the shape-gated branch echoes minNights with no attribution", () => {
    const [r] = resolveSegmentPerks(seg({ nights: 3 }), rulesConfig([rule()]), MEMBER, new Map())
    expect(r.reason).toBe("stay-shape-not-matched")
    expect(r.satisfiedBy).toEqual([])
    expect(r.minNights).toBe(5)
  })

  it("a purchasable-not-held resolution carries the declared acquisition ECHO — cash and points as separate clauses", () => {
    const buyable = ents({ purchasable: [{
      key: "MARRIOTT_BONVOY", kind: "membership", program: "MARRIOTT_BONVOY",
      acquisitionCost: { amount: 0, currency: "USD" }, sourceUrl: "https://example.com", verifiedAt: "2026-08-28",
    }] })
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule()]), buyable, new Map())
    expect(r.reason).toBe("entitlement-purchasable-not-held")
    expect(r.acquisition).toEqual({ key: "MARRIOTT_BONVOY", cost: { amount: 0, currency: "USD" }, alternatives: [] })
    // Attribution never changes the ranking count.
    expect(rankablePerkNights(seg(), rulesConfig([rule()]), buyable)).toBe(0)
    expect(rankablePerkNights(seg(), rulesConfig([rule()]), MEMBER)).toBe(1)
  })
})

// ── Resolution states ────────────────────────────────────────────────────────

describe("perk resolution states", () => {
  it("verified rule + declared entitlement + per-night segment → APPLIED with a rule-supported free-night COUNT and a null points value", () => {
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule()]), MEMBER, new Map())
    expect(r.state).toBe("applied")
    expect(r.reason).toBe("applied")
    expect(r.freeNights).toBe(1)                             // counts a night — never a points figure
    expect(r.pointsValue).toBeNull()                         // the free night's value is never invented
  })

  it("a missing DECLARED entitlement is NOT_ELIGIBLE — never silently assumed", () => {
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule()]), ents(), new Map())
    expect(r.state).toBe("not_eligible")
    expect(r.reason).toBe("entitlement-not-held")
    expect(r.requires).toEqual(["membership:MARRIOTT_BONVOY"])
    expect(r.freeNights).toBe(0)
  })

  it("a purchasable-but-not-held entitlement stays NOT_ELIGIBLE with its own reason", () => {
    const purchasable = ents({
      purchasable: [{ key: "MARRIOTT_BONVOY", kind: "membership", acquisitionCost: { amount: 0, currency: "USD" }, sourceUrl: "https://example.com", verifiedAt: "2026-08-28" }],
    })
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule()]), purchasable, new Map())
    expect(r.state).toBe("not_eligible")
    expect(r.reason).toBe("entitlement-purchasable-not-held")
  })

  it("an UNVERIFIED (knowledge_encoded) rule is never optimizer-grade — NOT_ELIGIBLE even when the entitlement is held", () => {
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule({ verification: "knowledge_encoded" })]), MEMBER, new Map())
    expect(r.state).toBe("not_eligible")
    expect(r.reason).toBe("rule-unverified")
  })

  it("a source-stated FULL-STAY total is authoritative — the perk only QUALIFIES, price effect unknown, no discounted total", () => {
    const [r] = resolveSegmentPerks(seg({ quoteBasis: "full_stay" }), rulesConfig([rule()]), MEMBER, new Map())
    expect(r.state).toBe("qualifies_but_unpriced")
    expect(r.reason).toBe("stated-total-may-already-reflect-benefit")
    expect(r.freeNights).toBe(0)                             // never counted for ranking
  })

  it("a weekend_stay constraint cannot be verified (weekend definition unencoded) → QUALIFIES_BUT_UNPRICED", () => {
    const [r] = resolveSegmentPerks(seg(), rulesConfig([rule({ constraints: ["weekend_stay"] })]), MEMBER, new Map())
    expect(r.state).toBe("qualifies_but_unpriced")
    expect(r.reason).toBe("weekend-definition-not-encoded")
  })

  it("cash-only rules and award-excluding rules never apply to award segments", () => {
    const cashOnly = resolveSegmentPerks(seg(), rulesConfig([rule({ appliesTo: "cash" })]), MEMBER, new Map())[0]
    expect(cashOnly.state).toBe("not_eligible")
    expect(cashOnly.reason).toBe("cash-rates-only")
    const excludes = resolveSegmentPerks(seg(), rulesConfig([rule({ exclusions: ["award_redemption"] })]), MEMBER, new Map())[0]
    expect(excludes.state).toBe("not_eligible")
    expect(excludes.reason).toBe("excludes-award-redemption")
  })

  it("a stay below the rule's night pattern resolves NOT_ELIGIBLE (shape), never dropped silently", () => {
    const [r] = resolveSegmentPerks(seg({ nights: 3, checkOut: "2026-11-04" }), rulesConfig([rule()]), MEMBER, new Map())
    expect(r.state).toBe("not_eligible")
    expect(r.reason).toBe("stay-shape-not-matched")
  })

  it("benefit-only rules APPLY as annotation only — never arithmetic, never a free night", () => {
    const benefit = rule({ id: "test-benefit", perkType: "status_benefit", affectsArithmetic: false, repetition: null, stayPattern: { minNights: null } })
    const [r] = resolveSegmentPerks(seg(), rulesConfig([benefit]), MEMBER, new Map())
    expect(r.state).toBe("applied")
    expect(r.reason).toBe("applied-annotation-only")
    expect(r.affectsArithmetic).toBe(false)
    expect(r.freeNights).toBe(0)
  })

  it("booking conditions are echoed source-stated constraints, present only on non-not_eligible states", () => {
    const constrained = rule({ constraints: ["single_reservation", "standard_room_only"], requiredRateName: "Special Rate" })
    const [r] = resolveSegmentPerks(seg(), rulesConfig([constrained]), MEMBER, new Map())
    expect(r.bookingConditions).toEqual([
      "book as ONE reservation",
      "standard room only",
      'must be booked on the named rate "Special Rate"',
    ])
  })
})

// ── Certificate consumption ──────────────────────────────────────────────────

const CERT_RULE = rule({
  id: "test-cert-night", perkType: "weekend_night_certificate",
  badgeLabel: "CERT NIGHT", repetition: "once_per_certificate",
  requiresCertificate: { type: "TEST_CERT", quantity: 1 },
  stayPattern: { minNights: 2 },
})
const CERT_ENTS = ents({
  held: { memberships: ["MARRIOTT_BONVOY"], statuses: [], cards: [] },
  certificates: [{ key: "TEST_CERT", program: "MARRIOTT_BONVOY", quantity: 1 }],
})

describe("certificate consumption", () => {
  it("one declared certificate is consumed by the first qualifying segment and NEVER reused within the plan", () => {
    const segments = [seg({ nights: 5 }), seg({ checkIn: "2026-11-06", checkOut: "2026-11-11", nights: 5 })]
    const { segments: resolved, summary } = resolvePlanPerks(segments, rulesConfig([CERT_RULE]), CERT_ENTS)
    expect(resolved[0][0].state).toBe("applied")
    expect(resolved[0][0].certificateConsumed).toEqual({ type: "TEST_CERT", quantity: 1 })
    expect(resolved[1][0].state).toBe("not_eligible")
    expect(resolved[1][0].reason).toBe("certificate-exhausted-in-plan")
    expect(summary.certificatesConsumed).toEqual([{ type: "TEST_CERT", quantity: 1 }])
  })

  it("zero declared certificates → NOT_ELIGIBLE (declared stock only, never assumed)", () => {
    const noCert = ents({ held: { memberships: ["MARRIOTT_BONVOY"], statuses: [], cards: [] } })
    const [r] = resolveSegmentPerks(seg(), rulesConfig([CERT_RULE]), noCert, newCertificateLedger(noCert))
    expect(r.state).toBe("not_eligible")
  })

  it("certificate-consuming perks never enter the rankable per-edge count (consumption is plan-order-dependent)", () => {
    expect(rankablePerkNights(seg(), rulesConfig([CERT_RULE]), CERT_ENTS)).toBe(0)
    expect(rankablePerkNights(seg(), rulesConfig([rule()]), MEMBER)).toBe(1)
  })
})

// ── Ranking doctrine through buildStayPlan ───────────────────────────────────

const NOV6 = { start: "2026-11-01", end: "2026-11-06" }

/** Two competing complete 5-night plans: one Hyatt hotel (no applicable perk
 *  rule) vs one Marriott hotel (verified 5th-night rule). */
function competingRows(): StoredHotelAward[] {
  return [
    ob("2026-11-01", 5, { providerPropertyRef: "hyattp", propertyName: "Hyatt Place Bangkok", chain: "PLACE", program: "WORLD_OF_HYATT", sourceProgramName: "HYATT", pointsPerNight: 4500 }),
    ob("2026-11-01", 5),                                     // JW Marriott, per-night
  ]
}

describe("optimization goals over the perk layer", () => {
  const perkContext = { rules: rulesConfig([rule()]), entitlements: MEMBER }

  it("life_perks ranks the plan with more APPLIED verified free nights first; fewest_switches keeps the V1 ordering", () => {
    const lifePerks = buildStayPlan(competingRows(), NOV6.start, NOV6.end, { goal: "life_perks", perkContext })
    expect(lifePerks.plans[0].segments[0].propertyName).toBe("JW Marriott Bangkok")
    expect(lifePerks.plans[0].appliedPerkNights).toBe(1)
    // V1 ordering (fewest_switches): both plans tie on coverage/switches —
    // the deterministic signature (Hyatt's ref sorts first) decides.
    const switches = buildStayPlan(competingRows(), NOV6.start, NOV6.end, { goal: "fewest_switches", perkContext })
    expect(switches.plans[0].segments[0].propertyName).toBe("Hyatt Place Bangkok")
  })

  it("an unverified rule cannot affect ranking — the perk-carrying plan gains nothing from it", () => {
    const unverified = { rules: rulesConfig([rule({ verification: "knowledge_encoded" })]), entitlements: MEMBER }
    const r = buildStayPlan(competingRows(), NOV6.start, NOV6.end, { goal: "life_perks", perkContext: unverified })
    expect(r.plans[0].appliedPerkNights).toBe(0)
    expect(r.plans[0].segments[0].propertyName).toBe("Hyatt Place Bangkok")   // signature tie-break, as V1
  })

  it("a missing entitlement cannot affect ranking either — declared only", () => {
    const noEnts = { rules: rulesConfig([rule()]), entitlements: ents() }
    const r = buildStayPlan(competingRows(), NOV6.start, NOV6.end, { goal: "life_perks", perkContext: noEnts })
    expect(r.plans[0].appliedPerkNights).toBe(0)
    const applied = r.plans.flatMap(p => p.segments).flatMap(s => s.perks ?? []).filter(p => p.state === "applied")
    expect(applied).toEqual([])
  })

  it("points_cost prefers the lower source-stated total when the comparison is valid", () => {
    const rows = [
      ob("2026-11-01", 5, { provider: "gondola_hotels", providerPropertyRef: "cheap", propertyName: "Cheap Marriott", quoteBasis: "full_stay", pointsTotal: 100000, pointsPerNight: 20000 }),
      ob("2026-11-01", 5, { provider: "gondola_hotels", providerPropertyRef: "dear", propertyName: "Dear Marriott", quoteBasis: "full_stay", pointsTotal: 250000, pointsPerNight: 50000 }),
    ]
    const r = buildStayPlan(rows, NOV6.start, NOV6.end, { goal: "points_cost" })
    expect(r.plans[0].segments[0].propertyName).toBe("Cheap Marriott")
  })

  it("every goal is deterministic — identical inputs give identical results", () => {
    const rows = competingRows()
    for (const goal of ["life_perks", "points_cost", "fewest_switches"] as const) {
      const a = buildStayPlan(rows, NOV6.start, NOV6.end, { goal, perkContext })
      const b = buildStayPlan(rows, NOV6.start, NOV6.end, { goal, perkContext })
      expect(a).toEqual(b)
      expect(a.goal).toBe(goal)
    }
  })

  it("an unknown goal is refused loudly", () => {
    expect(() => buildStayPlan([], NOV6.start, NOV6.end, { goal: "cheapest_vibes" as never })).toThrow(/unknown optimization goal/)
  })
})

// ── Ranking inputs pinned through buildStayPlan ──────────────────────────────

describe("ranking inputs are exactly the documented ones", () => {
  const perkContext = { rules: rulesConfig([rule()]), entitlements: MEMBER }

  it("QUALIFIES_BUT_UNPRICED never counts: a full_stay segment ranks with 0 perk nights and life_perks orders exactly as fewest_switches", () => {
    expect(rankablePerkNights(seg({ quoteBasis: "full_stay" }), rulesConfig([rule()]), MEMBER)).toBe(0)
    const rows = [
      ob("2026-11-01", 5, { providerPropertyRef: "hyattp", propertyName: "Hyatt Place Bangkok", chain: "PLACE", program: "WORLD_OF_HYATT", sourceProgramName: "HYATT", pointsPerNight: 4500 }),
      ob("2026-11-01", 5, { provider: "gondola_hotels", quoteBasis: "full_stay", pointsTotal: 250000 }),
    ]
    const lp = buildStayPlan(rows, NOV6.start, NOV6.end, { goal: "life_perks", perkContext })
    expect(lp.plans.every(p => p.appliedPerkNights === 0)).toBe(true)
    const jw = lp.plans.find(p => p.segments[0]?.program === "MARRIOTT_BONVOY")!
    expect(jw.perkSummary!.appliedFreeNights).toBe(0)
    expect(jw.perkSummary!.qualifiesUnpriced.map(q => q.reason)).toEqual(["stated-total-may-already-reflect-benefit"])
    const v1 = buildStayPlan(rows, NOV6.start, NOV6.end, { goal: "fewest_switches", perkContext })
    expect(lp.plans.map(p => p.signature)).toEqual(v1.plans.map(p => p.signature))
  })

  it("a certificate-applied plan ranks with appliedPerkNights 0 although perkSummary.appliedFreeNights is 1", () => {
    const r = buildStayPlan([ob("2026-11-01", 5)], NOV6.start, NOV6.end, { goal: "life_perks", perkContext: { rules: rulesConfig([CERT_RULE]), entitlements: CERT_ENTS } })
    expect(r.plans[0].appliedPerkNights).toBe(0)
    expect(r.plans[0].perkSummary!.appliedFreeNights).toBe(1)
    expect(r.plans[0].perkSummary!.certificatesConsumed).toEqual([{ type: "TEST_CERT", quantity: 1 }])
  })

  it("life_perks puts MORE applied free nights above FEWER switches; fewest_switches reverses it", () => {
    const rows = [
      ob("2026-11-01", 10, { providerPropertyRef: "hyatt10", propertyName: "Hyatt 10n", chain: "PLACE", program: "WORLD_OF_HYATT", sourceProgramName: "HYATT", pointsPerNight: 4500 }),
      ob("2026-11-01", 5, { providerPropertyRef: "m1", propertyName: "Marriott One" }),
      ob("2026-11-06", 5, { providerPropertyRef: "m2", propertyName: "Marriott Two" }),
    ]
    const lp = buildStayPlan(rows, "2026-11-01", "2026-11-11", { goal: "life_perks", perkContext })
    expect(lp.plans[0].segments.map(s => s.propertyName)).toEqual(["Marriott One", "Marriott Two"])
    expect(lp.plans[0]).toMatchObject({ switches: 1, appliedPerkNights: 2 })
    const fw = buildStayPlan(rows, "2026-11-01", "2026-11-11", { goal: "fewest_switches", perkContext })
    expect(fw.plans[0].segments.map(s => s.propertyName)).toEqual(["Hyatt 10n"])
    expect(fw.plans[0]).toMatchObject({ switches: 0, appliedPerkNights: 0 })
  })

  it("per_block repeats only per FULL block — floor, never rounded up — and an unstated block length only qualifies", () => {
    const perBlock = rule({ repetition: "per_block" })              // minNights 5 = block length
    const r12 = resolveSegmentPerks(seg({ nights: 12, checkOut: "2026-11-13" }), rulesConfig([perBlock]), MEMBER, new Map())[0]
    const r9 = resolveSegmentPerks(seg({ nights: 9, checkOut: "2026-11-10" }), rulesConfig([perBlock]), MEMBER, new Map())[0]
    expect([r12.state, r12.freeNights]).toEqual(["applied", 2])
    expect([r9.state, r9.freeNights]).toEqual(["applied", 1])
    expect(Number.isInteger(r9.freeNights)).toBe(true)
    expect(r9.pointsValue).toBeNull()
    expect(rankablePerkNights(seg({ nights: 12, checkOut: "2026-11-13" }), rulesConfig([perBlock]), MEMBER)).toBe(2)
    const noBlock = resolveSegmentPerks(seg({ nights: 9, checkOut: "2026-11-10" }), rulesConfig([rule({ repetition: "per_block", stayPattern: { minNights: null } })]), MEMBER, new Map())[0]
    expect([noBlock.state, noBlock.reason, noBlock.freeNights]).toEqual(["qualifies_but_unpriced", "block-length-unstated", 0])
  })
})

// ── Honesty invariants with perks applied ────────────────────────────────────

describe("perk-aware honesty invariants", () => {
  const perkContext = { rules: rulesConfig([rule()]), entitlements: MEMBER }

  it("an APPLIED perk on a per-night-only segment still cannot create a stay total — nothing invents 250000 or a discounted figure", () => {
    const r = buildStayPlan([ob("2026-11-01", 5)], NOV6.start, NOV6.end, { goal: "life_perks", perkContext })
    const best = r.plans[0]
    expect(best.segments[0].pointsTotal).toBeNull()
    expect(best.segments[0].perks![0].state).toBe("applied")
    expect(best.programTotals[0].statedTotal).toBeNull()
    const json = JSON.stringify(best)
    expect(json).not.toContain("250000")                     // 50000 × 5 never appears
    expect(json).not.toContain("200000")                     // nor a "discounted" 4-night construction
  })

  it("programs are never combined into one points total, perks applied or not", () => {
    const rows = [
      ob("2026-11-01", 5, { provider: "gondola_hotels", quoteBasis: "full_stay", pointsTotal: 250000, pointsPerNight: 50000 }),
      ob("2026-11-06", 5, { provider: "gondola_hotels", providerPropertyRef: "hy", propertyName: "Grand Hyatt", chain: "HYATT", program: "WORLD_OF_HYATT", sourceProgramName: "HYATT", quoteBasis: "full_stay", pointsTotal: 87500, pointsPerNight: 17500 }),
    ]
    const r = buildStayPlan(rows, "2026-11-01", "2026-11-11", { goal: "life_perks", perkContext })
    const best = r.plans[0]
    expect(best.programTotals).toHaveLength(2)
    expect(JSON.stringify(best)).not.toContain("337500")     // the forbidden cross-program sum
  })

  it("perk resolution changes NO plan numbers — segments and totals are byte-identical with and without a perk context", () => {
    const rows = competingRows()
    const bare = buildStayPlan(rows, NOV6.start, NOV6.end, { goal: "fewest_switches" })
    const perky = buildStayPlan(rows, NOV6.start, NOV6.end, { goal: "fewest_switches", perkContext })
    const strip = (p: typeof bare.plans[0]) => ({
      ...p,
      segments: p.segments.map(s => { const rest = { ...s }; delete rest.perks; return rest }),
      perkSummary: undefined,
      appliedPerkNights: 0,
    })
    expect(perky.plans.map(strip)).toEqual(bare.plans.map(p => ({ ...p, perkSummary: undefined })))
  })
})

// ── Include-in-plan filtering ────────────────────────────────────────────────

describe("include-in-plan categories", () => {
  const CARD_RULE = rule({ id: "test-card-4th", badgeLabel: "4TH NIGHT BENEFIT", eligibility: { anyOf: ["card:TEST_CARD"] }, stayPattern: { minNights: 4 } })
  const BENEFIT_RULE = rule({ id: "test-benefit", perkType: "status_benefit", affectsArithmetic: false, repetition: null, stayPattern: { minNights: null } })

  it("categorizes arithmetic mechanics; benefit-only rules are never toggled", () => {
    expect(perkIncludeCategory(rule())).toBe("nth_night")
    expect(perkIncludeCategory(CARD_RULE)).toBe("card")
    expect(perkIncludeCategory(CERT_RULE)).toBe("certificate")
    expect(perkIncludeCategory(BENEFIT_RULE)).toBeNull()
  })

  it("an excluded category's rules are dropped entirely — neither ranked nor shown", () => {
    const all = rulesConfig([rule(), CARD_RULE, CERT_RULE, BENEFIT_RULE])
    const noNth = filterRulesByInclude(all, new Set<PerkIncludeCategory>(["card", "certificate"]))
    expect(noNth.rules.map(r => r.id)).toEqual(["test-card-4th", "test-cert-night", "test-benefit"])
    const none = filterRulesByInclude(all, new Set<PerkIncludeCategory>())
    expect(none.rules.map(r => r.id)).toEqual(["test-benefit"])   // benefit annotations always survive
  })
})

// ── Entitlement declaration (Edit entitlements) ──────────────────────────────

describe("entitlement declaration", () => {
  it("saveEntitlements refuses an invalid declaration loudly and writes nothing", () => {
    const tmp = path.join(os.tmpdir(), `ents-refuse-${process.pid}.json`)
    expect(() => saveEntitlements(ents({ held: { memberships: ["not-upper-snake"], statuses: [], cards: [] } }), tmp))
      .toThrow(/refusing to save/)
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it("a valid declaration round-trips through disk", () => {
    const tmp = path.join(os.tmpdir(), `ents-roundtrip-${process.pid}.json`)
    try {
      saveEntitlements(ents({
        held: { memberships: ["MARRIOTT_BONVOY"], statuses: ["HILTON_DIAMOND"], cards: [] },
        certificates: [{ key: "TEST_CERT", program: "MARRIOTT_BONVOY", quantity: 2 }],
      }), tmp)
      const loaded = loadEntitlements(true, tmp)
      expect(loaded.held.statuses).toEqual(["HILTON_DIAMOND"])
      expect(loaded.certificates[0].quantity).toBe(2)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it("the key catalog is derived from the rules — a closed vocabulary, nothing guessed", () => {
    const cat = entitlementKeyCatalog(rulesConfig([rule(), CERT_RULE, rule({ id: "test-hilton", program: "HILTON_HONORS", eligibility: { anyOf: ["status:HILTON_DIAMOND"] } })]))
    expect(cat.eligibility).toEqual([
      { kind: "membership", key: "MARRIOTT_BONVOY", programs: ["MARRIOTT_BONVOY"] },
      { kind: "status", key: "HILTON_DIAMOND", programs: ["HILTON_HONORS"] },
    ])
    expect(cat.certificates).toEqual([{ type: "TEST_CERT", programs: ["MARRIOTT_BONVOY"] }])
  })
})
