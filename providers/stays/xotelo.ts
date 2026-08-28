/**
 * Xotelo — free, keyless TripAdvisor-rates API (data.xotelo.com).
 *
 * Role in the funnel: cheap broad DISCOVERY. Two endpoints matter:
 *   /api/rates    per-OTA nightly prices for a specific stay (date-specific —
 *                 verified live before this provider was written)
 *   /api/heatmap  a ~90-day forward calendar classifying each date as
 *                 cheap/average/high for one property — one request covers
 *                 what would otherwise be dozens of rate searches
 *
 * Trust posture: Xotelo is donation-run with no SLA and could disappear any
 * week. Nothing here may become load-bearing knowledge outside this file —
 * the rest of the system sees only the normalized contract shapes. Its prices
 * are per-room-per-NIGHT figures relayed from OTA meta-search, so basis is
 * "nightly_room", source class is "meta", and taxes are "unknown" unless the
 * response carries a tax figure (the field exists but is often null).
 *
 * Politeness: this is somebody's free service. The provider itself does one
 * HTTP request per call and nothing else; pacing between calls is the
 * caller's job (the CLI sleeps between properties, the future scheduler will
 * inherit the same discipline).
 */

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
  StayCalendarDay,
  StayCalendarQuery,
  StayCalendarResult,
  StayProvider,
  StayProviderCapabilities,
  StayRateQuery,
  StayRateSearchResult,
  StaySearchOptions,
} from "./types.js"

export const XOTELO_PROVIDER = "xotelo"

/**
 * Overridable so tests can point at an unroutable address (defence in depth on
 * top of injected fetch) and so a mirror could be swapped in without a code
 * change if the service moves.
 */
function apiBase(): string {
  return process.env.XOTELO_API_BASE || "https://data.xotelo.com/api"
}

/** A TripAdvisor location key, e.g. "g3252668-d301967". */
const REF_PATTERN = /^g\d+-d\d+$/

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Provider responses older than this are stale enough to distrust: Xotelo
 * serves cached OTA quotes, and a two-day-old quote for a volatile luxury
 * rate is an anecdote, not an observation. Stale data is still recorded —
 * with confidence downgraded to "low" — so the staleness itself is visible.
 */
const STALE_AFTER_HOURS = 48

const DEFAULT_TIMEOUT_MS = 20_000

type FetchLike = typeof globalThis.fetch

export interface XoteloOptions {
  fetchImpl?: FetchLike
  db?: DB
}

export class XoteloProvider implements StayProvider {
  readonly name = XOTELO_PROVIDER
  readonly kind = "free" as const
  readonly confidence = "medium" as const
  readonly verificationLevel = "discovered" as const
  readonly capabilities: StayProviderCapabilities = {
    dateSpecificRates: true,
    calendar: true,
    roomLevel: false,
    structuredBoard: false,
    cancellation: false,
    taxesFees: "unknown",
  }

  private readonly fetchImpl: FetchLike
  private readonly explicitDb: DB | null

  constructor(options: XoteloOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.explicitDb = options.db ?? null
  }

  private db(): DB {
    return this.explicitDb ?? getDb()
  }

  /** Keyless — configuration cannot be missing. */
  isConfigured(): boolean {
    return true
  }

  /**
   * Deliberately does not call Xotelo: a health check that fetches would count
   * against the goodwill of a donation-run service on every status page load.
   * Liveness is only ever proven by a real, wanted observation.
   */
  async health(): Promise<ProviderHealth> {
    const usage = readUsage(this.db(), this.name)
    const detail = usage.lastSuccessAt
      ? `keyless public API; last successful fetch ${usage.lastSuccessAt}`
      : "keyless public API; no fetch attempted yet this period"
    return {
      provider: this.name,
      status: usage.lastError && !usage.lastSuccessAt ? "degraded" : "ok",
      detail,
      latencyMs: null,
      checkedAt: nowIso(),
      quota: this.quota(),
    }
  }

  /** No documented quota. Usage is still counted locally for the record. */
  quota(): ProviderQuota | null {
    const usage = readUsage(this.db(), this.name)
    return {
      estimatedUsed: usage.attempted,
      budget: null,
      reserve: 0,
      automationRemaining: null,
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

    const shapeError = validateRateQuery(query)
    if (shapeError) return fail("provider-error", shapeError, 0)

    const url = `${apiBase()}/rates`
      + `?hotel_key=${encodeURIComponent(query.providerRef)}`
      + `&chk_in=${query.checkIn}&chk_out=${query.checkOut}`
      + `&adults=${query.adults}&rooms=1`
      + `&currency=${encodeURIComponent(query.currency)}`

    const outcome = await this.get(url, options.timeoutMs)
    if (!outcome.ok) return fail(outcome.reason, outcome.error, 1)

    const body = outcome.body as XoteloEnvelope
    if (body.error) {
      // The API reported a structured error (bad key, bad dates). Not an
      // outage — record it as this provider's answer for this query.
      recordProviderEvent(this.db(), this.name, "error", String(body.error))
      return fail("no-results", `xotelo error: ${JSON.stringify(body.error)}`, 1)
    }

    const result = body.result
    if (!result || typeof result !== "object") {
      return fail("provider-error", "malformed response: no result object", 1)
    }

    // Identity check: when the response echoes the hotel key, it must be the
    // one we asked about. A mismatch means our ref table or their router is
    // wrong — either way the numbers must not enter this property's history.
    const echoedKey = extractEchoedKey(result)
    if (echoedKey && echoedKey !== query.providerRef) {
      recordProviderEvent(this.db(), this.name, "error",
        `identity mismatch: asked ${query.providerRef}, got ${echoedKey}`)
      return fail("provider-error",
        `identity mismatch: asked ${query.providerRef}, response is for ${echoedKey}`, 1)
    }

    // Date check: the response echoes chk_in/chk_out (observed live). A
    // response priced for different dates than we asked about must not enter
    // this stay's history — this is the guard against the Google-Hotels
    // failure mode where a server silently prices its own default window.
    const echoedIn = typeof result.chk_in === "string" ? result.chk_in : null
    const echoedOut = typeof result.chk_out === "string" ? result.chk_out : null
    if ((echoedIn && echoedIn !== query.checkIn) || (echoedOut && echoedOut !== query.checkOut)) {
      recordProviderEvent(this.db(), this.name, "error",
        `date mismatch: asked ${query.checkIn}..${query.checkOut}, got ${echoedIn}..${echoedOut}`)
      return fail("provider-error",
        `date mismatch: asked ${query.checkIn}..${query.checkOut}, response priced ${echoedIn}..${echoedOut}`, 1)
    }

    // Currency check: if the response names a currency, that is the truth
    // about the numbers regardless of what we requested.
    const currency = typeof result.currency === "string" && result.currency.trim()
      ? result.currency.trim().toUpperCase()
      : query.currency

    const providerAsOf = envelopeTimestamp(body)
    const stale = isStale(providerAsOf)
    const fetchedAt = nowIso()
    const nights = nightsBetween(query.checkIn, query.checkOut)

    const rawRates = Array.isArray(result.rates) ? result.rates : []
    const rates: NormalizedStayRate[] = []
    for (const r of rawRates) {
      if (!r || typeof r !== "object") continue
      const amount = typeof r.rate === "number" && Number.isFinite(r.rate) ? r.rate : null
      const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : null
      if (amount === null || amount <= 0 || !name) continue   // an unpriced or unnamed row observes nothing
      rates.push({
        propertyId: query.propertyId,
        providerPropertyRef: query.providerRef,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights,
        adults: query.adults,
        children: query.children,
        roomName: null,
        roomClass: null,
        board: "unknown",          // Xotelo carries no board data; the registry
        boardSource: "unknown",    // default is applied at record time, not here
        refundable: null,
        cancellationDeadline: null,
        rateSource: name,
        sourceClass: "meta",
        price: { amount, currency },
        priceBasis: "nightly_room",
        taxesFees: typeof r.tax === "number" && Number.isFinite(r.tax) ? "excluded" : "unknown",
        taxesFeesAmount: typeof r.tax === "number" && Number.isFinite(r.tax) ? r.tax : null,
        provider: this.name,
        fetchedAt,
        providerAsOf,
        verificationLevel: this.verificationLevel,
        confidence: stale ? "low" : this.confidence,
      })
    }

    if (rates.length === 0) return fail("no-results", "no priced OTA rates in response", 1)

    return {
      provider: this.name,
      ok: true,
      rates,
      callsSpent: 1,
      latencyMs: Date.now() - started,
      ...(options.captureRaw ? { raw: body } : {}),
    }
  }

  async fetchCalendar(query: StayCalendarQuery, options: StaySearchOptions = {}): Promise<StayCalendarResult> {
    const started = Date.now()
    const fail = (reason: StayCalendarResult["reason"], error: string, spent: number): StayCalendarResult => ({
      provider: this.name, ok: false, propertyId: query.propertyId, days: [],
      reason, error, callsSpent: spent, latencyMs: Date.now() - started,
    })

    if (!REF_PATTERN.test(query.providerRef)) {
      return fail("provider-error", `invalid TripAdvisor key: ${query.providerRef}`, 0)
    }
    const horizon = Math.max(7, Math.min(180, Math.floor(query.horizonDays || 90)))
    // The endpoint anchors its window on a chk_out parameter.
    const chkOut = addDays(new Date(), horizon)

    const url = `${apiBase()}/heatmap`
      + `?hotel_key=${encodeURIComponent(query.providerRef)}`
      + `&chk_out=${chkOut}`

    const outcome = await this.get(url, options.timeoutMs)
    if (!outcome.ok) return fail(outcome.reason, outcome.error, 1)

    const body = outcome.body as XoteloEnvelope
    if (body.error) {
      recordProviderEvent(this.db(), this.name, "error", String(body.error))
      return fail("no-results", `xotelo error: ${JSON.stringify(body.error)}`, 1)
    }

    const heatmap = (body.result as Record<string, unknown> | undefined)?.heatmap as
      Record<string, unknown> | undefined
    if (!heatmap || typeof heatmap !== "object") {
      return fail("provider-error", "malformed response: no heatmap object", 1)
    }

    const days: StayCalendarDay[] = [
      ...classDays(heatmap.cheap_price_days, "cheap"),
      ...classDays(heatmap.average_price_days, "average"),
      ...classDays(heatmap.high_price_days, "high"),
    ]
    if (days.length === 0) return fail("no-results", "heatmap contained no classified days", 1)

    return {
      provider: this.name,
      ok: true,
      propertyId: query.propertyId,
      days,
      callsSpent: 1,
      latencyMs: Date.now() - started,
      ...(options.captureRaw ? { raw: body } : {}),
    }
  }

  /**
   * One counted HTTP GET. The attempt is recorded BEFORE the fetch — a crash
   * mid-flight still leaves a trace — and never throws.
   */
  private async get(url: string, timeoutMs?: number): Promise<
    | { ok: true; body: unknown }
    | { ok: false; reason: "provider-error" | "timeout"; error: string }
  > {
    const db = this.db()
    recordCallAttempt(db, this.name)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: "error",
        headers: {
          // Honest identification for a donation-run service.
          "User-Agent": "travel-radar-stays/0.1 (personal, low-volume)",
          "Accept": "application/json",
        },
      })
      if (!res.ok) {
        const error = `HTTP ${res.status}`
        recordCallOutcome(db, this.name, { ok: false, error })
        recordProviderEvent(db, this.name, classifyFailure(error), error)
        return { ok: false, reason: "provider-error", error }
      }
      const text = await res.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        const error = "malformed response: not JSON"
        recordCallOutcome(db, this.name, { ok: false, error })
        return { ok: false, reason: "provider-error", error }
      }
      recordCallOutcome(db, this.name, { ok: true })
      return { ok: true, body }
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      const error = aborted ? `timeout after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (err as Error).message
      recordCallOutcome(db, this.name, { ok: false, error })
      if (!aborted) recordProviderEvent(db, this.name, classifyFailure(error), error)
      return { ok: false, reason: aborted ? "timeout" : "provider-error", error }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Response plumbing ────────────────────────────────────────────────────────

interface XoteloEnvelope {
  error?: unknown
  result?: Record<string, unknown>
  timestamp?: unknown
}

function validateRateQuery(query: StayRateQuery): string | null {
  if (!REF_PATTERN.test(query.providerRef)) return `invalid TripAdvisor key: ${query.providerRef}`
  if (!DATE_PATTERN.test(query.checkIn) || !DATE_PATTERN.test(query.checkOut)) {
    return `invalid dates: ${query.checkIn}..${query.checkOut}`
  }
  if (nightsBetween(query.checkIn, query.checkOut) <= 0) {
    return `check-out must be after check-in: ${query.checkIn}..${query.checkOut}`
  }
  return null
}

function extractEchoedKey(result: Record<string, unknown>): string | null {
  for (const field of ["hotel_key", "hotelKey", "key"]) {
    const v = result[field]
    if (typeof v === "string" && REF_PATTERN.test(v)) return v
  }
  return null
}

function envelopeTimestamp(body: XoteloEnvelope): string | null {
  const ts = body.timestamp
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    // Unix seconds (their documented form); tolerate milliseconds.
    const ms = ts > 10_000_000_000 ? ts : ts * 1000
    return new Date(ms).toISOString()
  }
  return null
}

function isStale(providerAsOf: string | null): boolean {
  if (!providerAsOf) return false
  const age = Date.now() - Date.parse(providerAsOf)
  return Number.isFinite(age) && age > STALE_AFTER_HOURS * 3600_000
}

function classDays(value: unknown, dayClass: StayCalendarDay["dayClass"]): StayCalendarDay[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((d): d is string => typeof d === "string" && DATE_PATTERN.test(d))
    .map(date => ({ date, dayClass }))
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000)
}

function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}
