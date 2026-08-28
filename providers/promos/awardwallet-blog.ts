/**
 * Miles Promo Feed — AwardWallet's public "Current Buy Points & Miles
 * Promotions" page, airline table only.
 *
 * Promotion ENRICHMENT only: the award results stay the source of truth for
 * required miles, taxes and availability. This module echoes what the page
 * states — a bonus/discount percentage, an end date, and an effective
 * cost-per-mile ONLY when the source prints one — and never invents a number.
 *
 * Contract (house rules): never throws; a blocked or drifted page returns a
 * structured unavailable/anomaly state with zero promos; every outcome is
 * cached for the configured TTL so a bot-wall is never retried in a loop.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const CONFIG_PATH = path.join(ROOT, "config", "miles-promos.json")

export interface MilesPromosConfig {
  source: { url: string; ttlHours: number; timeoutMs: number }
  /** Source's parenthesized program name (lowercased) → our loyaltyProgram enum. */
  programMap: Record<string, string>
  /** Same, for the hotel section → hotel program keys (MARRIOTT_BONVOY, …).
   *  Optional so an older config degrades to airline-only, never a throw. */
  hotelProgramMap?: Record<string, string>
}

let cachedConfig: MilesPromosConfig | null = null

export function loadMilesPromosConfig(force = false): MilesPromosConfig {
  if (cachedConfig && !force) return cachedConfig
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as MilesPromosConfig
  if (!raw.source?.url || !raw.programMap) throw new Error("config/miles-promos.json is missing source.url or programMap")
  cachedConfig = raw
  return raw
}

export interface MilesPromo {
  /** Which promotions table the row came from. Hotel promos join stay cards
   *  via a property's explicit loyaltyProgram; airline promos join award
   *  results — the two never mix. */
  category: "airline" | "hotel"
  /** Exactly as the source names it, e.g. "KLM (Flying Blue)". */
  sourceProgramName: string
  /** Our award loyaltyProgram enum via the explicit config map — null when the
   *  source program is not one we search (kept, but enriches nothing). */
  loyaltyProgram: string | null
  /** false only for a DATED promotion whose end date has passed. */
  active: boolean
  bonusPercent: number | null
  discountPercent: number | null
  /** True when the source says "up to" — a tiered maximum, not a flat rate. */
  upTo: boolean
  /** US cents per mile, exactly as the source states (e.g. 1.69 = 1.69¢) —
   *  null whenever the page does not print a rate for this program. */
  effectiveCostPerMile: number | null
  currency: string | null
  /** ISO date; null = the source lists the promo as current but states no end
   *  date (endDateKnown makes that explicit). */
  validUntil: string | null
  endDateKnown: boolean
  sourceUrl: string
  fetchedAt: string
}

export type MilesPromoFeedReason =
  | "ok"
  | "unconfigured"
  | "http-error"
  | "blocked"
  | "format-changed"
  | "transport-error"

export interface MilesPromoFeed {
  ok: boolean
  reason: MilesPromoFeedReason
  detail: string | null
  promos: MilesPromo[]
  sourceUrl: string
  fetchedAt: string | null
  fromCache: boolean
  ageMinutes: number | null
}

// ── Parsing (pure — tests feed it the captured fixture) ──────────────────────

const AIRLINE_HEADING = "Buy Miles Promotions From Airlines"
const HOTEL_HEADING = "Buy Points Promotions From Hotels"

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|\u00a0/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
}

/** "9/16/26" → "2026-09-16"; anything else (absent, "Unknown") → null. */
function parseEndDate(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (!m) return null
  const year = m[3].length === 2 ? `20${m[3]}` : m[3]
  return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
}

/** The parenthesized program name, lowercased: "KLM (Flying Blue)" → "flying blue". */
function parenthesizedProgram(name: string): string | null {
  const m = name.match(/\(([^)]+)\)\s*$/)
  return m ? m[1].trim().toLowerCase() : null
}

/**
 * The page's "Top offers" highlight table is the only place a purchase rate
 * (¢/point) is printed. Returns rate by parenthesized program name — attached
 * to an airline promo only when the SAME program appears there.
 */
function statedRates(html: string): Map<string, number> {
  const rates = new Map<string, number>()
  const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/)
  if (!table) return rates
  for (const row of table[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(stripTags)
    if (cells.length < 3) continue
    const program = parenthesizedProgram(cells[0])
    const rate = cells[2].match(/([\d.]+)\s*[¢¢]/)
    if (program && rate) rates.set(program, Number(rate[1]))
  }
  return rates
}

export interface ParseOutcome {
  promos: MilesPromo[]
  /** Set when the page no longer looks like what we parse — never guessed around. */
  anomaly: string | null
}

/** One promotions section (airline or hotel): heading → next h2, pt-row table. */
function parseSection(
  html: string,
  heading: string,
  category: "airline" | "hotel",
  map: Record<string, string>,
  rates: Map<string, number>,
  cfg: MilesPromosConfig,
  opts: { now: Date; fetchedAt: string },
): MilesPromo[] | null {
  const headingAt = html.indexOf(heading)
  if (headingAt < 0) return null
  const nextH2 = html.indexOf("<h2", headingAt + heading.length)
  const section = html.slice(headingAt, nextH2 > 0 ? nextH2 : undefined)

  const rows = section.match(/<div class="pt-row">[\s\S]*?(?=<div class="pt-row">|$)/g) ?? []
  const today = opts.now.toISOString().slice(0, 10)
  const promos: MilesPromo[] = []

  for (const row of rows) {
    const cell = (cls: string): string => {
      const m = row.match(new RegExp(`<div class="pt-(?:head|body) pt-${cls}"[^>]*>([\\s\\S]*?)(?=<div class="pt-(?:head|body) pt-|$)`))
      return m ? stripTags(m[1]) : ""
    }
    const program = cell("program")
    if (!program || program === "Program") continue          // header row

    const comment = cell("comment")
    const percent = comment.match(/(up to\s+a?\s*)?(\d+(?:\.\d+)?)\s*%\s*(bonus|discount)/i)
    if (!percent) continue                                    // not a promo row we understand

    const kind = percent[3].toLowerCase()
    const validUntil = parseEndDate(cell("date"))
    const paren = parenthesizedProgram(program)
    const rate = paren !== null ? rates.get(paren) ?? null : null

    promos.push({
      category,
      sourceProgramName: program,
      loyaltyProgram: paren !== null ? map[paren] ?? null : null,
      // Expired DATED promos never qualify; an undated row is listed as
      // current by the source, so it stays active with endDateKnown false.
      active: validUntil === null || validUntil >= today,
      bonusPercent: kind === "bonus" ? Number(percent[2]) : null,
      discountPercent: kind === "discount" ? Number(percent[2]) : null,
      upTo: Boolean(percent[1]),
      effectiveCostPerMile: rate,
      currency: rate !== null ? "USD" : null,
      validUntil,
      endDateKnown: validUntil !== null,
      sourceUrl: cfg.source.url,
      fetchedAt: opts.fetchedAt,
    })
  }
  return promos
}

export function parsePromoPage(
  html: string,
  cfg: MilesPromosConfig,
  opts: { now: Date; fetchedAt: string },
): ParseOutcome {
  const rates = statedRates(html)

  // Airline section: its absence or emptiness is a format anomaly — the
  // original contract, unchanged.
  const airline = parseSection(html, AIRLINE_HEADING, "airline", cfg.programMap, rates, cfg, opts)
  if (airline === null) {
    return { promos: [], anomaly: `airline promotions heading not found — page format changed (expected "${AIRLINE_HEADING}")` }
  }
  if (airline.length === 0) {
    return { promos: [], anomaly: "airline section present but zero promo rows parsed — page format changed" }
  }

  // Hotel section: additive, best-effort. Its absence only means no hotel
  // enrichment — airline behavior is never held hostage to it.
  const hotel = parseSection(html, HOTEL_HEADING, "hotel", cfg.hotelProgramMap ?? {}, rates, cfg, opts) ?? []

  return { promos: [...airline, ...hotel], anomaly: null }
}

// ── Fetch + cache ────────────────────────────────────────────────────────────

let cachedFeed: { feed: MilesPromoFeed; fetchedAtMs: number } | null = null

function withCacheAge(feed: MilesPromoFeed, fetchedAtMs: number, now: Date): MilesPromoFeed {
  return { ...feed, fromCache: true, ageMinutes: Math.max(0, Math.round((now.getTime() - fetchedAtMs) / 60_000)) }
}

/** Test hook: clear the module cache. */
export function resetMilesPromoCache(): void {
  cachedFeed = null
}

async function fetchPromoPage(cfg: MilesPromosConfig): Promise<{ status: number | null; html: string | null; error: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.source.timeoutMs)
  try {
    const resp = await fetch(cfg.source.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    })
    const html = await resp.text()
    return { status: resp.status, html, error: null }
  } catch (err) {
    return { status: null, html: null, error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export async function getMilesPromoFeed(
  options: { forceRefresh?: boolean; now?: Date } = {},
): Promise<MilesPromoFeed> {
  const now = options.now ?? new Date()
  let cfg: MilesPromosConfig
  try {
    cfg = loadMilesPromosConfig()
  } catch (err) {
    return {
      ok: false, reason: "unconfigured", detail: (err as Error).message,
      promos: [], sourceUrl: "", fetchedAt: null, fromCache: false, ageMinutes: null,
    }
  }

  // Every outcome — success, block, drift — is cached for the TTL, so a
  // bot-wall is asked exactly once per window; only forceRefresh asks again.
  const ttlMs = cfg.source.ttlHours * 3600_000
  if (!options.forceRefresh && cachedFeed && now.getTime() - cachedFeed.fetchedAtMs < ttlMs) {
    return withCacheAge(cachedFeed.feed, cachedFeed.fetchedAtMs, now)
  }

  const fetchedAt = now.toISOString()
  const base = { promos: [] as MilesPromo[], sourceUrl: cfg.source.url, fetchedAt, fromCache: false, ageMinutes: 0 }
  const { status, html, error } = await fetchPromoPage(cfg)

  let feed: MilesPromoFeed
  if (error !== null || html === null) {
    feed = { ...base, ok: false, reason: "transport-error", detail: error ?? "no response body" }
  } else if (status === 403 || status === 429 || status === 503) {
    feed = { ...base, ok: false, reason: "blocked", detail: `HTTP ${status} — bot wall; not retrying until the cache window expires` }
  } else if (status !== 200) {
    feed = { ...base, ok: false, reason: "http-error", detail: `HTTP ${status}` }
  } else {
    const parsed = parsePromoPage(html, cfg, { now, fetchedAt })
    feed = parsed.anomaly !== null
      ? { ...base, ok: false, reason: "format-changed", detail: parsed.anomaly }
      : { ...base, ok: true, reason: "ok", detail: null, promos: parsed.promos }
  }

  cachedFeed = { feed, fetchedAtMs: now.getTime() }
  return feed
}
