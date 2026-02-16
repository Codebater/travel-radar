#!/usr/bin/env tsx
/**
 * Roame.travel Award Flight Scraper
 * 
 * Uses Roame's GraphQL API to search award availability across ALL mileage programs
 * in a single query. This effectively replaces individual airline scrapers for award search.
 * 
 * Requires: ~/.openclaw/credentials/roame.json with session cookie
 * 
 * Usage:
 *   npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 [--class PREM|ECON] [--programs ALL]
 *   npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 --class ECON --output results.json
 */

import fs from "fs"
import path from "path"

const CREDENTIALS_PATH = path.join(process.env.HOME!, ".openclaw/credentials/roame.json")
const GRAPHQL_URL = "https://roame.travel/api/graphql"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RoameFare {
  arrivalDatetime: string
  availableSeats: number | null
  departureDate: string
  operatingAirlines: string[]
  flightsDepartureDatetimes: string[]
  flightsArrivalDatetimes: string[]
  fareClass: string
  flightNumberOrder: string[]
  durationMinutes: number
  equipmentTypes: string[]
  allAirports: string[]
  numStops: number
  mileageProgram: string
  percentPremiumInt: number
  cabinClasses: string[]
  originIata: string
  destinationIata: string
  departureDateStr: string
  awardPoints: number
  surcharge: number
  roameScore: number
}

export interface RoameSearchResult {
  search: {
    origin: string
    destination: string
    date: string
    searchClass: string
    percentCompleted: number
  }
  fares: RoameFare[]
  programs: Record<string, RoameFare[]>
  totalFares: number
  timestamp: string
}

export interface UnifiedFlightResult {
  id: string
  source: "roame" | "aa-direct" | "google" | "estimate"
  type: "award" | "cash"
  // Route info
  origin: string
  destination: string
  airline: string
  operatingAirlines: string[]
  flightNumbers: string[]
  stops: number
  durationMinutes: number
  departureTime: string
  arrivalTime: string
  airports: string[]
  cabinClass: string
  equipment: string[]
  // Pricing
  points: number | null
  pointsProgram: string | null
  cashPrice: number | null
  taxes: number
  currency: string
  // Valuation
  cppValue: number | null
  roameScore: number | null
  availableSeats: number | null
  // Booking
  bookingUrl: string
  fareClass: string
}

// ─── Credentials ─────────────────────────────────────────────────────────────

interface RoameCredentials {
  session: string
  csrfSecret: string
  sessionExpiresAt: number
}

function loadCredentials(): RoameCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Roame credentials not found at ${CREDENTIALS_PATH}.\n` +
      `Login to roame.travel in browser, then save session cookie to this file.`
    )
  }
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")) as RoameCredentials
  
  // Check expiry
  if (creds.sessionExpiresAt && Date.now() > creds.sessionExpiresAt) {
    throw new Error(
      `Roame session expired on ${new Date(creds.sessionExpiresAt).toISOString()}.\n` +
      `Login to roame.travel again and update ${CREDENTIALS_PATH}`
    )
  }
  
  return creds
}

// ─── GraphQL Client ──────────────────────────────────────────────────────────

async function graphql(query: string, variables: Record<string, any>, creds?: RoameCredentials): Promise<any> {
  const credentials = creds || loadCredentials()
  
  const resp = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `session=${credentials.session}; csrfSecret=${credentials.csrfSecret}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  
  if (!resp.ok) {
    throw new Error(`Roame API HTTP ${resp.status}: ${resp.statusText}`)
  }
  
  const json = await resp.json()
  if (json.errors) {
    const msg = json.errors.map((e: any) => e.message).join("; ")
    throw new Error(`Roame GraphQL error: ${msg}`)
  }
  
  return json
}

// ─── Search Functions ────────────────────────────────────────────────────────

export async function initiateSearch(
  origin: string,
  destination: string,
  date: string,
  searchClass: string = "PREM",
  mileagePrograms: string[] = ["ALL"],
  creds?: RoameCredentials
): Promise<string> {
  const result = await graphql(
    `mutation initiateFlightSearchMutation($flightSearchInput: FlightSearchInput!) {
      initiateFlightSearch(flightSearchInput: $flightSearchInput) { jobUUID }
    }`,
    {
      flightSearchInput: {
        origin,
        destination,
        departureDate: date,
        pax: 1,
        searchClass,
        mileagePrograms,
        preSearch: false,
        daysAround: 0,
        tripLength: 0,
      }
    },
    creds
  )
  
  return result.data.initiateFlightSearch.jobUUID
}

export async function pollResults(
  jobUUID: string,
  maxWaitMs: number = 90000,
  onProgress?: (pct: number, fareCount: number) => void,
  creds?: RoameCredentials
): Promise<{ fares: RoameFare[], percentCompleted: number }> {
  const fareFragment = `
    arrivalDatetime availableSeats departureDate operatingAirlines
    flightsDepartureDatetimes flightsArrivalDatetimes fareClass
    flightNumberOrder durationMinutes equipmentTypes allAirports
    numStops mileageProgram percentPremiumInt cabinClasses
    originIata destinationIata departureDateStr awardPoints
    surcharge roameScore
  `
  
  const start = Date.now()
  let lastPct = 0
  let lastFareCount = 0
  let staleCount = 0
  
  while (Date.now() - start < maxWaitMs) {
    const result = await graphql(
      `query pingSearchResultsQuery($jobUUID: String!) {
        pingSearchResults(jobUUID: $jobUUID) {
          percentCompleted
          fares { ${fareFragment} }
        }
      }`,
      { jobUUID },
      creds
    )
    
    const { percentCompleted, fares } = result.data.pingSearchResults
    onProgress?.(percentCompleted, fares.length)
    
    if (percentCompleted >= 100) {
      return { fares, percentCompleted }
    }
    
    // Detect stalled search (no progress for 3 polls = ~9 seconds)
    if (fares.length === lastFareCount && percentCompleted === lastPct) {
      staleCount++
      if (staleCount >= 4) {
        return { fares, percentCompleted }
      }
    } else {
      staleCount = 0
    }
    
    lastPct = percentCompleted
    lastFareCount = fares.length
    await new Promise(r => setTimeout(r, 3000))
  }
  
  return { fares: [], percentCompleted: lastPct }
}

// ─── Search Wrapper ──────────────────────────────────────────────────────────

export async function searchRoame(
  origin: string,
  destination: string,
  date: string,
  searchClass: string = "PREM",
  programs: string[] = ["ALL"],
  verbose: boolean = false,
): Promise<RoameSearchResult> {
  const creds = loadCredentials()
  
  if (verbose) {
    process.stdout.write(`🔍 Roame: ${origin}→${destination} ${date} (${searchClass})\n`)
  }
  
  const jobUUID = await initiateSearch(origin, destination, date, searchClass, programs, creds)
  if (verbose) process.stdout.write(`  Job: ${jobUUID}\n`)
  
  const { fares, percentCompleted } = await pollResults(
    jobUUID, 90000,
    verbose ? (pct, count) => process.stdout.write(`\r  Progress: ${pct}% | ${count} fares`) : undefined,
    creds
  )
  if (verbose) process.stdout.write("\n")
  
  // Group by program
  const byProgram: Record<string, RoameFare[]> = {}
  for (const fare of fares) {
    if (!byProgram[fare.mileageProgram]) byProgram[fare.mileageProgram] = []
    byProgram[fare.mileageProgram]!.push(fare)
  }
  
  return {
    search: { origin, destination, date, searchClass, percentCompleted },
    fares,
    programs: byProgram,
    totalFares: fares.length,
    timestamp: new Date().toISOString(),
  }
}

// ─── Conversion to Unified Format ────────────────────────────────────────────

const PROGRAM_BOOKING_URLS: Record<string, string> = {
  ALASKA: "https://www.alaskaair.com/booking/flights",
  UNITED: "https://www.united.com/ual/en/us/flight-search/book-a-flight/results/awd",
  AMERICAN: "https://www.aa.com/booking/find-flights",
  DELTA: "https://www.delta.com/flight-search/search",
  AEROPLAN: "https://www.aeroplan.com/en/use-your-points/travel.html",
  FLYING_BLUE: "https://wwws.airfrance.us/search/open-dates",
  BRITISH_AIRWAYS: "https://www.britishairways.com/travel/redeem/execclub/",
  QANTAS: "https://www.qantas.com/au/en/book-a-trip/flights.html",
  EMIRATES: "https://www.emirates.com/us/english/",
  QATAR: "https://www.qatarairways.com/en-us/homepage.html",
  SINGAPORE: "https://www.singaporeair.com/en_UK/ppsclub-krisflyer/",
  VIRGIN_ATLANTIC: "https://www.virginatlantic.com/",
  AVIANCA: "https://www.lifemiles.com/",
  CATHAY: "https://www.cathaypacific.com/",
  ETIHAD: "https://www.etihad.com/",
  ANA: "https://www.ana.co.jp/en/us/",
  JAL: "https://www.jal.co.jp/en/",
}

const PROGRAM_DISPLAY_NAMES: Record<string, string> = {
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
  VIRGIN_ATLANTIC: "Virgin Atlantic",
  AVIANCA: "LifeMiles",
  CATHAY: "Cathay Pacific Asia Miles",
  ETIHAD: "Etihad Guest",
  ANA: "ANA Mileage Club",
  JAL: "JAL Mileage Bank",
}

// Estimated cash prices for CPP calculation (per cabin per direction)
const CABIN_CASH_ESTIMATES: Record<string, number> = {
  economy: 800,
  premium_economy: 1500,
  business: 4000,
  first: 8000,
}

function guessCabinFromClasses(cabinClasses: string[]): string {
  const joined = cabinClasses.join(" ").toLowerCase()
  if (joined.includes("first") || joined.includes("suites")) return "first"
  if (joined.includes("business") || joined.includes("polaris") || joined.includes("qsuites") || joined.includes("flagship")) return "business"
  if (joined.includes("premium")) return "premium_economy"
  return "economy"
}

export function roameFaresToUnified(fares: RoameFare[], searchClass: string): UnifiedFlightResult[] {
  return fares.map((fare, idx) => {
    const cabin = guessCabinFromClasses(fare.cabinClasses)
    const estimatedCash = CABIN_CASH_ESTIMATES[cabin] || 800
    const cppValue = fare.awardPoints > 0 
      ? ((estimatedCash - fare.surcharge) / (fare.awardPoints / 100))
      : null
    
    return {
      id: `roame-${fare.mileageProgram}-${idx}`,
      source: "roame" as const,
      type: "award" as const,
      origin: fare.originIata,
      destination: fare.destinationIata,
      airline: fare.operatingAirlines.join(" / "),
      operatingAirlines: fare.operatingAirlines,
      flightNumbers: fare.flightNumberOrder,
      stops: fare.numStops,
      durationMinutes: fare.durationMinutes,
      departureTime: fare.flightsDepartureDatetimes[0] || fare.departureDateStr,
      arrivalTime: fare.arrivalDatetime,
      airports: fare.allAirports,
      cabinClass: cabin,
      equipment: fare.equipmentTypes,
      points: fare.awardPoints,
      pointsProgram: fare.mileageProgram,
      cashPrice: null,
      taxes: fare.surcharge,
      currency: "USD",
      cppValue: cppValue ? Math.round(cppValue * 10) / 10 : null,
      roameScore: fare.roameScore,
      availableSeats: fare.availableSeats,
      bookingUrl: PROGRAM_BOOKING_URLS[fare.mileageProgram] || `https://roame.travel`,
      fareClass: fare.fareClass,
    }
  })
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  
  // Parse args
  const getArg = (flag: string, def: string) => {
    const idx = args.indexOf(flag)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1]! : def
  }
  const hasFlag = (flag: string) => args.includes(flag)
  
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Roame Award Flight Scraper

Usage:
  npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 [options]

Options:
  --from <IATA>     Origin airport (default: LAX)
  --to <IATA>       Destination airport (default: DXB)
  --date <YYYY-MM-DD>  Departure date (default: 2026-04-28)
  --class <PREM|ECON>  Search class (default: PREM)
  --programs <list>    Comma-separated programs or ALL (default: ALL)
  --output <file>      Output file (default: roame-results.json)
  --unified            Also output unified format
  --quiet              Suppress progress output
`)
    process.exit(0)
  }
  
  const origin = getArg("--from", "LAX")
  const destination = getArg("--to", "DXB")
  const date = getArg("--date", "2026-04-28")
  const searchClass = getArg("--class", "PREM")
  const programsStr = getArg("--programs", "ALL")
  const outputFile = getArg("--output", "roame-results.json")
  const quiet = hasFlag("--quiet")
  const unified = hasFlag("--unified")
  
  const programs = programsStr === "ALL" ? ["ALL"] : programsStr.split(",")
  
  const result = await searchRoame(origin, destination, date, searchClass, programs, !quiet)
  
  // Display results
  if (!quiet) {
    console.log(`\n${"═".repeat(100)}`)
    console.log(`🏆 ${result.totalFares} fares from ${Object.keys(result.programs).length} programs (${result.search.percentCompleted}% complete)`)
    console.log(`${"═".repeat(100)}`)
    
    const sortedPrograms = Object.entries(result.programs).sort((a, b) => {
      const bestA = Math.min(...a[1].map(f => f.awardPoints))
      const bestB = Math.min(...b[1].map(f => f.awardPoints))
      return bestA - bestB
    })
    
    for (const [program, programFares] of sortedPrograms) {
      const displayName = PROGRAM_DISPLAY_NAMES[program] || program
      console.log(`\n${displayName} (${programFares.length} fares):`)
      console.log(`${"─".repeat(100)}`)
      
      const sorted = programFares.sort((a, b) => a.awardPoints - b.awardPoints)
      for (const fare of sorted.slice(0, 5)) {
        const cabins = fare.cabinClasses.join("/")
        const route = fare.allAirports.join("→")
        const airlines = fare.operatingAirlines.join("/")
        const flights = fare.flightNumberOrder.join(" / ")
        const duration = `${Math.floor(fare.durationMinutes / 60)}h${fare.durationMinutes % 60}m`
        const seats = fare.availableSeats ? `(${fare.availableSeats} seats)` : ""
        
        console.log(
          `  ${fare.awardPoints.toLocaleString().padStart(8)} pts + $${fare.surcharge.toFixed(0).padStart(5)}` +
          `  ${cabins.padEnd(25)} ${route.padEnd(30)} ${duration.padEnd(7)} ${airlines.padEnd(10)} ${flights} ${seats}`
        )
      }
      if (sorted.length > 5) console.log(`  ... and ${sorted.length - 5} more`)
    }
  }
  
  // Save raw results
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2))
  if (!quiet) console.log(`\n💾 Raw results saved to ${outputFile}`)
  
  // Save unified format if requested
  if (unified) {
    const unifiedResults = roameFaresToUnified(result.fares, searchClass)
    const unifiedFile = outputFile.replace(".json", "-unified.json")
    fs.writeFileSync(unifiedFile, JSON.stringify(unifiedResults, null, 2))
    if (!quiet) console.log(`💾 Unified results saved to ${unifiedFile}`)
  }
}

// Run CLI if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("roame-scraper.ts") || 
  process.argv[1].endsWith("roame-scraper.js")
)
if (isMain) {
  main().catch(err => {
    console.error("❌", err.message)
    process.exit(1)
  })
}
