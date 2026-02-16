/**
 * Sweet Spot Database
 * 
 * Known high-value award redemptions by program, route type, and cabin.
 * Used to flag when search results hit a sweet spot — "book this, it's a steal."
 * 
 * Sources: TPG, OMAAT, FlyerTalk, Prince of Travel (as of Feb 2026)
 */

export interface SweetSpot {
  id: string
  program: string               // Program key (matches Roame keys)
  programName: string
  routeType: string             // e.g. "US-Europe", "US-Asia", "Intra-US"
  origins?: string[]            // Specific airports (empty = any)
  destinations?: string[]       // Specific airports (empty = any)
  originRegions?: string[]      // Region codes
  destRegions?: string[]        // Region codes
  cabin: "economy" | "premium_economy" | "business" | "first"
  maxPoints: number             // Award at or below this = sweet spot
  typicalCashPrice: number      // What this usually costs in cash
  expectedCpp: number           // Expected cents per point
  description: string           // Why this is good
  bookingTip?: string           // How to actually book it
  airlines?: string[]           // Specific airlines this applies to
  oneWay: boolean               // Is this a one-way price?
}

// ─── Region Definitions ──────────────────────────────────────────────────────

const US_AIRPORTS = ["LAX", "JFK", "SFO", "ORD", "MIA", "EWR", "IAD", "DFW", "ATL", "SEA", "BOS", "IAH", "DEN", "PHX", "LAS"]
const EUROPE_AIRPORTS = ["LHR", "CDG", "AMS", "FRA", "FCO", "MAD", "BCN", "IST", "ZRH", "MUC", "VIE", "CPH", "DUB", "LIS"]
const ASIA_AIRPORTS = ["NRT", "HND", "ICN", "HKG", "SIN", "BKK", "TPE", "KUL", "CGK", "MNL", "DEL", "BOM", "PVG", "PEK"]
const MIDDLE_EAST_AIRPORTS = ["DXB", "DOH", "AUH", "JED", "RUH", "AMM", "TLV"]
const OCEANIA_AIRPORTS = ["SYD", "MEL", "AKL", "BNE"]

function matchesRegion(airport: string, region: string): boolean {
  switch (region) {
    case "US": return US_AIRPORTS.includes(airport)
    case "Europe": return EUROPE_AIRPORTS.includes(airport)
    case "Asia": return ASIA_AIRPORTS.includes(airport)
    case "Middle East": return MIDDLE_EAST_AIRPORTS.includes(airport)
    case "Oceania": return OCEANIA_AIRPORTS.includes(airport)
    default: return false
  }
}

// ─── Sweet Spot Database ─────────────────────────────────────────────────────

export const SWEET_SPOTS: SweetSpot[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // FLYING BLUE — Known for flash deals and reasonable J pricing
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "fb-us-europe-j",
    program: "FLYING_BLUE", programName: "Flying Blue",
    routeType: "US-Europe", originRegions: ["US"], destRegions: ["Europe"],
    cabin: "business", maxPoints: 55000, typicalCashPrice: 4000, expectedCpp: 7.0,
    description: "Flying Blue J to Europe is one of the best sweet spots. 50-55K one-way on AF/KLM metal.",
    bookingTip: "Book on airfrance.us, look for Promo Rewards for even lower (37.5K). Transfer from Chase UR or Amex MR.",
    airlines: ["Air France", "KLM"],
    oneWay: true,
  },
  {
    id: "fb-us-europe-y",
    program: "FLYING_BLUE", programName: "Flying Blue",
    routeType: "US-Europe", originRegions: ["US"], destRegions: ["Europe"],
    cabin: "economy", maxPoints: 22000, typicalCashPrice: 600, expectedCpp: 2.7,
    description: "Flying Blue Y to Europe at 15-22K is solid value, especially on promo.",
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AEROPLAN — Incredible sweet spots, especially mixed-cabin
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "ac-us-europe-j",
    program: "AEROPLAN", programName: "Aeroplan",
    routeType: "US-Europe", originRegions: ["US"], destRegions: ["Europe"],
    cabin: "business", maxPoints: 70000, typicalCashPrice: 5000, expectedCpp: 6.5,
    description: "Aeroplan J to Europe on Star Alliance (Lufthansa, Swiss, Turkish, LOT). 60-70K standard.",
    bookingTip: "Book through aeroplan.com. Can route through IST for Turkish J.",
    airlines: ["Lufthansa", "Swiss", "Turkish Airlines", "LOT", "TAP"],
    oneWay: true,
  },
  {
    id: "ac-us-asia-j",
    program: "AEROPLAN", programName: "Aeroplan",
    routeType: "US-Asia", originRegions: ["US"], destRegions: ["Asia"],
    cabin: "business", maxPoints: 75000, typicalCashPrice: 6000, expectedCpp: 7.5,
    description: "Aeroplan 75K J to Asia is ELITE. ANA, EVA, Singapore on Star Alliance metal.",
    bookingTip: "ANA J via aeroplan.com is the holy grail — 75K and no fuel surcharges on ANA metal.",
    airlines: ["ANA", "EVA Air", "Singapore Airlines", "Asiana"],
    oneWay: true,
  },
  {
    id: "ac-us-middle-east-j",
    program: "AEROPLAN", programName: "Aeroplan",
    routeType: "US-Middle East", originRegions: ["US"], destRegions: ["Middle East"],
    cabin: "business", maxPoints: 70000, typicalCashPrice: 5500, expectedCpp: 7.0,
    description: "Aeroplan to Middle East via Turkish J through IST. 70K standard.",
    bookingTip: "Turkish J through IST is excellent product. Also Ethiopian J is underrated.",
    airlines: ["Turkish Airlines", "Ethiopian Airlines"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // VIRGIN ATLANTIC — ANA F sweet spot, Delta partner awards
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "vs-us-japan-f",
    program: "VIRGIN_ATLANTIC", programName: "Virgin Atlantic",
    routeType: "US-Japan", originRegions: ["US"], destinations: ["NRT", "HND"],
    cabin: "first", maxPoints: 120000, typicalCashPrice: 15000, expectedCpp: 12.0,
    description: "ANA F booked through Virgin Atlantic — 110-120K RT. The GOAT of award travel.",
    bookingTip: "Must book RT. Check ANA availability on United.com first, then call VS. Transfer from Chase UR.",
    airlines: ["ANA"],
    oneWay: false,
  },
  {
    id: "vs-us-europe-delta-j",
    program: "VIRGIN_ATLANTIC", programName: "Virgin Atlantic",
    routeType: "US-Europe", originRegions: ["US"], destRegions: ["Europe"],
    cabin: "business", maxPoints: 50000, typicalCashPrice: 4000, expectedCpp: 7.5,
    description: "Delta One booked via Virgin Atlantic. 50K OW when available.",
    bookingTip: "Search delta.com for award space, then book on VS site. Transfer from Chase UR.",
    airlines: ["Delta"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ALASKA — Partner award chart is gold
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "as-cathay-j",
    program: "ALASKA", programName: "Alaska Mileage Plan",
    routeType: "US-Asia", originRegions: ["US"], destRegions: ["Asia"],
    cabin: "business", maxPoints: 50000, typicalCashPrice: 5000, expectedCpp: 9.0,
    description: "Cathay Pacific J via Alaska — 50K OW is legendary value.",
    bookingTip: "Search BA.com for Cathay availability. Call Alaska to book. Availability is rare but incredible.",
    airlines: ["Cathay Pacific"],
    oneWay: true,
  },
  {
    id: "as-jal-j",
    program: "ALASKA", programName: "Alaska Mileage Plan",
    routeType: "US-Asia", originRegions: ["US"], destRegions: ["Asia"],
    cabin: "business", maxPoints: 60000, typicalCashPrice: 6000, expectedCpp: 9.0,
    description: "JAL J via Alaska — 60K OW with no fuel surcharges. Amazing product.",
    bookingTip: "Check JAL.com for availability, call Alaska to book. LAX/SFO/SEA routes.",
    airlines: ["Japan Airlines"],
    oneWay: true,
  },
  {
    id: "as-emirates-f",
    program: "ALASKA", programName: "Alaska Mileage Plan",
    routeType: "US-Middle East", originRegions: ["US"], destRegions: ["Middle East"],
    cabin: "first", maxPoints: 115000, typicalCashPrice: 12000, expectedCpp: 10.0,
    description: "Emirates F via Alaska — 115K OW. One of the best F products in the sky.",
    bookingTip: "Check Emirates.com for availability (no fuel surcharges via Alaska). Very limited seats.",
    airlines: ["Emirates"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BA AVIOS — Short-haul king
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "ba-short-haul-y",
    program: "BRITISH_AIRWAYS", programName: "BA Avios",
    routeType: "Short-haul", originRegions: ["US"],
    cabin: "economy", maxPoints: 7500, typicalCashPrice: 200, expectedCpp: 2.5,
    description: "Avios on AA short-haul (under 1150mi) — 7,500 one-way. NYC-MIA, LAX-SFO, etc.",
    bookingTip: "Book on BA.com using AA flight numbers. No fuel surcharges on AA metal.",
    airlines: ["American Airlines"],
    oneWay: true,
  },
  {
    id: "ba-short-haul-j",
    program: "BRITISH_AIRWAYS", programName: "BA Avios",
    routeType: "Short-haul", originRegions: ["US"],
    cabin: "business", maxPoints: 15000, typicalCashPrice: 500, expectedCpp: 3.0,
    description: "Avios for AA domestic first — 15K OW on routes under 1150mi.",
    airlines: ["American Airlines"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TURKISH — Excellent for Star Alliance awards, especially to Africa/ME
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "tk-us-ist-j",
    program: "TURKISH", programName: "Turkish Miles&Smiles",
    routeType: "US-Istanbul", originRegions: ["US"], destinations: ["IST"],
    cabin: "business", maxPoints: 45000, typicalCashPrice: 4000, expectedCpp: 8.0,
    description: "Turkish J to IST — 45K OW. Outstanding product and lounge.",
    bookingTip: "Book on turkishairlines.com. Transfer from Bilt.",
    airlines: ["Turkish Airlines"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UNITED — Decent for domestic, mediocre for international
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "ua-domestic-y",
    program: "UNITED", programName: "United MileagePlus",
    routeType: "Intra-US", originRegions: ["US"], destRegions: ["US"],
    cabin: "economy", maxPoints: 12500, typicalCashPrice: 250, expectedCpp: 1.8,
    description: "United saver Y domestic — 10-12.5K OW. Decent for transcontinental.",
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════  
  // EMIRATES — Aspirational F class
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "ek-us-dxb-j",
    program: "EMIRATES", programName: "Emirates Skywards",
    routeType: "US-Dubai", originRegions: ["US"], destinations: ["DXB"],
    cabin: "business", maxPoints: 72500, typicalCashPrice: 5000, expectedCpp: 6.5,
    description: "Emirates J direct to DXB — 72.5K OW. Game changer when available.",
    bookingTip: "Search emirates.com, pay with Skywards. Transfer from Amex MR or Bilt.",
    airlines: ["Emirates"],
    oneWay: true,
  },
  {
    id: "ek-us-dxb-f",
    program: "EMIRATES", programName: "Emirates Skywards",
    routeType: "US-Dubai", originRegions: ["US"], destinations: ["DXB"],
    cabin: "first", maxPoints: 136000, typicalCashPrice: 12000, expectedCpp: 8.5,
    description: "Emirates F to DXB — the iconic shower suite experience. 136K OW.",
    airlines: ["Emirates"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // QATAR — QSuites is the GOAT J product
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "qr-us-doha-j",
    program: "QATAR", programName: "Qatar Privilege Club",
    routeType: "US-Middle East", originRegions: ["US"], destinations: ["DOH"],
    cabin: "business", maxPoints: 70000, typicalCashPrice: 5500, expectedCpp: 7.0,
    description: "QSuites is the best business class in the sky. 70K OW to DOH.",
    bookingTip: "Book on qatarairways.com. Transfer from Amex MR.",
    airlines: ["Qatar Airways"],
    oneWay: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DELTA — Revenue-based, but occasional gems
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "dl-flash-j",
    program: "DELTA", programName: "Delta SkyMiles",
    routeType: "US-Europe", originRegions: ["US"], destRegions: ["Europe"],
    cabin: "business", maxPoints: 80000, typicalCashPrice: 4000, expectedCpp: 4.5,
    description: "Delta One flash sales to Europe — 60-80K when they appear.",
    bookingTip: "Check delta.com frequently. No fuel surcharges. Also bookable via VS.",
    airlines: ["Delta"],
    oneWay: true,
  },
]

// ─── Matching Engine ─────────────────────────────────────────────────────────

export interface SweetSpotMatch {
  spot: SweetSpot
  matchScore: number      // 0-100, how well this matches
  pointsSaved: number     // vs typical award pricing
  actualCpp: number       // Calculated from actual cash price
  label: string           // Short label for badges
}

/**
 * Check if a flight result matches any sweet spots
 */
export function matchSweetSpots(
  origin: string,
  destination: string,
  program: string,
  cabin: string,
  points: number,
  cashComparable: number | null,
): SweetSpotMatch[] {
  const matches: SweetSpotMatch[] = []
  
  for (const spot of SWEET_SPOTS) {
    // Program must match
    if (spot.program !== program) continue
    
    // Cabin must match
    if (spot.cabin !== cabin) continue
    
    // Check region/airport matching
    let routeMatches = false
    
    // Specific airport match
    if (spot.origins?.length && spot.destinations?.length) {
      routeMatches = spot.origins.includes(origin) && spot.destinations.includes(destination)
    } else if (spot.originRegions?.length && spot.destRegions?.length) {
      const originMatch = spot.originRegions.some(r => matchesRegion(origin, r))
      const destMatch = spot.destRegions.some(r => matchesRegion(destination, r))
      routeMatches = originMatch && destMatch
    } else if (spot.originRegions?.length && spot.destinations?.length) {
      routeMatches = spot.originRegions.some(r => matchesRegion(origin, r)) && spot.destinations.includes(destination)
    } else if (spot.originRegions?.length) {
      // Short-haul spots might only specify origin region
      routeMatches = spot.originRegions.some(r => matchesRegion(origin, r))
    }
    
    if (!routeMatches) continue
    
    // Points must be at or below the sweet spot threshold
    if (points > spot.maxPoints) continue
    
    // Calculate actual value
    const cashRef = cashComparable || spot.typicalCashPrice
    const actualCpp = points > 0 ? (cashRef / (points / 100)) : 0
    const pointsSaved = spot.maxPoints - points  // Below max = even sweeter
    
    let matchScore = 70  // Base score for matching
    
    // Bonus for being well under max points
    const pctUnderMax = (spot.maxPoints - points) / spot.maxPoints
    matchScore += Math.round(pctUnderMax * 20)
    
    // Bonus for high cpp
    if (actualCpp >= spot.expectedCpp) matchScore += 10
    
    matches.push({
      spot,
      matchScore: Math.min(100, matchScore),
      pointsSaved,
      actualCpp: Math.round(actualCpp * 10) / 10,
      label: `🎯 SWEET SPOT: ${spot.description.slice(0, 60)}`,
    })
  }
  
  return matches.sort((a, b) => b.matchScore - a.matchScore)
}

/**
 * Get all sweet spots relevant to a route (even if no matching results yet)
 * Useful for showing "here's what to look for" on this route
 */
export function getSweetSpotsForRoute(origin: string, destination: string): SweetSpot[] {
  return SWEET_SPOTS.filter(spot => {
    if (spot.origins?.length && spot.destinations?.length) {
      return spot.origins.includes(origin) && spot.destinations.includes(destination)
    }
    if (spot.originRegions?.length && spot.destRegions?.length) {
      return spot.originRegions.some(r => matchesRegion(origin, r)) &&
             spot.destRegions.some(r => matchesRegion(destination, r))
    }
    if (spot.originRegions?.length && spot.destinations?.length) {
      return spot.originRegions.some(r => matchesRegion(origin, r)) && spot.destinations.includes(destination)
    }
    return false
  })
}
