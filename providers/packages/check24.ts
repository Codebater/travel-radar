/**
 * CHECK24 Reisen (urlaub.check24.de) — Tier 2 cross-seller CONFIRMATION,
 * never a sweep.
 *
 * Clean-room implementation from our own live probes (2026-08-28). One
 * endpoint matters:
 *
 *   POST /suche/json/dynamic/offer   form-encoded job/poll: the same POST
 *        creates the search job (status "Pending") and, repeated, reports it
 *        until "Success" (≈25 offers across multiple tour operators),
 *        "Empty" (valid zero-offer answer, immediate) or "Error". A poll
 *        loop is ONE logical search — many HTTP POSTs, one spend.
 *
 * Role: answer "does a competing operator materially beat TUI for this exact
 * product" — its offers arrive as verification_level "verified" because an
 * INDEPENDENT seller quoting the same product is the strongest package
 * evidence this radar has.
 *
 * Blocking doctrine: this seller fingerprints clients. HTTP 403/429/503, a
 * challenge header, or HTML instead of JSON means the bot wall answered —
 * the provider returns reason "blocked", records the event, and the CALLER
 * stops or degrades. No retries, no workarounds, no CAPTCHA anything, ever.
 *
 * Measured semantics that will bite anyone who forgets them:
 *   - price.person is per person; price.total (and effectivePrice.amount)
 *     are the ALLOCATION total. roomAllocation "A" is ONE adult; two adults
 *     is "A-A". A 1-adult probe reads deceptively like a per-person quote.
 *   - departureDate/returnDate are TRIP days; hotel nights =
 *     travelAttributes.overnightStays (overnight outbounds land next day).
 *     Check-in is derived from the outbound flight's actual arrival datetime
 *     — evidenced, never assumed equal to the departure date.
 *   - responses carry no currency field; EUR is a structural fact about this
 *     German-market seller (config check24.currencyNote).
 */

import crypto from "crypto"
import { getDb, nowIso, type DB } from "../../db/index.js"
import {
  recordCallAttempt,
  recordCallOutcome,
  recordProviderEvent,
  readUsage,
} from "../../db/repositories.js"
import { loadPackagesConfig } from "../../packages/config.js"
import {
  boardFromCheck24MealType,
  check24CateringList,
  dateOnly,
  isIsoDate,
  normalizeCabin,
} from "../../packages/normalize.js"
import { classifyRoomText } from "../../stays/normalize.js"
import type {
  NormalizedPackageOffer,
  PackageFlightSegment,
  PackageOffersQuery,
  PackageProvider,
  PackageProviderCapabilities,
  PackageSearchOptions,
  PackageSearchResult,
  ProviderHealth,
  ProviderQuota,
} from "./types.js"

export const CHECK24_PACKAGES_PROVIDER = "check24_packages"

function apiBase(): string {
  return process.env.CHECK24_PACKAGES_API_BASE || loadPackagesConfig().check24.apiBase
}

/** CHECK24 hotel ids are plain positive integers. */
const REF_PATTERN = /^\d+$/

const DEFAULT_TIMEOUT_MS = 25_000

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

type FetchLike = typeof globalThis.fetch
type SleepLike = (ms: number) => Promise<void>

export interface Check24PackagesOptions {
  fetchImpl?: FetchLike
  db?: DB
  /** Injectable so tests poll without wall-clock waits. */
  sleepImpl?: SleepLike
}

export class Check24PackagesProvider implements PackageProvider {
  readonly name = CHECK24_PACKAGES_PROVIDER
  readonly kind = "free" as const
  readonly confidence = "medium" as const
  readonly capabilities: PackageProviderCapabilities = {
    calendar: false,
    datedOffers: true,
    multiOperator: true,
    flightIdentity: true,
    priceSplit: false,
    taxesFees: "included",
  }

  private readonly fetchImpl: FetchLike
  private readonly explicitDb: DB | null
  private readonly sleepImpl: SleepLike

  constructor(options: Check24PackagesOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.explicitDb = options.db ?? null
    this.sleepImpl = options.sleepImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  private db(): DB {
    return this.explicitDb ?? getDb()
  }

  isConfigured(): boolean {
    return true
  }

  async health(): Promise<ProviderHealth> {
    const usage = readUsage(this.db(), this.name)
    return {
      provider: this.name,
      status: usage.lastError && !usage.lastSuccessAt ? "degraded" : "ok",
      detail: usage.lastSuccessAt
        ? `keyless unofficial API; last successful search ${usage.lastSuccessAt}`
        : "keyless unofficial API; no search attempted yet this period",
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

  async searchOffers(query: PackageOffersQuery, options: PackageSearchOptions = {}): Promise<PackageSearchResult> {
    const started = Date.now()
    const fail = (reason: PackageSearchResult["reason"], error: string, spent: number): PackageSearchResult => ({
      provider: this.name, ok: false, offers: [], reason, error,
      callsSpent: spent, latencyMs: Date.now() - started,
    })

    if (!REF_PATTERN.test(query.providerRef)) {
      return fail("provider-error", `invalid check24 hotel id: ${query.providerRef}`, 0)
    }
    // This seller prices trips, not stays: without the door-to-door envelope
    // the query is unanswerable, and guessing it from the check-in would
    // silently price a different product.
    if (!isIsoDate(query.tripDeparture ?? "") || !isIsoDate(query.tripReturn ?? "")) {
      return fail("provider-error", "check24 needs tripDeparture/tripReturn (trip envelope dates)", 0)
    }
    const catering = check24CateringList(query.board)
    if (!catering) return fail("provider-error", `no check24 catering filter for board "${query.board}"`, 0)
    if (query.adults < 1 || query.adults > 6) return fail("provider-error", `invalid adults: ${query.adults}`, 0)

    const cfg = loadPackagesConfig().check24
    const searchUrl = `${apiBase()}/suche/hotel?` + new URLSearchParams({
      airport: query.origin,
      transportType: "flight",
      // "A" per adult, joined: "A-A" = 2 adults. THE allocation trap.
      roomAllocation: Array(query.adults).fill("A").join("-"),
      departureDate: query.tripDeparture!,
      returnDate: query.tripReturn!,
      days: "exact",
      pageArea: "package", ds: "h",
      sorting: "categoryDistribution", offerSort: "offerRanking", areaSort: "topregion",
      extendedSearch: "1", noRedirect: "1",
      hotelId: query.providerRef,
      cateringList: catering,
    }).toString()

    const form = new URLSearchParams({
      transactionId: crypto.randomUUID(), clientId: crypto.randomUUID(),
      previousSearchUrl: "", disableCache: "1", forceFailedVacancies: "0",
      forceEstaHint: "0", forceErrorVacancies: "0", forceFlightTimeChange: "0",
      forceCancellationNotAvailable: "0", searchUrl,
      withTravelExperts: "1", isWithServiceInformation: "0", isWithPriceAlarm: "1",
    }).toString()

    // ONE logical search: the attempt is recorded once, however many polls run.
    const db = this.db()
    recordCallAttempt(db, this.name)

    let body: Record<string, unknown> | null = null
    for (let poll = 0; poll < cfg.maxPolls; poll++) {
      const outcome = await this.post(`${apiBase()}/suche/json/dynamic/offer`, form, searchUrl, options.timeoutMs)
      if (!outcome.ok) {
        recordCallOutcome(db, this.name, { ok: false, error: outcome.error })
        recordProviderEvent(db, this.name, outcome.reason === "blocked" ? "auth" : "error", outcome.error)
        return fail(outcome.reason, outcome.error, 1)
      }
      body = outcome.body as Record<string, unknown>
      const status = body.status
      if (status === "Success" || status === "Empty" || status === "Error") break
      body = null
      await this.sleepImpl(cfg.pollIntervalMs)
    }

    if (!body) {
      const error = `search job did not finish within ${cfg.maxPolls} polls`
      recordCallOutcome(db, this.name, { ok: false, error })
      return fail("timeout", error, 1)
    }
    if (body.status === "Error") {
      const error = "check24 reported search Error (invalid hotel id or parameters)"
      recordCallOutcome(db, this.name, { ok: false, error })
      recordProviderEvent(db, this.name, "error", error)
      return fail("provider-error", error, 1)
    }
    if (body.status === "Empty") {
      // A valid answer: this hotel has no offers for exactly these dates.
      recordCallOutcome(db, this.name, { ok: true })
      return fail("no-results", "no offers for exactly these trip dates", 1)
    }

    const parsed = parseCheck24OfferResponse(body, query, this.name, cfg.currency)
    if ("error" in parsed) {
      recordCallOutcome(db, this.name, { ok: false, error: parsed.error })
      recordProviderEvent(db, this.name, "error", parsed.error)
      return fail("provider-error", parsed.error, 1)
    }
    recordCallOutcome(db, this.name, { ok: true })
    if (parsed.offers.length === 0) return fail("no-results", "no offers matched the requested board", 1)

    return {
      provider: this.name, ok: true, offers: parsed.offers,
      callsSpent: 1, latencyMs: Date.now() - started,
      ...(options.captureRaw ? { raw: body } : {}),
    }
  }

  /** One HTTP POST inside the poll loop. Detects the bot wall; never throws. */
  private async post(url: string, form: string, referer: string, timeoutMs?: number): Promise<
    | { ok: true; body: unknown }
    | { ok: false; reason: "provider-error" | "timeout" | "blocked"; error: string }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept-Language": "de-DE,de;q=0.9",
          "Referer": referer,
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      })
      if (res.status === 403 || res.status === 429 || res.status === 503 || res.headers.get("cf-mitigated")) {
        return {
          ok: false, reason: "blocked",
          error: `bot wall answered (HTTP ${res.status}) — stop, do not retry (config blockNote)`,
        }
      }
      if (!res.ok) return { ok: false, reason: "provider-error", error: `HTTP ${res.status}` }
      const text = await res.text()
      try {
        return { ok: true, body: JSON.parse(text) }
      } catch {
        const challenge = /<html|<!doctype/i.test(text)
        return {
          ok: false,
          reason: challenge ? "blocked" : "provider-error",
          error: challenge
            ? "HTML challenge page instead of JSON — stop, do not retry (config blockNote)"
            : "malformed response: not JSON",
        }
      }
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      return {
        ok: false,
        reason: aborted ? "timeout" : "provider-error",
        error: aborted ? `timeout after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (err as Error).message,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Parsing (exported for fixture tests) ─────────────────────────────────────

interface ParseFailure { error: string }
interface ParseSuccess { offers: NormalizedPackageOffer[] }

export function parseCheck24OfferResponse(
  body: Record<string, unknown>, query: PackageOffersQuery, provider: string, currency: string,
): ParseSuccess | ParseFailure {
  const items = body.items
  if (!items || typeof items !== "object") return { error: "malformed response: no items object" }
  const meta = (body.meta ?? {}) as Record<string, any>

  // Occupancy echo: a response priced for a different party must not enter
  // history — this is THE guard against the 1-adult/2-adult allocation trap.
  if (typeof meta.travellerCount === "number" && meta.travellerCount !== query.adults + query.children) {
    return { error: `occupancy mismatch: asked ${query.adults + query.children} travellers, response priced ${meta.travellerCount}` }
  }

  const offers: NormalizedPackageOffer[] = []
  for (const raw of Object.values(items as Record<string, unknown>)) {
    const item = raw as Record<string, any>
    if (!item || typeof item !== "object") continue

    // Identity echo per offer.
    if (item.hotelId != null && String(item.hotelId) !== query.providerRef) {
      return { error: `identity mismatch: asked hotel ${query.providerRef}, item is for ${item.hotelId}` }
    }
    // Trip-date echo per offer.
    const ta = (item.travelAttributes ?? {}) as Record<string, any>
    const echoedDep = dateOnly(ta.departureDate)
    const echoedRet = dateOnly(ta.returnDate)
    if ((echoedDep && echoedDep !== query.tripDeparture) || (echoedRet && echoedRet !== query.tripReturn)) {
      return { error: `date mismatch: asked ${query.tripDeparture}..${query.tripReturn}, item priced ${echoedDep}..${echoedRet}` }
    }

    const acc = (item.accommodationData ?? {}) as Record<string, any>
    const board = boardFromCheck24MealType(acc.mealType)
    // The catering filter is "this level or better": better-board offers are a
    // DIFFERENT product, not a match — skipped, not compared.
    if (board !== query.board) continue

    const price = (item.price ?? {}) as Record<string, any>
    const total = typeof price.total === "number" && Number.isFinite(price.total) ? price.total : null
    if (total === null || total <= 0) continue   // an unpriced row observes nothing
    const perPerson = typeof price.person === "number" && Number.isFinite(price.person) ? price.person : null

    const flight = (item.flight ?? {}) as Record<string, any>
    const outbound = (flight.outbound ?? {}) as Record<string, any>
    const inbound = (flight.inbound ?? {}) as Record<string, any>

    // Hotel nights are EVIDENCED: check-in = the outbound flight's actual
    // arrival date; nights = overnightStays. Rows missing either observe
    // nothing hotel-comparable and are skipped.
    const checkIn = dateOnly(outbound?.arrival?.dateTime)
    const nights = typeof ta.overnightStays === "number" && ta.overnightStays > 0 ? ta.overnightStays : null
    if (!checkIn || nights === null) continue
    const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)

    const roomDesc = (acc.roomDescription ?? {}) as Record<string, any>
    const roomName = typeof roomDesc.description === "string" && roomDesc.description.trim()
      ? roomDesc.description.trim()
      : typeof roomDesc.name === "string" && roomDesc.name.trim() ? roomDesc.name.trim() : null

    // Inclusion evidence, never inference: transfer key present-and-truthy is
    // included, present-and-empty is not included, absent is unknown.
    const transfer = !("transfer" in acc) ? "unknown" : acc.transfer ? "included" : "not_included"
    // hasLuggage true is affirmative evidence; anything else stays unknown
    // (false may only mean "no luggage info", which is not "no luggage").
    const baggage = flight.hasLuggage === true ? "included" : "unknown"

    const cancellation = (item.cancellation ?? {}) as Record<string, any>
    const refundable = cancellation.isFreeCancellation === true || cancellation.isRefundable === true
      ? "refundable" : "unknown"

    const unknownInclusions: string[] = []
    if (baggage === "unknown") unknownInclusions.push("baggage allowance not stated in offer")
    if (transfer === "unknown") unknownInclusions.push("transfer inclusion not stated")
    if (refundable === "unknown") unknownInclusions.push("cancellation terms not stated")

    const outboundParsed = segmentsOf(outbound)
    const outboundSegments = outboundParsed.map(stripCabin)

    offers.push({
      propertyId: query.propertyId,
      providerPropertyRef: query.providerRef,
      giataId: null,             // check24 speaks its own hotel ids, not GIATA
      hotelName: typeof meta.hotelName === "string" ? meta.hotelName : null,
      origin: query.origin,
      destinationAirport: lastArrival(outboundSegments),
      destinationRegion: null,
      checkIn, checkOut, nights,
      tripDeparture: typeof outbound?.departure?.dateTime === "string" ? outbound.departure.dateTime : null,
      tripReturn: typeof inbound?.departure?.dateTime === "string" ? inbound.departure.dateTime : null,
      tripDays: typeof ta.days === "number" && ta.days > 0 ? ta.days : null,
      adults: query.adults,
      children: query.children,
      roomName,
      roomClass: roomName ? classifyRoomText(roomName) : null,
      board,
      boardSource: "structured",
      cabin: normalizeCabin(outboundParsed[0]?.cabin ?? null),
      outboundSegments,
      returnSegments: segmentsOf(inbound).map(stripCabin),
      flightPricePerPerson: null,
      hotelPricePerPerson: null,
      priceSplitSource: "absent",
      baggage,
      transfer,
      cancellation: refundable,
      totalPrice: { amount: total, currency },
      pricePerPerson: perPerson,
      taxesFees: "included",
      unknownInclusions,
      tourOperator: typeof item.tourOperatorAlias === "string" && item.tourOperatorAlias.trim()
        ? item.tourOperatorAlias.trim()
        : typeof item.tourOperatorCode === "string" ? item.tourOperatorCode : null,
      providerIds: retainedCheck24Ids(item, flight),
      // The provider's own per-offer link, VERBATIM — safety-checked at
      // render time, stored untouched.
      providerUrls: typeof item.detailsUrl === "string" && item.detailsUrl.trim()
        ? { detailsPath: item.detailsUrl }
        : {},
      provider,
      fetchedAt: nowIso(),
      verificationLevel: "verified",
      confidence: "medium",
    })
  }
  return { offers }
}

function retainedCheck24Ids(item: Record<string, any>, flight: Record<string, any>): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    itemId: item.id != null ? String(item.id) : "",
    hotelId: item.hotelId != null ? String(item.hotelId) : "",
    tourOperatorCode: item.tourOperatorCode,
    supplierCode: item.supplierCode,
    accommodationCode: item.accommodationCode,
    flightHash: flight.flightHash,
  })) {
    if (typeof value === "string" && value) ids[key] = value
  }
  return ids
}

type SegmentWithCabin = PackageFlightSegment & { cabin: string | null }

function stripCabin(s: SegmentWithCabin): PackageFlightSegment {
  return {
    airline: s.airline, airlineName: s.airlineName, flightNumber: s.flightNumber,
    from: s.from, to: s.to, departure: s.departure, arrival: s.arrival,
  }
}

function segmentsOf(leg: Record<string, any>): SegmentWithCabin[] {
  if (!Array.isArray(leg?.segments)) return []
  return leg.segments.map((s: Record<string, any>) => ({
    airline: typeof s?.airline?.code === "string" ? s.airline.code : null,
    airlineName: typeof s?.airline?.name === "string" ? s.airline.name : null,
    flightNumber: typeof s?.flightNumber === "string" ? s.flightNumber : null,
    from: typeof s?.departure?.airport?.code === "string" ? s.departure.airport.code : null,
    to: typeof s?.arrival?.airport?.code === "string" ? s.arrival.airport.code : null,
    departure: typeof s?.departure?.localDateTime === "string" ? s.departure.localDateTime : null,
    arrival: typeof s?.arrival?.localDateTime === "string" ? s.arrival.localDateTime : null,
    cabin: typeof s?.cabinClass === "string" ? s.cabinClass : null,
  }))
}

function lastArrival(segments: PackageFlightSegment[]): string | null {
  return segments.length ? segments[segments.length - 1].to : null
}
