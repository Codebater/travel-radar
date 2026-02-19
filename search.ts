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
import { execSync } from "child_process"
import { searchRoame, roameFaresToUnified } from "./roame-scraper.js"
import type { RoameFare, UnifiedFlightResult } from "./roame-scraper.js"
import { scoreFlights, type ValueScoredFlight, type ValueInsight } from "./value-engine.ts"
import { getSweetSpotsForRoute } from "./sweet-spots.ts"
import { findFundingPaths } from "./transfer-partners.ts"

// ─── Load .env file ──────────────────────────────────────────────────────────
const ROOT = path.dirname(new URL(import.meta.url).pathname)
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
      if (!process.env[key]) process.env[key] = val
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
  const awPath = path.join(process.env.HOME!, ".openclaw/credentials/awardwallet.json")
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

// ─── fast_flights (Primary Google Flights Source) ─────────────────────────

async function searchFastFlights(config: SearchConfig): Promise<{ flights: UnifiedFlightResult[], completion: number }> {
  const scriptPath = path.join(ROOT, "scripts", "search-google-flights.py")
  const venvPython = path.join(ROOT, ".venv", "bin", "python3")
  const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3"
  
  if (!fs.existsSync(scriptPath)) {
    console.warn("⚠️ fast_flights script not found, falling back to SerpAPI")
    return { flights: [], completion: 0 }
  }

  const cabinMap: Record<string, string> = { ECON: "economy", PREM: "business", both: "economy" }
  const classesToSearch = config.searchClass === "both" ? ["economy", "business"] : [cabinMap[config.searchClass] || "economy"]
  const allFlights: UnifiedFlightResult[] = []

  for (const cabin of classesToSearch) {
    try {
      let cmd = `"${pythonBin}" "${scriptPath}" ${config.origin} ${config.destination} ${config.departureDate} --class ${cabin}`
      if (config.returnDate) cmd += ` --return ${config.returnDate}`
      
      const output = execSync(cmd, {
        timeout: 45000,
        env: { ...process.env },
        encoding: "utf-8",
      })

      // Parse only the last line (JSON output) — stderr goes to console
      const lines = output.trim().split("\n")
      const jsonLine = lines[lines.length - 1]!
      const results = JSON.parse(jsonLine) as any[]

      for (const r of results) {
        const depTimeStr = r.departureTime || ""
        const extractedDate = depTimeStr && /^\d{4}-\d{2}-\d{2}/.test(depTimeStr) ? depTimeStr.slice(0, 10) : config.departureDate

        allFlights.push({
          id: `google-${allFlights.length}`,
          source: "google",
          type: "cash",
          origin: r.origin || config.origin,
          destination: r.destination || config.destination,
          airline: r.airline || "Unknown",
          operatingAirlines: (r.airline || "Unknown").split(", "),
          flightNumbers: [],
          stops: r.stops || 0,
          durationMinutes: r.durationMinutes || 0,
          departureTime: r.departureTime || "",
          arrivalTime: r.arrivalTime || "",
          airports: [r.origin || config.origin, r.destination || config.destination],
          cabinClass: r.cabinClass || cabin,
          equipment: [],
          points: null,
          pointsProgram: null,
          cashPrice: r.cashPrice || null,
          taxes: 0,
          currency: "USD",
          cppValue: null,
          roameScore: null,
          availableSeats: null,
          bookingUrl: `https://www.google.com/travel/flights?q=flights+from+${config.origin}+to+${config.destination}+on+${config.departureDate}`,
          fareClass: r.isBest ? "best" : "",
          travelDate: extractedDate,
        })
      }
    } catch (err) {
      console.warn(`⚠️ fast_flights (${cabin}) failed:`, (err as Error).message?.slice(0, 200))
    }
  }

  return { flights: allFlights, completion: allFlights.length > 0 ? 100 : 0 }
}

// ─── SerpAPI Usage Limiter ─────────────────────────────────────────────────
const USAGE_FILE = path.join(ROOT, "serpapi-usage.json")
const MONTHLY_LIMIT = 95  // hard cap (5 buffer under 100 free tier)
const WARN_AT = 80

function checkSerpApiUsage(): { allowed: boolean; used: number } {
  let usage = { month: "", searches: 0, limit: MONTHLY_LIMIT, warn_at: WARN_AT, last_reset: "" }
  try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) } catch {}
  
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (usage.month !== currentMonth) {
    usage = { month: currentMonth, searches: 0, limit: MONTHLY_LIMIT, warn_at: WARN_AT, last_reset: new Date().toISOString().slice(0, 10) }
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2))
  }
  
  if (usage.searches >= MONTHLY_LIMIT) {
    console.warn(`🛑 SerpAPI monthly limit reached (${usage.searches}/${MONTHLY_LIMIT}). Skipping to stay on free tier.`)
    return { allowed: false, used: usage.searches }
  }
  if (usage.searches >= WARN_AT) {
    console.warn(`⚠️ SerpAPI usage warning: ${usage.searches}/${MONTHLY_LIMIT} searches used this month`)
  }
  return { allowed: true, used: usage.searches }
}

function incrementSerpApiUsage(): void {
  let usage = { month: "", searches: 0, limit: MONTHLY_LIMIT, warn_at: WARN_AT, last_reset: "" }
  try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) } catch {}
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (usage.month !== currentMonth) {
    usage = { month: currentMonth, searches: 0, limit: MONTHLY_LIMIT, warn_at: WARN_AT, last_reset: new Date().toISOString().slice(0, 10) }
  }
  usage.searches++
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2))
}

async function searchSerpApiGoogle(config: SearchConfig): Promise<{ flights: UnifiedFlightResult[], completion: number }> {
  const apiKey = process.env.SERP_API_KEY
  if (!apiKey) {
    console.warn("⚠️ SERP_API_KEY not set — get one at https://serpapi.com/manage-api-key (100 free/mo)")
    return { flights: [], completion: 0 }
  }

  const { allowed, used } = checkSerpApiUsage()
  if (!allowed) return { flights: [], completion: 0 }

  const cabinMap: Record<string, number> = { ECON: 1, PREM: 2, both: 1 }
  const cabinNames: Record<number, string> = { 1: "economy", 2: "business" }
  const classesToSearch = config.searchClass === "both" ? [1, 2] : [cabinMap[config.searchClass] || 1]
  const allFlights: UnifiedFlightResult[] = []

  for (const travelClass of classesToSearch) {
    try {
      const params = new URLSearchParams({
        engine: "google_flights",
        departure_id: config.origin,
        arrival_id: config.destination,
        outbound_date: config.departureDate,
        type: config.returnDate ? "1" : "2",
        travel_class: String(travelClass),
        currency: "USD",
        hl: "en",
        api_key: apiKey,
      })
      if (config.returnDate) params.set("return_date", config.returnDate)

      incrementSerpApiUsage()
      const resp = await fetch(`https://serpapi.com/search?${params}`)
      if (!resp.ok) {
        const body = await resp.text()
        console.warn(`⚠️ SerpAPI ${resp.status}: ${body.slice(0, 200)}`)
        continue
      }

      const data = await resp.json() as any

      for (const category of ["best_flights", "other_flights"]) {
        for (const itinerary of data[category] || []) {
          const legs = itinerary.flights || []
          if (legs.length === 0) continue

          const firstLeg = legs[0]
          const lastLeg = legs[legs.length - 1]
          const airlines = [...new Set(legs.map((l: any) => l.airline).filter(Boolean))]
          const flightNums = legs.map((l: any) => l.flight_number).filter(Boolean)
          const layovers = itinerary.layovers || []
          const airports = [
            firstLeg.departure_airport?.id || config.origin,
            ...layovers.map((l: any) => l.id || l.name),
            lastLeg.arrival_airport?.id || config.destination,
          ].filter(Boolean)

          // Extract travel date from departure time or fall back to search date
          const depTimeStr = firstLeg.departure_airport?.time || ""
          const extractedDate = depTimeStr ? depTimeStr.split("T")[0] || depTimeStr.split(" ")[0] || config.departureDate : config.departureDate
          const flightTravelDate = extractedDate && /^\d{4}-\d{2}-\d{2}/.test(extractedDate) ? extractedDate.slice(0, 10) : config.departureDate

          allFlights.push({
            id: `google-${allFlights.length}`,
            source: "google",
            type: "cash",
            origin: firstLeg.departure_airport?.id || config.origin,
            destination: lastLeg.arrival_airport?.id || config.destination,
            airline: airlines.join(" / ") || "Unknown",
            operatingAirlines: airlines,
            flightNumbers: flightNums,
            stops: layovers.length,
            durationMinutes: itinerary.total_duration || legs.reduce((s: number, l: any) => s + (l.duration || 0), 0),
            departureTime: firstLeg.departure_airport?.time || "",
            arrivalTime: lastLeg.arrival_airport?.time || "",
            airports,
            cabinClass: cabinNames[travelClass] || "economy",
            equipment: legs.map((l: any) => l.airplane || "").filter(Boolean),
            points: null,
            pointsProgram: null,
            cashPrice: itinerary.price || null,
            taxes: 0,
            currency: "USD",
            cppValue: null,
            roameScore: null,
            availableSeats: null,
            bookingUrl: itinerary.booking_token
              ? `https://www.google.com/travel/flights/booking?token=${encodeURIComponent(itinerary.booking_token)}`
              : `https://www.google.com/travel/flights?q=flights+from+${config.origin}+to+${config.destination}+on+${config.departureDate}`,
            fareClass: itinerary.type || "",
            travelDate: flightTravelDate,
          })
        }
      }
    } catch (err) {
      console.warn(`⚠️ SerpAPI Google Flights (class ${travelClass}) failed:`, (err as Error).message)
    }
  }

  return { flights: allFlights, completion: allFlights.length > 0 ? 100 : 0 }
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
    const cmd = `python3 "${scriptPath}" ${config.origin} ${config.destination} ${config.departureDate} --max-beyond 5 --min-savings 30`
    const output = execSync(cmd, {
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
  const allFlights: UnifiedFlightResult[] = []
  
  const promises: Promise<void>[] = []
  
  if (config.sources.includes("roame")) {
    promises.push(
      searchRoameSource(config).then(({ flights, completion }) => {
        allFlights.push(...flights)
        completionPct["roame"] = completion
        console.log(`✅ Roame: ${flights.length} award fares`)
      }).catch(err => {
        console.error(`❌ Roame failed: ${err.message}`)
        completionPct["roame"] = 0
      })
    )
  }
  
  if (config.sources.includes("google")) {
    promises.push(
      (async () => {
        // Try fast_flights first (no API key needed, no rate limits)
        console.log("🔍 Trying fast_flights (primary)...")
        const fastResult = await searchFastFlights(config).catch(err => {
          console.warn(`⚠️ fast_flights failed: ${err.message?.slice(0, 100)}`)
          return { flights: [] as UnifiedFlightResult[], completion: 0 }
        })
        
        if (fastResult.flights.length > 0) {
          allFlights.push(...fastResult.flights)
          completionPct["google"] = fastResult.completion
          console.log(`✅ Google Flights (fast_flights): ${fastResult.flights.length} cash fares`)
          return
        }
        
        // Fallback to SerpAPI if fast_flights returned nothing
        console.log("🔄 fast_flights returned 0 results, falling back to SerpAPI...")
        const serpResult = await searchSerpApiGoogle(config)
        allFlights.push(...serpResult.flights)
        completionPct["google"] = serpResult.completion
        console.log(`✅ Google Flights (SerpAPI fallback): ${serpResult.flights.length} cash fares`)
      })().catch(err => {
        console.error(`❌ Google Flights failed: ${err.message}`)
        completionPct["google"] = 0
      })
    )
  }

  if (config.sources.includes("hidden-city")) {
    promises.push(
      searchHiddenCity(config).then(({ flights, completion }) => {
        allFlights.push(...flights)
        completionPct["hidden-city"] = completion
        console.log(`✅ Hidden City: ${flights.length} opportunities`)
      }).catch(err => {
        console.error(`❌ Hidden City failed: ${err.message}`)
        completionPct["hidden-city"] = 0
      })
    )
  }
  
  await Promise.allSettled(promises)
  
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
  --sources <list>       Comma-separated: roame,google,aa (default: roame,google)
  --output <file>        Output file (default: results.json)
  --flex <0|1|2>         Flexible dates: search ±N days via Roame (default: 0)
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
    sources: getArg("--sources", "roame,google,hidden-city").split(","),
    output: getArg("--output", "results.json"),
    flexDays: parseInt(getArg("--flex", "0")),
    verbose: hasFlag("--verbose"),
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
