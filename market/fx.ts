/**
 * FX observation layer.
 *
 * Rules that must never soften:
 *   - native amounts are NEVER overwritten; a conversion is a VIEW derived
 *     from (amount, fx_rate_observation row) and stores the row's id, so the
 *     arithmetic is reproducible historically from the database alone.
 *   - rates come from stored observations of a real source (Frankfurter,
 *     serving the ECB's official euro reference rates) — never an LLM, never
 *     a constant in code.
 *   - a stale or missing rate is a named refusal: no numeric winner.
 *   - no implicit chaining: only configured pairs convert.
 */

import { nowIso, type DB } from "../db/index.js"
import {
  classifyFailure,
  recordCallAttempt,
  recordCallOutcome,
  recordProviderEvent,
} from "../db/repositories.js"
import { loadMarketConfig } from "./config.js"

export const FX_PROVIDER = "frankfurter_ecb"

function apiBase(): string {
  return process.env.MARKET_FX_API_BASE || loadMarketConfig().fx.apiBase
}

const CCY = /^[A-Z]{3}$/
const DEFAULT_TIMEOUT_MS = 15_000

type FetchLike = typeof globalThis.fetch

export interface FxObservation {
  id: number
  baseCurrency: string
  quoteCurrency: string
  rate: number
  provider: string
  providerDate: string
  fetchedAt: string
}

export interface FxFetchResult {
  ok: boolean
  observation?: FxObservation
  error?: string
}

/**
 * One counted GET to the rate source; on success the observation is stored
 * append-only and returned with its row id.
 */
export async function fetchAndStoreFxRate(
  db: DB, base: string, quote: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<FxFetchResult> {
  if (!CCY.test(base) || !CCY.test(quote) || base === quote) {
    return { ok: false, error: `invalid pair ${base}/${quote}` }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = `${apiBase()}/latest?from=${base}&to=${quote}`
  recordCallAttempt(db, FX_PROVIDER)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        "User-Agent": "travel-radar-market/0.1 (personal, low-volume)",
        "Accept": "application/json",
      },
    })
    if (!res.ok) {
      const error = `HTTP ${res.status}`
      recordCallOutcome(db, FX_PROVIDER, { ok: false, error })
      return { ok: false, error }
    }
    const body = await res.json() as { base?: unknown; date?: unknown; rates?: Record<string, unknown> }
    // Echo-check: the response must be about the pair we asked for.
    if (body.base !== base) {
      const error = `base mismatch: asked ${base}, response is ${String(body.base)}`
      recordCallOutcome(db, FX_PROVIDER, { ok: false, error })
      recordProviderEvent(db, FX_PROVIDER, "error", error)
      return { ok: false, error }
    }
    const rate = body.rates?.[quote]
    const providerDate = body.date
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0
      || typeof providerDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(providerDate)) {
      const error = "malformed response: no positive rate / no reference date"
      recordCallOutcome(db, FX_PROVIDER, { ok: false, error })
      return { ok: false, error }
    }
    recordCallOutcome(db, FX_PROVIDER, { ok: true })
    const fetchedAt = nowIso()
    const result = db.prepare(`
      INSERT INTO fx_rate_observations (base_currency, quote_currency, rate, provider, provider_date, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(base, quote, rate, FX_PROVIDER, providerDate, fetchedAt)
    return {
      ok: true,
      observation: {
        id: Number(result.lastInsertRowid),
        baseCurrency: base, quoteCurrency: quote, rate,
        provider: FX_PROVIDER, providerDate, fetchedAt,
      },
    }
  } catch (err) {
    const aborted = (err as Error).name === "AbortError"
    const error = aborted ? `timeout after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (err as Error).message
    recordCallOutcome(db, FX_PROVIDER, { ok: false, error })
    if (!aborted) recordProviderEvent(db, FX_PROVIDER, classifyFailure(error), error)
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

export function getFxObservation(db: DB, id: number): FxObservation | null {
  const r = db.prepare("SELECT * FROM fx_rate_observations WHERE id = ?").get(id) as
    Record<string, unknown> | undefined
  return r ? hydrate(r) : null
}

/** Newest stored observation for a pair — recency by id, the append-only rule. */
export function latestFxObservation(db: DB, base: string, quote: string): FxObservation | null {
  const r = db.prepare(`
    SELECT * FROM fx_rate_observations
    WHERE base_currency = ? AND quote_currency = ?
    ORDER BY id DESC LIMIT 1
  `).get(base, quote) as Record<string, unknown> | undefined
  return r ? hydrate(r) : null
}

function hydrate(r: Record<string, unknown>): FxObservation {
  return {
    id: r.id as number,
    baseCurrency: r.base_currency as string,
    quoteCurrency: r.quote_currency as string,
    rate: r.rate as number,
    provider: r.provider as string,
    providerDate: r.provider_date as string,
    fetchedAt: r.fetched_at as string,
  }
}

export function isFxStale(obs: FxObservation, now = new Date()): boolean {
  const ageDays = (now.getTime() - Date.parse(`${obs.providerDate}T00:00:00Z`)) / 86_400_000
  return !Number.isFinite(ageDays) || ageDays > loadMarketConfig().fx.maxAgeDays
}

export interface FxConversion {
  amount: number               // converted, in the observation's quote currency
  fxObservationId: number
}

export interface FxRefusal {
  reason: "missing_pair" | "no_observation" | "stale_observation"
  detail: string
}

/**
 * Convert a native amount into the target currency through the newest stored
 * observation for the configured pair. Pure over its inputs: the same
 * observation row always yields the same number — historical reproducibility
 * is `convertWith(amount, getFxObservation(db, storedId))`.
 */
export function convertVia(
  db: DB, amount: number, from: string, to: string, now = new Date(),
): FxConversion | FxRefusal {
  if (from === to) {
    // Same currency needs no FX at all — and must not consume an observation.
    return { amount, fxObservationId: 0 }
  }
  const configured = loadMarketConfig().fx.pairs.some(([b, q]) => b === from && q === to)
  if (!configured) {
    return { reason: "missing_pair", detail: `no configured FX pair ${from}→${to} — chaining is not allowed` }
  }
  const obs = latestFxObservation(db, from, to)
  if (!obs) return { reason: "no_observation", detail: `no stored FX observation for ${from}→${to}` }
  if (isFxStale(obs, now)) {
    return {
      reason: "stale_observation",
      detail: `newest ${from}→${to} observation is dated ${obs.providerDate} (older than ${loadMarketConfig().fx.maxAgeDays}d) — no numeric winner from a stale rate`,
    }
  }
  return { amount: convertWith(amount, obs), fxObservationId: obs.id }
}

/** The reproducible core: amount × the stored rate, rounded to cents. */
export function convertWith(amount: number, obs: FxObservation): number {
  return Math.round(amount * obs.rate * 100) / 100
}

export function isFxRefusal(v: FxConversion | FxRefusal): v is FxRefusal {
  return (v as FxRefusal).reason !== undefined
}
