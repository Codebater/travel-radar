/**
 * Shadow anomaly engine — types.
 *
 * SHADOW MODE: this package decides what it THINKS is exceptional and records
 * that decision. It sends nothing. There is deliberately no notifier, no
 * transport and no "alert" type in here — enabling alerts is a later phase and
 * must be a visible, reviewed change rather than a config flip.
 *
 * Every figure is relative to OBSERVATIONS BY THIS RADAR. "Median" always means
 * "median of what we have seen", never a market price.
 */

export type CandidateType = "cash" | "award"
export type TripType = "oneway" | "return"

export type ConfidenceLabel =
  | "INSUFFICIENT" | "VERY_LOW" | "LOW" | "MEDIUM" | "HIGHER"

/** A machine-readable reason plus the human detail that produced it. */
export interface Reason {
  code: string
  detail: string
}

/**
 * The dimensions an observation must share before two prices may be compared
 * (§L). origin/destination/cabin/tripType are hard — the others may be relaxed
 * when the strict sample is too thin, and the relaxation is recorded.
 */
export interface ComparabilityKey {
  origin: string
  destination: string
  cabin: string
  tripType: TripType
  tripLengthBucket: string | null
  directness: "direct" | "connecting" | "unknown"
  /** Awards only: a program's price is meaningless next to another program's. */
  loyaltyProgram?: string | null
}

/** Features preserved for a later seasonality model (§M). Not used in scoring. */
export interface ObservationFeatures {
  travelMonth: number             // 1-12 of the departure date
  departureWeekday: number        // 0=Sunday
  tripLengthNights: number | null
  daysUntilDeparture: number      // relative to when it was OBSERVED, not now
}

export interface BaselineStats {
  key: string
  scope: string                   // "strict" | "relaxed:directness" | …
  /** Values in the baseline: prices for cash, points for awards. */
  count: number
  min: number
  max: number
  median: number
  /** Where the current value sits among the baseline, 0 = cheapest ever seen. */
  percentile: number
  percentBelowMedian: number
  differenceFromMinimum: number
  firstAt: string
  lastAt: string
  ageDays: number
  confidence: ConfidenceLabel
  confidenceValue: number
  /** Awards only: median surcharge in the baseline, per currency. */
  medianTaxes: number | null
  taxesCurrency: string | null
  isNewObservedLow: boolean
}

export interface ScoreComponent {
  raw: number                     // 0..1 before weighting
  weight: number
  points: number                  // raw * weight * 100
  detail: string
}

export interface ScoreResult {
  score: number                   // 0-100, EXPERIMENTAL
  components: Record<string, ScoreComponent>
  weightsVersion: string
  /** Weights actually applied after dropping unavailable components. */
  effectiveWeights: Record<string, number>
}

export interface CashProvenance {
  provider: string | null
  verificationLevel: string | null
  samples: number
  medianPrice: number | null
  currency: string | null
  ageDays: number | null
}

export interface CppResult {
  cpp: number | null              // cents per point
  basis: "verified" | "discovered" | "none"
  confidence: ConfidenceLabel
  cashProvenance: CashProvenance
}

/** One program's offer for a shared itinerary (§Q). */
export interface ProgramOffer {
  loyaltyProgram: string
  points: number
  taxesAmount: number | null
  taxesCurrency: string | null
  cpp: number | null
  percentBelowMedian: number | null
  provider: string
  bookable: boolean | null        // null when balances are unavailable
  pointsShortfall: number | null
}

export interface ProgramComparison {
  itineraryHash: string
  offers: ProgramOffer[]
  winners: {
    lowestPoints: string | null
    lowestTaxes: string | null
    highestCpp: string | null
    bestVsBaseline: string | null
    bookable: string[]
  }
  note: string
}

export interface DealCandidate {
  id?: number
  sourceTable: "flight_prices" | "award_prices"
  sourceId: number
  observedAt: string
  asOf: string
  evaluatedAt: string

  type: CandidateType
  origin: string
  destination: string
  route: string
  departureDate: string
  returnDate: string | null
  tripType: TripType
  cabin: string
  airline: string | null
  stops: number | null
  itineraryHash: string | null

  loyaltyProgram: string | null
  priceAmount: number | null
  priceCurrency: string | null
  points: number | null
  taxesAmount: number | null
  taxesCurrency: string | null

  baseline: BaselineStats
  cpp: CppResult | null
  programComparison: ProgramComparison | null

  provider: string
  providerConfidence: string
  verificationLevel: string

  score: number
  scoreBreakdown: ScoreResult
  reasons: Reason[]
  features: ObservationFeatures
  presetsMatched: string[]
  threshold: number
  /** candidate = at/above threshold; below-threshold rows are kept for review. */
  status: "candidate" | "below-threshold"
  engineVersion: string
}

export type FeedbackVerdict = "GOOD_DEAL" | "NORMAL" | "BAD_SIGNAL"
