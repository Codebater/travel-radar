/**
 * Roame (roame.travel) — award availability across many programs in one search.
 *
 * Wraps the existing roame-scraper.ts rather than rewriting it: the GraphQL
 * client, polling loop and credential handling are unchanged. This file only
 * adapts its output to the NormalizedAwardFlight contract and adds the pieces
 * the provider layer needs — configuration checks, a health probe that never
 * touches the network, and honest failure results instead of thrown errors.
 *
 * Coverage note: which loyalty programs Roame returns is route-dependent and is
 * tracked in coverage.json with evidence, not assumed here.
 */

import fs from "fs"
import path from "path"
import os from "os"
import {
  searchRoame, buildProgramBookingUrl, type RoameFare,
} from "../../roame-scraper.js"
import { itineraryHash } from "../../cache/key.js"
import { findTransferPaths } from "../../transfer-partners.js"
import type {
  AwardFlightProvider, AwardFlightQuery, AwardSearchOptions, AwardSearchResult,
  CabinClass, NormalizedAwardFlight, ProviderHealth, TransferOption,
} from "./types.js"

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

const CREDENTIALS_PATH = path.join(homeDir(), ".openclaw", "credentials", "roame.json")

/** Roame program key → display name. Mirrors the scraper's map plus the keys
 *  actually observed in real responses (Roame says LIFEMILES, not AVIANCA). */
const PROGRAM_NAMES: Record<string, string> = {
  ALASKA: "Alaska Mileage Plan",
  UNITED: "United MileagePlus",
  AMERICAN: "AA AAdvantage",
  DELTA: "Delta SkyMiles",
  AEROPLAN: "Aeroplan",
  FLYING_BLUE: "Flying Blue",
  BRITISH_AIRWAYS: "BA Avios",
  QANTAS: "Qantas Frequent Flyer",
  EMIRATES: "Emirates Skywards",
  QATAR: "Qatar Privilege Club",
  SINGAPORE: "Singapore KrisFlyer",
  VIRGIN_ATLANTIC: "Virgin Atlantic Flying Club",
  VIRGIN_AUSTRALIA: "Velocity Frequent Flyer",
  LIFEMILES: "Avianca LifeMiles",
  AVIANCA: "Avianca LifeMiles",
  CATHAY: "Cathay Pacific Asia Miles",
  ETIHAD: "Etihad Guest",
  ANA: "ANA Mileage Club",
  JAL: "JAL Mileage Bank",
  JETBLUE: "JetBlue TrueBlue",
  // Keys Roame may use for programs it documents but this project has not yet
  // observed live (display names only — coverage claims live in coverage.json).
  //
  // LUFTHANSA is Roame's real identifier for Miles & More: the API rejects
  // "MILES_AND_MORE" as an invalid MileageProgram but accepts "LUFTHANSA".
  // Live probing on 2026-08-27 nonetheless returned ZERO Miles & More fares
  // under that key — see coverage.json.
  LUFTHANSA: "Lufthansa Miles & More",
  MILES_AND_MORE: "Lufthansa Miles & More",
  FINNAIR: "Finnair Plus",
  SAS: "SAS EuroBonus",
  TAP: "TAP Miles&Go",
  EVA: "EVA Infinity MileageLands",
  TURKISH: "Turkish Miles&Smiles",
  AER_LINGUS: "Aer Lingus AerClub",
  FRONTIER: "Frontier Miles",
  AEROMEXICO: "Aeromexico Rewards",
}

function guessCabin(cabinClasses: string[]): CabinClass {
  const joined = cabinClasses.join(" ").toLowerCase()
  if (joined.includes("first") || joined.includes("suites")) return "first"
  if (joined.includes("business") || joined.includes("polaris") || joined.includes("qsuites") || joined.includes("flagship")) return "business"
  if (joined.includes("premium")) return "premium_economy"
  return "economy"
}

function transferOptionsFor(programKey: string): TransferOption[] {
  return findTransferPaths(programKey).map(tp => ({
    from: tp.from,
    fromName: tp.fromName,
    ratio: tp.ratio,
    transferTime: tp.transferTime,
    ...(tp.bonus ? { bonus: tp.bonus } : {}),
  }))
}

export class RoameAwardProvider implements AwardFlightProvider {
  readonly name = "roame"
  readonly confidence = "high" as const   // live availability straight from program engines
  readonly callsPerSearch = 1             // one job per search class

  isEnabled(): boolean {
    return (process.env.ENABLE_ROAME ?? "true") !== "false"
  }

  isConfigured(): boolean {
    return this.isEnabled() && fs.existsSync(CREDENTIALS_PATH)
  }

  quota() {
    return null   // Roame documents no call quota
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    if (!this.isEnabled()) {
      return { provider: this.name, status: "unconfigured", detail: "disabled via ENABLE_ROAME=false", latencyMs: null, checkedAt, quota: null }
    }
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      return {
        provider: this.name, status: "unconfigured", latencyMs: null, checkedAt, quota: null,
        detail: `no session at ${CREDENTIALS_PATH} — log in at roame.travel and save the session cookie`,
      }
    }
    // Read the expiry from the file; deliberately no network call.
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"))
      if (creds.sessionExpiresAt && Date.now() > creds.sessionExpiresAt) {
        return {
          provider: this.name, status: "degraded", latencyMs: null, checkedAt, quota: null,
          detail: `session cookie expired ${new Date(creds.sessionExpiresAt).toISOString().slice(0, 10)} — log in at roame.travel again`,
        }
      }
      const expires = creds.sessionExpiresAt
        ? ` (session valid until ${new Date(creds.sessionExpiresAt).toISOString().slice(0, 10)})`
        : ""
      return { provider: this.name, status: "ok", detail: `session present${expires}`, latencyMs: null, checkedAt, quota: null }
    } catch (err) {
      return { provider: this.name, status: "error", detail: `credentials unreadable: ${(err as Error).message}`, latencyMs: null, checkedAt, quota: null }
    }
  }

  async search(query: AwardFlightQuery, options: AwardSearchOptions = {}): Promise<AwardSearchResult> {
    const started = Date.now()
    if (!this.isEnabled()) {
      return { provider: this.name, ok: false, flights: [], callsSpent: 0, latencyMs: 0, completionPct: null, reason: "unconfigured", error: "disabled via ENABLE_ROAME=false" }
    }

    // One clock reading for the whole search - see normalise().
    const fetchedAt = new Date().toISOString()
    const classes = query.searchClass === "both" ? ["ECON", "PREM"] : [query.searchClass]
    const flights: NormalizedAwardFlight[] = []
    let completion = 0
    let callsSpent = 0
    let lastError: string | null = null
    const failedClasses: string[] = []

    for (const cls of classes) {
      try {
        callsSpent++
        const result = await searchRoame(
          query.origin, query.destination, query.departureDate,
          cls, ["ALL"], false, query.flexDays || 0, options.signal,
        )
        completion += result.search.percentCompleted
        for (const fare of result.fares) flights.push(this.normalise(fare, query, fetchedAt))
      } catch (err) {
        lastError = (err as Error).message
        failedClasses.push(cls)
      }
    }

    const latencyMs = Date.now() - started
    const completionPct = Math.round(completion / classes.length)

    if (flights.length === 0 && lastError) {
      const unconfigured = lastError.includes("credentials not found") || lastError.includes("session expired") || lastError.includes("session rejected")
      return {
        provider: this.name, ok: false, flights: [], callsSpent, latencyMs, completionPct,
        reason: unconfigured ? "unconfigured" : lastError.includes("timed out") ? "timeout" : "provider-error",
        error: lastError,
      }
    }
    if (flights.length === 0) {
      return { provider: this.name, ok: false, flights: [], callsSpent, latencyMs, completionPct, reason: "no-results", error: "Roame returned no fares" }
    }
    // Some classes succeeded and some failed (e.g. ECON returned fares but the
    // PREM job died). ok:true so the fares are used, but flagged partial so the
    // orchestrator never caches a half-empty payload as a complete "both"
    // result — that would silently hide business/first availability for the
    // whole cache TTL.
    const partial = failedClasses.length > 0
    return {
      provider: this.name, ok: true, flights, callsSpent, latencyMs, completionPct,
      ...(partial ? { partial: true, error: `${failedClasses.join("/")} search failed: ${lastError}` } : {}),
    }
  }

  /**
   * Roame's request is (origin, destination, departureDate, class, flexDays).
   * The return date is never sent, so a search for the same outbound date with
   * a different trip length is the SAME request and must hit the same cache
   * entry — otherwise the observer's rotating trip lengths (7/10/14/21 nights)
   * turn one Roame search into four identical ones.
   */
  normalizeCacheQuery(query: AwardFlightQuery): AwardFlightQuery {
    return { ...query, returnDate: null }
  }

  private normalise(fare: RoameFare, query: AwardFlightQuery, fetchedAt: string): NormalizedAwardFlight {
    const cabin = guessCabin(fare.cabinClasses)
    const travelDate = fare.departureDateStr || fare.departureDate || query.departureDate
    const departureTime = fare.flightsDepartureDatetimes[0] || null
    const programKey = fare.mileageProgram

    return {
      itineraryHash: itineraryHash({
        origin: fare.originIata,
        destination: fare.destinationIata,
        departureDate: travelDate,
        departureTime,
        arrivalTime: fare.arrivalDatetime,
        // NOT query.returnDate — see the returnDate field below.
        returnDate: null,
        cabin,
        airlines: fare.operatingAirlines,
        stops: fare.numStops,
        durationMinutes: fare.durationMinutes,
      }),
      origin: fare.originIata,
      destination: fare.destinationIata,
      departureDate: travelDate,
      departureTime,
      arrivalTime: fare.arrivalDatetime || null,
      // A Roame award fare is ONE-WAY. searchRoame() is called with origin,
      // destination and a single date — there is no return leg in the request —
      // and every booking URL this project builds for those programs says so
      // (tripType=ONE_WAY / O / OW / one-way). Stamping the SEARCH's return
      // date here made a one-way price look like a round-trip one, which
      // matters now that the anomaly engine refuses to compare one-way with
      // return: identical one-way fares were landing in two separate baselines
      // depending on whether the search that found them had a return date, and
      // a genuine round-trip source would later have been compared against
      // them at roughly half the price.
      returnDate: null,
      // Roame reports operating carriers; the marketing carrier is not exposed.
      airline: null,
      operatingAirlines: fare.operatingAirlines,
      flightNumbers: fare.flightNumberOrder,
      stops: fare.numStops,
      durationMinutes: fare.durationMinutes || null,
      airports: fare.allAirports,
      cabin,
      equipment: fare.equipmentTypes,
      loyaltyProgram: programKey,
      loyaltyProgramName: PROGRAM_NAMES[programKey] || programKey,
      points: fare.awardPoints,
      taxes: { amount: fare.surcharge, currency: "USD" },
      availableSeats: fare.availableSeats,
      transferOptions: transferOptionsFor(programKey),
      bookingUrl: buildProgramBookingUrl(programKey, fare.originIata, fare.destinationIata, travelDate, cabin),
      provider: this.name,
      // Stamped ONCE per search, not per fare. Everything downstream treats
      // fetched_at as the identity of a fetch: the anomaly baseline excludes
      // an observation's own batch with `fetched_at < asOf`, and a per-row
      // clock makes rows from one search milliseconds apart, so the earlier
      // ones become "prior history" for the later ones. That manufactured a
      // NEW_OBSERVED_LOW candidate out of a single search's internal spread.
      fetchedAt,
      verificationLevel: "discovered",
      providerConfidence: this.confidence,
      providerScore: fare.roameScore ?? null,
      raw: { fareClass: fare.fareClass, percentPremiumInt: fare.percentPremiumInt, cabinClasses: fare.cabinClasses },
    }
  }
}
