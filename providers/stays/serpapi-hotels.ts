/**
 * SerpAPI Google Hotels — METERED VERIFICATION ONLY.
 *
 * Role in the funnel: the paid last word on "is this price real at retail?".
 * It is never a discovery crawler: the ONLY caller is the verification gate,
 * every call has a recorded gate reason, and the provider itself enforces a
 * monthly ceiling. Uses the flight radar's SERP_API_KEY credential
 * convention, but its usage is counted under its OWN provider name
 * ('serpapi_hotels') with its OWN budget (STAYS_SERPAPI_MONTHLY_BUDGET,
 * default from config) — the flight radar's budget and manual reserve are
 * structurally out of reach: nothing here reads or writes the 'serpapi'
 * usage row.
 *
 * Query model: a Google Hotels search by property name (`q`), matched back
 * to the property by normalised-name set equality — a wrong-property match
 * poisons history invisibly, so no confident match = no observation
 * (`no-results`), never a guess. The response's search_parameters echo the
 * dates and currency; both are verified.
 *
 * Field honesty: Google gives nightly and total, each with an optional
 * before-taxes figure. Taxes are "included" ONLY when a before-taxes figure
 * exists and is lower (the difference IS the taxes); with no before-taxes
 * figure the status stays "unknown". Board and room are never stated at
 * this level and stay unknown/null.
 */

import { serpApiBudget } from "../../cache/policy.js"
import { getDb, nowIso, type DB } from "../../db/index.js"
import {
  classifyFailure,
  recordCallAttempt,
  recordCallOutcome,
  recordProviderEvent,
  readUsage,
} from "../../db/repositories.js"
import type {
  NormalizedStayRate,
  ProviderHealth,
  ProviderQuota,
  StayProvider,
  StayProviderCapabilities,
  StayRateQuery,
  StayRateSearchResult,
  StaySearchOptions,
} from "./types.js"

export const SERPAPI_HOTELS_PROVIDER = "serpapi_hotels"

function apiBase(): string {
  return process.env.SERPAPI_HOTELS_API_BASE || "https://serpapi.com"
}

/** The stay radar's own configured monthly ceiling. */
export function staysSerpApiMonthlyBudget(fallback = 15): number {
  const raw = Number(process.env.STAYS_SERPAPI_MONTHLY_BUDGET ?? fallback)
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

/**
 * The account-level monthly allowance shared by BOTH radars. Defaults to the
 * free tier's 100 — a paid tier is never silently assumed; raising it is an
 * explicit env decision (SERPAPI_ACCOUNT_MONTHLY_ALLOWANCE).
 */
export function serpApiAccountAllowance(fallback = 100): number {
  const raw = Number(process.env.SERPAPI_ACCOUNT_MONTHLY_ALLOWANCE ?? fallback)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * What the stay radar may actually spend this month: its own configured
 * ceiling, capped by what the account allowance leaves AFTER the flight
 * radar's entire budget (which includes the flight manual reserve). With the
 * defaults — allowance 100, flight budget 90, stays config 15 — the
 * effective stay ceiling is 10: the flight radar's ground is untouchable.
 */
export function staysEffectiveMonthlyBudget(): { ceiling: number; accountHeadroom: number; configured: number } {
  const configured = staysSerpApiMonthlyBudget()
  const accountHeadroom = Math.max(0, serpApiAccountAllowance() - serpApiBudget().monthlyBudget)
  return { ceiling: Math.min(configured, accountHeadroom), accountHeadroom, configured }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_TIMEOUT_MS = 30_000

type FetchLike = typeof globalThis.fetch

export interface SerpApiHotelsOptions {
  fetchImpl?: FetchLike
  db?: DB
}

export class SerpApiHotelsProvider implements StayProvider {
  readonly name = SERPAPI_HOTELS_PROVIDER
  readonly kind = "metered" as const
  readonly confidence = "high" as const
  readonly verificationLevel = "verified" as const
  readonly capabilities: StayProviderCapabilities = {
    dateSpecificRates: true,
    calendar: false,
    roomLevel: false,
    structuredBoard: false,
    cancellation: false,
    taxesFees: "partial",     // before-taxes figures appear on some offers only
  }

  private readonly fetchImpl: FetchLike
  private readonly explicitDb: DB | null

  constructor(options: SerpApiHotelsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.explicitDb = options.db ?? null
  }

  private db(): DB {
    return this.explicitDb ?? getDb()
  }

  isConfigured(): boolean {
    return Boolean(process.env.SERP_API_KEY)
  }

  /** Never calls SerpAPI — a health check must never be billable. */
  async health(): Promise<ProviderHealth> {
    const usage = readUsage(this.db(), this.name)
    return {
      provider: this.name,
      status: !this.isConfigured() ? "unconfigured"
        : usage.lastError && !usage.lastSuccessAt ? "degraded" : "ok",
      detail: this.isConfigured()
        ? `metered verification; ${usage.attempted}/${staysEffectiveMonthlyBudget().ceiling} of the stay radar's effective monthly budget used`
        : "SERP_API_KEY not set",
      latencyMs: null,
      checkedAt: nowIso(),
      quota: this.quota(),
    }
  }

  quota(): ProviderQuota | null {
    const usage = readUsage(this.db(), this.name)
    const budget = staysEffectiveMonthlyBudget().ceiling
    return {
      estimatedUsed: usage.attempted,
      budget,
      reserve: 0,                 // the manual reserve concept belongs to flights; stays has none
      automationRemaining: Math.max(0, budget - usage.attempted),
      reportedRemaining: null,
      reportedLimit: null,
      reportedAt: null,
    }
  }

  async searchRates(query: StayRateQuery, options: StaySearchOptions = {}): Promise<StayRateSearchResult> {
    const started = Date.now()
    const fail = (reason: StayRateSearchResult["reason"], error: string, spent: number): StayRateSearchResult => ({
      provider: this.name, ok: false, rates: [], reason, error,
      callsSpent: spent, latencyMs: Date.now() - started,
    })

    if (!this.isConfigured()) return fail("unconfigured", "SERP_API_KEY not set", 0)
    if (!query.providerRef.startsWith("q:") || query.providerRef.length < 5) {
      return fail("provider-error", `serpapi_hotels ref must be "q:<property name>", got: ${query.providerRef}`, 0)
    }
    if (!DATE_PATTERN.test(query.checkIn) || !DATE_PATTERN.test(query.checkOut)) {
      return fail("provider-error", `invalid dates: ${query.checkIn}..${query.checkOut}`, 0)
    }
    const nights = Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / 86_400_000)
    if (nights <= 0) return fail("provider-error", "check-out must be after check-in", 0)

    // The provider's own hard ceilings — the caller's gate should have
    // checked first, but a ceiling that trusts its callers is not a ceiling.
    // Two independent guards:
    //   1. the stay radar's effective monthly budget (its config, capped by
    //      the account allowance minus the FLIGHT radar's whole budget — the
    //      flight budget and reserve are ground the stays can never stand on);
    //   2. combined actual usage across both radars vs the account allowance,
    //      so even a mis-configured pair of budgets cannot overrun the plan.
    const db = this.db()
    const usage = readUsage(db, this.name)
    const effective = staysEffectiveMonthlyBudget()
    if (usage.attempted >= effective.ceiling) {
      return fail("budget-exhausted",
        `stay verification budget exhausted (${usage.attempted}/${effective.ceiling} this month; ` +
        `configured ${effective.configured}, account headroom after flight budget ${effective.accountHeadroom})`, 0)
    }
    const combinedUsed = usage.attempted + readUsage(db, "serpapi").attempted
    if (combinedUsed >= serpApiAccountAllowance()) {
      return fail("budget-exhausted",
        `SerpAPI account allowance exhausted (${combinedUsed}/${serpApiAccountAllowance()} across flights + stays)`, 0)
    }

    const searchText = query.providerRef.slice(2)
    const url = `${apiBase()}/search.json`
      + `?engine=google_hotels&q=${encodeURIComponent(searchText)}`
      + `&check_in_date=${query.checkIn}&check_out_date=${query.checkOut}`
      + `&adults=${query.adults}&currency=${encodeURIComponent(query.currency)}`
      + `&api_key=${encodeURIComponent(process.env.SERP_API_KEY as string)}`

    recordCallAttempt(db, this.name)      // before the fetch — a crash still counts as spent
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let payload: unknown
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal, redirect: "error" })
      const text = await res.text()
      if (!res.ok) {
        const error = `HTTP ${res.status}`
        recordCallOutcome(db, this.name, { ok: false, error })
        recordProviderEvent(db, this.name, classifyFailure(error), `${error}: ${text.slice(0, 200)}`)
        return fail("provider-error", error, 1)
      }
      try {
        payload = JSON.parse(text)
      } catch {
        recordCallOutcome(db, this.name, { ok: false, error: "not JSON" })
        return fail("provider-error", "malformed response: not JSON", 1)
      }
      recordCallOutcome(db, this.name, { ok: true })
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      const error = aborted ? `timeout after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (err as Error).message
      recordCallOutcome(db, this.name, { ok: false, error })
      if (!aborted) recordProviderEvent(db, this.name, classifyFailure(error), error)
      return fail(aborted ? "timeout" : "provider-error", error, 1)
    } finally {
      clearTimeout(timer)
    }

    const parsed = parseGoogleHotels(payload, query, searchText, nights, this.name)
    if ("error" in parsed) {
      if (parsed.record) recordProviderEvent(db, this.name, "error", parsed.error)
      return fail(parsed.reason, parsed.error, 1)
    }
    if (parsed.rates.length === 0) return fail("no-results", "matched property carries no priced offers", 1)

    return {
      provider: this.name,
      ok: true,
      rates: parsed.rates,
      callsSpent: 1,
      latencyMs: Date.now() - started,
      ...(options.captureRaw ? { raw: payload } : {}),
    }
  }
}

// ─── Parsing (exported for fixture tests) ───────────────────────────────────

type ParseFailure = { error: string; reason: "provider-error" | "no-results"; record: boolean }

export function parseGoogleHotels(
  payload: unknown,
  query: StayRateQuery,
  searchText: string,
  nights: number,
  providerName: string,
): { rates: NormalizedStayRate[]; matchedName: string } | ParseFailure {
  if (!payload || typeof payload !== "object") {
    return { error: "malformed response: not an object", reason: "provider-error", record: false }
  }
  const root = payload as Record<string, unknown>
  if (root.error) {
    return { error: `serpapi error: ${String(root.error)}`, reason: "no-results", record: true }
  }

  // Date + currency echo: search_parameters state what was actually priced.
  const params = root.search_parameters as Record<string, unknown> | undefined
  if (params) {
    if (typeof params.check_in_date === "string" && params.check_in_date !== query.checkIn) {
      return {
        error: `date mismatch: asked ${query.checkIn}, response priced ${params.check_in_date}`,
        reason: "provider-error", record: true,
      }
    }
    if (typeof params.currency === "string" && params.currency !== query.currency) {
      return {
        error: `currency mismatch: asked ${query.currency}, response is ${params.currency}`,
        reason: "provider-error", record: true,
      }
    }
  }

  // Two response shapes, both observed live: a q naming a specific hotel
  // returns a DIRECT property response (name/rate_per_night/prices at the
  // top level); a broader q returns a properties[] list. Handle both, with
  // the same identity check either way.
  const wanted = normalizeName(searchText)
  const nameMatches = (name: string): boolean => {
    const candidate = normalizeName(name)
    return wanted.every(w => candidate.includes(w)) && candidate.every(w => wanted.includes(w))
  }

  let match: Record<string, unknown> | null = null
  if (typeof root.name === "string" && (root.rate_per_night || root.total_rate || root.prices)) {
    if (!nameMatches(root.name)) {
      return {
        error: `direct property response is for "${root.name}", not "${searchText}"`,
        reason: "no-results", record: true,
      }
    }
    match = root
  } else {
    const properties = Array.isArray(root.properties) ? root.properties : []
    for (const p of properties) {
      if (!p || typeof p !== "object") continue
      const prop = p as Record<string, unknown>
      if (typeof prop.name === "string" && prop.name && nameMatches(prop.name)) {
        match = prop
        break
      }
    }
    if (!match) {
      return {
        error: `no confident property match for "${searchText}" among ${properties.length} results`,
        reason: "no-results", record: true,
      }
    }
  }

  const matchedName = match.name as string
  const fetchedAt = nowIso()
  const rates: NormalizedStayRate[] = []

  const common = {
    propertyId: query.propertyId,
    providerPropertyRef: query.providerRef,
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    nights,
    adults: query.adults,
    children: query.children,
    roomName: null,
    roomClass: null,
    board: "unknown" as const,
    boardSource: "unknown" as const,
    refundable: null,
    cancellationDeadline: null,
    sourceClass: "meta" as const,     // property-level aggregator quotes — the
                                      // same product class as the free meta tier
    provider: providerName,
    fetchedAt,
    providerAsOf: null,
    verificationLevel: "verified" as const,
    confidence: "high" as const,
  }

  // The property's total for the stay, taxes-in when Google shows a lower
  // before-taxes figure (the difference IS the taxes — never invented).
  const total = extractMoney(match.total_rate)
  if (total) {
    rates.push({
      ...common,
      rateSource: "Google (lowest total)",
      price: { amount: total.amount, currency: query.currency },
      priceBasis: "stay_total",
      taxesFees: total.taxesIncluded ? "included" : "unknown",
      taxesFeesAmount: total.taxesAmount,
    })
  }

  // Per-OTA nightly offers.
  const offers = Array.isArray(match.prices) ? match.prices : []
  for (const offerRaw of offers) {
    if (!offerRaw || typeof offerRaw !== "object") continue
    const offer = offerRaw as Record<string, unknown>
    const source = typeof offer.source === "string" && offer.source.trim() ? offer.source.trim() : null
    const money = extractMoney(offer.rate_per_night)
    if (!source || !money) continue
    rates.push({
      ...common,
      rateSource: source,
      price: { amount: money.amount, currency: query.currency },
      priceBasis: "nightly_room",
      taxesFees: money.taxesIncluded ? "included" : "unknown",
      taxesFeesAmount: money.taxesAmount,
    })
  }

  return { rates, matchedName }
}

function extractMoney(value: unknown): { amount: number; taxesIncluded: boolean; taxesAmount: number | null } | null {
  if (!value || typeof value !== "object") return null
  const m = value as Record<string, unknown>
  const amount = typeof m.extracted_lowest === "number" && Number.isFinite(m.extracted_lowest)
    ? m.extracted_lowest : null
  if (amount === null || amount <= 0) return null
  const before = typeof m.extracted_before_taxes_fees === "number" && Number.isFinite(m.extracted_before_taxes_fees)
    ? m.extracted_before_taxes_fees : null
  if (before !== null && before > 0 && before < amount) {
    return { amount, taxesIncluded: true, taxesAmount: Math.round((amount - before) * 100) / 100 }
  }
  return { amount, taxesIncluded: false, taxesAmount: null }
}

function normalizeName(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 1 && !["the", "and", "spa", "all", "inclusive", "resort", "hotel", "at"].includes(w))
}
