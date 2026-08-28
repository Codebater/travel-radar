/**
 * Hotel perk rules + entitlements — the verified-perk foundation.
 *
 * Pins that: both shipped configs parse and validate; validation refuses
 * malformed rule/entitlement data loudly; matching is program/nights/brand/
 * date-gated; eligibility is DECLARED config (eligible / purchasable /
 * requires), never inferred; badges are display-only and never carry a
 * synthesized number; and the shipped configs produce the intended badges
 * for real observation shapes.
 */

import { describe, expect, it } from "vitest"
import {
  applicablePerks, loadEntitlements, loadHotelPerkRules,
  validateEntitlements, validatePerkRules,
  type EntitlementsConfig, type HotelPerkRule, type HotelPerkRulesConfig, type PerkMatchStay,
} from "../providers/hotel-awards/perks.js"

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

function stay(over: Partial<PerkMatchStay> = {}): PerkMatchStay {
  return { program: "MARRIOTT_BONVOY", chain: "Marriott", nights: 5, checkIn: "2026-11-21", ...over }
}

// ── Shipped configs ──────────────────────────────────────────────────────────

describe("the shipped configs", () => {
  it("hotel-perk-rules.json parses, validates, and every rule cites a source", () => {
    const cfg = loadHotelPerkRules(true)
    expect(validatePerkRules(cfg)).toEqual([])
    expect(cfg.rules.length).toBeGreaterThan(0)
    for (const r of cfg.rules) {
      expect(r.sourceUrl).toMatch(/^https:\/\//)
      expect(r.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it("every shipped rule records its verification evidence, and unverified rules say so explicitly", () => {
    const cfg = loadHotelPerkRules(true)
    for (const r of cfg.rules) {
      expect(r.verificationEvidence, `${r.id} must record how it was (or was not) verified`).toBeTruthy()
      if (r.verification === "knowledge_encoded") {
        expect(r.verificationEvidence).toMatch(/UNVERIFIED/i)
      }
    }
    // The source-verified corrections from the 2026-08-28 pass are pinned:
    const byId = Object.fromEntries(cfg.rules.map(r => [r.id, r]))
    expect(byId["hilton-award-5th-night-free"].verification).toBe("source_page")
    expect(byId["hilton-award-5th-night-free"].eligibility.anyOf).toContain("status:HILTON_DIAMOND_RESERVE")
    expect(byId["marriott-award-5th-night-free"].verification).toBe("source_page")
    expect(byId["ihg-ambassador-weekend-night"].perkType).toBe("weekend_night_certificate")
    expect(byId["hyatt-globalist-benefits"].verification).toBe("knowledge_encoded")
  })

  it("the shipped rules carry machine-readable optimizer semantics exactly matching their verified conditions", () => {
    const byId = Object.fromEntries(loadHotelPerkRules(true).rules.map(r => [r.id, r]))
    // Marriott S5P4: once per redemption stay, one reservation, standard rooms, certs excluded.
    const m = byId["marriott-award-5th-night-free"]
    expect(m.repetition).toBe("once_per_stay")
    expect(m.constraints).toEqual(["single_reservation", "standard_room_only"])
    expect(m.exclusions).toEqual(["free_night_certificate"])
    // Hilton 5th night: conservative once_per_stay floor; standard room, 100% Points.
    const h = byId["hilton-award-5th-night-free"]
    expect(h.repetition).toBe("once_per_stay")
    expect(h.constraints).toEqual(["standard_room_only", "full_points_only"])
    // IHG card: conservative once_per_stay floor; same reservation.
    expect(byId["ihg-card-4th-night-free"].repetition).toBe("once_per_stay")
    expect(byId["ihg-card-4th-night-free"].constraints).toEqual(["single_reservation"])
    // Ambassador: certificate-consuming, named rate, weekend stay, no award/free-night combos.
    const a = byId["ihg-ambassador-weekend-night"]
    expect(a.repetition).toBe("once_per_certificate")
    expect(a.requiresCertificate).toEqual({ type: "IHG_AMBASSADOR_WEEKEND_NIGHT", quantity: 1 })
    expect(a.requiredRateName).toBe("Ambassador Complimentary Weekend Night")
    expect(a.constraints).toEqual(["weekend_stay"])
    expect(a.exclusions).toEqual(["award_redemption", "other_free_night_offers"])
    // Benefit-only rules carry no arithmetic semantics at all.
    for (const id of ["hilton-gold-fnb-credit", "marriott-platinum-welcome-gift", "hyatt-globalist-benefits"]) {
      expect(byId[id].repetition).toBeNull()
      expect(byId[id].requiresCertificate).toBeNull()
      expect(byId[id].requiredRateName).toBeNull()
      expect(byId[id].constraints).toEqual([])
      expect(byId[id].exclusions).toEqual([])
    }
  })

  it("the Ambassador purchasable badge echoes the verified points-priced acquisition alternative", () => {
    const badges = applicablePerks(
      stay({ program: "IHG_ONE_REWARDS", chain: "InterContinental", nights: 2 }),
      loadHotelPerkRules(true), loadEntitlements(true),
    )
    const b = badges.find(x => x.ruleId === "ihg-ambassador-weekend-night")
    expect(b).toBeDefined()
    expect(b!.eligibility).toBe("purchasable")
    expect(b!.acquisition!.cost).toEqual({ amount: 225, currency: "USD" })
    expect(b!.acquisition!.alternatives).toEqual([{ amount: 45000, pointsProgram: "IHG_ONE_REWARDS" }])
  })

  it("entitlements.json parses and holds NOTHING by default — entitlement is declared, never inferred", () => {
    const cfg = loadEntitlements(true)
    expect(validateEntitlements(cfg)).toEqual([])
    expect(cfg.held.memberships).toEqual([])
    expect(cfg.held.statuses).toEqual([])
    expect(cfg.held.cards).toEqual([])
  })

  it("a 5-night Marriott award stay gets the 5th-night badge as purchasable (join free) with defaults", () => {
    const badges = applicablePerks(stay(), loadHotelPerkRules(true), loadEntitlements(true))
    const b = badges.find(x => x.ruleId === "marriott-award-5th-night-free")
    expect(b).toBeDefined()
    expect(b!.badgeLabel).toBe("5TH NIGHT BENEFIT")
    expect(b!.eligibility).toBe("purchasable")
    expect(b!.acquisition).toEqual({ key: "MARRIOTT_BONVOY", cost: { amount: 0, currency: "USD" }, alternatives: [] })
  })

  it("a 5-night Hilton award stay needs status: badge is 'requires' — no free join can satisfy a status rule", () => {
    const badges = applicablePerks(stay({ program: "HILTON_HONORS", chain: "Hilton" }), loadHotelPerkRules(true), loadEntitlements(true))
    const b = badges.find(x => x.ruleId === "hilton-award-5th-night-free")
    expect(b).toBeDefined()
    expect(b!.eligibility).toBe("requires")
    expect(b!.acquisition).toBeNull()
  })

  it("a 4-night Marriott stay gets no 5th-night badge", () => {
    const badges = applicablePerks(stay({ nights: 4 }), loadHotelPerkRules(true), loadEntitlements(true))
    expect(badges.find(x => x.ruleId === "marriott-award-5th-night-free")).toBeUndefined()
  })
})

// ── Validation refuses bad data ──────────────────────────────────────────────

describe("perk rule validation", () => {
  it("refuses bad ids, duplicates, bad eligibility keys, bad nights, bad dates, non-https sources", () => {
    const problems = validatePerkRules(rulesConfig([
      rule({ id: "Bad_Id" }),
      rule({ id: "dup" }),
      rule({ id: "dup" }),
      rule({ id: "bad-key", eligibility: { anyOf: ["tier:GOLD"] } }),
      rule({ id: "bad-nights", stayPattern: { minNights: 0 } }),
      rule({ id: "bad-date", verifiedAt: "not-a-date" }),
      rule({ id: "bad-url", sourceUrl: "http://example.com" }),
      rule({ id: "bad-applies", appliesTo: "everything" as never }),
    ]))
    expect(problems.some(p => p.includes("Bad_Id") || p.includes("rules[0]"))).toBe(true)
    expect(problems.some(p => p.includes("duplicate id"))).toBe(true)
    expect(problems.some(p => p.includes('"tier:GOLD"'))).toBe(true)
    expect(problems.some(p => p.includes("minNights"))).toBe(true)
    expect(problems.some(p => p.includes("verifiedAt"))).toBe(true)
    expect(problems.some(p => p.includes("https"))).toBe(true)
    expect(problems.some(p => p.includes("appliesTo"))).toBe(true)
  })

  it("refuses an empty eligibility list — a perk without a stated requirement cannot exist", () => {
    expect(validatePerkRules(rulesConfig([rule({ eligibility: { anyOf: [] } })])).some(p => p.includes("anyOf"))).toBe(true)
  })

  it("accepts a clean rule", () => {
    expect(validatePerkRules(rulesConfig([rule()]))).toEqual([])
  })
})

describe("entitlement validation", () => {
  it("refuses malformed held keys, bad acquisition costs and negative certificate quantities", () => {
    const problems = validateEntitlements(ents({
      held: { memberships: ["lower-case"], statuses: [], cards: [] },
      purchasable: [{ key: "X", kind: "membership", acquisitionCost: { amount: -1, currency: "USD" }, sourceUrl: "https://x.example", verifiedAt: "2026-08-28" }],
      certificates: [{ key: "CERT", program: "MARRIOTT_BONVOY", quantity: -2 }],
    }))
    expect(problems.some(p => p.includes("lower-case"))).toBe(true)
    expect(problems.some(p => p.includes("acquisitionCost"))).toBe(true)
    expect(problems.some(p => p.includes("quantity"))).toBe(true)
  })

  it("accepts empty held lists — holding nothing is a valid, honest state", () => {
    expect(validateEntitlements(ents())).toEqual([])
  })
})

// ── Matching gates ───────────────────────────────────────────────────────────

describe("perk matching", () => {
  const cfg = rulesConfig([rule()])

  it("gates on program and minimum nights", () => {
    expect(applicablePerks(stay({ program: "HILTON_HONORS" }), cfg, ents())).toEqual([])
    expect(applicablePerks(stay({ nights: 4 }), cfg, ents())).toEqual([])
    expect(applicablePerks(stay({ nights: 5 }), cfg, ents())).toHaveLength(1)
  })

  it("a rule with no minimum nights applies to any stay length", () => {
    const c = rulesConfig([rule({ stayPattern: { minNights: null } })])
    expect(applicablePerks(stay({ nights: 1 }), c, ents())).toHaveLength(1)
  })

  it("a dated rule applies only when check-in falls inside its effective window", () => {
    const c = rulesConfig([rule({ effectiveFrom: "2026-12-01", effectiveTo: "2027-01-31" })])
    expect(applicablePerks(stay({ checkIn: "2026-11-21" }), c, ents())).toEqual([])
    expect(applicablePerks(stay({ checkIn: "2026-12-15" }), c, ents())).toHaveLength(1)
    expect(applicablePerks(stay({ checkIn: "2027-02-01" }), c, ents())).toEqual([])
  })

  it("brand restrictions match the stored chain exactly (case-insensitive) and a null chain never matches", () => {
    const c = rulesConfig([rule({ brandRestrictions: ["InterContinental"] })])
    expect(applicablePerks(stay({ chain: "intercontinental" }), c, ents())).toHaveLength(1)
    expect(applicablePerks(stay({ chain: "Holiday Inn" }), c, ents())).toEqual([])
    expect(applicablePerks(stay({ chain: null }), c, ents())).toEqual([])
  })

  it("a cash-only rule still badges but carries its applicability verbatim", () => {
    const c = rulesConfig([rule({ appliesTo: "cash" })])
    const [b] = applicablePerks(stay(), c, ents())
    expect(b.appliesTo).toBe("cash")
  })
})

// ── Eligibility states ───────────────────────────────────────────────────────

describe("eligibility states", () => {
  const cfg = rulesConfig([rule({ eligibility: { anyOf: ["status:MARRIOTT_PLATINUM", "membership:MARRIOTT_BONVOY"] } })])

  it("'eligible' only when a declared held entitlement satisfies the rule", () => {
    const [b] = applicablePerks(stay(), cfg, ents({ held: { memberships: [], statuses: ["MARRIOTT_PLATINUM"], cards: [] } }))
    expect(b.eligibility).toBe("eligible")
    expect(b.acquisition).toBeNull()
  })

  it("'purchasable' echoes the CHEAPEST configured acquisition — a config echo, not a computation", () => {
    const e = ents({
      purchasable: [
        { key: "MARRIOTT_PLATINUM", kind: "status", acquisitionCost: { amount: 500, currency: "USD" }, sourceUrl: "https://x.example", verifiedAt: "2026-08-28" },
        { key: "MARRIOTT_BONVOY", kind: "membership", acquisitionCost: { amount: 0, currency: "USD" }, sourceUrl: "https://x.example", verifiedAt: "2026-08-28" },
      ],
    })
    const [b] = applicablePerks(stay(), cfg, e)
    expect(b.eligibility).toBe("purchasable")
    expect(b.acquisition).toEqual({ key: "MARRIOTT_BONVOY", cost: { amount: 0, currency: "USD" }, alternatives: [] })
  })

  it("'requires' when nothing is held and no acquisition path is configured", () => {
    const [b] = applicablePerks(stay(), cfg, ents())
    expect(b.eligibility).toBe("requires")
    expect(b.requires).toEqual(["status:MARRIOTT_PLATINUM", "membership:MARRIOTT_BONVOY"])
  })

  it("a held entitlement of the WRONG kind never satisfies — 'MARRIOTT_BONVOY' as a card is not the membership", () => {
    const [b] = applicablePerks(stay(), cfg, ents({ held: { memberships: [], statuses: [], cards: ["MARRIOTT_BONVOY"] } }))
    expect(b.eligibility).toBe("requires")
  })
})

// ── Machine-readable optimizer semantics ─────────────────────────────────────

describe("optimizer-semantics validation", () => {
  it("an arithmetic rule must state its repetition — prose notes are not machine-readable", () => {
    const problems = validatePerkRules(rulesConfig([rule({ repetition: null })]))
    expect(problems.some(p => p.includes("must state its repetition"))).toBe(true)
  })

  it("a benefit-only rule must not carry repetition semantics", () => {
    const problems = validatePerkRules(rulesConfig([rule({ affectsArithmetic: false, repetition: "once_per_stay" })]))
    expect(problems.some(p => p.includes("benefit-only rule"))).toBe(true)
  })

  it("certificate consumption and once_per_certificate must always travel together", () => {
    expect(validatePerkRules(rulesConfig([rule({ repetition: "once_per_certificate", requiresCertificate: null })]))
      .some(p => p.includes("requires requiresCertificate"))).toBe(true)
    expect(validatePerkRules(rulesConfig([rule({ repetition: "once_per_stay", requiresCertificate: { type: "X_CERT", quantity: 1 } })]))
      .some(p => p.includes("once_per_certificate"))).toBe(true)
  })

  it("refuses malformed certificate requirements, rate names, and unknown or duplicate constraint/exclusion values", () => {
    const problems = validatePerkRules(rulesConfig([
      rule({ id: "bad-cert", repetition: "once_per_certificate", requiresCertificate: { type: "lower", quantity: 0 } }),
      rule({ id: "bad-rate", requiredRateName: "   " }),
      rule({ id: "bad-constraint", constraints: ["breakfast_included" as never] }),
      rule({ id: "dup-exclusion", exclusions: ["award_redemption", "award_redemption"] }),
    ]))
    expect(problems.some(p => p.includes("requiresCertificate.type"))).toBe(true)
    expect(problems.some(p => p.includes("requiresCertificate.quantity"))).toBe(true)
    expect(problems.some(p => p.includes("requiredRateName"))).toBe(true)
    expect(problems.some(p => p.includes('unknown constraints value "breakfast_included"'))).toBe(true)
    expect(problems.some(p => p.includes("must not contain duplicates"))).toBe(true)
  })

  it("refuses malformed acquisition alternatives", () => {
    const problems = validateEntitlements(ents({
      purchasable: [{
        key: "X", kind: "membership", acquisitionCost: { amount: 225, currency: "USD" },
        acquisitionAlternatives: [{ amount: 0, pointsProgram: "ihg points" }],
        sourceUrl: "https://x.example", verifiedAt: "2026-08-28",
      }],
    }))
    expect(problems.some(p => p.includes("acquisitionAlternatives[0].amount"))).toBe(true)
    expect(problems.some(p => p.includes("acquisitionAlternatives[0].pointsProgram"))).toBe(true)
  })
})

describe("certificate gating in the matcher", () => {
  const certRule = rulesConfig([rule({
    program: "IHG_ONE_REWARDS",
    eligibility: { anyOf: ["membership:IHG_AMBASSADOR"] },
    repetition: "once_per_certificate",
    requiresCertificate: { type: "IHG_AMBASSADOR_WEEKEND_NIGHT", quantity: 1 },
    stayPattern: { minNights: 2 },
  })])
  const bkk = stay({ program: "IHG_ONE_REWARDS", chain: "InterContinental", nights: 2 })

  it("holding the membership without the declared certificate is NOT eligible — the missing certificate is named", () => {
    const [b] = applicablePerks(bkk, certRule, ents({ held: { memberships: ["IHG_AMBASSADOR"], statuses: [], cards: [] } }))
    expect(b.eligibility).toBe("requires")
    expect(b.requires).toContain("certificate:IHG_AMBASSADOR_WEEKEND_NIGHT")
  })

  it("membership plus a declared certificate of sufficient quantity is eligible", () => {
    const [b] = applicablePerks(bkk, certRule, ents({
      held: { memberships: ["IHG_AMBASSADOR"], statuses: [], cards: [] },
      certificates: [{ key: "IHG_AMBASSADOR_WEEKEND_NIGHT", program: "IHG_ONE_REWARDS", quantity: 1 }],
    }))
    expect(b.eligibility).toBe("eligible")
    expect(b.requires).not.toContain("certificate:IHG_AMBASSADOR_WEEKEND_NIGHT")
  })

  it("badges pass the machine semantics through verbatim", () => {
    const [b] = applicablePerks(bkk, certRule, ents())
    expect(b.repetition).toBe("once_per_certificate")
    expect(b.requiresCertificate).toEqual({ type: "IHG_AMBASSADOR_WEEKEND_NIGHT", quantity: 1 })
    expect(b.constraints).toEqual([])
    expect(b.exclusions).toEqual([])
  })
})

// ── Doctrine: badges are display-only ────────────────────────────────────────

describe("badges never carry a synthesized number", () => {
  it("a badge exposes no points, totals or savings fields — only rule facts and the declared acquisition echo", () => {
    const [b] = applicablePerks(stay(), rulesConfig([rule()]), loadEntitlements(true))
    expect(Object.keys(b).sort()).toEqual([
      "acquisition", "affectsArithmetic", "appliesTo", "badgeLabel", "bookingChannel",
      "constraints", "displayBenefit", "eligibility", "exclusions", "perkType",
      "repetition", "requiredRateName", "requires", "requiresCertificate", "ruleId",
      "verification", "verifiedAt",
    ])
    expect(b.affectsArithmetic).toBe(true) // a marker for a later phase — nothing here computed with it
  })
})
