#!/usr/bin/env tsx
/**
 * Unified Flight Search Orchestrator
 * 
 * Runs multiple search sources in parallel and outputs a unified results.json
 * that the dashboard can load.
 * 
 * Sources:
 *   - Roame (award flights across ALL programs) ✅
 *   - AA direct scraper (detailed fare data, backup) ✅  
 *   - Google Flights via fast_flights (primary, no API key) ✅ → SerpAPI fallback
 *   - Hidden city engine (positioning/savings) ✅
 * 
 * Usage:
 *   npx tsx search.ts --from LAX --to DXB --date 2026-04-28
 *   npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --return 2026-05-04 --class both
 */

import "./load-env.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { UnifiedFlightResult } from "./roame-scraper.js"
import { scoreFlights, type ValueScoredFlight, type ValueInsight } from "./value-engine.ts"
import { getSweetSpotsForRoute } from "./sweet-spots.ts"
import { searchCashFlights } from "./providers/cash-flights/index.js"
import type { NormalizedCashFlight, CabinClass } from "./providers/cash-flights/index.js"
import { searchAwardFlights, type NormalizedAwardFlight, type AwardProviderOutcome } from "./providers/award-flights/index.js"
import { searchHiddenCity as searchHiddenCityEngine, type HiddenCityOpportunity } from "./providers/cash-flights/hidden-city.js"
import { getBalances, type PointsBalance } from "./providers/balances/index.js"
import { buildRedemptionComparisons, type RedemptionComparison } from "./value-compare.js"
import { getDb } from "./db/index.js"
import { recordSearchRequest, saveSearchResult } from "./db/repositories.js"

// .env is loaded by the shared side-effect module so every entry point sees it.
const ROOT = path.dirname(fileURLToPath(import.meta.url))

// ─── Types ───────────────────────────────────────────────────────────────────

interface SearchConfig {
  origin: string
  destination: string
  departureDate: string
  returnDate?: string
  searchClass: "ECON" | "PREM" | "both"
  sources: string[]
  output: string
  verbose: boolean
  flexDays?: number   // 0, 1, or 2 — passed to Roame's daysAround
  /** Bypass the cash cache and refetch. */
  forceRefresh?: boolean
  /** A person asked for this, so the metered reserve may be spent. */
  userInitiated?: boolean
  /** Ask the metered provider to confirm the free provider's prices. */
  verifyPrices?: boolean
  source?: "api" | "cli" | "test"
  /**
   * Persist the payload to search_results (default true). serve.ts sets false
   * for the internal return-leg search of a round trip: only the MERGED
   * outbound+return payload may become the "latest result", never the
   * reversed return leg on its own.
   */
  persistResults?: boolean
}

interface DashboardResults {
  meta: {
    origin: string
    destination: string
    departureDate: string
    returnDate: string | null
    searchedAt: string
    sources: string[]
    completionPct: Record<string, number>
    totalFlights?: number     // set by serve.ts when outbound + return are merged
    /** The unified search_requests row this payload belongs to. serve.ts uses
     *  it to persist the MERGED outbound+return payload over the outbound row,
     *  so the dashboard's "latest result" is never just the reversed return leg. */
    searchRequestId?: number | null
  }
  balances: PointsBalance[]
  /** Where the balances came from and how old they are (never the values themselves in logs). */
  balancesMeta?: { source: string; fetchedAt: string | null; ageMinutes: number | null }
  flights: ValueScoredFlight[]
  recommendations: Recommendation[]
  insights: ValueInsight[]
  routeSweetSpots: { program: string; cabin: string; maxPoints: number; description: string }[]
  /** Same-flight-different-program comparisons — see value-compare.ts. */
  redemptionComparisons?: RedemptionComparison[]
  /** Per-award-provider outcome (cache age, calls spent, errors). */
  awardProviders?: AwardProviderOutcome[]
  warnings: string[]
}

interface Recommendation {
  rank: number
  title: string
  subtitle: string
  details: string[]
  totalCost: string
  cppValue: string | null
  bookingUrl: string
  badgeText: string
  badgeColor: "emerald" | "accent" | "gold"
}

// ─── Points Balances ─────────────────────────────────────────────────────────
// Balances come from providers/balances: AwardWallet behind a 12h snapshot
// cache (LOYALTY_BALANCE_TTL_HOURS). A search does not refetch them; an
// explicit refresh does.

function formatBalance(n: number): string {
  return n.toLocaleString()
}

// ─── Award Flights (provider abstraction) ─────────────────────────────────
//
// Roame, ATF and the cross-verification logic all live behind
// providers/award-flights. This adapter converts NormalizedAwardFlight back
// into the UnifiedFlightResult shape the value engine and dashboard expect.

function awardToUnified(f: NormalizedAwardFlight, idx: number, cacheAgeMinutes: number | null): UnifiedFlightResult {
  return {
    id: `award-${f.provider}-${f.loyaltyProgram}-${idx}`,
    source: f.provider === "atf" ? "atf" : "roame",
    type: "award",
    tags: f.verificationLevel === "cross-verified" ? ["cross-verified"] : undefined,
    origin: f.origin,
    destination: f.destination,
    airline: f.airline || f.operatingAirlines.join(" / ") || "Unknown",
    operatingAirlines: f.operatingAirlines,
    flightNumbers: f.flightNumbers,
    stops: f.stops ?? 0,
    durationMinutes: f.durationMinutes ?? 0,
    departureTime: f.departureTime || f.departureDate,
    arrivalTime: f.arrivalTime || f.departureDate,
    airports: f.airports,
    cabinClass: f.cabin,
    equipment: f.equipment,
    points: f.points,
    pointsProgram: f.loyaltyProgram,
    cashPrice: null,
    taxes: f.taxes?.amount ?? 0,
    currency: f.taxes?.currency ?? "USD",
    cppValue: null,
    roameScore: f.providerScore,
    availableSeats: f.availableSeats,
    bookingUrl: f.bookingUrl,
    fareClass: typeof f.raw?.fareClass === "string" ? f.raw.fareClass : "",
    travelDate: f.departureDate,
    provider: f.provider,
    verificationLevel: f.verificationLevel,
    providerConfidence: f.providerConfidence,
    fetchedAt: f.fetchedAt,
    cacheAgeMinutes,
    itineraryHash: f.itineraryHash,
    loyaltyProgramName: f.loyaltyProgramName,
  }
}

async function searchAwardSource(
  config: SearchConfig,
  providerFilter: string[],
  searchRequestId: number | null,
): Promise<{ flights: UnifiedFlightResult[]; completionPct: Record<string, number>; outcome: AwardProviderOutcome[]; warnings: string[] }> {
  const outcome = await searchAwardFlights({
    origin: config.origin,
    destination: config.destination,
    departureDate: config.departureDate,
    returnDate: config.returnDate || null,
    searchClass: config.searchClass,
    adults: 1,
    flexDays: config.flexDays || 0,
  }, {
    providers: providerFilter,
    forceRefresh: config.forceRefresh,
    searchRequestId,
  })

  const completionPct: Record<string, number> = {}
  for (const p of outcome.perProvider) {
    completionPct[p.provider] = p.ok ? (p.completionPct ?? 100) : 0
  }

  const cacheAgeByProvider = new Map(outcome.perProvider.map(p => [p.provider, p.cacheAgeMinutes]))
  const flights = outcome.flights.map((f, i) =>
    awardToUnified(f, i, cacheAgeByProvider.get(f.provider) ?? null))

  if (outcome.crossVerifiedCount > 0) {
    console.log(`  🔗 Cross-verified: ${outcome.crossVerifiedCount} redemptions confirmed by two providers`)
  }

  return { flights, completionPct, outcome: outcome.perProvider, warnings: outcome.warnings }
}

// ─── Cash Flights (provider abstraction) ──────────────────────────────────
//
// Phase 2 moved every cash-price concern behind providers/cash-flights:
// provider selection, the cache, the price history and the SerpAPI budget all
// live there. This function only adapts the normalised result back into the
// UnifiedFlightResult shape that the value engine and dashboard already expect.

/** Currency the cash providers are asked for. The value engine compares cash
 *  against award taxes without conversion, so this stays USD unless overridden. */
const CASH_CURRENCY = process.env.CASH_CURRENCY || "USD"

function toUnified(f: NormalizedCashFlight, idx: number, cacheAgeMinutes: number | null): UnifiedFlightResult {
  return {
    id: `cash-${f.provider}-${idx}`,
    source: "google",
    type: "cash",
    origin: f.origin,
    destination: f.destination,
    airline: f.airlines.join(" / ") || f.airline || "Unknown",
    operatingAirlines: f.airlines,
    flightNumbers: f.flightNumbers,
    stops: f.stops ?? 0,
    durationMinutes: f.durationMinutes ?? 0,
    departureTime: f.departureTime || "",
    arrivalTime: f.arrivalTime || "",
    airports: f.segments.length
      ? [f.segments[0]!.origin, ...f.segments.slice(1).map(s => s.origin), f.segments[f.segments.length - 1]!.destination]
      : [f.origin, f.destination],
    cabinClass: f.cabin,
    equipment: f.segments.map(s => s.aircraft || "").filter(Boolean),
    points: null,
    pointsProgram: null,
    cashPrice: f.price.amount,
    taxes: f.taxes?.amount ?? 0,
    currency: f.price.currency,
    cppValue: null,
    roameScore: null,
    availableSeats: null,
    bookingUrl: f.bookingUrl,
    fareClass: f.priceLevel ? `price-level:${f.priceLevel}` : "",
    travelDate: f.departureDate,
    // Phase 2 freshness metadata — consumed by the dashboard badge.
    provider: f.provider,
    verificationLevel: f.verificationLevel,
    providerConfidence: f.providerConfidence,
    fetchedAt: f.fetchedAt,
    cacheAgeMinutes,
  }
}

async function searchCashSource(
  config: SearchConfig,
  searchRequestId: number | null = null,
): Promise<{ flights: UnifiedFlightResult[]; completion: number; warnings: string[] }> {
  const cabins: CabinClass[] = config.searchClass === "both"
    ? ["economy", "business"]
    : config.searchClass === "PREM" ? ["business"] : ["economy"]

  const flights: UnifiedFlightResult[] = []
  const warnings: string[] = []
  let anySucceeded = false

  for (const cabin of cabins) {
    const outcome = await searchCashFlights({
      origin: config.origin,
      destination: config.destination,
      departureDate: config.departureDate,
      returnDate: config.returnDate || null,
      cabin,
      adults: 1,
      currency: CASH_CURRENCY,
    }, {
      source: config.source ?? "cli",
      forceRefresh: config.forceRefresh,
      userInitiated: config.userInitiated,
      verify: config.verifyPrices,
      searchRequestId: searchRequestId ?? undefined,
    })

    if (outcome.flights.length > 0) anySucceeded = true
    warnings.push(...outcome.warnings)
    for (const f of outcome.flights) {
      flights.push(toUnified(f, flights.length, outcome.cacheAgeMinutes))
    }
  }

  return { flights, completion: anySucceeded ? 100 : 0, warnings }
}

// ─── Hidden City Engine ──────────────────────────────────────────────────────
//
// Phase 3: the engine lives in providers/cash-flights/hidden-city.ts and gets
// every price through searchCashFlights — cash cache, SerpAPI budget guard,
// reserve and provider_usage all apply. The old Python path called SerpAPI
// directly with its own counter and is no longer wired into the application.

function hiddenCityToUnified(r: HiddenCityOpportunity, i: number, searchDate: string): UnifiedFlightResult {
  return {
    id: `hidden-city-${i}`,
    source: "hidden-city",
    type: "cash",
    origin: r.origin,
    destination: r.realDestination,
    airline: r.airlines.join(" / ") || "Various",
    operatingAirlines: r.airlines.length ? r.airlines : ["Various"],
    flightNumbers: r.flightNumbers,
    stops: r.stops,
    durationMinutes: r.totalDurationMinutes ?? 0,
    departureTime: r.departureTime || "",
    arrivalTime: r.arrivalAtLayover || "",
    airports: [r.origin, r.realDestination, r.ticketedDestination],
    cabinClass: "economy",
    equipment: [],
    points: null,
    pointsProgram: null,
    cashPrice: r.hiddenCityPrice,
    taxes: 0,
    currency: r.currency,
    cppValue: null,
    roameScore: null,
    availableSeats: null,
    bookingUrl: r.bookingUrl,
    // Legacy encoding kept for the dashboard card; structured fields carry the truth.
    fareClass: `hidden-city:${r.ticketedDestination}|saves:$${Math.round(r.savings)}(${r.savingsPercent}%)|risk:${r.riskLevel}|direct:$${r.directPrice}`,
    travelDate: searchDate,
    hiddenCity: true,
    hiddenCityWarnings: r.warnings,
    hiddenCityRisk: r.riskLevel,
    provider: r.provider,
  }
}

async function searchHiddenCity(
  config: SearchConfig,
  searchRequestId: number | null,
): Promise<{ flights: UnifiedFlightResult[]; completion: number }> {
  try {
    const outcome = await searchHiddenCityEngine({
      origin: config.origin,
      destination: config.destination,
      departureDate: config.departureDate,
      currency: CASH_CURRENCY,
    }, {
      source: config.source ?? "cli",
      forceRefresh: config.forceRefresh,
      userInitiated: config.userInitiated,
      searchRequestId: searchRequestId ?? undefined,
    })
    for (const note of outcome.notes) console.log(`  hidden-city: ${note}`)
    const flights = outcome.opportunities.map((r, i) => hiddenCityToUnified(r, i, config.departureDate))
    return { flights, completion: outcome.opportunities.length > 0 ? 100 : 0 }
  } catch (err) {
    console.warn("⚠️ Hidden city search failed:", (err as Error).message?.slice(0, 200))
    return { flights: [], completion: 0 }
  }
}

// ─── Recommendation Engine ───────────────────────────────────────────────────

function generateRecommendations(
  flights: ValueScoredFlight[],
  balances: PointsBalance[],
  config: SearchConfig
): Recommendation[] {
  const recommendations: Recommendation[] = []
  
  // #1: Best value award (highest real CPP that's affordable)
  const bestValueAwards = flights
    .filter(f => f.type === "award" && f.realCpp !== null && f.realCpp > 0 && f.canAfford)
    .sort((a, b) => (b.realCpp || 0) - (a.realCpp || 0))
  
  if (bestValueAwards.length > 0) {
    const best = bestValueAwards[0]!
    const cppLabel = best.cashSource === "exact-match" ? "(vs actual cash)" : 
                     best.cashSource === "same-cabin" ? "(vs avg cash)" : "(est.)"
    const sweetSpotTag = best.sweetSpotMatch ? " 🎯 SWEET SPOT" : ""
    
    recommendations.push({
      rank: 1,
      title: `${best.pointsProgram} → ${best.airline}${sweetSpotTag}`,
      subtitle: `${best.cabinClass} class via ${best.airports.join("→")}`,
      details: [
        `✈️ ${best.flightNumbers.join(" / ")}`,
        `⏱ ${Math.floor(best.durationMinutes / 60)}h${best.durationMinutes % 60}m, ${best.stops} stop${best.stops !== 1 ? "s" : ""}`,
        `💰 Cash comparable: $${best.cashComparable?.toLocaleString()} ${cppLabel}`,
        `✅ ${best.affordDetails}`,
        ...(best.sweetSpotMatch ? [`🎯 ${best.sweetSpotMatch.spot.description.slice(0, 80)}`] : []),
      ],
      totalCost: `${formatBalance(best.points || 0)} pts + $${best.taxes}`,
      cppValue: `${best.realCpp}¢/pt`,
      bookingUrl: best.bookingUrl,
      badgeText: "#1 BEST VALUE",
      badgeColor: "emerald",
    })
  }
  
  // #2: Best product (business/first with best combo of roame score + value)
  const premiumFlights = flights
    .filter(f => f.type === "award" && (f.cabinClass === "business" || f.cabinClass === "first") && f.canAfford)
    .sort((a, b) => b.valueScore - a.valueScore)
  
  const alreadyUsed = bestValueAwards[0]?.id
  const bestPremium = premiumFlights.find(f => f.id !== alreadyUsed)
  
  if (bestPremium) {
    recommendations.push({
      rank: 2,
      title: `${bestPremium.pointsProgram} → ${bestPremium.airline}`,
      subtitle: `${bestPremium.cabinClass} class • ${bestPremium.airports.join("→")}`,
      details: [
        `✈️ ${bestPremium.flightNumbers.join(" / ")}`,
        `🏆 Value Score: ${bestPremium.valueScore}/100`,
        bestPremium.realCpp ? `📊 ${bestPremium.realCpp}¢/pt vs $${bestPremium.cashComparable?.toLocaleString()} cash` : "",
        `⏱ ${Math.floor(bestPremium.durationMinutes / 60)}h${bestPremium.durationMinutes % 60}m`,
      ].filter(Boolean),
      totalCost: `${formatBalance(bestPremium.points || 0)} pts + $${bestPremium.taxes}`,
      cppValue: bestPremium.realCpp ? `${bestPremium.realCpp}¢/pt` : null,
      bookingUrl: bestPremium.bookingUrl,
      badgeText: "#2 BEST PRODUCT",
      badgeColor: "accent",
    })
  }
  
  // #3: Cash option (with context on whether it beats points)
  const cashFlights = flights
    .filter(f => f.type === "cash" && f.cashPrice && f.cashPrice > 0)
    .sort((a, b) => (a.cashPrice || Infinity) - (b.cashPrice || Infinity))
  
  if (cashFlights.length > 0) {
    const best = cashFlights[0]!
    const bestAwardCpp = bestValueAwards[0]?.realCpp || 0
    const cashWins = bestAwardCpp < 1.5  // If best award is under 1.5cpp, cash is probably better
    
    recommendations.push({
      rank: 3,
      title: `Cash ${best.cabinClass} at $${best.cashPrice?.toLocaleString()}`,
      subtitle: `${best.airline} • ${best.stops === 0 ? "Nonstop" : `${best.stops} stop`}`,
      details: [
        `✈️ ${best.flightNumbers.join(" / ")}`,
        cashWins 
          ? `🏆 Cash wins — best award is only ${bestAwardCpp}¢/pt, save points for a better route`
          : `💡 Points get ${bestAwardCpp}¢/pt value here — use them`,
      ],
      totalCost: `$${best.cashPrice?.toLocaleString()}`,
      cppValue: null,
      bookingUrl: best.bookingUrl,
      badgeText: cashWins ? "#3 CASH WINS" : "#3 SAVE POINTS",
      badgeColor: "gold",
    })
  }
  
  return recommendations
}

// ─── Warning Generation ──────────────────────────────────────────────────────

function generateWarnings(balances: PointsBalance[]): string[] {
  const warnings: string[] = []
  
  // Chase UR → Emirates Skywards dead
  warnings.push("⚠️ Chase UR → Emirates Skywards transfers ENDED Oct 2025")
  
  // Virgin Atlantic doesn't book Emirates
  warnings.push("⚠️ Virgin Atlantic does NOT book Emirates flights")
  
  // Alaska balance warning
  const alaska = balances.find(b => b.programKey === "ALASKA")
  if (alaska && alaska.balance < 100000) {
    warnings.push(`⚠️ Alaska only has ${formatBalance(alaska.balance)} — enough for ~1 business OW or 1 economy RT`)
  }
  
  return warnings
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

async function runSearch(config: SearchConfig): Promise<DashboardResults> {
  console.log(`\n🔍 Flight Search: ${config.origin} → ${config.destination}`)
  console.log(`   Date: ${config.departureDate}${config.returnDate ? ` → ${config.returnDate}` : " (one-way)"}`)
  console.log(`   Class: ${config.searchClass}`)
  console.log(`   Sources: ${config.sources.join(", ")}\n`)

  const startTime = Date.now()
  const db = getDb()

  // One unified search request: cash, award and hidden-city observations all
  // reference this single row. (§ search request model)
  let searchRequestId: number | null = null
  try {
    searchRequestId = recordSearchRequest(db, {
      origin: config.origin, destination: config.destination,
      departureDate: config.departureDate, returnDate: config.returnDate || null,
      cabin: config.searchClass, adults: 1, currency: CASH_CURRENCY,
    }, config.source ?? "cli")
  } catch (err) {
    console.warn(`⚠️ could not record search request: ${(err as Error).message}`)
  }

  // Balances: snapshot-cached (12h TTL). Only an explicit refresh refetches.
  console.log("💳 Loading points balances...")
  const balancesResult = await getBalances({ forceRefresh: config.forceRefresh, db })
  const balances = balancesResult.balances
  console.log(`   ${balances.length} programs loaded (${balancesResult.source})`)

  // Run search sources in parallel
  const completionPct: Record<string, number> = {}
  const otherFlights: UnifiedFlightResult[] = []
  let awardFlights: UnifiedFlightResult[] = []
  let awardProviders: AwardProviderOutcome[] = []
  const sourceWarnings: string[] = []
  const promises: Promise<void>[] = []

  // Award providers requested via --sources (roame/atf map to provider names).
  const awardProviderFilter = ["roame", "atf"].filter(p => config.sources.includes(p))
  if (awardProviderFilter.length > 0) {
    promises.push(
      searchAwardSource(config, awardProviderFilter, searchRequestId)
        .then(({ flights, completionPct: pct, outcome, warnings }) => {
          awardFlights = flights
          awardProviders = outcome
          Object.assign(completionPct, pct)
          sourceWarnings.push(...warnings)
          console.log(`✅ Awards: ${flights.length} redemptions across ${new Set(flights.map(f => f.pointsProgram)).size} programs`)
        }).catch(err => {
          console.error(`❌ Award search failed: ${err.message}`)
          for (const p of awardProviderFilter) completionPct[p] = 0
        })
    )
  }

  let cashPromise: Promise<void> = Promise.resolve()
  if (config.sources.includes("google")) {
    cashPromise = searchCashSource(config, searchRequestId).then(({ flights, completion, warnings }) => {
      otherFlights.push(...flights)
      completionPct["google"] = completion
      sourceWarnings.push(...warnings)
      console.log(`✅ Cash flights: ${flights.length} fares`)
    }).catch(err => {
      console.error(`❌ Cash flight search failed: ${err.message}`)
      completionPct["google"] = 0
    })
    promises.push(cashPromise)
  }

  if (config.sources.includes("hidden-city")) {
    // Chained after the cash source on purpose: the hidden-city direct-price
    // query is identical to the main economy search, so running it afterwards
    // turns it into a cache hit instead of a concurrent duplicate fetch (and,
    // when the free provider is down, a duplicate SerpAPI spend).
    promises.push(
      cashPromise.then(() => searchHiddenCity(config, searchRequestId)).then(({ flights, completion }) => {
        otherFlights.push(...flights)
        completionPct["hidden-city"] = completion
        console.log(`✅ Hidden City: ${flights.length} opportunities`)
      }).catch(err => {
        console.error(`❌ Hidden City failed: ${err.message}`)
        completionPct["hidden-city"] = 0
      })
    )
  }

  await Promise.allSettled(promises)

  // Combine all flights
  const allFlights = [...awardFlights, ...otherFlights]

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n📊 Search complete: ${allFlights.length} flights in ${elapsed}s`)

  // Run value engine — cross-reference award vs cash, score everything
  console.log("🧠 Running value engine...")
  const { scored, insights } = scoreFlights(allFlights, balances, config.origin, config.destination)
  console.log(`   ${scored.filter(f => f.realCpp !== null).length} award flights scored against real cash prices`)
  console.log(`   ${scored.filter(f => f.sweetSpotMatch).length} sweet spot matches found`)
  console.log(`   ${insights.length} insights generated`)

  // Sort scored flights by value score (highest first)
  scored.sort((a, b) => b.valueScore - a.valueScore)

  // The dashboard's per-card cent-per-mile badge and its "cpp"/"value" sorts
  // read flight.cppValue. Awards now arrive from the provider layer with
  // cppValue null (the old hardcoded estimate is gone), so feed those fields
  // from the value engine's realCpp - strictly better data, same UI contract.
  for (const f of scored) {
    if (f.type === "award" && f.cppValue === null && f.realCpp !== null) f.cppValue = f.realCpp
  }

  // Same flight, different programs → explicit comparison (§ best redemption)
  const redemptionComparisons = buildRedemptionComparisons(scored)
  const multiProgram = redemptionComparisons.filter(c => c.optionCount > 1).length
  if (multiProgram > 0) {
    console.log(`   ${multiProgram} itineraries bookable through more than one program`)
  }

  // Generate recommendations from value-scored results
  const recommendations = generateRecommendations(scored, balances, config)
  const warnings = generateWarnings(balances)
  for (const w of [...new Set(sourceWarnings)]) warnings.push(`⚠️ Provider — ${w}`)

  // Get route sweet spots for context
  const routeSpots = getSweetSpotsForRoute(config.origin, config.destination)
  const routeSweetSpots = routeSpots.map(s => ({
    program: s.programName,
    cabin: s.cabin,
    maxPoints: s.maxPoints,
    description: s.description,
  }))

  const results: DashboardResults = {
    meta: {
      origin: config.origin,
      destination: config.destination,
      departureDate: config.departureDate,
      returnDate: config.returnDate || null,
      searchedAt: new Date().toISOString(),
      sources: config.sources,
      completionPct,
      searchRequestId,
    },
    balances,
    balancesMeta: {
      source: balancesResult.source,
      fetchedAt: balancesResult.fetchedAt,
      ageMinutes: balancesResult.ageMinutes,
    },
    flights: scored,
    recommendations,
    insights,
    routeSweetSpots,
    redemptionComparisons,
    awardProviders,
    warnings,
  }

  // SQLite is the persistence source; results.json remains a debug export.
  if (searchRequestId !== null && config.persistResults !== false) {
    try {
      saveSearchResult(db, searchRequestId, results)
    } catch (err) {
      console.warn(`⚠️ could not persist search result: ${(err as Error).message}`)
    }
  }

  return results
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const getArg = (flag: string, def: string) => {
    const idx = args.indexOf(flag)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1]! : def
  }
  const hasFlag = (flag: string) => args.includes(flag)
  
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Unified Flight Search

Usage:
  npx tsx search.ts --from LAX --to DXB --date 2026-04-28 [options]

Options:
  --from <IATA>          Origin airport (default: LAX)
  --to <IATA>            Destination airport (default: DXB)
  --date <YYYY-MM-DD>    Departure date (default: 2026-04-28)
  --return <YYYY-MM-DD>  Return date (omit for one-way)
  --class <ECON|PREM|both>  Search class (default: both)
  --sources <list>       Comma-separated: roame,atf,google,hidden-city (default: roame,atf,google,hidden-city)
  --output <file>        Output file (default: results.json)
  --flex <0|1|2>         Flexible dates: search ±N days via Roame (default: 0)
  --refresh              Bypass the cash cache and refetch (may spend metered calls)
  --verify               Ask the metered provider to confirm cash prices
  --verbose              Show detailed progress
`)
    process.exit(0)
  }
  
  const config: SearchConfig = {
    origin: getArg("--from", "LAX"),
    destination: getArg("--to", "DXB"),
    departureDate: getArg("--date", "2026-04-28"),
    returnDate: args.includes("--return") ? getArg("--return", "") : undefined,
    searchClass: getArg("--class", "both") as any,
    sources: getArg("--sources", "roame,atf,google,hidden-city").split(","),
    output: getArg("--output", "results.json"),
    flexDays: parseInt(getArg("--flex", "0")),
    verbose: hasFlag("--verbose"),
    forceRefresh: hasFlag("--refresh"),
    // A person typed this command, so the metered reserve may be spent.
    userInitiated: hasFlag("--refresh") || hasFlag("--verify"),
    verifyPrices: hasFlag("--verify"),
    source: "cli",
  }
  
  const results = await runSearch(config)
  
  // Save results
  fs.writeFileSync(config.output, JSON.stringify(results, null, 2))
  console.log(`\n💾 Results saved to ${config.output}`)
  
  // Print summary
  console.log(`\n🏆 Top Recommendations:`)
  for (const rec of results.recommendations) {
    console.log(`  ${rec.badgeText}: ${rec.title}`)
    console.log(`    ${rec.totalCost} ${rec.cppValue ? `(${rec.cppValue})` : ""}`)
    for (const d of rec.details) {
      console.log(`    ${d}`)
    }
    console.log()
  }
  
  if (results.insights.length > 0) {
    console.log(`\n💡 Insights:`)
    for (const insight of results.insights) {
      const icon = insight.priority === "high" ? "🔴" : insight.priority === "medium" ? "🟡" : "🔵"
      console.log(`  ${icon} ${insight.title}`)
      console.log(`    ${insight.detail}`)
    }
  }
  
  if (results.routeSweetSpots.length > 0) {
    console.log(`\n🎯 Sweet Spots for ${config.origin}→${config.destination}:`)
    for (const spot of results.routeSweetSpots) {
      console.log(`  ${spot.program} ${spot.cabin}: ≤${spot.maxPoints.toLocaleString()} pts — ${spot.description.slice(0, 70)}`)
    }
  }
  
  if (results.warnings.length > 0) {
    console.log(`\n⚠️ Warnings:`)
    for (const w of results.warnings) {
      console.log(`  ${w}`)
    }
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith("search.ts") || 
  process.argv[1].endsWith("search.js")
)
if (isMain) {
  main().catch(err => {
    console.error("❌", err.message)
    process.exit(1)
  })
}

export { runSearch, SearchConfig, DashboardResults, UnifiedFlightResult }
