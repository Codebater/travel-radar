/**
 * Perk-aware stay-plan resolution — the verified machine-readable perk layer
 * (config/hotel-perk-rules.json + declared entitlements) applied to stay-plan
 * SEGMENTS. Pure functions over configs passed in; nothing here loads, writes
 * or searches.
 *
 * Every candidate perk (every rule of the segment's program) resolves to one
 * of exactly three states:
 *
 *   applied                — the VERIFIED rule applies to this planned segment
 *                            given DECLARED entitlements. For an arithmetic
 *                            rule the only number this licenses is the rule-
 *                            supported FREE-NIGHT COUNT (e.g. "Stay for 5,
 *                            Pay for 4" on one qualifying 5-night reservation
 *                            = 1 free night). The free night's points value is
 *                            never stated by the source and NEVER invented —
 *                            pointsValue is structurally null, and no
 *                            discounted points total exists anywhere.
 *   qualifies_but_unpriced — the rule qualifies but its price effect on this
 *                            segment cannot be honestly established (e.g. the
 *                            source stated a full-stay total and whether it
 *                            already reflects the benefit is unstated, or a
 *                            source-stated constraint is not machine-checkable
 *                            like the program-specific weekend definition).
 *                            May be highlighted; must never change a number
 *                            or the ranking.
 *   not_eligible           — shape mismatch, unverified rule, cash-only rule
 *                            on an award segment, missing DECLARED entitlement
 *                            (never inferred, never assumed), or certificate
 *                            stock exhausted (annual certificates are never
 *                            reused within one plan).
 *
 * Ranking doctrine: ONLY applied arithmetic perks may affect ranking, and
 * only through their free-night COUNT. Certificate-consuming perks resolve
 * plan-level (consumption is order-dependent) and are excluded from the
 * per-edge count the optimizer ranks with. knowledge_encoded rules are never
 * optimizer-grade.
 */

import {
  applicablePerks,
  heldKeys,
  type EntitlementsConfig,
  type HotelPerkRule,
  type HotelPerkRulesConfig,
  type PerkBadge,
} from "./perks.js"

export type PerkResolutionState = "applied" | "qualifies_but_unpriced" | "not_eligible"

/** Honest machine-stable reason slugs — every resolution says why. */
export type PerkResolutionReason =
  | "applied"                                // arithmetic rule, free-night count rule-supported
  | "applied-annotation-only"                // benefit-only rule — never numeric, never ranked
  | "stay-shape-not-matched"                 // nights/brand/date window do not match
  | "rule-unverified"                        // knowledge_encoded — never optimizer-grade
  | "cash-rates-only"                        // rule applies to cash rates; segments are award stays
  | "excludes-award-redemption"              // source-stated exclusion forbids award stays
  | "entitlement-not-held"                   // declared entitlements do not satisfy the rule
  | "entitlement-purchasable-not-held"       // an acquisition path exists but nothing is held
  | "certificate-exhausted-in-plan"          // declared stock already consumed by this plan
  | "stated-total-may-already-reflect-benefit" // full-stay total is authoritative; effect unknown
  | "weekend-definition-not-encoded"         // which nights count as "weekend" is program-specific
  | "block-length-unstated"                  // per_block repetition without a stated block length

export interface SegmentPerkResolution {
  ruleId: string
  badgeLabel: string
  program: string
  perkType: string
  state: PerkResolutionState
  reason: PerkResolutionReason
  /** Rule-supported free-night COUNT for an applied arithmetic perk on this
   *  segment; 0 in every other case. Counts nights, never points. */
  freeNights: number
  /** Structurally null — the free night's points value is never invented. */
  pointsValue: null
  affectsArithmetic: boolean
  verification: HotelPerkRule["verification"]
  /** Source-stated booking conditions the actual booking must honor for the
   *  perk to apply — echoed for the user, never verified bookable here. */
  bookingConditions: string[]
  /** Certificate this applied resolution consumed from the plan ledger. */
  certificateConsumed: { type: string; quantity: number } | null
  /** What would satisfy the rule (verbatim keys) — for not_eligible states. */
  requires: string[]
  /** The DECLARED held keys (kind:KEY) that satisfy this rule, in the rule's
   *  anyOf order — attribution for "why does this apply", never inferred.
   *  Empty for not_eligible states. */
  satisfiedBy: string[]
  /** The rule's stay-pattern minimum nights, echoed for display. */
  minNights: number | null
  /** Declared acquisition path (config ECHO from the badge) — present only
   *  when the reason is entitlement-purchasable-not-held; cash and points
   *  alternatives stay separate clauses, never blended. */
  acquisition: PerkBadge["acquisition"]
}

/** The segment fields perk resolution needs. */
export interface PerkPlanSegment {
  program: string
  chain: string | null
  nights: number
  checkIn: string
  checkOut: string
  quoteBasis: string
}

/** "Include in plan" categories — arithmetic mechanics the user can exclude.
 *  Benefit-only rules always annotate and are not toggled. */
export type PerkIncludeCategory = "nth_night" | "card" | "certificate"
export const PERK_INCLUDE_CATEGORIES: PerkIncludeCategory[] = ["nth_night", "card", "certificate"]

export function perkIncludeCategory(rule: Pick<HotelPerkRule, "affectsArithmetic" | "requiresCertificate" | "eligibility">): PerkIncludeCategory | null {
  if (!rule.affectsArithmetic) return null                 // benefit-only: never toggled, never ranked
  if (rule.requiresCertificate !== null) return "certificate"
  if (rule.eligibility.anyOf.every(k => k.startsWith("card:"))) return "card"
  return "nth_night"
}

/** Drop excluded arithmetic categories BEFORE resolution — an excluded
 *  mechanic neither ranks nor renders. Benefit-only rules always survive. */
export function filterRulesByInclude(config: HotelPerkRulesConfig, include: Set<PerkIncludeCategory>): HotelPerkRulesConfig {
  return {
    ...config,
    rules: config.rules.filter(r => {
      const cat = perkIncludeCategory(r)
      return cat === null || include.has(cat)
    }),
  }
}

const CONSTRAINT_TEXT: Record<string, string> = {
  single_reservation: "book as ONE reservation",
  standard_room_only: "standard room only",
  full_points_only: "100% points redemption (not points + cash)",
  weekend_stay: "qualifying nights must be weekend nights",
}

function bookingConditions(badge: PerkBadge): string[] {
  const out = badge.constraints.map(c => CONSTRAINT_TEXT[c] ?? c)
  if (badge.requiredRateName) out.push(`must be booked on the named rate "${badge.requiredRateName}"`)
  return out
}

/** Plan-level certificate ledger — declared quantities only; one plan never
 *  reuses an annual certificate. */
export type CertificateLedger = Map<string, number>

export function newCertificateLedger(ents: EntitlementsConfig): CertificateLedger {
  return new Map(ents.certificates.map(c => [c.key, c.quantity]))
}

function resolution(
  badge: PerkBadge,
  state: PerkResolutionState,
  reason: PerkResolutionReason,
  freeNights = 0,
  certificateConsumed: SegmentPerkResolution["certificateConsumed"] = null,
): SegmentPerkResolution {
  return {
    ruleId: badge.ruleId,
    badgeLabel: badge.badgeLabel,
    program: "",                                            // filled by caller
    perkType: badge.perkType,
    state,
    reason,
    freeNights,
    pointsValue: null,
    affectsArithmetic: badge.affectsArithmetic,
    verification: badge.verification,
    bookingConditions: state === "not_eligible" ? [] : bookingConditions(badge),
    certificateConsumed,
    requires: state === "not_eligible" ? badge.requires : [],
    satisfiedBy: [],                                        // filled by the caller from DECLARED keys
    minNights: null,
    acquisition: reason === "entitlement-purchasable-not-held" ? badge.acquisition : null,
  }
}

/**
 * Resolve every candidate perk of one segment. The ledger is MUTATED when an
 * applied resolution consumes a certificate — call segments in date order so
 * consumption is deterministic.
 */
export function resolveSegmentPerks(
  segment: PerkPlanSegment,
  rules: HotelPerkRulesConfig,
  ents: EntitlementsConfig,
  ledger: CertificateLedger,
): SegmentPerkResolution[] {
  const badges = applicablePerks(
    { program: segment.program, chain: segment.chain, nights: segment.nights, checkIn: segment.checkIn },
    rules, ents,
  )
  const out: SegmentPerkResolution[] = []
  const held = heldKeys(ents)

  for (const rule of rules.rules) {
    if (rule.program !== segment.program) continue          // not a candidate for this segment
    const badge = badges.find(b => b.ruleId === rule.id)

    let res: SegmentPerkResolution
    if (!badge) {
      // Shape-gated out by the matcher (nights / brand / effective window).
      res = {
        ruleId: rule.id, badgeLabel: rule.badgeLabel, program: rule.program, perkType: rule.perkType,
        state: "not_eligible", reason: "stay-shape-not-matched", freeNights: 0, pointsValue: null,
        affectsArithmetic: rule.affectsArithmetic, verification: rule.verification,
        bookingConditions: [], certificateConsumed: null, requires: [...rule.eligibility.anyOf],
        satisfiedBy: [], minNights: rule.stayPattern.minNights, acquisition: null,
      }
    } else {
      res = ladder(badge, rule, segment, ents, ledger)
      res.program = rule.program
      res.minNights = rule.stayPattern.minNights
      // Attribution = DECLARED held keys ∩ the rule's own anyOf, in rule order.
      if (res.state !== "not_eligible") res.satisfiedBy = rule.eligibility.anyOf.filter(k => held.has(k))
    }
    out.push(res)
  }
  return out
}

function ladder(
  badge: PerkBadge,
  rule: HotelPerkRule,
  segment: PerkPlanSegment,
  ents: EntitlementsConfig,
  ledger: CertificateLedger,
): SegmentPerkResolution {
  // Unverified rules are never optimizer-grade — not applied, not qualifying.
  if (badge.verification !== "source_page") return resolution(badge, "not_eligible", "rule-unverified")
  // Plan segments are award stays: cash-only rules and award-excluding rules are out.
  if (badge.appliesTo === "cash") return resolution(badge, "not_eligible", "cash-rates-only")
  if (badge.exclusions.includes("award_redemption")) return resolution(badge, "not_eligible", "excludes-award-redemption")
  // Entitlement is DECLARED, never inferred — nothing is silently assumed.
  if (badge.eligibility !== "eligible") {
    return resolution(badge, "not_eligible",
      badge.eligibility === "purchasable" ? "entitlement-purchasable-not-held" : "entitlement-not-held")
  }
  // Annual certificates cannot be reused within one plan.
  const cert = badge.requiresCertificate
  if (cert !== null && (ledger.get(cert.type) ?? 0) < cert.quantity) {
    return resolution(badge, "not_eligible", "certificate-exhausted-in-plan")
  }
  // Benefit-only perks annotate — never numeric, never ranked.
  if (!badge.affectsArithmetic) return resolution(badge, "applied", "applied-annotation-only")

  // Arithmetic rules: only a rule-supported construction may produce a number.
  if (badge.constraints.includes("weekend_stay")) {
    // Which nights count as "weekend" is program-specific and NOT encoded —
    // the constraint cannot be verified against the segment's dates.
    return resolution(badge, "qualifies_but_unpriced", "weekend-definition-not-encoded")
  }
  let freeNights: number
  if (badge.repetition === "per_block") {
    const block = rule.stayPattern.minNights
    if (block === null) return resolution(badge, "qualifies_but_unpriced", "block-length-unstated")
    freeNights = Math.floor(segment.nights / block)
  } else {
    freeNights = 1                                          // once_per_stay / once_per_certificate
  }
  if (segment.quoteBasis === "full_stay") {
    // The source-stated stay total is authoritative. Whether it already
    // reflects this benefit is not stated — claiming a free night on top
    // could double-count, and no discounted total may ever be constructed.
    return resolution(badge, "qualifies_but_unpriced", "stated-total-may-already-reflect-benefit")
  }
  // Applied: the free-night COUNT is rule-supported; its points value is not
  // stated and never invented. Consume the certificate, if any, NOW.
  let consumed: SegmentPerkResolution["certificateConsumed"] = null
  if (cert !== null) {
    ledger.set(cert.type, (ledger.get(cert.type) ?? 0) - cert.quantity)
    consumed = { type: cert.type, quantity: cert.quantity }
  }
  return resolution(badge, "applied", "applied", freeNights, consumed)
}

/**
 * Per-edge free-night count for OPTIMIZER RANKING: applied arithmetic,
 * NON-certificate perks only. Certificate consumption is plan-order-dependent
 * and resolves plan-level — it never enters the per-edge ranking count.
 * (No certificate rule can currently apply to an award segment anyway.)
 */
export function rankablePerkNights(
  segment: PerkPlanSegment,
  rules: HotelPerkRulesConfig,
  ents: EntitlementsConfig,
): number {
  const nonCert: HotelPerkRulesConfig = { ...rules, rules: rules.rules.filter(r => r.requiresCertificate === null) }
  return resolveSegmentPerks(segment, nonCert, ents, new Map())
    .filter(r => r.state === "applied" && r.affectsArithmetic)
    .reduce((sum, r) => sum + r.freeNights, 0)
}

export interface AppliedPerkSummary {
  ruleId: string
  badgeLabel: string
  program: string
  count: number
  freeNights: number
  annotationOnly: boolean
}

export interface PlanPerkSummary {
  /** Free nights from ALL applied arithmetic perks (certificates included). */
  appliedFreeNights: number
  /** Applied arithmetic perks — the "verified perks applied" of the plan. */
  applied: AppliedPerkSummary[]
  /** Applied benefit-only annotations (breakfast/F&B/status) — never numeric. */
  annotations: AppliedPerkSummary[]
  qualifiesUnpriced: { ruleId: string; badgeLabel: string; program: string; count: number; reason: PerkResolutionReason }[]
  certificatesConsumed: { type: string; quantity: number }[]
}

/**
 * Resolve a whole plan's segments in date order with one certificate ledger.
 * Returns per-segment resolutions (parallel to `segments`) plus the summary.
 */
export function resolvePlanPerks(
  segments: PerkPlanSegment[],
  rules: HotelPerkRulesConfig,
  ents: EntitlementsConfig,
): { segments: SegmentPerkResolution[][]; summary: PlanPerkSummary } {
  const ledger = newCertificateLedger(ents)
  const perSegment = segments.map(s => resolveSegmentPerks(s, rules, ents, ledger))

  const applied = new Map<string, AppliedPerkSummary>()
  const annotations = new Map<string, AppliedPerkSummary>()
  const qualifies = new Map<string, PlanPerkSummary["qualifiesUnpriced"][number]>()
  const certs = new Map<string, number>()
  for (const r of perSegment.flat()) {
    if (r.state === "applied") {
      const bucket = r.affectsArithmetic ? applied : annotations
      const cur = bucket.get(r.ruleId) ?? {
        ruleId: r.ruleId, badgeLabel: r.badgeLabel, program: r.program,
        count: 0, freeNights: 0, annotationOnly: !r.affectsArithmetic,
      }
      cur.count++
      cur.freeNights += r.freeNights
      bucket.set(r.ruleId, cur)
      if (r.certificateConsumed) {
        certs.set(r.certificateConsumed.type, (certs.get(r.certificateConsumed.type) ?? 0) + r.certificateConsumed.quantity)
      }
    } else if (r.state === "qualifies_but_unpriced") {
      const cur = qualifies.get(r.ruleId) ?? { ruleId: r.ruleId, badgeLabel: r.badgeLabel, program: r.program, count: 0, reason: r.reason }
      cur.count++
      qualifies.set(r.ruleId, cur)
    }
  }
  return {
    segments: perSegment,
    summary: {
      appliedFreeNights: [...applied.values()].reduce((s, p) => s + p.freeNights, 0),
      applied: [...applied.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      annotations: [...annotations.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      qualifiesUnpriced: [...qualifies.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      certificatesConsumed: [...certs.entries()].map(([type, quantity]) => ({ type, quantity })).sort((a, b) => a.type.localeCompare(b.type)),
    },
  }
}
