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

import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"
import os from "os"
import { searchRoame, roameFaresToUnified } from "./roame-scraper.js"
import type { RoameFare, UnifiedFlightResult } from "./roame-scraper.js"
import { searchATF, atfToUnified, ATF_AIRLINE_META } from "./atf-scraper.js"
import { scoreFlights, type ValueScoredFlight, type ValueInsight } from "./value-engine.ts"
import { getSweetSpotsForRoute } from "./sweet-spots.ts"
import { findFundingPaths } from "./transfer-partners.ts"
import { searchCashFlights } from "./providers/cash-flights/index.js"
import { resolvePython } from "./providers/cash-flights/python-bridge.js"
import type { NormalizedCashFlight, CabinClass } from "./providers/cash-flights/index.js"

/** Home directory, cross-platform. HOME is unset on Windows outside of Git Bash. */
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

// ─── Load .env file ──────────────────────────────────────────────────────────
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(ROOT, ".env")
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8")
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      // The real environment always wins, including when it deliberately sets a
      // variable to empty. `SERP_API_KEY=` in the environment means "do not use
      // SerpAPI"; treating that as unset would let .env silently switch a paid
      // provider back on.
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}

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
}

interface PointsBalance {
  program: string
  programKey: string
  balance: number
  displayBalance: string
  transferPartners?: string[]
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
  }
  balances: PointsBalance[]
  flights: ValueScoredFlight[]
  recommendations: Recommendation[]
  insights: ValueInsight[]
  routeSweetSpots: { program: string; cabin: string; maxPoints: number; description: string }[]
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

async function loadBalances(): Promise<PointsBalance[]> {
  // Try AwardWallet first
  const awPath = path.join(homeDir(), ".openclaw", "credentials", "awardwallet.json")
  if (fs.existsSync(awPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(awPath, "utf-8"))
      const apiKey = creds.apiKey || creds.api_key
      const userId = creds.userId || creds.user_id
      
      const resp = await fetch(`https://business.awardwallet.com/api/export/v1/connectedUser/${userId}`, {
        headers: { "X-Authentication": apiKey, Accept: "application/json" }
      })
      
      if (resp.ok) {
        const data = await resp.json() as any
        if (data.accounts) {
          return data.accounts
            .filter((a: any) => (a.balanceRaw || 0) > 0)
            .map((a: any) => ({
              program: a.displayName || a.name,
              programKey: mapProgramKey(a.displayName || a.name),
              balance: a.balanceRaw || parseInt(String(a.balance).replace(/,/g, ""), 10) || 0,
              displayBalance: formatBalance(a.balanceRaw || 0),
            }))
            .sort((a: PointsBalance, b: PointsBalance) => b.balance - a.balance)
        }
      }
    } catch (e) {
      console.warn("⚠️ AwardWallet fetch failed, using hardcoded balances")
    }
  }
  
  // Fallback: hardcoded balances from task spec
  return [
    { program: "Chase UR", programKey: "chase-ur", balance: 1315295, displayBalance: "1,315,295" },
    { program: "Flying Blue", programKey: "FLYING_BLUE", balance: 851165, displayBalance: "851,165" },
    { program: "Marriott Bonvoy", programKey: "marriott", balance: 1392260, displayBalance: "1,392,260" },
    { program: "Hilton Honors", programKey: "hilton", balance: 734242, displayBalance: "734,242" },
    { program: "Aeroplan", programKey: "AEROPLAN", balance: 475663, displayBalance: "475,663" },
    { program: "Delta SkyMiles", programKey: "DELTA", balance: 293430, displayBalance: "293,430" },
    { program: "Southwest RR", programKey: "southwest", balance: 144250, displayBalance: "144,250" },
    { program: "Alaska Mileage Plan", programKey: "ALASKA", balance: 87685, displayBalance: "87,685" },
    { program: "BA Avios", programKey: "BRITISH_AIRWAYS", balance: 71449, displayBalance: "71,449" },
    { program: "United MileagePlus", programKey: "UNITED", balance: 70000, displayBalance: "70,000" },
    { program: "Virgin Atlantic", programKey: "VIRGIN_ATLANTIC", balance: 60728, displayBalance: "60,728" },
    { program: "Bilt Rewards", programKey: "bilt", balance: 59390, displayBalance: "59,390" },
  ]
}

function formatBalance(n: number): string {
  return n.toLocaleString()
}

function mapProgramKey(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes("chase") || lower.includes("ultimate rewards")) return "chase-ur"
  if (lower.includes("flying blue") || lower.includes("air france")) return "FLYING_BLUE"
  if (lower.includes("aeroplan") || lower.includes("air canada")) return "AEROPLAN"
  if (lower.includes("alaska")) return "ALASKA"
  if (lower.includes("united")) return "UNITED"
  if (lower.includes("delta")) return "DELTA"
  if (lower.includes("british") || lower.includes("avios")) return "BRITISH_AIRWAYS"
  if (lower.includes("emirates") && lower.includes("skywards")) return "EMIRATES"
  if (lower.includes("qatar")) return "QATAR"
  if (lower.includes("qantas")) return "QANTAS"
  if (lower.includes("virgin") && lower.includes("atlantic")) return "VIRGIN_ATLANTIC"
  if (lower.includes("marriott")) return "marriott"
  if (lower.includes("hilton")) return "hilton"
  if (lower.includes("southwest")) return "southwest"
  if (lower.includes("bilt")) return "bilt"
  return lower.replace(/\s+/g, "-")
}

// ─── Search Sources ──────────────────────────────────────────────────────────

async function searchRoameSource(config: SearchConfig): Promise<{ flights: UnifiedFlightResult[], completion: number }> {
  const classes = config.searchClass === "both" ? ["ECON", "PREM"] : [config.searchClass]
  const allFlights: UnifiedFlightResult[] = []
  let totalCompletion = 0
  
  for (const cls of classes) {
    try {
      const result = await searchRoame(
        config.origin, config.destination, config.departureDate,
        cls, ["ALL"], config.verbose, config.flexDays || 0
      )
      
      const unified = roameFaresToUnified(result.fares, cls)
      allFlights.push(...unified)
      totalCompletion += result.search.percentCompleted
    } catch (err) {
      console.error(`❌ Roame ${cls} search failed:`, (err as Error).message)
    }
  }
  
  return { flights: allFlights, completion: totalCompletion / classes.length }
}

// ─── ATF Source ──────────────────────────────────────────────────────────────

async function searchATFSource(config: SearchConfig): Promise<{ flights: UnifiedFlightResult[], completion: number }> {
  try {
    const results = await searchATF(config.origin, config.destination, config.departureDate)
    const flights = atfToUnified(results)
    return { flights, completion: flights.length > 0 ? 100 : 50 }
  } catch (err) {
    console.error(`❌ ATF failed: ${(err as Error).message}`)
    return { flights: [], completion: 0 }
  }
}

// ─── ATF × Roame Cross-Reference ─────────────────────────────────────────────

/**
 * Cross-reference ATF and Roame award results.
 *
 * Matching key: pointsProgram + cabinClass + travelDate
 *   - Both sources agree  → "cross-verified" (keep Roame data — richer; pull ATF seat count if Roame lacks it)
 *   - ATF found, Roame missed → "ATF-exclusive" (ATF result kept as-is)
 *   - Roame found, ATF doesn't cover → unchanged (ATF only covers 5 airlines)
 *
 * ATF covers: british_airways, qatar_airways, cathay_pacific, virgin_atlantic, iberia.
 * Everything else Roame finds is out of ATF scope and stays untagged.
 */
function crossReferenceATFAndRoame(
  roameFlights: UnifiedFlightResult[],
  atfFlights: UnifiedFlightResult[],
): UnifiedFlightResult[] {
  if (atfFlights.length === 0) return roameFlights

  // Build ATF result lookup: key → ATFUnifiedResult
  const atfByKey = new Map<string, UnifiedFlightResult>()
  for (const f of atfFlights) {
    if (!f.pointsProgram || !f.cabinClass || !f.travelDate) continue
    const key = `${f.pointsProgram}:${f.cabinClass}:${f.travelDate}`
    atfByKey.set(key, f)
  }

  // ATF-covered program keys (to know when a Roame miss is meaningful)
  const atfProgramKeys = new Set(
    Object.values(ATF_AIRLINE_META).map(m => m.programKey)
  )

  const merged: UnifiedFlightResult[] = []
  const matchedATFKeys = new Set<string>()

  for (const roameFlight of roameFlights) {
    if (roameFlight.type !== "award" || !roameFlight.pointsProgram) {
      merged.push(roameFlight)
      continue
    }

    const key = `${roameFlight.pointsProgram}:${roameFlight.cabinClass}:${roameFlight.travelDate}`
    const atfMatch = atfByKey.get(key)

    if (atfMatch) {
      matchedATFKeys.add(key)
      // Keep Roame data (has duration, stops, flight numbers, roameScore)
      // Enrich with ATF seat count if Roame doesn't have it
      merged.push({
        ...roameFlight,
        availableSeats: roameFlight.availableSeats ?? atfMatch.availableSeats,
        tags: [...(roameFlight.tags || []), "cross-verified"],
      })
    } else {
      // Not in ATF — only note the absence if ATF covers this program
      // (Roame might show flights ATF doesn't cover, like QR on Flying Blue)
      merged.push(roameFlight)
    }
  }

  // Add ATF-exclusive results (availability ATF found that Roame missed)
  for (const [key, atfFlight] of atfByKey.entries()) {
    if (!matchedATFKeys.has(key)) {
      console.log(`  🔵 ATF-exclusive: ${atfFlight.airline} ${atfFlight.cabinClass} (${atfFlight.pointsProgram})`)
      merged.push({
        ...atfFlight,
        tags: [...(atfFlight.tags || []), "ATF-exclusive"],
      })
    }
  }

  return merged
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

async function searchHiddenCity(config: SearchConfig): Promise<{ flights: UnifiedFlightResult[], completion: number }> {
  const scriptPath = path.join(ROOT, "scripts", "search-hidden-city.py")
  if (!fs.existsSync(scriptPath)) {
    console.warn("⚠️ Hidden city script not found")
    return { flights: [], completion: 0 }
  }

  try {
    // Use max-beyond 5 to conserve SerpAPI budget (1 direct + 5 beyond = 6 calls max)
    const argv = [scriptPath, config.origin, config.destination, config.departureDate,
                  "--max-beyond", "5", "--min-savings", "30"]
    const output = execFileSync(resolvePython(), argv, {
      timeout: 120000,
      env: { ...process.env },
      encoding: "utf-8",
    })

    // Parse only the last line (JSON output) — stderr goes to console
    const lines = output.trim().split("\n")
    const jsonLine = lines[lines.length - 1]!
    const results = JSON.parse(jsonLine) as any[]
    
    const flights: UnifiedFlightResult[] = results.map((r, i) => ({
      id: `hidden-city-${i}`,
      source: "hidden-city" as const,
      type: "cash" as const,
      origin: r.origin,
      destination: r.real_destination,
      airline: r.airline || "Various",
      operatingAirlines: (r.airline || "Various").split(" / "),
      flightNumbers: r.flight_numbers || [],
      stops: r.stops || 1,
      durationMinutes: r.total_duration_min || 0,
      departureTime: r.departure_time || "",
      arrivalTime: r.arrival_at_layover || "",
      airports: [r.origin, r.real_destination, r.ticketed_destination],
      cabinClass: "economy",
      equipment: [],
      points: null,
      pointsProgram: null,
      cashPrice: r.hidden_city_price || null,
      taxes: 0,
      currency: "USD",
      cppValue: null,
      roameScore: null,
      availableSeats: null,
      bookingUrl: r.booking_url || `https://www.google.com/travel/flights`,
      fareClass: `hidden-city:${r.ticketed_destination}|saves:$${Math.round(r.savings)}(${r.savings_percent}%)|risk:${r.risk_score}|direct:$${r.direct_price}`,
      travelDate: config.departureDate,
    }))

    return { flights, completion: results.length > 0 ? 100 : 0 }
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
  
  // Load balances
  console.log("💳 Loading points balances...")
  const balances = await loadBalances()
  console.log(`   ${balances.length} programs loaded`)
  
  // Run search sources in parallel
  const completionPct: Record<string, number> = {}
  // Non-award flights (cash, hidden-city) go directly here
  const otherFlights: UnifiedFlightResult[] = []
  // Award sources kept separate for cross-referencing
  let roameFlights: UnifiedFlightResult[] = []
  let atfFlights: UnifiedFlightResult[] = []

  const cashWarnings: string[] = []
  const promises: Promise<void>[] = []
  
  if (config.sources.includes("roame")) {
    promises.push(
      searchRoameSource(config).then(({ flights, completion }) => {
        roameFlights = flights
        completionPct["roame"] = completion
        console.log(`✅ Roame: ${flights.length} award fares`)
      }).catch(err => {
        console.error(`❌ Roame failed: ${err.message}`)
        completionPct["roame"] = 0
      })
    )
  }

  if (config.sources.includes("atf")) {
    promises.push(
      searchATFSource(config).then(({ flights, completion }) => {
        atfFlights = flights
        completionPct["atf"] = completion
        console.log(`✅ ATF: ${flights.length} award fares across ${new Set(flights.map(f => f.pointsProgram)).size} programs`)
      }).catch(err => {
        console.error(`❌ ATF failed: ${err.message}`)
        completionPct["atf"] = 0
      })
    )
  }
  
  if (config.sources.includes("google")) {
    promises.push(
      searchCashSource(config).then(({ flights, completion, warnings }) => {
        otherFlights.push(...flights)
        completionPct["google"] = completion
        cashWarnings.push(...warnings)
        console.log(`✅ Cash flights: ${flights.length} fares`)
      }).catch(err => {
        console.error(`❌ Cash flight search failed: ${err.message}`)
        completionPct["google"] = 0
      })
    )
  }

  if (config.sources.includes("hidden-city")) {
    promises.push(
      searchHiddenCity(config).then(({ flights, completion }) => {
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

  // ── Cross-reference ATF vs Roame ──────────────────────────────────────────
  // Merge award sources: cross-verified flights get richer data + tags;
  // ATF-exclusive finds are flagged for the value engine and dashboard.
  const awardFlights = crossReferenceATFAndRoame(roameFlights, atfFlights)
  const crossVerified = awardFlights.filter(f => f.tags?.includes("cross-verified")).length
  const atfExclusive = awardFlights.filter(f => f.tags?.includes("ATF-exclusive")).length
  if (roameFlights.length > 0 || atfFlights.length > 0) {
    console.log(`  🔗 Cross-reference: ${crossVerified} verified, ${atfExclusive} ATF-exclusive`)
  }

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
  
  // Generate recommendations from value-scored results
  const recommendations = generateRecommendations(scored, balances, config)
  const warnings = generateWarnings(balances)
  for (const w of [...new Set(cashWarnings)]) warnings.push(`⚠️ Cash provider — ${w}`)
  
  // Get route sweet spots for context
  const routeSpots = getSweetSpotsForRoute(config.origin, config.destination)
  const routeSweetSpots = routeSpots.map(s => ({
    program: s.programName,
    cabin: s.cabin,
    maxPoints: s.maxPoints,
    description: s.description,
  }))
  
  return {
    meta: {
      origin: config.origin,
      destination: config.destination,
      departureDate: config.departureDate,
      returnDate: config.returnDate || null,
      searchedAt: new Date().toISOString(),
      sources: config.sources,
      completionPct,
    },
    balances,
    flights: scored,
    recommendations,
    insights,
    routeSweetSpots,
    warnings,
  }
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
