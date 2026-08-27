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

/** §20 how a candidate was found - see discovery/types.ts for the vocabulary. */
export type DiscoveryMethod =
  | "FIXED_OBSERVER" | "FLEXIBLE_DATE" | "POSITIONING"
  | "OPEN_JAW" | "WILDCARD" | "TAKE_ME_ANYWHERE"

/**
 * §2/§13 - what an open-jaw candidate carries, so a reader can see the trip
 * rather than a total.
 *
 * Both legs are here in full, each with its own price, seller and timestamp,
 * because that is what buying this actually involves. Nothing in here ever
 * presents the two as one round trip quoted by one provider.
 */
export interface OpenJawDetail {
  pairId: number
  outbound: OpenJawLegDetail
  inbound: OpenJawLegDetail
  destinationPair: {
    group: string | null
    arrive: string
    depart: string
    usefulness: number
    transfer: { mode: string; hours: number; typicalCost: Record<string, number> } | null
    note: string | null
  }
  /** The two fares and nothing else. */
  totalPrice: number
  /** Getting between the cities, and home from the airport you did not leave from. */
  transferCost: number
  destinationTransferCost: number
  homeTransferCost: number
  homeTransfer: { mode: string; hours: number } | null
  trueTripCost: number
  currency: string
  tripLengthNights: number
  /** The ordinary round trip this was measured against, with the row it came from. */
  comparator: {
    priceId: number
    price: number
    currency: string
    origin: string
    destination: string
    departureDate: string
    returnDate: string
    nights: number
    provider: string
    observedAt: string
  } | null
  saving: number | null
  savingPercent: number | null
  netSaving: number | null
  netSavingPercent: number | null
  friction: number
  frictionReasons: string[]
  mixedProvider: boolean
  legAgeSpreadDays: number
  convenience: number
  convenienceDetail: string
  qualifies: boolean
  note: string
}

export interface OpenJawLegDetail {
  priceId: number
  origin: string
  destination: string
  departureDate: string
  departureTime: string | null
  price: number
  currency: string
  provider: string
  providerConfidence: string
  verificationLevel: string
  airline: string | null
  stops: number | null
  durationMinutes: number | null
  baggage: string | null
  observedAt: string
}

export interface DealCandidate {
  id?: number
  /**
   * `open_jaw` points at an open_jaw_pairs row rather than an observation: an
   * open jaw is a decision about TWO observations, and there is nothing else
   * for it to point at. The pair row keeps both leg ids as foreign keys, so
   * provenance is still a join and never a copy.
   */
  sourceTable: "flight_prices" | "award_prices" | "open_jaw"
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

  // ── Phase 6 discovery dimensions ────────────────────────────────────────
  /** Which method surfaced this. Recorded so the useless methods can be found. */
  discoveredBy: DiscoveryMethod
  discoveryRunId: number | null
  destinationGroup: string | null
  tripLengthNights: number | null
  /** §21 the absolute-price tier this fare reached, independent of history. */
  absoluteTier: "interesting" | "extreme" | "wtf" | null
  /** §26 believability. A flagged row is stored, not discarded. */
  sanity: "ok" | "SUSPICIOUS_DATA"
  sanityDetail: string | null
  /** §23 whether THIS price has been confirmed, distinct from provider trust. */
  verificationStatus: "unverified" | "verified" | "cross-verified" | "suspicious"
  /** §3/§4 present only when the trip starts somewhere other than home. */
  requiresPositioning: boolean
  positioning: unknown | null
  positioningPenalty: number | null
  trueTripStartCost: number | null
  /** §8 present only when the trip does not fly in and out of the same pair of airports. */
  isOpenJaw: boolean
  openJaw: OpenJawDetail | null
  clusterId: number | null
  /** candidate = at/above threshold; below-threshold rows are kept for review. */
  status: "candidate" | "below-threshold"
  engineVersion: string
}

/**
 * §33 - WOULD_BOOK is the verdict that actually matters. "Good deal" is an
 * opinion about the algorithm; "would book" is an opinion about the trip, and
 * only the second one tells us whether this thing is worth running.
 */
export type FeedbackVerdict = "GOOD_DEAL" | "NORMAL" | "BAD_SIGNAL" | "WOULD_BOOK"
