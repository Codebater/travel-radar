/**
 * TUI (tui.com, tenant TUICOM) — the package tier's Tier 0 + Tier 1 seller.
 *
 * Clean-room implementation from our own live probes (2026-08-28), endpoint
 * shapes cross-checked against the MIT-licensed tuiwatch dossier. Three
 * endpoints, all keyless:
 *
 *   GET {calendarApiBase}/data   Tier 0 — one call returns months of dated
 *                                cheapest-package offers for one hotel
 *   GET {offerApiBase}/data      Tier 1 — dated offers for one window, with
 *                                room granularity and flight identity
 *   (POST {searchApiBase}/hotel-offer-cards/… region sweep exists but is not
 *    wired — the radar observes its own universe, it does not crawl regions)
 *
 * Trust posture: unofficial, unversioned, revocable. The two CloudFront hosts
 * are OPAQUE and may rotate: a DNS failure, 403 or non-JSON answer is treated
 * as configuration/health failure — the provider fails loudly with a recorded
 * event and the radar keeps working without packages. It NEVER falls back to
 * scraping HTML or guessing hosts.
 *
 * Field rules measured live:
 *   - the calendar endpoint wants tenant=tui.com, boardCodes=GT06-*; the
 *     offer endpoint wants tenant=TUICOM, boardTypes=GT06-* — both dialects
 *     live in config/normalize, not inline.
 *   - prices are per-person AND total; the flight side carries its own
 *     personPrices (a genuine seller-supplied split); no hotel-side price is
 *     ever supplied, so hotelPricePerPerson stays null — a split is never
 *     derived by subtraction.
 *   - German package law makes advertised package prices final totals, so
 *     taxesFees is "included" for offers this seller prices in EUR.
 */

import { getDb, nowIso, type DB } from "../../db/index.js"
import {
  classifyFailure,
  recordCallAttempt,
  recordCallOutcome,
  recordProviderEvent,
  readUsage,
} from "../../db/repositories.js"
import { loadPackagesConfig } from "../../packages/config.js"
import {
  boardFromTuiCode,
  dateOnly,
  isIsoDate,
  nightsBetween,
  normalizeCabin,
  tripDaysBetween,
  tuiBoardCode,
} from "../../packages/normalize.js"
import { classifyRoomText } from "../../stays/normalize.js"
import type {
  NormalizedPackageOffer,
  PackageCalendarQuery,
  PackageFlightSegment,
  PackageOffersQuery,
  PackageProvider,
  PackageProviderCapabilities,
  PackageSearchOptions,
  PackageSearchResult,
  ProviderHealth,
  ProviderQuota,
} from "./types.js"

export const TUI_PACKAGES_PROVIDER = "tui_packages"

function offerBase(): string {
  return process.env.TUI_PACKAGES_OFFER_BASE || loadPackagesConfig().tui.offerApiBase
}

function calendarBase(): string {
  return process.env.TUI_PACKAGES_CALENDAR_BASE || loadPackagesConfig().tui.calendarApiBase
}

/** A GIATA id is a plain positive integer. */
const REF_PATTERN = /^\d+$/

const DEFAULT_TIMEOUT_MS = 25_000

/** The site's own UA class — an unofficial first-party API answers browsers. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

type FetchLike = typeof globalThis.fetch

export interface TuiPackagesOptions {
  fetchImpl?: FetchLike
  db?: DB
}

export class TuiPackagesProvider implements PackageProvider {
  readonly name = TUI_PACKAGES_PROVIDER
  readonly kind = "free" as const
  readonly confidence = "medium" as const
  readonly capabilities: PackageProviderCapabilities = {
    calendar: true,
    datedOffers: true,
    multiOperator: false,      // TUI-family operators only (LTUR/TUID/ATID observed)
    flightIdentity: true,
    priceSplit: true,
    taxesFees: "included",
  }

  private readonly fetchImpl: FetchLike
  private readonly explicitDb: DB | null

  constructor(options: TuiPackagesOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.explicitDb = options.db ?? null
  }

  private db(): DB {
    return this.explicitDb ?? getDb()
  }

  /** Keyless — configuration cannot be missing. Hosts are echo-validated per call. */
  isConfigured(): boolean {
    return true
  }

  /** Never fetches: liveness is only proven by a real, wanted observation. */
  async health(): Promise<ProviderHealth> {
    const usage = readUsage(this.db(), this.name)
    return {
      provider: this.name,
      status: usage.lastError && !usage.lastSuccessAt ? "degraded" : "ok",
      detail: usage.lastSuccessAt
        ? `keyless unofficial API; last successful fetch ${usage.lastSuccessAt}`
        : "keyless unofficial API; no fetch attempted yet this period",
      latencyMs: null,
      checkedAt: nowIso(),
      quota: this.quota(),
    }
  }

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

  async fetchCalendar(query: PackageCalendarQuery, options: PackageSearchOptions = {}): Promise<PackageSearchResult> {
    const started = Date.now()
    const fail = (reason: PackageSearchResult["reason"], error: string, spent: number): PackageSearchResult => ({
      provider: this.name, ok: false, offers: [], reason, error,
      callsSpent: spent, latencyMs: Date.now() - started,
    })

    const shapeError = validateCalendarQuery(query)
    if (shapeError) return fail("provider-error", shapeError, 0)
    const boardCode = tuiBoardCode(query.board)
    if (!boardCode) return fail("provider-error", `no TUI board code for "${query.board}"`, 0)

    const cfg = loadPackagesConfig().tui
    const url = `${calendarBase()}/data`
      + `?searchscope=PACKAGE&duration=${query.nights}`
      + `&adults=${query.adults}`
      + `&giatas=${encodeURIComponent(query.providerRef)}`
      + `&startSearchRange=${query.rangeStart}&endSearchRange=${query.rangeEnd}`
      + `&tenant=${encodeURIComponent(cfg.calendarTenant)}`
      + `&airports=${encodeURIComponent(query.origin)}`
      + `&roomTypeOpCodes=&boardCodes=${encodeURIComponent(boardCode)}&tourOperators=`
      + `&startDate=${query.rangeStart}&endDate=${query.rangeEnd}`

    const outcome = await this.get(url, options.timeoutMs)
    if (!outcome.ok) return fail(outcome.reason, outcome.error, 1)

    const parsed = parseTuiCalendarResponse(outcome.body, query, this.name)
    if ("error" in parsed) {
      recordProviderEvent(this.db(), this.name, "error", parsed.error)
      return fail(parsed.reason, parsed.error, 1)
    }
    if (parsed.offers.length === 0) return fail("no-results", "calendar contained no offers for this window", 1)

    return {
      provider: this.name, ok: true, offers: parsed.offers,
      callsSpent: 1, latencyMs: Date.now() - started,
      ...(options.captureRaw ? { raw: outcome.body } : {}),
    }
  }

  async searchOffers(query: PackageOffersQuery, options: PackageSearchOptions = {}): Promise<PackageSearchResult> {
    const started = Date.now()
    const fail = (reason: PackageSearchResult["reason"], error: string, spent: number): PackageSearchResult => ({
      provider: this.name, ok: false, offers: [], reason, error,
      callsSpent: spent, latencyMs: Date.now() - started,
    })

    const shapeError = validateOffersQuery(query)
    if (shapeError) return fail("provider-error", shapeError, 0)
    const boardCode = tuiBoardCode(query.board)
    if (!boardCode) return fail("provider-error", `no TUI board code for "${query.board}"`, 0)

    const cfg = loadPackagesConfig().tui
    // startDate/endDate bound the WHOLE TRIP envelope, not the check-in
    // (measured live: a narrow check-in-sized window returns nothing because
    // the outbound departs the day before and the return lands days after).
    // The request therefore widens the envelope — one day of overnight
    // departure before, the stay plus travel slack after — and the check-in
    // selection happens at parse time against the caller's actual window.
    const envelopeStart = shiftDate(query.checkInFrom, -1)
    const envelopeEnd = shiftDate(query.checkInTo, query.nights + 2)
    // No transferIncluded filter: the radar observes what IS sold; the
    // transfer flag on each offer is the evidence, not a query constraint.
    const url = `${offerBase()}/data`
      + `?giataId=${encodeURIComponent(query.providerRef)}`
      + `&locale=${encodeURIComponent(cfg.locale)}&tenant=${encodeURIComponent(cfg.tenant)}`
      + `&startDate=${envelopeStart}&endDate=${envelopeEnd}`
      + `&durations=${query.nights}&travellers=${query.adults}`
      + `&airports=${encodeURIComponent(query.origin)}`
      + `&boardTypes=${encodeURIComponent(boardCode)}&searchScope=PACKAGE`

    const outcome = await this.get(url, options.timeoutMs)
    if (!outcome.ok) return fail(outcome.reason, outcome.error, 1)

    const parsed = parseTuiOffersResponse(outcome.body, query, this.name)
    if ("error" in parsed) {
      recordProviderEvent(this.db(), this.name, "error", parsed.error)
      return fail(parsed.reason, parsed.error, 1)
    }
    if (parsed.offers.length === 0) return fail("no-results", "no offers in window", 1)

    return {
      provider: this.name, ok: true, offers: parsed.offers,
      callsSpent: 1, latencyMs: Date.now() - started,
      ...(options.captureRaw ? { raw: outcome.body } : {}),
    }
  }

  /**
   * One counted HTTP GET, attempt recorded BEFORE the fetch. A rotated or
   * blocked host surfaces here as HTTP error / non-JSON and is recorded as a
   * provider event — configuration/health failure, never a silent fallback.
   */
  private async get(url: string, timeoutMs?: number): Promise<
    | { ok: true; body: unknown }
    | { ok: false; reason: "provider-error" | "timeout" | "blocked"; error: string }
  > {
    const db = this.db()
    recordCallAttempt(db, this.name)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: "error",
        headers: { "User-Agent": BROWSER_UA, "Accept": "application/json" },
      })
      if (!res.ok) {
        const blocked = res.status === 403 || res.status === 429 || res.status === 503
        const error = blocked
          ? `HTTP ${res.status} — host rotated or blocking; update config/packages.json hosts (see hostsNote)`
          : `HTTP ${res.status}`
        recordCallOutcome(db, this.name, { ok: false, error })
        return { ok: false, reason: blocked ? "blocked" : "provider-error", error }
      }
      const text = await res.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        const error = "malformed response: not JSON (host rotation symptom — see config hostsNote)"
        recordCallOutcome(db, this.name, { ok: false, error })
        recordProviderEvent(db, this.name, "error", error)
        return { ok: false, reason: "provider-error", error }
      }
      recordCallOutcome(db, this.name, { ok: true })
      return { ok: true, body }
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      const error = aborted
        ? `timeout after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `${(err as Error).message} (unreachable host — rotation symptom, see config hostsNote)`
      recordCallOutcome(db, this.name, { ok: false, error })
      if (!aborted) recordProviderEvent(db, this.name, classifyFailure(error), error)
      return { ok: false, reason: aborted ? "timeout" : "provider-error", error }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Parsing (exported for fixture tests) ─────────────────────────────────────

interface ParseFailure { error: string; reason: "provider-error" | "no-results" }
interface ParseSuccess { offers: NormalizedPackageOffer[] }

function retainedTuiIds(o: Record<string, any>, hotelProduct: string | null): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    tempId: o.tempId, travelType: o.travelType, brand: o.brand,
    tourOperator: o.tourOperator, bookingTourOperator: o.bookingTourOperator,
    programType: o.programType, flightKey: o.departure?.flightKey,
    hotelProduct,
  })) {
    if (typeof value === "string" && value) ids[key] = value
  }
  return ids
}

/**
 * Calendar response: {offers:[…], currency, travellers}. No hotel echo exists
 * on this endpoint (measured), so hotel identity rides on the giata we sent —
 * a NAMED limitation; Tier 1 re-checks identity via its hotel.giata echo.
 * Everything the response DOES echo is checked: origin airport, nights,
 * board, travellers count, currency.
 */
export function parseTuiCalendarResponse(
  body: unknown, query: PackageCalendarQuery, provider: string,
): ParseSuccess | ParseFailure {
  const b = body as { offers?: unknown; currency?: unknown; travellers?: unknown }
  if (!b || !Array.isArray(b.offers)) return { error: "malformed response: no offers array", reason: "provider-error" }
  if (b.offers.length === 0) return { offers: [] }

  const currency = typeof b.currency === "string" && b.currency.trim() ? b.currency.trim().toUpperCase() : null
  if (!currency) return { error: "offers present but response names no currency", reason: "provider-error" }
  if (currency !== query.currency.toUpperCase()) {
    return { error: `currency mismatch: asked ${query.currency}, response is ${currency}`, reason: "provider-error" }
  }
  const travellers = Array.isArray(b.travellers) ? b.travellers.length : null
  if (travellers !== null && travellers !== query.adults + query.children) {
    return { error: `travellers mismatch: asked ${query.adults + query.children}, response priced ${travellers}`, reason: "provider-error" }
  }

  const offers: NormalizedPackageOffer[] = []
  for (const raw of b.offers) {
    const offer = normalizeTuiOffer(raw, {
      provider, currency,
      propertyId: query.propertyId, providerRef: query.providerRef,
      origin: query.origin, adults: query.adults, children: query.children,
      expectedNights: query.nights, expectedBoard: query.board,
      verificationLevel: "discovered",
    })
    if ("error" in offer) return { error: offer.error, reason: "provider-error" }
    if ("skip" in offer) continue
    offers.push(offer.value)
  }
  return { offers }
}

/** Offers response: {hotel:{giata,name}, currency, offers:[…]}. Full echo set. */
export function parseTuiOffersResponse(
  body: unknown, query: PackageOffersQuery, provider: string,
): ParseSuccess | ParseFailure {
  const b = body as { hotel?: { giata?: unknown; name?: unknown; product?: unknown }; currency?: unknown; offers?: unknown }
  if (!b || !Array.isArray(b.offers)) return { error: "malformed response: no offers array", reason: "provider-error" }
  if (b.offers.length === 0) return { offers: [] }

  // Identity check: the response names its hotel; it must be the one we asked
  // about, or the numbers must not enter this property's history.
  const echoedGiata = typeof b.hotel?.giata === "number" ? b.hotel.giata : null
  if (echoedGiata === null || String(echoedGiata) !== query.providerRef) {
    return { error: `identity mismatch: asked giata ${query.providerRef}, response is for ${echoedGiata}`, reason: "provider-error" }
  }
  const currency = typeof b.currency === "string" && b.currency.trim() ? b.currency.trim().toUpperCase() : null
  if (!currency) return { error: "offers present but response names no currency", reason: "provider-error" }
  if (currency !== query.currency.toUpperCase()) {
    return { error: `currency mismatch: asked ${query.currency}, response is ${currency}`, reason: "provider-error" }
  }

  const hotelName = typeof b.hotel?.name === "string" ? b.hotel.name : null
  const hotelProduct = typeof b.hotel?.product === "string" ? b.hotel.product : null
  const offers: NormalizedPackageOffer[] = []
  for (const raw of b.offers) {
    const offer = normalizeTuiOffer(raw, {
      provider, currency, hotelName, hotelProduct,
      giataId: echoedGiata,
      propertyId: query.propertyId, providerRef: query.providerRef,
      origin: query.origin, adults: query.adults, children: query.children,
      expectedNights: query.nights, expectedBoard: query.board,
      checkInFrom: query.checkInFrom, checkInTo: query.checkInTo,
      verificationLevel: "confirmed",
    })
    if ("error" in offer) return { error: offer.error, reason: "provider-error" }
    if ("skip" in offer) continue
    offers.push(offer.value)
  }
  return { offers }
}

interface TuiNormalizeContext {
  hotelProduct?: string | null
  provider: string
  currency: string
  propertyId: string
  providerRef: string
  origin: string
  adults: number
  children: number
  expectedNights: number
  expectedBoard: string
  verificationLevel: "discovered" | "confirmed"
  hotelName?: string | null
  giataId?: number | null
  checkInFrom?: string
  checkInTo?: string
}

/** One raw TUI offer → the contract shape, or an echo-check failure. */
function normalizeTuiOffer(
  raw: unknown, ctx: TuiNormalizeContext,
): { value: NormalizedPackageOffer } | { error: string } | { skip: string } {
  const o = raw as Record<string, any>
  if (!o || typeof o !== "object") return { error: "malformed offer entry" }

  const checkIn = dateOnly(o.checkInDate)
  const checkOut = dateOnly(o.checkOutDate)
  if (!checkIn || !checkOut) return { error: `offer without check-in/out dates` }
  const nights = typeof o.lengthOfStay === "number" ? o.lengthOfStay : nightsBetween(checkIn, checkOut)
  if (nights !== ctx.expectedNights) {
    return { error: `nights mismatch: asked ${ctx.expectedNights}, offer has ${nights} (${checkIn})` }
  }
  // The request deliberately asks a wider trip envelope than the caller's
  // check-in window (see searchOffers); an in-envelope offer outside the
  // requested check-ins is a correct answer to the wider question — selected
  // out, not an echo failure.
  if (ctx.checkInFrom && (checkIn < ctx.checkInFrom || checkIn > (ctx.checkInTo ?? ctx.checkInFrom))) {
    return { skip: `check-in ${checkIn} outside requested window ${ctx.checkInFrom}..${ctx.checkInTo}` }
  }

  const departure = o.departure as Record<string, any> | undefined
  const ret = o.return as Record<string, any> | undefined
  const echoedOrigin = departure?.departureAirport?.code
  if (typeof echoedOrigin === "string" && echoedOrigin !== ctx.origin) {
    return { error: `origin mismatch: asked ${ctx.origin}, offer departs ${echoedOrigin}` }
  }

  const room = Array.isArray(o.rooms) ? o.rooms[0] as Record<string, any> : undefined
  const board = boardFromTuiCode(room?.boardCode)
  if (board !== ctx.expectedBoard) {
    return { error: `board mismatch: asked ${ctx.expectedBoard}, offer is ${board} (${room?.boardCode ?? "no code"})` }
  }

  const totalPrice = typeof o.totalPrice === "number" && Number.isFinite(o.totalPrice) ? o.totalPrice : null
  if (totalPrice === null || totalPrice <= 0) return { error: `offer without a positive totalPrice (${checkIn})` }
  const pricePerPerson = typeof o.calculatedPricePerPerson === "number" && Number.isFinite(o.calculatedPricePerPerson)
    ? o.calculatedPricePerPerson
    : null

  // The seller's own flight-side split: outbound + return per-person prices.
  // (return is routinely 0 because the round trip is priced on the outbound.)
  const flightPp = flightPerPerson(departure) !== null || flightPerPerson(ret) !== null
    ? (flightPerPerson(departure) ?? 0) + (flightPerPerson(ret) ?? 0)
    : null

  const transfer = room?.transferIncluded === true ? "included"
    : room?.transferIncluded === false ? "not_included"
    : "unknown"
  const cancellation = typeof o.cancellationType === "string"
    ? (/^refundable$/i.test(o.cancellationType) ? "refundable"
      : /non.?refundable/i.test(o.cancellationType) ? "nonrefundable" : "unknown")
    : "unknown"

  const unknownInclusions = ["baggage allowance not stated in offer"]
  if (transfer === "unknown") unknownInclusions.push("transfer inclusion not stated")

  const roomName = typeof room?.description === "string" && room.description.trim() ? room.description.trim() : null

  const value: NormalizedPackageOffer = {
    propertyId: ctx.propertyId,
    providerPropertyRef: ctx.providerRef,
    giataId: ctx.giataId ?? (REF_PATTERN.test(ctx.providerRef) ? Number(ctx.providerRef) : null),
    hotelName: ctx.hotelName ?? null,
    origin: ctx.origin,
    destinationAirport: typeof departure?.arrivalAirport?.code === "string" ? departure.arrivalAirport.code : null,
    destinationRegion: null,
    checkIn, checkOut, nights,
    tripDeparture: typeof departure?.departureDateTime === "string" ? departure.departureDateTime : null,
    tripReturn: typeof ret?.departureDateTime === "string" ? ret.departureDateTime : null,
    tripDays: tripDaysBetween(departure?.departureDateTime ?? null, ret?.arrivalDateTime ?? null),
    adults: ctx.adults,
    children: ctx.children,
    roomName,
    roomClass: roomName ? classifyRoomText(roomName) : null,
    board: board,
    boardSource: "structured",
    cabin: normalizeCabin(departure?.class),
    outboundSegments: segmentsOf(departure),
    returnSegments: segmentsOf(ret),
    flightPricePerPerson: flightPp,
    hotelPricePerPerson: null,       // never supplied; never derived
    priceSplitSource: flightPp !== null ? "provider" : "absent",
    baggage: "unknown",
    transfer,
    cancellation,
    totalPrice: { amount: totalPrice, currency: ctx.currency },
    pricePerPerson,
    taxesFees: "included",
    unknownInclusions,
    tourOperator: typeof o.tourOperator === "string" && o.tourOperator.trim() ? o.tourOperator.trim() : null,
    providerIds: retainedTuiIds(o, ctx.hotelProduct ?? null),
    providerUrls: {},          // TUI returns no per-offer URL — never invented
    provider: ctx.provider,
    fetchedAt: nowIso(),
    verificationLevel: ctx.verificationLevel,
    confidence: "medium",
  }
  return { value }
}

function flightPerPerson(leg: Record<string, any> | undefined): number | null {
  if (!leg) return null
  const pp = Array.isArray(leg.personPrices) ? leg.personPrices[0]?.price : null
  return typeof pp === "number" && Number.isFinite(pp) ? pp : null
}

function segmentsOf(leg: Record<string, any> | undefined): PackageFlightSegment[] {
  if (!leg || !Array.isArray(leg.segments)) return []
  return leg.segments.map((s: Record<string, any>) => ({
    airline: typeof s?.airline?.code === "string" ? s.airline.code : null,
    airlineName: typeof s?.airline?.value === "string" ? s.airline.value : null,
    flightNumber: typeof s?.number === "string" ? s.number : null,
    from: typeof s?.departureAirport?.code === "string" ? s.departureAirport.code : null,
    to: typeof s?.arrivalAirport?.code === "string" ? s.arrivalAirport.code : null,
    departure: typeof s?.departureDateTime === "string" ? s.departureDateTime : null,
    arrival: typeof s?.arrivalDateTime === "string" ? s.arrivalDateTime : null,
  }))
}

function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

// ── Query validation ─────────────────────────────────────────────────────────

function validateCalendarQuery(q: PackageCalendarQuery): string | null {
  if (!REF_PATTERN.test(q.providerRef)) return `invalid giata ref: ${q.providerRef}`
  if (!isIsoDate(q.rangeStart) || !isIsoDate(q.rangeEnd)) return `invalid range: ${q.rangeStart}..${q.rangeEnd}`
  if (q.rangeEnd <= q.rangeStart) return `range end must be after start: ${q.rangeStart}..${q.rangeEnd}`
  if (!Number.isInteger(q.nights) || q.nights <= 0) return `invalid nights: ${q.nights}`
  if (!Number.isInteger(q.adults) || q.adults <= 0) return `invalid adults: ${q.adults}`
  return null
}

function validateOffersQuery(q: PackageOffersQuery): string | null {
  if (!REF_PATTERN.test(q.providerRef)) return `invalid giata ref: ${q.providerRef}`
  if (!isIsoDate(q.checkInFrom) || !isIsoDate(q.checkInTo)) {
    return `invalid check-in window: ${q.checkInFrom}..${q.checkInTo}`
  }
  if (q.checkInTo < q.checkInFrom) {
    return `check-in window end before start: ${q.checkInFrom}..${q.checkInTo}`
  }
  if (!Number.isInteger(q.nights) || q.nights <= 0) return `invalid nights: ${q.nights}`
  if (!Number.isInteger(q.adults) || q.adults <= 0) return `invalid adults: ${q.adults}`
  return null
}
