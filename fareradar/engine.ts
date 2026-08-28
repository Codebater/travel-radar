/**
 * The fare-radar engine: plan → sparse discovery → refine promising cells →
 * candidates with honest cabin labels, quality flags, deterministic scores
 * and Phase-8i offer locators. FREE provider only — the metered tier is
 * structurally unreachable (allowMeteredFallback:false on every search).
 */

import { nowIso, type DB } from "../db/index.js"
import { recordSearchRequest } from "../db/repositories.js"
import { searchCashFlights, type CashSearchOutcome } from "../providers/cash-flights/index.js"
import type { CabinClass, CashFlightQuery, NormalizedCashFlight } from "../providers/cash-flights/types.js"
import { buildFlightLocator, locatorForSource, upsertLocator, type FlightPriceRow } from "../offers/locators.js"
import { recordVerification, type RecheckResult } from "../offers/recheck.js"
import {
  anywhereDestinations,
  homeAirports,
  loadFareRadarConfig,
  watchlist,
  type FareRadarConfig,
} from "./config.js"
import {
  buildSearchPlan,
  refinementProbes,
  shiftDate,
  type RefinementCell,
  type SearchPlan,
  type SparseProbe,
} from "./planner.js"
import { assessQuality, classifyCabinMix, scoreCandidate } from "./score.js"
import {
  candidatesForRun,
  createFareRadarRun,
  finishFareRadarRun,
  insertFareCandidates,
  type FareCandidateInput,
  type StoredFareCandidate,
} from "./store.js"

export type SearchFn = (
  query: CashFlightQuery,
  options: { source: "cli" | "api" | "test"; allowMeteredFallback: false; searchRequestId?: number; forceRefresh?: boolean; db?: DB },
) => Promise<CashSearchOutcome>

export interface EngineDeps {
  search?: SearchFn
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface FareRadarParams {
  origins?: string[]
  destination?: string
  watchlistName?: string
  anywhere?: boolean
  nextDays?: number
  windowStart?: string
  minNights?: number
  maxNights?: number
  cabin?: CabinClass
  adults?: number
  maxSearches?: number
  includeExtended?: boolean
  source?: "cli" | "api" | "test"
}

export interface FareRadarSummary {
  runId: number
  plan: SearchPlan
  destinationMode: string
  searchesIssued: number
  callsSpent: number
  candidatesStored: number
  droppedByQuality: Record<string, number>
  cheapest: StoredFareCandidate[]
  bestValue: StoredFareCandidate[]
}

interface Collected {
  flight: NormalizedCashFlight
  searchRequestId: number
  fromProbe: SparseProbe
}

export async function runFareRadar(db: DB, params: FareRadarParams = {}, deps: EngineDeps = {}): Promise<FareRadarSummary> {
  const cfg = loadFareRadarConfig()
  const search = deps.search ?? (searchCashFlights as unknown as SearchFn)
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const log = deps.log ?? (line => console.log(line))

  const origins = params.origins?.length ? params.origins.map(o => o.toUpperCase()) : homeAirports(cfg, params.includeExtended)
  const { destinations, destinationMode } = resolveDestinations(cfg, params)
  const cabin: CabinClass = params.cabin ?? "business"
  const adults = params.adults ?? 1
  const windowStart = params.windowStart ?? shiftDate(new Date().toISOString().slice(0, 10), 1)
  const windowEnd = shiftDate(windowStart, (params.nextDays ?? cfg.window.defaultNextDays) - 1)
  const minNights = params.minNights ?? cfg.window.minNights
  const maxNights = params.maxNights ?? cfg.window.maxNights

  const plan = buildSearchPlan(cfg, {
    origins, destinations, windowStart, windowEnd, minNights, maxNights,
    maxSearches: params.maxSearches,
  })
  for (const line of plan.lines) log(line)

  const runId = createFareRadarRun(db, {
    origins, destinations: plan.destinations, destinationMode,
    windowStart, windowEnd, minNights, maxNights,
    cabin, adults, currency: cfg.budget.currency,
    plan: { lines: plan.lines, reductions: plan.reductions, sparseCalls: plan.sparseCalls, refineReserve: plan.refineReserve, confirmReserve: plan.confirmReserve, cap: plan.cap },
    callsPlanned: plan.callsPlanned,
    source: params.source ?? "cli",
  })

  const collected: Collected[] = []
  let searchesIssued = 0
  let callsSpent = 0

  const issue = async (probe: SparseProbe, forceRefresh = false): Promise<void> => {
    const query: CashFlightQuery = {
      origin: probe.origin, destination: probe.destination,
      departureDate: probe.departureDate,
      returnDate: shiftDate(probe.departureDate, probe.nights),
      cabin, adults, currency: cfg.budget.currency,
    }
    const searchRequestId = recordSearchRequest(db, query, params.source === "api" ? "api" : "cli")
    const outcome = await search(query, {
      source: params.source === "api" ? "api" : "cli",
      allowMeteredFallback: false,        // the metered tier is NEVER touched
      searchRequestId, forceRefresh, db,
    })
    searchesIssued++
    callsSpent += outcome.callsSpent
    for (const flight of outcome.flights) collected.push({ flight, searchRequestId, fromProbe: probe })
    if (!outcome.fromCache) await sleep(1200)   // politeness toward the free provider
  }

  // ── Tier 0: sparse discovery ──────────────────────────────────────────────
  for (const probe of plan.sparse) await issue(probe)

  // ── Tier 1: refine the most promising cells ───────────────────────────────
  const cells = promisingCells(collected, cabin).slice(0, cfg.budget.refineTopCells)
  const refines = refinementProbes(cfg, plan, cells)
  log(`Refinement: ${cells.length} promising cells → ${refines.length} probes`)
  for (const probe of refines) {
    if (searchesIssued >= plan.callsPlanned - plan.confirmReserve) {
      log(`  refinement stopped at the budget line (${searchesIssued} searches issued)`)
      break
    }
    await issue(probe)
  }

  // ── Candidates: dedupe, classify, flag, score, locate ─────────────────────
  const droppedByQuality: Record<string, number> = {}
  const deduped = dedupe(collected)
  const enriched = deduped.flatMap(entry => {
    const quality = assessQuality(entry.flight, cfg)
    if (quality.dropped) {
      droppedByQuality[quality.dropped] = (droppedByQuality[quality.dropped] ?? 0) + 1
      return []
    }
    return [{ ...entry, quality, cabinMix: classifyCabinMix(entry.flight, cabin) }]
  })

  const businessFamily = enriched.filter(e => e.cabinMix.mix.startsWith("BUSINESS"))
  const cheapestQualifying = businessFamily.length
    ? Math.min(...businessFamily.map(e => e.flight.price.amount))
    : enriched.length ? Math.min(...enriched.map(e => e.flight.price.amount)) : 0

  const candidates: FareCandidateInput[] = []
  for (const entry of enriched.slice(0, 200)) {
    const f = entry.flight
    const returnDate = f.returnDate ?? shiftDate(f.departureDate, entry.fromProbe.nights)
    const nights = Math.round((Date.parse(returnDate) - Date.parse(f.departureDate)) / 86_400_000)
    const scored = scoreCandidate(
      f.price.amount, cheapestQualifying, entry.cabinMix.mix,
      f.stops, f.durationMinutes, entry.quality.flags, cfg,
    )
    const priceRow = flightPriceRowFor(db, f, entry.searchRequestId)
    let locatorId: number | null = null
    if (priceRow) {
      upsertLocator(db, buildFlightLocator(priceRow))
      locatorId = locatorForSource(db, "flight_prices", priceRow.id)?.id ?? null
    }
    candidates.push({
      runId,
      flightPriceId: priceRow?.id ?? null,
      itineraryHash: f.itineraryHash,
      origin: f.origin, destination: f.destination,
      departureDate: f.departureDate, returnDate, nights, adults,
      cabin, cabinMix: entry.cabinMix.mix, cabinMixDetail: entry.cabinMix.detail,
      airline: f.airline, airlines: f.airlines, stops: f.stops,
      durationMinutes: f.durationMinutes,
      qualityFlags: entry.quality.flags,
      priceAmount: f.price.amount, priceCurrency: f.price.currency,
      dealScore: scored.dealScore, scoreBreakdown: scored.breakdown,
      provider: f.provider,
      locatorId,
      observedAt: f.fetchedAt,
    })
  }
  insertFareCandidates(db, candidates)
  finishFareRadarRun(db, runId, { callsSpent, searchesIssued, candidatesFound: candidates.length })
  log(`Run #${runId}: ${searchesIssued} searches (${callsSpent} billable calls — expected 0), ${candidates.length} candidates` +
    (Object.keys(droppedByQuality).length ? `, dropped: ${JSON.stringify(droppedByQuality)}` : ""))

  const stored = candidatesForRun(db, runId)
  return {
    runId, plan, destinationMode, searchesIssued, callsSpent,
    candidatesStored: stored.length, droppedByQuality,
    cheapest: stored.slice(0, 10),
    bestValue: [...stored].sort((a, b) => b.dealScore - a.dealScore || a.priceAmount - b.priceAmount).slice(0, 10),
  }
}

function resolveDestinations(cfg: FareRadarConfig, params: FareRadarParams): { destinations: string[]; destinationMode: string } {
  if (params.destination) return { destinations: [params.destination.toUpperCase()], destinationMode: "specific" }
  if (params.watchlistName) {
    const list = watchlist(cfg, params.watchlistName)
    if (!list) throw new Error(`unknown watchlist "${params.watchlistName}" — configured: ${Object.keys(cfg.watchlists).filter(k => Array.isArray(cfg.watchlists[k])).join(", ")}`)
    return { destinations: list, destinationMode: `watchlist:${params.watchlistName}` }
  }
  if (params.anywhere) return { destinations: anywhereDestinations(cfg), destinationMode: "anywhere" }
  throw new Error("a destination, --watchlist or --anywhere is required")
}

/** Cheapest business-family result per (route, probe date), cheapest first. */
function promisingCells(collected: Collected[], requested: string): RefinementCell[] {
  const byCell = new Map<string, RefinementCell>()
  for (const entry of collected) {
    if (entry.flight.cabin !== requested) continue
    const key = `${entry.fromProbe.origin}|${entry.fromProbe.destination}|${entry.fromProbe.departureDate}`
    const price = entry.flight.price.amount
    const existing = byCell.get(key)
    if (!existing || price < existing.cheapestObserved) {
      byCell.set(key, {
        origin: entry.fromProbe.origin, destination: entry.fromProbe.destination,
        departureDate: entry.fromProbe.departureDate, cheapestObserved: price,
      })
    }
  }
  return [...byCell.values()].sort((a, b) => a.cheapestObserved - b.cheapestObserved)
}

/** One candidate per (route, dates, airline set): the cheapest sighting. */
function dedupe(collected: Collected[]): Collected[] {
  const best = new Map<string, Collected>()
  for (const entry of collected) {
    const f = entry.flight
    const key = [f.origin, f.destination, f.departureDate, f.returnDate ?? "-", f.airlines.join("+") || f.airline || "?", f.stops ?? "?"].join("|")
    const existing = best.get(key)
    if (!existing || f.price.amount < existing.flight.price.amount) best.set(key, entry)
  }
  return [...best.values()].sort((a, b) => a.flight.price.amount - b.flight.price.amount)
}

function flightPriceRowFor(db: DB, flight: NormalizedCashFlight, searchRequestId: number): FlightPriceRow | null {
  const bySearch = db.prepare(`
    SELECT id, provider, airline, flight_numbers, origin, destination, departure_date,
           return_date, cabin, adults, price_amount, price_currency, booking_url, fetched_at
    FROM flight_prices
    WHERE search_request_id = ? AND itinerary_hash = ?
    ORDER BY id DESC LIMIT 1
  `).get(searchRequestId, flight.itineraryHash) as FlightPriceRow | undefined
  if (bySearch) return bySearch
  // Cache-served itineraries were persisted by an EARLIER search — link the
  // newest historical row for the same itinerary instead of re-recording.
  const byHash = db.prepare(`
    SELECT id, provider, airline, flight_numbers, origin, destination, departure_date,
           return_date, cabin, adults, price_amount, price_currency, booking_url, fetched_at
    FROM flight_prices
    WHERE itinerary_hash = ?
    ORDER BY id DESC LIMIT 1
  `).get(flight.itineraryHash) as FlightPriceRow | undefined
  return byHash ?? null
}

// ── Recheck finalists (Phase-8i verification, fare-radar flavored) ───────────

export interface FinalistRecheck {
  candidateId: number
  status: "verified" | "changed" | "unavailable"
  observedPrice: number
  currentPrice: number | null
  currency: string
  detail: string
}

export async function recheckTopFares(
  db: DB, runId: number, topN: number, deps: EngineDeps = {},
): Promise<FinalistRecheck[]> {
  const cfg = loadFareRadarConfig()
  const search = deps.search ?? (searchCashFlights as unknown as SearchFn)
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const finalists = candidatesForRun(db, runId).slice(0, Math.min(topN, cfg.budget.confirmFinalists))
  const results: FinalistRecheck[] = []

  for (const candidate of finalists) {
    const query: CashFlightQuery = {
      origin: candidate.origin, destination: candidate.destination,
      departureDate: candidate.departureDate, returnDate: candidate.returnDate,
      cabin: candidate.cabin as CabinClass, adults: candidate.adults,
      currency: candidate.priceCurrency,
    }
    const searchRequestId = recordSearchRequest(db, query, "cli")
    const outcome = await search(query, {
      source: "cli", allowMeteredFallback: false, searchRequestId, forceRefresh: true, db,
    })
    const match = outcome.flights
      .filter(f => (f.airline ?? f.airlines[0] ?? null) === candidate.airline && f.stops === candidate.stops)
      .sort((a, b) => a.price.amount - b.price.amount)[0]
      ?? null

    const result: FinalistRecheck = match
      ? {
          candidateId: candidate.id,
          status: match.price.amount === candidate.priceAmount ? "verified" : "changed",
          observedPrice: candidate.priceAmount,
          currentPrice: match.price.amount,
          currency: candidate.priceCurrency,
          detail: match.price.amount === candidate.priceAmount
            ? "fare re-resolved at the observed price"
            : `fare moved: ${candidate.priceAmount} → ${match.price.amount} ${candidate.priceCurrency}`,
        }
      : {
          candidateId: candidate.id,
          status: "unavailable",
          observedPrice: candidate.priceAmount,
          currentPrice: null,
          currency: candidate.priceCurrency,
          detail: `no ${candidate.airline ?? "?"} itinerary with ${candidate.stops ?? "?"} stop(s) on these dates any more — historical observation stands`,
        }
    results.push(result)

    // Persist through the 8i verification trail when a locator exists.
    if (candidate.locatorId !== null) {
      const verification: RecheckResult = {
        locatorId: candidate.locatorId,
        status: result.status,
        observedPrice: result.observedPrice,
        observedCurrency: result.currency,
        currentPrice: result.currentPrice,
        currentCurrency: result.currentPrice !== null ? result.currency : null,
        changes: result.status === "changed"
          ? [{ dimension: "price", observed: result.observedPrice, current: result.currentPrice }]
          : [],
        newObservationIds: [],
        detail: result.detail,
        checkedAt: nowIso(),
      }
      recordVerification(db, verification)
    }
    if (!outcome.fromCache) await sleep(1200)
  }
  return results
}
