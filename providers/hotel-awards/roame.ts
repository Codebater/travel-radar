/**
 * Roame Hotels — hotel award provider #2, on the REAL authenticated search.
 *
 * Product search, clean-room-captured and verified live 2026-08-28 (see
 * config `roame.capturedSearch`):
 *
 *   POST https://roame.travel/encore/graphql
 *   query HotelAvailablePeriods($input: HotelRoomPeriodWhereInput!) {
 *     hotelAvailablePeriods(input: $input) {
 *       hasMore endCursor
 *       availableHotels {
 *         hotelDetail { id name brand mileageProgram city country url }
 *         availableRooms { roomDetail { roomCode roomName roomType }
 *           offerPeriods { avgAwardPoints avgSurchargeUsd avgCashPriceUsd avgCpp
 *                          nights roomCode roomType startDate mileageProgram
 *                          offerCode createTime } }
 *         availabilityPercent lastUpdated } } }
 *
 * The obsolete /api/graphql `pingHotelResult(where: HotelHistoryWhereInput)`
 * path is GONE — this provider carries no graphqlUrl/whereTemplate, so it
 * cannot hit the wrong endpoint.
 *
 * Honesty rules (verified units in capturedSearch.unitsAndTraps):
 *   - avgAwardPoints is a PER-NIGHT average → pointsPerNight, quoteBasis
 *     per_night. A stay total is NEVER synthesized (no avg × nights);
 *   - nights is source-stated; checkOut = startDate + nights (the same
 *     deterministic UTC-day arithmetic Gondola uses);
 *   - avgSurchargeUsd/avgCashPriceUsd are USD; a surcharge of 0 does NOT
 *     become a stated zero-tax — only a POSITIVE surcharge is "stated",
 *     everything else is unknown;
 *   - program = mileageProgram mapped EXPLICITLY (never inferred from name);
 *   - room code/type/name preserved from roomDetail;
 *   - availabilityPercent is period metadata, not a live hold →
 *     availabilityState stays "unknown" (Roame is historical/period data);
 *   - booking URL only when the source provides a real one (hotelDetail.url);
 *   - location is an EXPLICIT configured map bbox; a location with no bbox is
 *     structured unconfigured — never geocoded or guessed;
 *   - 401/403/429/503 or a missing session → structured blocked/auth states,
 *     no retries.
 */

import fs from "fs"
import os from "os"
import path from "path"
import type {
  HotelAwardProvider, HotelAwardProviderCapabilities, HotelAwardQuery,
  HotelAwardSearchResult, NormalizedHotelAward,
} from "./types.js"
import { loadHotelAwardsConfig, type HotelAwardsConfig } from "./gondola.js"

type RoameConfig = NonNullable<HotelAwardsConfig["roame"]>

const HOTEL_AVAILABLE_PERIODS_QUERY = `query HotelAvailablePeriods($input: HotelRoomPeriodWhereInput!) {
  hotelAvailablePeriods(input: $input) {
    hasMore
    endCursor
    availableHotels {
      hotelDetail { id name brand mileageProgram city country url }
      availableRooms {
        roomDetail { roomCode roomName roomType }
        offerPeriods { avgAwardPoints avgSurchargeUsd avgCashPriceUsd avgCpp nights roomCode roomType startDate mileageProgram offerCode createTime }
      }
      availabilityPercent
      lastUpdated
    }
  }
}`

// ── Raw response shapes (exactly the selected fields) ────────────────────────

export interface RoameOfferPeriod {
  avgAwardPoints: number | null
  avgSurchargeUsd: number | null
  avgCashPriceUsd: number | null
  avgCpp: number | null
  nights: number | null
  roomCode: string | null
  roomType: string | null
  startDate: string | null
  mileageProgram: string | null
  offerCode: string | null
  createTime: string | null
}
export interface RoameRoomDetail { roomCode: string | null; roomName: string | null; roomType: string | null }
export interface RoameAvailableRoom { roomDetail: RoameRoomDetail | null; offerPeriods: RoameOfferPeriod[] | null }
export interface RoameHotelDetail {
  id: string; name: string; brand: string | null; mileageProgram: string | null
  city: string | null; country: string | null; url: string | null
}
export interface RoameAvailableHotel {
  hotelDetail: RoameHotelDetail | null
  availableRooms: RoameAvailableRoom[] | null
  availabilityPercent: number | null
  lastUpdated: string | null
}
export interface RoameHotelAvailablePeriods {
  hasMore: boolean | null
  endCursor: string | null
  availableHotels: RoameAvailableHotel[] | null
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), p.slice(1)) : p
}

// ── Input builder (the real HotelRoomPeriodWhereInput) ───────────────────────

export interface RoameBbox { bbox: [number, number, number, number]; center: [number, number] }

/** Resolve the requested location to an EXPLICIT configured bbox — or null.
 *  Never geocodes; a city string alone can never become a box. */
export function resolveBbox(cfg: RoameConfig, location: string): RoameBbox | null {
  const entry = cfg.locations[location.trim().toLowerCase()]
  if (!entry || typeof entry === "string") return null
  return entry
}

export function buildEncoreInput(
  cfg: RoameConfig,
  query: HotelAwardQuery,
  bbox: RoameBbox,
  minNights: number,
  startCursorGT: string | null,
): Record<string, unknown> {
  const { start, end } = cfg.search.awardPointsRange
  return {
    awardPointsRange: { start, end },
    cppMin: cfg.search.cppMin,
    // Our enum keys ARE the source's program enum values (mapped the other way
    // to our enum on the way out). Explicit list — never a guess.
    mileagePrograms: Object.keys(cfg.hotelProgramMap),
    stayDateRange: { startDate: query.checkIn, endDate: query.checkOut },
    minNights,
    roomType: cfg.search.roomTypeEnum,          // server-dictated casing
    startCursorGT,
    sortBy: cfg.search.sortByEnum,              // server-dictated casing
    mapBoundInput: {
      bounding: { type: "Point", coordinates: bbox.center, bbox: bbox.bbox },
      enforce: true,
    },
  }
}

// ── Pure mapping (fixture-pinned in tests) ───────────────────────────────────

/** One offer period → one NormalizedHotelAward. Returns null when the row
 *  lacks the minimum source-stated fact (program, nights, points, startDate). */
export function mapRoameOffer(
  hotel: RoameHotelDetail,
  rooms: RoameAvailableRoom[],
  offer: RoameOfferPeriod,
  opts: { programMap: Record<string, string>; fetchedAt: string; lastUpdated: string | null },
): NormalizedHotelAward | null {
  const program = offer.mileageProgram ?? hotel.mileageProgram
  if (!program || offer.nights === null || offer.avgAwardPoints === null || !offer.startDate) return null

  const nights = offer.nights
  const checkIn = offer.startDate.slice(0, 10)
  const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)

  // Room name from the matching roomDetail; class from the offer's room type.
  const room = rooms.map(r => r.roomDetail).find(rd => rd && rd.roomCode && rd.roomCode === offer.roomCode) ?? null

  return {
    provider: "roame_hotels",
    providerPropertyRef: hotel.id,
    propertyId: null,                            // explicit refs only — never name-matched
    propertyName: hotel.name,
    chain: hotel.brand,
    program: opts.programMap[program] ?? program.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    sourceProgramName: program,
    checkIn,
    checkOut,
    nights,
    // avgAwardPoints is a PER-NIGHT average → per_night. A stay total is never
    // synthesized (that would be the forbidden avg × nights).
    quoteBasis: "per_night",
    roomClass: offer.roomType ?? room?.roomType ?? null,
    roomName: room?.roomName ?? null,
    pointsTotal: null,
    pointsPerNight: Math.round(offer.avgAwardPoints),
    // USD. A POSITIVE surcharge is stated; 0 or absent is unknown — a zero
    // average almost certainly means "not captured", not "no taxes".
    taxesFeesAmount: offer.avgSurchargeUsd !== null && offer.avgSurchargeUsd > 0 ? offer.avgSurchargeUsd : null,
    taxesFeesCurrency: offer.avgSurchargeUsd !== null && offer.avgSurchargeUsd > 0 ? "USD" : null,
    taxesFeesState: offer.avgSurchargeUsd !== null && offer.avgSurchargeUsd > 0 ? "stated" : "unknown",
    awardType: "points",
    cashComparisonAmount: offer.avgCashPriceUsd !== null && offer.avgCashPriceUsd > 0 ? offer.avgCashPriceUsd : null,
    cashComparisonCurrency: offer.avgCashPriceUsd !== null && offer.avgCashPriceUsd > 0 ? "USD" : null,
    // Roame offer periods are historical/period aggregates, NOT a live hold —
    // availabilityPercent is metadata, never a guarantee, so state stays unknown.
    availabilityState: "unknown",
    searchState: "complete",
    verificationLevel: "discovered",
    sourceFreshness: offer.createTime ?? opts.lastUpdated ?? null,
    bookingUrl: hotel.url ?? null,               // the source's real hotel URL, or null
    fetchedAt: opts.fetchedAt,
  }
}

export function mapEncorePage(
  page: RoameHotelAvailablePeriods,
  opts: { programMap: Record<string, string>; fetchedAt: string },
): NormalizedHotelAward[] {
  const out: NormalizedHotelAward[] = []
  for (const hotel of page.availableHotels ?? []) {
    if (!hotel.hotelDetail) continue
    const rooms = hotel.availableRooms ?? []
    for (const room of rooms) {
      for (const offer of room.offerPeriods ?? []) {
        const mapped = mapRoameOffer(hotel.hotelDetail, rooms, offer, { ...opts, lastUpdated: hotel.lastUpdated })
        if (mapped) out.push(mapped)
      }
    }
  }
  return out
}

// ── The provider ─────────────────────────────────────────────────────────────

const BLOCKED_STATUSES = new Set([403, 429, 503])

export class RoameHotelAwardsProvider implements HotelAwardProvider {
  readonly name = "roame_hotels"
  readonly capabilities: HotelAwardProviderCapabilities = {
    multiNightQuotes: true,        // each offer period states its own nights
    statesPointsPerNight: true,    // avgAwardPoints is a per-night figure
    statesTaxes: true,             // avgSurchargeUsd, when > 0
    statesRooms: true,             // roomDetail carries name/type
    dynamicPrograms: false,        // fixed hotel program set
    metered: false,
  }

  private readonly roame: RoameConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: HotelAwardsConfig = loadHotelAwardsConfig(), fetchImpl: typeof fetch = fetch) {
    if (!cfg.roame) throw new Error("config/hotel-awards.json is missing the roame block")
    this.roame = cfg.roame
    this.fetchImpl = fetchImpl
  }

  private credentials(): { session: string; csrfSecret: string } | null {
    try {
      const raw = fs.readFileSync(expandHome(process.env.HOTEL_AWARDS_ROAME_CREDS || this.roame.credentialsPath), "utf-8")
      const c = JSON.parse(raw) as { session?: string; csrfSecret?: string }
      return c.session ? { session: c.session, csrfSecret: c.csrfSecret ?? "" } : null
    } catch { return null }
  }

  /** Configured for a run when a session exists AND the location has an
   *  explicit bbox. isConfigured() answers the session half; the per-query
   *  bbox half is enforced in search(). */
  isConfigured(): boolean {
    return this.credentials() !== null
  }

  private async postPage(input: Record<string, unknown>, creds: { session: string; csrfSecret: string }):
    Promise<{ page?: RoameHotelAvailablePeriods; blocked?: number; error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.roame.timeoutMs)
    let resp: Response
    try {
      resp = await this.fetchImpl(this.roame.encoreUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `session=${creds.session}; csrfSecret=${creds.csrfSecret}` },
        body: JSON.stringify({ query: HOTEL_AVAILABLE_PERIODS_QUERY, variables: { input } }),
        signal: controller.signal,
      })
    } catch (err) {
      return { error: `Roame request failed: ${(err as Error).message}` }
    } finally {
      clearTimeout(timer)
    }
    if (resp.status === 401 || resp.status === 403) return { blocked: resp.status, error: `Roame HTTP ${resp.status} — session rejected` }
    if (BLOCKED_STATUSES.has(resp.status)) return { blocked: resp.status, error: `Roame HTTP ${resp.status} — throttled` }
    if (!resp.ok) return { error: `Roame HTTP ${resp.status}` }

    let body: { data?: { hotelAvailablePeriods?: RoameHotelAvailablePeriods }; errors?: { message: string }[] }
    try { body = await resp.json() as typeof body } catch { return { error: "Roame response was not JSON" } }
    if (body.errors?.length) {
      const msg = body.errors[0].message
      if (/auth|session|unauthor/i.test(msg)) return { blocked: 401, error: `Roame auth error: ${msg}` }
      return { error: `Roame GraphQL error: ${msg}` }
    }
    const page = body.data?.hotelAvailablePeriods
    if (!page) return { error: "Roame response missing hotelAvailablePeriods" }
    return { page }
  }

  async search(query: HotelAwardQuery): Promise<HotelAwardSearchResult> {
    const started = Date.now()
    const fetchedAt = new Date().toISOString()
    const nights = Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / 86_400_000)
    const fail = (reason: HotelAwardSearchResult["reason"], searchState: HotelAwardSearchResult["searchState"], error: string, callsSpent = 0): HotelAwardSearchResult =>
      ({ provider: this.name, ok: false, searchState, awards: [], reason, error, callsSpent, latencyMs: Date.now() - started })

    if (nights < 1) return fail("provider-error", "incomplete", `check-out must follow check-in (${query.checkIn}..${query.checkOut})`)

    // minNights is decoupled from the window length, but LIVE-VERIFIED
    // (2026-08-29): Encore echoes the EXACT requested window either way —
    // minNights only filters which hotels qualify; it never enumerates
    // shorter periods. Long-range coverage is the sparse window planner's
    // job (planner.ts), one exact sub-window query at a time.
    // Resolution: explicit query value → config default → the window length.
    const requestedMin = query.minNights ?? this.roame.search.defaultMinNights ?? nights
    if (!Number.isInteger(requestedMin) || requestedMin < 1) {
      return fail("provider-error", "incomplete", `minNights must be an integer ≥ 1 (got ${String(requestedMin)})`)
    }
    // The window length is a KNOWN cap — a segment cannot be longer than the
    // window. Only this real reduction may ever produce night_clamped.
    const minNights = Math.min(requestedMin, nights)
    const nightClamped = requestedMin > nights

    const creds = this.credentials()
    if (!creds) return fail("unconfigured", "blocked", `no Roame session at ${this.roame.credentialsPath} — sign in and save the session cookie`)

    // Location is an EXPLICIT configured bbox or nothing — never geocoded.
    const bbox = resolveBbox(this.roame, query.location)
    if (!bbox) {
      return fail("unconfigured", "incomplete",
        `no configured map bbox for location "${query.location}" — add it to config roame.locations; refusing to geocode or guess a bounding box`)
    }

    const awards: NormalizedHotelAward[] = []
    let callsSpent = 0
    let cursor: string | null = null
    let pagedOut = false
    for (let pageNum = 0; pageNum < Math.max(1, this.roame.search.maxPages); pageNum++) {
      const input = buildEncoreInput(this.roame, query, bbox, minNights, cursor)
      const out = await this.postPage(input, creds)
      callsSpent++
      if (out.error !== undefined && out.page === undefined) {
        if (out.blocked !== undefined) return fail("blocked", "blocked", out.error, callsSpent)
        return fail("provider-error", "incomplete", out.error, callsSpent)
      }
      const page = out.page!
      awards.push(...mapEncorePage(page, { programMap: this.roame.hotelProgramMap, fetchedAt }))
      if (page.hasMore && page.endCursor) {
        cursor = page.endCursor
        if (pageNum + 1 >= this.roame.search.maxPages) { pagedOut = true; break }
      } else {
        break
      }
    }

    if (awards.length === 0) {
      // A clamped-then-empty walk stays night_clamped — the clamp explains
      // why the request's own minimum was not what actually ran.
      return { provider: this.name, ok: true, searchState: nightClamped ? "night_clamped" : "empty", awards: [], callsSpent, latencyMs: Date.now() - started, appliedMinNights: minNights }
    }
    // A hard page cap that stopped mid-results is recorded honestly, and
    // outranks the clamp (missing results are the bigger truth); the clamp
    // itself stays visible via appliedMinNights vs the requested value.
    const searchState = pagedOut ? "incomplete" : nightClamped ? "night_clamped" : "complete"
    return { provider: this.name, ok: true, searchState, awards, callsSpent, latencyMs: Date.now() - started, appliedMinNights: minNights }
  }
}
