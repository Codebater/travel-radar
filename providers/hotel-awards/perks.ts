/**
 * Hotel perk rules + entitlements — typed loading, validation, and badge
 * matching for the Hotel Award Radar.
 *
 * DISPLAY-ONLY phase. This module answers exactly one question per stored
 * award observation: "which VERIFIED perk rules apply to this stay, and is
 * the user eligible, could they buy eligibility, or does it need a status/
 * card they don't hold?" It produces badges — never numbers.
 *
 * Load-bearing honesty rules:
 *   - a perk rule NEVER by itself licenses arithmetic. affectsArithmetic is
 *     a marker for a LATER construction phase, which may cite a rule only
 *     when the underlying observation carries sufficient source-stated data
 *     (full-stay totals are authoritative; actual per-night values plus a
 *     verified rule may support a construction; an AVERAGE points/night
 *     alone never becomes a stay total). Nothing here computes anything;
 *   - entitlement is DECLARED, never inferred: 'eligible' requires the exact
 *     key in config/entitlements.json held.*; 'purchasable' requires an
 *     explicit purchasable[] entry; everything else is 'requires';
 *   - brand restrictions match the observation's stored chain EXACTLY
 *     (case-insensitive) — a null chain never matches a restricted rule;
 *   - a dated rule applies only when the stay's check-in falls inside its
 *     effective window;
 *   - acquisition cost is a config ECHO (the declared price), not a
 *     computation, and appears only on 'purchasable' badges.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const RULES_PATH = path.join(ROOT, "config", "hotel-perk-rules.json")
const ENTITLEMENTS_PATH = path.join(ROOT, "config", "entitlements.json")

// ── Types ────────────────────────────────────────────────────────────────────

export type PerkApplicability = "award" | "cash" | "both"
export type EntitlementKind = "membership" | "status" | "card"

export interface HotelPerkRule {
  id: string
  program: string
  perkType: string
  badgeLabel: string
  displayBenefit: string
  appliesTo: PerkApplicability
  /** Entitlement keys ("kind:KEY") — ANY one satisfies the rule. */
  eligibility: { anyOf: string[] }
  stayPattern: { minNights: number | null }
  /** Accepted chain strings (case-insensitive exact match) — null = all. */
  brandRestrictions: string[] | null
  bookingChannel: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  sourceUrl: string
  verifiedAt: string
  /** source_page = encoded conditions were read on the official sourceUrl on
   *  verifiedAt; knowledge_encoded = NOT verified online — surfaced as
   *  unverified everywhere, never optimizer-grade. */
  verification: "source_page" | "knowledge_encoded"
  /** Exact quotes / findings from the verification pass, or why it failed. */
  verificationEvidence?: string
  affectsArithmetic: boolean
  arithmeticNote?: string
}

export interface HotelPerkRulesConfig {
  description?: string
  updated?: string
  eligibilityKeyFormat?: string
  rules: HotelPerkRule[]
}

export interface AcquisitionCost { amount: number; currency: string }

export interface PurchasableEntitlement {
  key: string
  kind: EntitlementKind
  program?: string
  /** Declared price — echoed on badges, never computed with. Null = price unknown. */
  acquisitionCost: AcquisitionCost | null
  sourceUrl: string
  verifiedAt: string
  note?: string
}

export interface CertificateConfig {
  key: string
  program: string
  /** Declared quantity only — consumption state is NOT config (later phase). */
  quantity: number
  note?: string
}

export interface EntitlementsConfig {
  description?: string
  updated?: string
  held: { memberships: string[]; statuses: string[]; cards: string[] }
  purchasable: PurchasableEntitlement[]
  certificates: CertificateConfig[]
}

// ── Validation (config is refused loudly, never patched silently) ────────────

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const KEY = /^[A-Z0-9_]+$/
const ELIGIBILITY_KEY = /^(membership|status|card):[A-Z0-9_]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS: EntitlementKind[] = ["membership", "status", "card"]
const APPLIES: PerkApplicability[] = ["award", "cash", "both"]

export function validatePerkRules(config: HotelPerkRulesConfig): string[] {
  const problems: string[] = []
  if (!Array.isArray(config.rules)) return ["rules must be an array"]
  const seen = new Set<string>()
  config.rules.forEach((r, i) => {
    const at = `rules[${i}]${r?.id ? ` (${r.id})` : ""}`
    if (!r.id || !SLUG.test(r.id)) problems.push(`${at}: id must be a kebab-case slug`)
    else if (seen.has(r.id)) problems.push(`${at}: duplicate id`)
    else seen.add(r.id)
    if (!r.program || !KEY.test(r.program)) problems.push(`${at}: program must be an UPPER_SNAKE program key`)
    if (!r.perkType || !/^[a-z0-9_]+$/.test(r.perkType)) problems.push(`${at}: perkType must be a snake_case type`)
    if (!r.badgeLabel?.trim()) problems.push(`${at}: badgeLabel is required`)
    if (!r.displayBenefit?.trim()) problems.push(`${at}: displayBenefit is required`)
    if (!APPLIES.includes(r.appliesTo)) problems.push(`${at}: appliesTo must be award|cash|both`)
    const anyOf = r.eligibility?.anyOf
    if (!Array.isArray(anyOf) || anyOf.length === 0) problems.push(`${at}: eligibility.anyOf must be a non-empty array`)
    else anyOf.forEach(k => { if (!ELIGIBILITY_KEY.test(k)) problems.push(`${at}: eligibility key "${k}" must be kind:KEY (kind ∈ membership|status|card)`) })
    const mn = r.stayPattern?.minNights
    if (r.stayPattern === undefined || (mn !== null && (!Number.isInteger(mn) || mn < 1))) {
      problems.push(`${at}: stayPattern.minNights must be null or an integer ≥ 1`)
    }
    if (r.brandRestrictions !== null && (!Array.isArray(r.brandRestrictions) || r.brandRestrictions.length === 0 || r.brandRestrictions.some(b => !b?.trim()))) {
      problems.push(`${at}: brandRestrictions must be null or a non-empty array of non-empty strings`)
    }
    for (const [field, v] of [["effectiveFrom", r.effectiveFrom], ["effectiveTo", r.effectiveTo], ["verifiedAt", r.verifiedAt]] as const) {
      if (field === "verifiedAt" ? !DATE.test(v ?? "") : v !== null && !DATE.test(v)) problems.push(`${at}: ${field} must be ${field === "verifiedAt" ? "" : "null or "}YYYY-MM-DD`)
    }
    if (!r.sourceUrl?.startsWith("https://")) problems.push(`${at}: sourceUrl must be an https URL`)
    if (r.verification !== "source_page" && r.verification !== "knowledge_encoded") problems.push(`${at}: verification must be source_page|knowledge_encoded`)
    if (typeof r.affectsArithmetic !== "boolean") problems.push(`${at}: affectsArithmetic must be a boolean`)
  })
  return problems
}

export function validateEntitlements(config: EntitlementsConfig): string[] {
  const problems: string[] = []
  const held = config.held
  if (!held || !Array.isArray(held.memberships) || !Array.isArray(held.statuses) || !Array.isArray(held.cards)) {
    problems.push("held must declare memberships, statuses and cards arrays (empty is valid — entitlement is never inferred)")
  } else {
    for (const [kind, keys] of [["membership", held.memberships], ["status", held.statuses], ["card", held.cards]] as const) {
      keys.forEach(k => { if (!KEY.test(k)) problems.push(`held ${kind} key "${k}" must be UPPER_SNAKE`) })
    }
  }
  if (!Array.isArray(config.purchasable)) problems.push("purchasable must be an array")
  else config.purchasable.forEach((p, i) => {
    const at = `purchasable[${i}]${p?.key ? ` (${p.key})` : ""}`
    if (!p.key || !KEY.test(p.key)) problems.push(`${at}: key must be UPPER_SNAKE`)
    if (!KINDS.includes(p.kind)) problems.push(`${at}: kind must be membership|status|card`)
    if (p.acquisitionCost !== null && (typeof p.acquisitionCost?.amount !== "number" || p.acquisitionCost.amount < 0 || !p.acquisitionCost.currency?.trim())) {
      problems.push(`${at}: acquisitionCost must be null or {amount ≥ 0, currency}`)
    }
    if (!p.sourceUrl?.startsWith("https://")) problems.push(`${at}: sourceUrl must be an https URL`)
    if (!DATE.test(p.verifiedAt ?? "")) problems.push(`${at}: verifiedAt must be YYYY-MM-DD`)
  })
  if (!Array.isArray(config.certificates)) problems.push("certificates must be an array")
  else config.certificates.forEach((c, i) => {
    const at = `certificates[${i}]${c?.key ? ` (${c.key})` : ""}`
    if (!c.key || !KEY.test(c.key)) problems.push(`${at}: key must be UPPER_SNAKE`)
    if (!c.program || !KEY.test(c.program)) problems.push(`${at}: program must be an UPPER_SNAKE program key`)
    if (!Number.isInteger(c.quantity) || c.quantity < 0) problems.push(`${at}: quantity must be an integer ≥ 0`)
  })
  return problems
}

// ── Loaders (cached like every other config; throw on invalid data) ──────────

let cachedRules: HotelPerkRulesConfig | null = null
let cachedEntitlements: EntitlementsConfig | null = null

export function loadHotelPerkRules(force = false, configPath = RULES_PATH): HotelPerkRulesConfig {
  if (cachedRules && !force && configPath === RULES_PATH) return cachedRules
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as HotelPerkRulesConfig
  const problems = validatePerkRules(raw)
  if (problems.length > 0) throw new Error(`config/hotel-perk-rules.json is invalid:\n  - ${problems.join("\n  - ")}`)
  if (configPath === RULES_PATH) cachedRules = raw
  return raw
}

export function loadEntitlements(force = false, configPath = ENTITLEMENTS_PATH): EntitlementsConfig {
  if (cachedEntitlements && !force && configPath === ENTITLEMENTS_PATH) return cachedEntitlements
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as EntitlementsConfig
  const problems = validateEntitlements(raw)
  if (problems.length > 0) throw new Error(`config/entitlements.json is invalid:\n  - ${problems.join("\n  - ")}`)
  if (configPath === ENTITLEMENTS_PATH) cachedEntitlements = raw
  return raw
}

// ── Matching (pure, deterministic — the date is an argument, never Date.now)──

export type PerkEligibilityState = "eligible" | "purchasable" | "requires"

export interface PerkBadge {
  ruleId: string
  perkType: string
  badgeLabel: string
  displayBenefit: string
  appliesTo: PerkApplicability
  eligibility: PerkEligibilityState
  /** The rule's anyOf keys, verbatim — what would satisfy it. */
  requires: string[]
  /** Declared acquisition price of the cheapest configured purchasable
   *  satisfier — a config echo, present only on 'purchasable' badges. */
  acquisition: { key: string; cost: AcquisitionCost | null } | null
  bookingChannel: string | null
  affectsArithmetic: boolean
  verifiedAt: string
  verification: HotelPerkRule["verification"]
}

/** The observation fields matching needs — a subset of NormalizedHotelAward. */
export interface PerkMatchStay {
  program: string
  chain: string | null
  nights: number
  checkIn: string
}

function heldKeys(ents: EntitlementsConfig): Set<string> {
  const s = new Set<string>()
  for (const k of ents.held.memberships) s.add(`membership:${k}`)
  for (const k of ents.held.statuses) s.add(`status:${k}`)
  for (const k of ents.held.cards) s.add(`card:${k}`)
  return s
}

function purchasableFor(ents: EntitlementsConfig, eligibilityKey: string): PurchasableEntitlement | null {
  const [kind, key] = eligibilityKey.split(":")
  const matches = ents.purchasable.filter(p => p.kind === kind && p.key === key)
  if (matches.length === 0) return null
  // Cheapest declared price wins the echo; unknown-price entries sort last.
  return matches.sort((a, b) => (a.acquisitionCost?.amount ?? Infinity) - (b.acquisitionCost?.amount ?? Infinity))[0]
}

/** Which verified perk rules apply to one stored award-stay observation, and
 *  at which declared eligibility state. Display-only: no ranking, no numbers. */
export function applicablePerks(
  stay: PerkMatchStay,
  rules: HotelPerkRulesConfig,
  ents: EntitlementsConfig,
): PerkBadge[] {
  const held = heldKeys(ents)
  const badges: PerkBadge[] = []

  for (const rule of rules.rules) {
    if (rule.program !== stay.program) continue
    if (rule.stayPattern.minNights !== null && stay.nights < rule.stayPattern.minNights) continue
    // A dated rule applies only when the stay's check-in is inside its window.
    if (rule.effectiveFrom !== null && stay.checkIn < rule.effectiveFrom) continue
    if (rule.effectiveTo !== null && stay.checkIn > rule.effectiveTo) continue
    if (rule.brandRestrictions !== null) {
      const chain = stay.chain?.trim().toLowerCase()
      if (!chain || !rule.brandRestrictions.some(b => b.trim().toLowerCase() === chain)) continue
    }

    let state: PerkEligibilityState = "requires"
    let acquisition: PerkBadge["acquisition"] = null
    if (rule.eligibility.anyOf.some(k => held.has(k))) {
      state = "eligible"
    } else {
      const options = rule.eligibility.anyOf
        .map(k => purchasableFor(ents, k))
        .filter((p): p is PurchasableEntitlement => p !== null)
        .sort((a, b) => (a.acquisitionCost?.amount ?? Infinity) - (b.acquisitionCost?.amount ?? Infinity))
      if (options.length > 0) {
        state = "purchasable"
        acquisition = { key: options[0].key, cost: options[0].acquisitionCost }
      }
    }

    badges.push({
      ruleId: rule.id,
      perkType: rule.perkType,
      badgeLabel: rule.badgeLabel,
      displayBenefit: rule.displayBenefit,
      appliesTo: rule.appliesTo,
      eligibility: state,
      requires: [...rule.eligibility.anyOf],
      acquisition,
      bookingChannel: rule.bookingChannel,
      affectsArithmetic: rule.affectsArithmetic,
      verifiedAt: rule.verifiedAt,
      verification: rule.verification,
    })
  }

  return badges
}
