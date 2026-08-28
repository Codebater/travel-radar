/**
 * Gondola MCP — hotel award provider (Phase 1's only source).
 *
 * Free anonymous MCP server (verified live 2026-08-28): JSON-RPC over
 * Streamable HTTP at mcp.gondola.ai/mcp, session id via the Mcp-Session-Id
 * header, tool results as MARKDOWN text. Tools used, and only these:
 *   - search_hotels{location*, checkin*, checkout*, hotel_name?, chain_name?, num_adults?}
 *   - get_multi_night_rates{hotel_id*, start_date*, end_date*, nights?}
 *   - get_booking_link{hotel_id*, checkin*, checkout*, num_adults?}
 *
 * Measured response dialect the parsers are pinned to (fixtures in tests):
 *   ### Name (ID: 39678735)
 *   **Chain:** Wyndham | ...
 *   **Cash: USD 185.00/night** (total: USD 926.47) | ...
 *   **Points: 7,500 pts/night** (37,500 pts total) via Wyndham Rewards | ...
 * Multi-night: "**2026-11-21 → 2026-11-26** — THB 6090.00/night | total ... | 7,500 pts/night | ..."
 * Booking:    "[Book on Gondola.ai](https://gondola.ai/hotel/details/<id>?checkin=...&checkout=...)"
 *
 * Honesty rules enforced here:
 *   - the stay-total points figure is stored ONLY because the source prints
 *     "(N pts total)" for the requested stay — we never compute it;
 *   - taxes are never stated by Gondola → taxesFeesState "unknown", never 0;
 *   - rooms are unstated on these quotes → roomClass/roomName null;
 *   - the multi-night check must ECHO the exact requested window to count as
 *     availability confirmation — anything else leaves "unknown";
 *   - 403/429/503 or a failed handshake is BLOCKED: stop, no retries.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type {
  HotelAwardProvider, HotelAwardProviderCapabilities, HotelAwardQuery,
  HotelAwardSearchResult, NormalizedHotelAward,
} from "./types.js"

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const CONFIG_PATH = path.join(ROOT, "config", "hotel-awards.json")

export interface HotelAwardsConfig {
  gondola: { mcpUrl: string; timeoutMs: number }
  budget: { maxCallsPerRun: number; detailTopN: number; politenessMs: number }
  programMap: Record<string, string>
}

let cachedConfig: HotelAwardsConfig | null = null

export function loadHotelAwardsConfig(force = false): HotelAwardsConfig {
  if (cachedConfig && !force) return cachedConfig
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as HotelAwardsConfig
  if (!raw.gondola?.mcpUrl || !raw.budget || !raw.programMap) {
    throw new Error("config/hotel-awards.json is missing gondola.mcpUrl, budget or programMap")
  }
  return (cachedConfig = raw)
}

/** Source program name → our hotel program enum; unmapped keeps the source's
 *  own name normalized (explicit either way — never guessed). */
export function mapHotelProgram(sourceName: string, map: Record<string, string>): string {
  const key = sourceName.trim().toLowerCase()
  return map[key] ?? sourceName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

// ── Markdown parsers (pure — fixture-pinned in tests) ────────────────────────

export interface GondolaHotelRow {
  hotelId: string
  name: string
  chain: string | null
  pointsPerNight: number | null
  pointsTotal: number | null
  sourceProgramName: string | null
  cashPerNight: number | null
  cashTotal: number | null
  cashCurrency: string | null
}

const num = (s: string) => Number(s.replace(/,/g, ""))

export function parseSearchMarkdown(md: string): GondolaHotelRow[] | null {
  if (!/## Hotel Search Results/.test(md)) return null      // format drift — never guessed around
  const rows: GondolaHotelRow[] = []
  for (const block of md.split(/^### /m).slice(1)) {
    const head = block.match(/^(.+?) \(ID: (\d+)\)/)
    if (!head) continue
    const chain = block.match(/\*\*Chain:\*\* ([^|*\n]+)/)
    const points = block.match(/\*\*Points: ([\d,]+) pts\/night\*\*(?: \(([\d,]+) pts total\))? via ([^|*\n]+)/)
    const cash = block.match(/\*\*Cash: ([A-Z]{3}) ([\d,.]+)\/night\*\*(?: \(total: ([A-Z]{3}) ([\d,.]+)\))?/)
    rows.push({
      hotelId: head[2],
      name: head[1].trim(),
      chain: chain ? chain[1].trim() : null,
      pointsPerNight: points ? num(points[1]) : null,
      pointsTotal: points?.[2] ? num(points[2]) : null,       // ONLY when the source printed a stay total
      sourceProgramName: points ? points[3].trim() : null,
      cashPerNight: cash ? num(cash[2]) : null,
      cashTotal: cash?.[4] ? num(cash[4]) : null,
      cashCurrency: cash ? cash[1] : null,
    })
  }
  return rows
}

/** True only when the multi-night calendar ECHOES the exact requested stay
 *  window as one quoted unit — the full-stay confirmation. */
export function multiNightConfirmsWindow(md: string, checkIn: string, checkOut: string): boolean {
  const re = new RegExp(`\\*\\*${checkIn} → ${checkOut}\\*\\*`)
  return re.test(md)
}

export function parseBookingLink(md: string): string | null {
  const m = md.match(/\[Book on [^\]]+\]\((https?:\/\/[^)]+)\)/)
  return m ? m[1] : null
}

// ── Minimal MCP client (JSON-RPC over Streamable HTTP) ───────────────────────

interface RpcOutcome { status: number | null; result: unknown; error: string | null }

export class GondolaMcpClient {
  private sessionId: string | null = null
  private initialized = false
  private nextId = 1

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  private async post(body: unknown, expectId: number | null): Promise<RpcOutcome> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      }
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
      const resp = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal })
      const sid = resp.headers.get("mcp-session-id")
      if (sid) this.sessionId = sid
      const text = await resp.text()
      if (expectId === null) return { status: resp.status, result: null, error: null }
      const ct = resp.headers.get("content-type") ?? ""
      let payload: any = null
      if (ct.includes("event-stream")) {
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue
          try {
            const j = JSON.parse(line.slice(5))
            if (j.id === expectId) payload = j
          } catch { /* keep scanning */ }
        }
      } else {
        try { payload = JSON.parse(text) } catch { payload = null }
      }
      if (resp.status !== 200 || payload === null) {
        return { status: resp.status, result: null, error: `HTTP ${resp.status}${payload === null ? " (unparseable body)" : ""}` }
      }
      if (payload.error) return { status: resp.status, result: null, error: String(payload.error.message ?? "rpc error") }
      return { status: resp.status, result: payload.result, error: null }
    } catch (err) {
      return { status: null, result: null, error: (err as Error).message }
    } finally {
      clearTimeout(timer)
    }
  }

  private async ensureInitialized(): Promise<string | null> {
    if (this.initialized) return null
    const id = this.nextId++
    const init = await this.post({
      jsonrpc: "2.0", id, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "travel-radar", version: "0.1" } },
    }, id)
    if (init.error) return init.error
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, null)
    this.initialized = true
    return null
  }

  /** One tool call → the markdown text of content[0]. Never throws. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string | null; status: number | null; error: string | null }> {
    const initError = await this.ensureInitialized()
    if (initError) return { text: null, status: null, error: `handshake failed: ${initError}` }
    const id = this.nextId++
    const out = await this.post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, id)
    if (out.error) return { text: null, status: out.status, error: out.error }
    const content = (out.result as any)?.content?.[0]
    if (!content || content.type !== "text" || typeof content.text !== "string") {
      return { text: null, status: out.status, error: "tool result carried no text content — format changed" }
    }
    return { text: content.text, status: out.status, error: null }
  }
}

// ── The provider ─────────────────────────────────────────────────────────────

const BLOCKED_STATUSES = new Set([403, 429, 503])

export class GondolaHotelAwardsProvider implements HotelAwardProvider {
  readonly name = "gondola_hotels"
  readonly capabilities: HotelAwardProviderCapabilities = {
    multiNightQuotes: true,        // stay totals stated per search window; calendar echoes whole windows
    statesPointsPerNight: true,
    statesTaxes: false,            // never stated → unknown stays unknown
    statesRooms: false,            // property-level quotes only
    dynamicPrograms: true,         // whatever program the source names per hotel
    metered: false,
  }

  private readonly cfg: HotelAwardsConfig
  private readonly client: Pick<GondolaMcpClient, "callTool">

  constructor(cfg = loadHotelAwardsConfig(), client?: Pick<GondolaMcpClient, "callTool">) {
    this.cfg = cfg
    this.client = client ?? new GondolaMcpClient(
      process.env.HOTEL_AWARDS_MCP_URL || cfg.gondola.mcpUrl,
      cfg.gondola.timeoutMs,
    )
  }

  isConfigured(): boolean {
    return true   // keyless
  }

  /** 1 search + (2 × detailTopN) detail calls, cap-checked by the caller. */
  plannedCalls(): number {
    return 1 + 2 * this.cfg.budget.detailTopN
  }

  async search(query: HotelAwardQuery): Promise<HotelAwardSearchResult> {
    const started = Date.now()
    const fetchedAt = new Date().toISOString()
    const nights = Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / 86_400_000)
    let callsSpent = 0
    const fail = (reason: HotelAwardSearchResult["reason"], searchState: HotelAwardSearchResult["searchState"], error: string): HotelAwardSearchResult =>
      ({ provider: this.name, ok: false, searchState, awards: [], reason, error, callsSpent, latencyMs: Date.now() - started })

    if (nights < 1) return fail("provider-error", "incomplete", `check-out must follow check-in (${query.checkIn}..${query.checkOut})`)

    const search = await this.client.callTool("search_hotels", {
      location: query.location,
      checkin: query.checkIn,
      checkout: query.checkOut,
      num_adults: query.adults,
      ...(query.hotelName ? { hotel_name: query.hotelName } : {}),
      ...(query.chainName ? { chain_name: query.chainName } : {}),
    })
    callsSpent++
    if (search.error !== null || search.text === null) {
      if (search.status !== null && BLOCKED_STATUSES.has(search.status)) {
        return fail("blocked", "blocked", `HTTP ${search.status} — blocked; not retrying`)
      }
      return fail("provider-error", "incomplete", search.error ?? "no response")
    }

    const rows = parseSearchMarkdown(search.text)
    if (rows === null) return fail("format-changed", "incomplete", "search response no longer matches the known markdown dialect")

    // Award rows only: a hotel without a source-stated points line is not an
    // award observation. Stay totals must be SOURCE-stated to be full_stay.
    const awardRows = rows.filter(r => r.pointsPerNight !== null && r.sourceProgramName !== null)
    if (awardRows.length === 0) {
      return { provider: this.name, ok: true, searchState: "empty", awards: [], callsSpent, latencyMs: Date.now() - started }
    }

    const awards: NormalizedHotelAward[] = awardRows.map(r => ({
      provider: this.name,
      providerPropertyRef: r.hotelId,
      propertyId: null,                       // explicit refs only — none exist yet
      propertyName: r.name,
      chain: r.chain,
      program: mapHotelProgram(r.sourceProgramName!, this.cfg.programMap),
      sourceProgramName: r.sourceProgramName!,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights,
      quoteBasis: r.pointsTotal !== null ? "full_stay" : "per_night",
      roomClass: null,
      roomName: null,
      pointsTotal: r.pointsTotal,             // never computed — source-stated or null
      pointsPerNight: r.pointsPerNight,
      taxesFeesAmount: null,
      taxesFeesCurrency: null,
      taxesFeesState: "unknown",              // Gondola states no award taxes — never zero
      awardType: "points",
      cashComparisonAmount: r.cashTotal,
      cashComparisonCurrency: r.cashTotal !== null ? r.cashCurrency : null,
      availabilityState: "unknown",
      searchState: "complete",
      verificationLevel: "discovered",
      sourceFreshness: null,
      bookingUrl: null,
      fetchedAt,
    }))

    // Detail pass: the cheapest detailTopN full-stay quotes get (a) a
    // multi-night confirmation that the EXACT window is quoted as one unit,
    // (b) their provider booking link. Politeness-paced, cap already planned.
    const detailed = awards
      .filter(a => a.quoteBasis === "full_stay")
      .sort((a, b) => (a.pointsTotal ?? Infinity) - (b.pointsTotal ?? Infinity))
      .slice(0, this.cfg.budget.detailTopN)

    for (const award of detailed) {
      await new Promise(r => setTimeout(r, this.cfg.budget.politenessMs))
      const mn = await this.client.callTool("get_multi_night_rates", {
        hotel_id: Number(award.providerPropertyRef),
        start_date: query.checkIn,
        end_date: query.checkOut,
        nights,
      })
      callsSpent++
      if (mn.text !== null && multiNightConfirmsWindow(mn.text, query.checkIn, query.checkOut)) {
        award.availabilityState = "available"   // the source echoed the exact stay window as one quoted unit
      }
      // No echo → stays "unknown": absence of confirmation is never evidence
      // of unavailability, and never silently upgrades either.

      await new Promise(r => setTimeout(r, this.cfg.budget.politenessMs))
      const bl = await this.client.callTool("get_booking_link", {
        hotel_id: Number(award.providerPropertyRef),
        checkin: query.checkIn,
        checkout: query.checkOut,
        num_adults: query.adults,
      })
      callsSpent++
      if (bl.text !== null) award.bookingUrl = parseBookingLink(bl.text)
    }

    return { provider: this.name, ok: true, searchState: "complete", awards, callsSpent, latencyMs: Date.now() - started }
  }
}
