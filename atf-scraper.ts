#!/usr/bin/env tsx
/**
 * Award Travel Finder (ATF) Scraper
 *
 * Searches award availability for 5 airlines via the ATF REST API.
 * Used as a cross-reference source alongside Roame to verify availability
 * and surface ATF-exclusive findings.
 *
 * Supported airlines: british_airways, qatar_airways, cathay_pacific, virgin_atlantic, iberia
 * Rate limit: 150 calls/month (each airline per route per date = 1 call)
 *
 * API key from ATF_API_KEY env var or ~/.openclaw/credentials/awardtravelfinder.json
 *
 * Usage:
 *   npx tsx atf-scraper.ts --from LAX --to LHR --date 2026-03-15
 *   npx tsx atf-scraper.ts --from LAX --to LHR --date 2026-03-15 --unified --output atf.json
 */

import fs from "fs"
import path from "path"
import type { UnifiedFlightResult } from "./roame-scraper.js"

const ATF_BASE_URL = "https://awardtravelfinder.com/api/v1"
const CREDENTIALS_PATH = path.join(process.env.HOME!, ".openclaw/credentials/awardtravelfinder.json")
const MONTHLY_LIMIT = 150
const WARN_AT_REMAINING = 20

// All airlines supported by ATF. Each = 1 API call per search.
export const ATF_AIRLINES = [
  "british_airways",
  "qatar_airways",
  "cathay_pacific",
  "virgin_atlantic",
  "iberia",
] as const

export type ATFAirline = typeof ATF_AIRLINES[number]

// ─── Types ───────────────────────────────────────────────────────────────────

interface ATFCabin {
  available: boolean
  seats: number
  points?: number
  taxes?: number
  taxes_currency?: string
}

interface ATFAvailability {
  date: string
  cabins: {
    economy?: ATFCabin
    premium_economy?: ATFCabin
    business?: ATFCabin
    first?: ATFCabin
  }
}

interface ATFData {
  route: string
  search_date: string
  response_type: string
  availability: ATFAvailability
}

interface ATFUsage {
  tier: string
  remaining_calls: number
  monthly_limit: number
}

interface ATFResponse {
  success: boolean
  data: ATFData
  usage: ATFUsage
}

export interface ATFResult {
  airline: ATFAirline
  origin: string
  destination: string
  date: string
  response: ATFResponse
  error?: string
}

// ─── API Key ─────────────────────────────────────────────────────────────────

function loadApiKey(): string {
  // 1. Environment variable (preferred)
  if (process.env.ATF_API_KEY) {
    return process.env.ATF_API_KEY
  }

  // 2. Credentials file fallback
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"))
      const key = creds.apiKey || creds.api_key || creds.key
      if (key) return key
    } catch (e) {
      throw new Error(`Failed to parse ${CREDENTIALS_PATH}: ${(e as Error).message}`)
    }
  }

  throw new Error(
    `ATF API key not found.\n` +
    `Set ATF_API_KEY env var or save to ${CREDENTIALS_PATH}:\n` +
    `  { "apiKey": "your-key-here" }`
  )
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function fetchATFAirline(
  apiKey: string,
  airline: ATFAirline,
  origin: string,
  destination: string,
  date: string,
): Promise<ATFResult> {
  const url = `${ATF_BASE_URL}/${airline}/availability?departure_code=${origin}&arrival_code=${destination}&date=${date}`

  try {
    const resp = await fetch(url, {
      headers: {
        "X-API-Key": apiKey,
        "Accept": "application/json",
      },
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      return {
        airline, origin, destination, date,
        response: null as any,
        error: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
      }
    }

    const data = await resp.json() as ATFResponse

    // Warn loudly if running low on monthly budget
    if (data.usage?.remaining_calls !== undefined && data.usage.remaining_calls < WARN_AT_REMAINING) {
      process.stderr.write(
        `⚠️  ATF API WARNING: only ${data.usage.remaining_calls}/${data.usage.monthly_limit} calls remaining this month!\n`
      )
    }

    return { airline, origin, destination, date, response: data }
  } catch (err) {
    return {
      airline, origin, destination, date,
      response: null as any,
      error: (err as Error).message,
    }
  }
}

// ─── Main Search ─────────────────────────────────────────────────────────────

/**
 * Search all 5 ATF airlines in parallel for a single route + date.
 * Consumes 5 API calls (one per airline). Budget: 150/month = 30 full searches.
 */
export async function searchATF(
  origin: string,
  destination: string,
  date: string,
): Promise<ATFResult[]> {
  const apiKey = loadApiKey()

  process.stderr.write(
    `🔍 ATF: ${origin}→${destination} ${date} (${ATF_AIRLINES.length} airlines = ${ATF_AIRLINES.length} calls)\n`
  )

  const results = await Promise.all(
    ATF_AIRLINES.map(airline => fetchATFAirline(apiKey, airline, origin, destination, date))
  )

  const successful = results.filter(r => !r.error && r.response?.success)
  const failed = results.filter(r => r.error || !r.response?.success)

  for (const f of failed) {
    process.stderr.write(`  ❌ ATF ${f.airline}: ${f.error || "API returned success=false"}\n`)
  }
  process.stderr.write(`  ✅ ATF: ${successful.length}/${ATF_AIRLINES.length} airlines responded\n`)

  // Report current usage from last successful response
  const lastUsage = successful[successful.length - 1]?.response?.usage
  if (lastUsage) {
    const used = lastUsage.monthly_limit - lastUsage.remaining_calls
    process.stderr.write(
      `  📊 ATF budget: ${used}/${lastUsage.monthly_limit} calls used (${lastUsage.remaining_calls} remaining)\n`
    )
  }

  return results
}

// ─── Airline Metadata ─────────────────────────────────────────────────────────

export const ATF_AIRLINE_META: Record<ATFAirline, { name: string; programKey: string; programName: string }> = {
  british_airways:  { name: "British Airways",  programKey: "BRITISH_AIRWAYS", programName: "BA Avios" },
  qatar_airways:    { name: "Qatar Airways",     programKey: "QATAR",           programName: "Qatar Privilege Club" },
  cathay_pacific:   { name: "Cathay Pacific",    programKey: "CATHAY",          programName: "Asia Miles" },
  virgin_atlantic:  { name: "Virgin Atlantic",   programKey: "VIRGIN_ATLANTIC", programName: "Virgin Points" },
  iberia:           { name: "Iberia",            programKey: "IBERIA",          programName: "Iberia Plus" },
}

// ─── Booking URLs ─────────────────────────────────────────────────────────────

function buildATFBookingUrl(
  airline: ATFAirline,
  origin: string,
  destination: string,
  date: string,
  cabin: string,
): string {
  switch (airline) {
    case "british_airways":
      return `https://www.britishairways.com/travel/redeem/execclub/_gf/en_us?eId=111095&from=${origin}&to=${destination}&depDate=${date}&cabin=${cabin === "first" ? "F" : cabin === "business" ? "C" : "M"}&ad=1&ch=0&inf=0&yf=0`
    case "qatar_airways":
      return `https://booking.qatarairways.com/nsp/views/showBooking.action?widget=QR&searchType=F&bookingClass=${cabin === "first" ? "F" : cabin === "business" ? "C" : "E"}&tripType=O&from=${origin}&to=${destination}&departing=${date}&adult=1&child=0&infant=0&bookAward=true`
    case "cathay_pacific":
      return `https://www.cathaypacific.com/cx/en_HK/book-a-trip/redeem-flights/redeem-flight-awards.html?origin=${origin}&destination=${destination}&departDate=${date}`
    case "virgin_atlantic":
      return `https://www.virginatlantic.com/flight-search/select-flights?origin=${origin}&destination=${destination}&awardSearch=true&departureDate=${date}&adult=1`
    case "iberia":
      return `https://www.iberia.com/vuelos/ofertas/avios/?origin=${origin}&destination=${destination}&departureDate=${date}&passengers=1&type=OW`
    default:
      return "https://awardtravelfinder.com"
  }
}

// ─── Conversion to Unified Format ─────────────────────────────────────────────

/**
 * Convert ATF API results to UnifiedFlightResult format.
 * Each available cabin per airline becomes one UnifiedFlightResult.
 */
export function atfToUnified(atfResults: ATFResult[]): UnifiedFlightResult[] {
  const unified: UnifiedFlightResult[] = []

  for (const result of atfResults) {
    if (result.error || !result.response?.success || !result.response.data) continue

    const { airline, origin, destination, date } = result
    const meta = ATF_AIRLINE_META[airline]
    const availability = result.response.data.availability

    const cabinEntries = Object.entries(availability.cabins) as [string, ATFCabin][]

    for (const [cabinKey, cabin] of cabinEntries) {
      if (!cabin.available || !cabin.points) continue

      // Normalize taxes: ATF returns taxes in GBP for BA/VA/IB routes
      // Convert to USD at approximate 1.27 rate
      let taxesUSD = cabin.taxes || 0
      if (cabin.taxes_currency === "GBP") {
        taxesUSD = Math.round((cabin.taxes || 0) * 1.27)
      }

      unified.push({
        id: `atf-${airline}-${cabinKey}-${unified.length}`,
        source: "atf" as any,  // "atf" extends the source union; type updated in roame-scraper.ts
        type: "award",
        origin,
        destination,
        airline: meta.name,
        operatingAirlines: [meta.name],
        flightNumbers: [],          // ATF doesn't expose flight numbers
        stops: 0,                   // ATF doesn't expose stop count
        durationMinutes: 0,
        departureTime: date,
        arrivalTime: date,
        airports: [origin, destination],
        cabinClass: cabinKey,
        equipment: [],
        points: cabin.points,
        pointsProgram: meta.programKey,
        cashPrice: null,
        taxes: taxesUSD,
        currency: "USD",
        cppValue: null,             // computed by value-engine
        roameScore: null,
        availableSeats: cabin.seats || null,
        bookingUrl: buildATFBookingUrl(airline, origin, destination, date, cabinKey),
        fareClass: `atf:${meta.programKey}:${cabinKey}`,
        travelDate: date,
      })
    }
  }

  return unified
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
Award Travel Finder (ATF) Scraper

Usage:
  npx tsx atf-scraper.ts --from LAX --to LHR --date 2026-03-15 [options]

Options:
  --from <IATA>        Origin airport (default: LAX)
  --to <IATA>          Destination airport (default: LHR)
  --date <YYYY-MM-DD>  Departure date (default: 2026-03-15)
  --output <file>      Output file (default: atf-results.json)
  --unified            Also output unified format
  --quiet              Suppress table output (stderr warnings still shown)

Airlines searched: ${ATF_AIRLINES.join(", ")}
Rate limit: ${MONTHLY_LIMIT} calls/month. Each search = ${ATF_AIRLINES.length} calls = ~${Math.floor(MONTHLY_LIMIT / ATF_AIRLINES.length)} full searches/month.
`)
    process.exit(0)
  }

  const origin = getArg("--from", "LAX")
  const destination = getArg("--to", "LHR")
  const date = getArg("--date", "2026-03-15")
  const outputFile = getArg("--output", "atf-results.json")
  const quiet = hasFlag("--quiet")
  const unified = hasFlag("--unified")

  const results = await searchATF(origin, destination, date)

  if (!quiet) {
    console.log(`\n${"═".repeat(80)}`)
    console.log(`🏆 ATF Results: ${origin} → ${destination} on ${date}`)
    console.log(`${"═".repeat(80)}`)

    for (const result of results) {
      const meta = ATF_AIRLINE_META[result.airline]
      if (result.error) {
        console.log(`\n❌ ${meta.name}: ${result.error}`)
        continue
      }
      if (!result.response?.success) {
        console.log(`\n⚠️  ${meta.name}: API returned success=false`)
        continue
      }

      const cabins = result.response.data.availability.cabins
      const available = (Object.entries(cabins) as [string, ATFCabin][]).filter(
        ([, c]) => c.available && c.points
      )

      if (available.length === 0) {
        console.log(`\n${meta.name}: No availability`)
        continue
      }

      console.log(`\n${meta.name} (${meta.programName}):`)
      console.log(`${"─".repeat(60)}`)
      for (const [cabinKey, cabin] of available) {
        const taxStr = cabin.taxes ? ` + ${cabin.taxes_currency || "USD"}${cabin.taxes} taxes` : ""
        const seatsStr = cabin.seats ? ` (${cabin.seats} seat${cabin.seats !== 1 ? "s" : ""})` : ""
        console.log(`  ${cabinKey.padEnd(18)} ${cabin.points!.toLocaleString().padStart(8)} pts${taxStr}${seatsStr}`)
      }
    }
    console.log()
  }

  // Save raw results
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2))
  if (!quiet) console.log(`💾 Raw results saved to ${outputFile}`)

  // Save unified format if requested
  if (unified) {
    const unifiedResults = atfToUnified(results)
    const unifiedFile = outputFile.replace(".json", "-unified.json")
    fs.writeFileSync(unifiedFile, JSON.stringify(unifiedResults, null, 2))
    if (!quiet) console.log(`💾 Unified results saved to ${unifiedFile}`)
  }
}

// Run CLI if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("atf-scraper.ts") ||
  process.argv[1].endsWith("atf-scraper.js")
)
if (isMain) {
  main().catch(err => {
    console.error("❌", err.message)
    process.exit(1)
  })
}
