/**
 * Trip Composer shapes. The core doctrine lives in the types:
 *
 *   - cash and miles NEVER blend: TripCost carries cash components (each
 *     with its currency), miles PER PROGRAM, and a list of NAMED unknowns.
 *     "$4,165 cash + 84,000 LifeMiles", never "$5,005 equivalent".
 *   - a trip's identity is price-free and derived (trips/identity.ts);
 *   - provenance is id links back to every underlying observation.
 */

export type TripConstruction = "cash" | "award" | "positioning_cash" | "open_jaw"

export interface CashComponent {
  kind: "airfare" | "award_taxes" | "positioning" | "stay" | "transfer"
  amount: number
  currency: string
  detail: string
}

export interface MilesComponent {
  program: string
  miles: number
  legs: string
}

export interface TripCost {
  cashComponents: CashComponent[]
  /** Set only when EVERY cash component shares one currency. */
  cashTotal: { amount: number; currency: string } | null
  milesComponents: MilesComponent[]
  /** What this trip does NOT know, by name. Absent cost ≠ zero cost. */
  unknownCosts: string[]
}

export interface FlightSide {
  construction: TripConstruction
  origin: string
  destinationAirport: string
  outboundDeparture: string
  returnDeparture: string | null
  cabin: string
  /** Human detail per leg: airline, price/points, stops. */
  legs: {
    direction: "outbound" | "return"
    airline: string | null
    stops: number | null
    price: { amount: number; currency: string } | null
    points: { program: string; miles: number } | null
    taxes: { amount: number; currency: string } | null
    sourceId: number
    sourceTable: "flight_prices" | "award_prices"
    verificationLevel: string
  }[]
  /** 0..1 quality of the flight side, with how it was derived. */
  quality: number
  qualityDetail: string
  candidateScore: number | null
}

export interface StaySide {
  windowKey: string
  propertyId: string
  propertyName: string
  destinationGroup: string
  nearestAirports: string[]
  checkIn: string
  checkOut: string
  nights: number
  board: string
  roomClass: string | null
  roomName: string | null
  nightly: number
  stayTotal: number
  currency: string
  taxStatus: string
  verificationStatus: string
  persistence: string
  refundable: boolean | null
  quality: number
  qualityDetail: string
  candidateId: number | null
  observationIds: number[]
}

export interface ComposedTrip {
  tripKey: string
  flight: FlightSide
  stay: StaySide
  adults: number
  cost: TripCost
  dateCompatibility: { value: number; detail: string }
  complexity: { flags: string[]; penalty: number }
  tripAbsolute: { tier: string | null; score: number; rulePath: string; perNight: number | null; detail: string }
  evidenceValue: number
  usabilityValue: number
  admissionGate: string
  score: number
  scoreBreakdown: Record<string, unknown>
  reasons: string[]
  status: "interesting" | "rejected"
  rejectionReason: string | null
}

export interface ComposeSummary {
  stayWindowsConsidered: number
  flightOptionsConsidered: number
  combinationsExamined: number
  feasible: number
  admitted: number
  stored: number
  rejected: Record<string, number>
  ceilingsHit: string[]
  durationMs: number
}
