/**
 * Agoda (unofficial) — targeted room-level CONFIRMATION, never a broad crawler.
 *
 * Clean-room implementation from our own browser network capture (2026-08-28):
 * the Agoda property page's own room-grid API, replayed with the same headers
 * the page sends. No third-party code was consulted or copied.
 *
 * Two endpoints:
 *   GET  /api/cronos/search/GetUnifiedSuggestResult/3/16/1/0/en-gb/?searchText=…
 *        → property ObjectId + CityId + CountryId (used once, at resolve time)
 *   POST /api/v1/property/room-grid
 *        → rooms × offers with per-night tax-INCLUSIVE pricing (priceStrategy
 *          301), structured booleans (isFreeCancellation, isBreakfastIncluded),
 *          benefits ("All Inclusive", …), and cancellation policy text with a
 *          deadline. Headers observed: a static bundle api key
 *          (ag-initiator-api-key) and x-gate-meta = base64(epochMs|uuid|path).
 *          Verified to work cookie-free from Node with a fresh random uuid.
 *
 * Trust posture: unofficial, unversioned, revocable — Agoda can change or
 * block any of this at any time. Every parse is defensive, a failure is a
 * result (never a throw), there are NO retries (a failed confirmation is a
 * recorded fact, not a retry loop), and the radar must keep working
 * Xotelo-only if this provider dies. Field rule: anything Agoda does not
 * actually state stays null/unknown — especially taxes: only an explicit
 * "incl. taxes"/"with taxes" price note marks a price tax-inclusive.
 *
 * Ref format: "propertyId:cityId:countryId" (e.g. "41483:17759:34") — all
 * three are needed by the room-grid body, so all three ARE the identity.
 */

import crypto from "crypto"
import { getDb, nowIso, type DB } from "../../db/index.js"
import {
  classifyFailure,
  recordCallAttempt,
  recordCallOutcome,
  recordProviderEvent,
  readUsage,
} from "../../db/repositories.js"
import { classifyRoomText, normalizeBoardText } from "../../stays/normalize.js"
import type {
  BoardBasis,
  NormalizedStayRate,
  ProviderHealth,
  ProviderQuota,
  StayProvider,
  StayProviderCapabilities,
  StayRateQuery,
  StayRateSearchResult,
  StaySearchOptions,
} from "./types.js"

export const AGODA_PROVIDER = "agoda"

function apiBase(): string {
  return process.env.AGODA_API_BASE || "https://www.agoda.com"
}

/** The web bundle's static initiator key, observed 2026-08-28. May rot. */
const INITIATOR_API_KEY = "b3949fd5-9553-4b4e-b221-48be2a1b84a8"

const REF_PATTERN = /^\d+:\d+:\d+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Display currency is selected by Agoda's internal numeric id, not ISO code
 * (currencyCode is ignored — measured). Ids probed live 2026-08-28.
 */
const CURRENCY_IDS: Record<string, number> = {
  EUR: 1, HKD: 3, SGD: 5, USD: 7, CZK: 22, KRW: 26,
}

const DEFAULT_TIMEOUT_MS = 25_000

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

/** Response fields we ask for — the minimal set that keeps offer names populated. */
const FIELDS = [
  "rateCategory", "cancellationInfo", "cancellationPolicyTitleTemplate",
  "Features", "sizeInfo", "breakfastInfo", "searchToken", "SoldOut",
]

type FetchLike = typeof globalThis.fetch

export interface AgodaOptions {
  fetchImpl?: FetchLike
  db?: DB
}

export class AgodaProvider implements StayProvider {
  readonly name = AGODA_PROVIDER
  readonly kind = "free" as const
  readonly confidence = "medium" as const
  readonly verificationLevel = "confirmed" as const
  readonly capabilities: StayProviderCapabilities = {
    dateSpecificRates: true,
    calendar: false,
    roomLevel: true,
    structuredBoard: true,
    cancellation: true,
    taxesFees: "included",
  }

  private readonly fetchImpl: FetchLike
  private readonly explicitDb: DB | null

  constructor(options: AgodaOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.explicitDb = options.db ?? null
  }

  private db(): DB {
    return this.explicitDb ?? getDb()
  }

  isConfigured(): boolean {
    return true
  }

  /** Never fetches — an unofficial endpoint least of all. */
  async health(): Promise<ProviderHealth> {
    const usage = readUsage(this.db(), this.name)
    return {
      provider: this.name,
      status: usage.lastError && !usage.lastSuccessAt ? "degraded" : "ok",
      detail: usage.lastSuccessAt
        ? `unofficial endpoint; last successful fetch ${usage.lastSuccessAt}`
        : "unofficial endpoint; liveness only proven by a real confirmation",
      latencyMs: null,
      checkedAt: nowIso(),
      quota: this.quota(),
    }
  }

  quota(): ProviderQuota | null {
    const usage = readUsage(this.db(), this.name)
    return {
      estimatedUsed: usage.attempted,
      budget: null,               // ceilings live in stays/budget.ts, not here
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

    if (!REF_PATTERN.test(query.providerRef)) {
      return fail("provider-error", `invalid agoda ref (want propertyId:cityId:countryId): ${query.providerRef}`, 0)
    }
    if (!DATE_PATTERN.test(query.checkIn) || !DATE_PATTERN.test(query.checkOut)) {
      return fail("provider-error", `invalid dates: ${query.checkIn}..${query.checkOut}`, 0)
    }
    const nights = Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / 86_400_000)
    if (nights <= 0) return fail("provider-error", "check-out must be after check-in", 0)

    const currencyId = CURRENCY_IDS[query.currency]
    if (currencyId === undefined) {
      // Refuse rather than fall back: a wrong display currency silently
      // corrupts every number downstream.
      return fail("unconfigured", `no agoda currency id known for ${query.currency}`, 0)
    }

    const [propertyId, cityId, countryId] = query.providerRef.split(":").map(Number)
    const path = "/api/v1/property/room-grid"
    const uid = crypto.randomUUID()
    const body = {
      clientApplicationName: "capybara",
      pricingRequest: {},
      userContext: {
        priceStrategy: 301,       // observed: "per night incl. taxes & fees"
        firstDownloadVersion: "6_0", cmsMode: 0, currencyDisplayType: 2,
        currencyId, mseHotelIds: [], pointsMaxId: 0,
      },
      userState: { currentFunnel: "regular", loyalty: { pastBookingsLevel: -1 } },
      propertyId: String(propertyId),
      fields: FIELDS,
      supportFeatures: [],
      searchCriteria: {
        adults: query.adults,
        checkIn: query.checkIn, checkOut: query.checkOut,
        childrenAges: [], durationType: "nightly", rooms: 1,
      },
      searchFilters: { searchType: 4, cityId, filters: "", countryId, syncIds: [] },
    }

    const db = this.db()
    recordCallAttempt(db, this.name)     // before the fetch — a crash still leaves a trace
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let payload: unknown
    try {
      const res = await this.fetchImpl(`${apiBase()}${path}`, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "ag-initiator-api-key": INITIATOR_API_KEY,
          "ag-initiator-version": "6_0",
          "ag-language-locale": "en-gb",
          "ag-cid": "-1",
          "ag-user-id": uid,
          "x-gate-meta": Buffer.from(`${Date.now()}|${uid}|${path}`).toString("base64"),
          "user-agent": BROWSER_UA,
          "accept": "application/json",
        },
        body: JSON.stringify(body),
      })
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
        const error = "malformed response: not JSON"
        recordCallOutcome(db, this.name, { ok: false, error })
        return fail("provider-error", error, 1)
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

    const parsed = parseRoomGrid(payload, query, propertyId, nights, this.name)
    if ("error" in parsed) {
      if (parsed.record) recordProviderEvent(db, this.name, "error", parsed.error)
      return fail(parsed.reason, parsed.error, 1)
    }
    if (parsed.rates.length === 0) return fail("no-results", "no priced offers in response", 1)

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

// ─── Parsing (exported for fixture-based tests) ─────────────────────────────

type ParseFailure = {
  error: string
  reason: "provider-error" | "no-results"
  record: boolean
}

export function parseRoomGrid(
  payload: unknown,
  query: StayRateQuery,
  expectedPropertyId: number,
  nights: number,
  providerName: string,
): { rates: NormalizedStayRate[] } | ParseFailure {
  if (!payload || typeof payload !== "object") {
    return { error: "malformed response: not an object", reason: "provider-error", record: false }
  }
  const root = payload as Record<string, unknown>

  // Identity: the response names the property it priced. A mismatch must not
  // enter this property's history.
  if (typeof root.propertyId === "number" && root.propertyId !== expectedPropertyId) {
    return {
      error: `identity mismatch: asked ${expectedPropertyId}, response is for ${root.propertyId}`,
      reason: "provider-error", record: true,
    }
  }

  // Dates: the response echoes its criteria as "Nov 10 - Nov 15, 2 guests"
  // (en-gb, which we pin via ag-language-locale). Parse defensively; only an
  // affirmative mismatch rejects — an unparseable description is tolerated.
  const desc = typeof root.searchCriteriaDescription === "string" ? root.searchCriteriaDescription : null
  if (desc) {
    const echoed = parseCriteriaDates(desc, query.checkIn)
    if (echoed && (echoed.checkIn !== query.checkIn || echoed.checkOut !== query.checkOut)) {
      return {
        error: `date mismatch: asked ${query.checkIn}..${query.checkOut}, response priced ` +
          `${echoed.checkIn}..${echoed.checkOut} ("${desc}")`,
        reason: "provider-error", record: true,
      }
    }
  }

  if (root.isSoldOut === true) {
    return { error: "property reports sold out for these dates", reason: "no-results", record: false }
  }

  const rooms = Array.isArray(root.rooms) ? root.rooms : []
  const fetchedAt = nowIso()
  const rates: NormalizedStayRate[] = []

  for (const roomRaw of rooms) {
    if (!roomRaw || typeof roomRaw !== "object") continue
    const room = roomRaw as Record<string, unknown>
    const roomName = typeof room.name === "string" && room.name.trim() ? room.name.trim() : null
    const offers = Array.isArray(room.offers) ? room.offers : []

    for (const offerRaw of offers) {
      if (!offerRaw || typeof offerRaw !== "object") continue
      const offer = offerRaw as Record<string, unknown>
      const price = extractPrice(offer, query.currency)
      if (price === "currency-mismatch") {
        // The response is denominated in a currency we did not ask for —
        // recording these numbers under the requested currency would poison
        // the baseline invisibly. Reject the whole response.
        return {
          error: `currency mismatch: asked ${query.currency}, response is denominated differently`,
          reason: "provider-error", record: true,
        }
      }
      if (!price) continue                        // an unpriced offer observes nothing

      const booking = (offer.bookingDetails ?? {}) as Record<string, unknown>
      const offerName = typeof offer.name === "string" && offer.name.trim() ? offer.name.trim() : null
      const board = boardFromOffer(offerName, offer, booking)
      const cancellation = cancellationFromOffer(offer, booking)

      rates.push({
        propertyId: query.propertyId,
        providerPropertyRef: query.providerRef,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights,
        adults: query.adults,
        children: query.children,
        roomName,
        roomClass: classifyRoomText(roomName),
        board: board.board,
        boardSource: board.source,
        refundable: cancellation.refundable,
        cancellationDeadline: cancellation.deadline,
        rateSource: "Agoda",
        sourceClass: "retail",
        price: { amount: price.amount, currency: price.currency },
        priceBasis: "nightly_room",
        // ONLY an explicit price note marks taxes included — a missing note
        // must never be read as "inclusive", that is the teaser bug's cousin.
        taxesFees: price.taxesIncluded ? "included" : "unknown",
        taxesFeesAmount: null,
        provider: providerName,
        fetchedAt,
        providerAsOf: null,
        verificationLevel: "confirmed",
        confidence: "medium",
      })
    }
  }

  return { rates }
}

function extractPrice(
  offer: Record<string, unknown>,
  requestedCurrency: string,
): { amount: number; currency: string; taxesIncluded: boolean } | "currency-mismatch" | null {
  const price = offer.price as Record<string, unknown> | undefined
  const final = price?.final as Record<string, unknown> | undefined
  const amount = typeof final?.amountNumber === "number" && Number.isFinite(final.amountNumber)
    ? final.amountNumber : null
  if (amount === null || amount <= 0) return null

  // The response prints a currency SYMBOL (live-verified: "USD", "€", "Kč").
  // When the symbol is recognisable it must agree with what we asked for;
  // an unrecognised symbol is tolerated as the requested currency (the id
  // mapping controls the actual denomination).
  const symbol = typeof final?.currency === "string" ? final.currency : ""
  const iso = SYMBOL_TO_ISO[symbol]
  if (iso && iso !== requestedCurrency) return "currency-mismatch"

  const info = Array.isArray(price?.priceInfo) ? (price!.priceInfo as unknown[]).join(" ") : ""
  const taxesIncluded = /incl.*tax|with tax/i.test(info)
  return { amount, currency: requestedCurrency, taxesIncluded }
}

const SYMBOL_TO_ISO: Record<string, string> = {
  "€": "EUR", "Kč": "CZK", "HK$": "HKD", "S$": "SGD", "₩": "KRW", "USD": "USD", "$": "USD",
}

function boardFromOffer(
  offerName: string | null,
  offer: Record<string, unknown>,
  booking: Record<string, unknown>,
): { board: BoardBasis; source: "structured" | "unknown" } {
  // Benefits are the most explicit signal ("All Inclusive" as a named benefit).
  const benefits = Array.isArray(offer.benefits) ? offer.benefits : []
  const benefitTexts = benefits
    .map(b => (b && typeof b === "object" ? (b as Record<string, unknown>).text : null))
    .filter((t): t is string => typeof t === "string")

  if (benefitTexts.some(t => /all[\s-]?inclusive/i.test(t))) return { board: "all_inclusive", source: "structured" }
  const fromName = normalizeBoardText(offerName)
  if (fromName !== "unknown") return { board: fromName, source: "structured" }
  const meals = {
    breakfast: benefitTexts.some(t => /breakfast/i.test(t)) || booking.isBreakfastIncluded === true,
    lunch: benefitTexts.some(t => /lunch/i.test(t)),
    dinner: benefitTexts.some(t => /dinner/i.test(t)),
  }
  if (meals.breakfast && meals.lunch && meals.dinner) return { board: "full_board", source: "structured" }
  if (meals.breakfast) return { board: "breakfast", source: "structured" }
  return { board: "unknown", source: "unknown" }
}

function cancellationFromOffer(
  offer: Record<string, unknown>,
  booking: Record<string, unknown>,
): { refundable: boolean | null; deadline: string | null } {
  const policies = Array.isArray(offer.policies) ? offer.policies : []
  const cancelPolicy = policies
    .map(p => (p && typeof p === "object" ? p as Record<string, unknown> : null))
    .find(p => p && typeof p.name === "string" && /cancel/i.test(p.name))
  const text = cancelPolicy && Array.isArray(cancelPolicy.descriptions)
    ? (cancelPolicy.descriptions as unknown[]).filter(d => typeof d === "string").join("\n")
    : ""

  let refundable: boolean | null = null
  if (booking.isFreeCancellation === true || /free cancellation/i.test(text)) refundable = true
  else if (/non[\s-]?refundable/i.test(text)) refundable = false
  else if (booking.isFreeCancellation === false && text) refundable = false

  // "Cancel for free before Oct 27, 2026" — en-gb month names, pinned locale.
  let deadline: string | null = null
  const m = /before\s+([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})/.exec(text)
  if (m) {
    const month = MONTHS[m[1].slice(0, 3)]
    if (month) deadline = `${m[3]}-${month}-${m[2].padStart(2, "0")}`
  }
  return { refundable, deadline }
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
}

/** "Nov 10 - Nov 15, 2 guests" + the query's year(s). */
function parseCriteriaDates(desc: string, queryCheckIn: string): { checkIn: string; checkOut: string } | null {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s*-\s*([A-Z][a-z]{2})\s+(\d{1,2})/.exec(desc)
  if (!m) return null
  const [, m1, d1, m2, d2] = m
  const year = Number(queryCheckIn.slice(0, 4))
  const mm1 = MONTHS[m1]; const mm2 = MONTHS[m2]
  if (!mm1 || !mm2) return null
  const checkIn = `${year}-${mm1}-${d1.padStart(2, "0")}`
  // A stay can wrap the year end (Dec → Jan).
  const outYear = Number(mm2) < Number(mm1) ? year + 1 : year
  const checkOut = `${outYear}-${mm2}-${d2.padStart(2, "0")}`
  return { checkIn, checkOut }
}

// ─── Resolution (used by the CLI, once per property) ────────────────────────

export interface AgodaResolution {
  ref: string                    // propertyId:cityId:countryId
  matchedName: string
  geo: string | null
}

/**
 * Resolve a property name to an Agoda ref via the suggest endpoint. Picks the
 * first IsHotel suggestion whose name plausibly matches; returns null rather
 * than guessing — a wrong ref poisons a property's history invisibly.
 */
export async function resolveAgodaRef(
  propertyName: string,
  options: { fetchImpl?: FetchLike; db?: DB } = {},
): Promise<AgodaResolution | { error: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const db = options.db ?? getDb()
  const guid = crypto.randomUUID()
  const url = `${apiBase()}/api/cronos/search/GetUnifiedSuggestResult/3/16/1/0/en-gb/`
    + `?searchText=${encodeURIComponent(propertyName)}`
    + `&guid=${guid}&origin=US&cid=-1&pageTypeId=1&logTypeId=1&isHotelLandSearch=true&lastSearchedCity=0`

  recordCallAttempt(db, AGODA_PROVIDER)
  let payload: unknown
  try {
    const res = await fetchImpl(url, {
      redirect: "error",
      headers: { "user-agent": BROWSER_UA, "accept": "application/json" },
    })
    if (!res.ok) {
      recordCallOutcome(db, AGODA_PROVIDER, { ok: false, error: `HTTP ${res.status}` })
      return { error: `HTTP ${res.status}` }
    }
    payload = JSON.parse(await res.text())
    recordCallOutcome(db, AGODA_PROVIDER, { ok: true })
  } catch (err) {
    recordCallOutcome(db, AGODA_PROVIDER, { ok: false, error: (err as Error).message })
    return { error: (err as Error).message }
  }

  const list = (payload as Record<string, unknown> | null)?.ViewModelList
  if (!Array.isArray(list)) return { error: "malformed suggest response" }

  const wanted = normalizeName(propertyName)
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const s = item as Record<string, unknown>
    if (s.IsHotel !== true) continue
    const name = typeof s.Name === "string" ? s.Name : ""
    if (!name) continue
    const candidate = normalizeName(name)
    // Identity check: after stopword removal the two names must carry the SAME
    // significant words in both directions. One-directional containment is not
    // enough — "Blue Lily Beach Resort Puri" contains every word of "Lily
    // Beach Resort" and is a different hotel on a different continent.
    if (!wanted.every(w => candidate.includes(w)) || !candidate.every(w => wanted.includes(w))) continue
    const propertyId = s.ObjectId; const cityId = s.CityId; const countryId = s.CountryId
    if (typeof propertyId !== "number" || typeof cityId !== "number" || typeof countryId !== "number") continue
    const names = s.DisplayNames as Record<string, unknown> | null
    return {
      ref: `${propertyId}:${cityId}:${countryId}`,
      matchedName: name,
      geo: names && typeof names.GeoHierarchyName === "string" ? names.GeoHierarchyName : null,
    }
  }
  return { error: `no confident match among suggestions for "${propertyName}"` }
}

function normalizeName(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 1 && !["the", "and", "spa", "all", "inclusive", "resort", "hotel"].includes(w))
}
