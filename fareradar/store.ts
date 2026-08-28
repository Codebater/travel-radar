/**
 * Fare-radar persistence: runs (with their visible plans) and candidates
 * (linked into the append-only flight_prices history). Plus the strictly
 * gated "typical fare" read — no maturity, no number.
 */

import { nowIso, type DB } from "../db/index.js"
import { nightsBucketLabel, stayDateFamily } from "../stays/identity.js"
import { loadStaysConfig } from "../stays/config.js"
import { loadFareRadarConfig, type TripType } from "./config.js"
import type { CabinMix } from "./score.js"

export interface FareRadarRunInput {
  tripType: TripType
  origins: string[]
  destinations: string[]
  destinationMode: string
  windowStart: string
  windowEnd: string
  /** NOT_APPLICABLE (0) for ONE_WAY runs — a request descriptor, never a trip length. */
  minNights: number
  maxNights: number
  cabin: string
  adults: number
  currency: string
  plan: unknown
  callsPlanned: number
  source: "cli" | "api" | "test"
}

export function createFareRadarRun(db: DB, input: FareRadarRunInput): number {
  const r = db.prepare(`
    INSERT INTO fare_radar_runs (
      trip_type, origins, destinations, destination_mode, window_start, window_end,
      min_nights, max_nights, cabin, adults, currency,
      plan, calls_planned, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tripType,
    JSON.stringify(input.origins), JSON.stringify(input.destinations), input.destinationMode,
    input.windowStart, input.windowEnd, input.minNights, input.maxNights,
    input.cabin, input.adults, input.currency,
    JSON.stringify(input.plan), input.callsPlanned, input.source, nowIso(),
  )
  return Number(r.lastInsertRowid)
}

export function finishFareRadarRun(
  db: DB, runId: number,
  totals: { callsSpent: number; searchesIssued: number; candidatesFound: number },
): void {
  db.prepare(`
    UPDATE fare_radar_runs
    SET calls_spent = ?, searches_issued = ?, candidates_found = ?, finished_at = ?
    WHERE id = ?
  `).run(totals.callsSpent, totals.searchesIssued, totals.candidatesFound, nowIso(), runId)
}

export interface FareCandidateInput {
  runId: number
  flightPriceId: number | null
  itineraryHash: string
  tripType: TripType
  origin: string
  destination: string
  departureDate: string
  /** null exactly when tripType is ONE_WAY — the schema CHECKs enforce it. */
  returnDate: string | null
  nights: number | null
  adults: number
  cabin: string
  cabinMix: CabinMix
  cabinMixDetail: string
  airline: string | null
  airlines: string[]
  stops: number | null
  durationMinutes: number | null
  qualityFlags: string[]
  priceAmount: number
  priceCurrency: string
  dealScore: number
  scoreBreakdown: Record<string, number | string>
  provider: string
  locatorId: number | null
  observedAt: string
}

export function insertFareCandidates(db: DB, candidates: FareCandidateInput[]): void {
  const insert = db.prepare(`
    INSERT INTO fare_radar_candidates (
      run_id, flight_price_id, itinerary_hash, trip_type, origin, destination,
      departure_date, return_date, nights, adults,
      cabin, cabin_mix, cabin_mix_detail, airline, airlines, stops, duration_minutes,
      quality_flags, price_amount, price_currency, deal_score, score_breakdown,
      fare_window_key, provider, locator_id, observed_at, created_at
    ) VALUES (
      @runId, @flightPriceId, @itineraryHash, @tripType, @origin, @destination,
      @departureDate, @returnDate, @nights, @adults,
      @cabin, @cabinMix, @cabinMixDetail, @airline, @airlines, @stops, @durationMinutes,
      @qualityFlags, @priceAmount, @priceCurrency, @dealScore, @scoreBreakdown,
      @fareWindowKey, @provider, @locatorId, @observedAt, @now
    )
  `)
  const tx = db.transaction(() => {
    for (const c of candidates) {
      insert.run({
        ...c,
        airlines: JSON.stringify(c.airlines),
        qualityFlags: JSON.stringify(c.qualityFlags),
        scoreBreakdown: JSON.stringify(c.scoreBreakdown),
        fareWindowKey: fareWindowKey(c),
        now: nowIso(),
      })
    }
  })
  tx()
}

/**
 * Strict-dimension key: the future fare-baseline substrate.
 *
 * ROUND_TRIP keys are byte-identical to their pre-8k form (the nights-bucket
 * slot carries short/medium/long/extended), so existing baseline history is
 * untouched. ONE_WAY puts the hard token "oneway" in that same slot — no
 * bucket label can ever spell "oneway", so the two families cannot collide
 * and can never mix.
 */
export function fareWindowKey(c: {
  tripType: TripType
  origin: string; destination: string; departureDate: string
  nights: number | null; cabin: string; adults: number; priceCurrency: string
}): string {
  const buckets = loadStaysConfig().anomaly.baseline.nightsBuckets
  if (c.tripType === "ROUND_TRIP" && c.nights === null) {
    throw new Error("a ROUND_TRIP fare-window key requires nights — refusing to bucket a missing dimension")
  }
  return [
    "fare", c.origin, c.destination,
    stayDateFamily(c.departureDate),
    c.tripType === "ONE_WAY" ? "oneway" : nightsBucketLabel(c.nights!, buckets),
    c.cabin, `${c.adults}a`, c.priceCurrency,
  ].join("|")
}

export interface StoredFareCandidate {
  id: number
  runId: number
  flightPriceId: number | null
  itineraryHash: string
  tripType: TripType
  origin: string
  destination: string
  departureDate: string
  returnDate: string | null
  nights: number | null
  adults: number
  cabin: string
  cabinMix: CabinMix
  cabinMixDetail: string
  airline: string | null
  airlines: string[]
  stops: number | null
  durationMinutes: number | null
  qualityFlags: string[]
  priceAmount: number
  priceCurrency: string
  dealScore: number
  scoreBreakdown: Record<string, unknown>
  fareWindowKey: string
  provider: string
  locatorId: number | null
  observedAt: string
}

function hydrate(r: Record<string, unknown>): StoredFareCandidate {
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    runId: r.run_id as number,
    flightPriceId: (r.flight_price_id as number) ?? null,
    itineraryHash: r.itinerary_hash as string,
    tripType: r.trip_type as TripType,
    origin: r.origin as string,
    destination: r.destination as string,
    departureDate: r.departure_date as string,
    returnDate: (r.return_date as string) ?? null,
    nights: (r.nights as number) ?? null,
    adults: r.adults as number,
    cabin: r.cabin as string,
    cabinMix: r.cabin_mix as CabinMix,
    cabinMixDetail: r.cabin_mix_detail as string,
    airline: (r.airline as string) ?? null,
    airlines: parse(r.airlines, []),
    stops: (r.stops as number) ?? null,
    durationMinutes: (r.duration_minutes as number) ?? null,
    qualityFlags: parse(r.quality_flags, []),
    priceAmount: r.price_amount as number,
    priceCurrency: r.price_currency as string,
    dealScore: r.deal_score as number,
    scoreBreakdown: parse(r.score_breakdown, {}),
    fareWindowKey: r.fare_window_key as string,
    provider: r.provider as string,
    locatorId: (r.locator_id as number) ?? null,
    observedAt: r.observed_at as string,
  }
}

export interface StoredFareRadarRun {
  id: number
  tripType: TripType
  origins: string[]
  destinations: string[]
  destinationMode: string
  windowStart: string
  windowEnd: string
  minNights: number
  maxNights: number
  cabin: string
  adults: number
  currency: string
  plan: Record<string, unknown>
  callsPlanned: number
  callsSpent: number
  searchesIssued: number
  candidatesFound: number
  createdAt: string
  finishedAt: string | null
}

export function latestFareRadarRun(db: DB): StoredFareRadarRun | null {
  const r = db.prepare(
    "SELECT * FROM fare_radar_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get() as Record<string, unknown> | undefined
  if (!r) return null
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    tripType: r.trip_type as TripType,
    origins: parse(r.origins, []),
    destinations: parse(r.destinations, []),
    destinationMode: r.destination_mode as string,
    windowStart: r.window_start as string,
    windowEnd: r.window_end as string,
    minNights: r.min_nights as number,
    maxNights: r.max_nights as number,
    cabin: r.cabin as string,
    adults: r.adults as number,
    currency: r.currency as string,
    plan: parse(r.plan, {}),
    callsPlanned: r.calls_planned as number,
    callsSpent: r.calls_spent as number,
    searchesIssued: r.searches_issued as number,
    candidatesFound: r.candidates_found as number,
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  }
}

export function candidatesForRun(db: DB, runId: number): StoredFareCandidate[] {
  const rows = db.prepare(
    "SELECT * FROM fare_radar_candidates WHERE run_id = ? ORDER BY price_amount ASC, id ASC",
  ).all(runId) as Record<string, unknown>[]
  return rows.map(hydrate)
}

// ── Typical fare (maturity-gated) ────────────────────────────────────────────

export interface TypicalFare {
  median: number
  samples: number
  distinctFetchDays: number
  mature: true
}

export interface TypicalFareRefusal {
  mature: false
  reason: string
}

/**
 * The typical fare for one trip shape from the append-only history — refused
 * entirely below the maturity bar. Trip type is REQUIRED: ROUND_TRIP reads
 * only return-dated rows in the matching nights bucket; ONE_WAY reads only
 * `return_date IS NULL` rows. The two markets never inform each other — a
 * thousand mature round-trip observations still cannot mature a one-way
 * typical fare, and vice versa. Strict as-of is unnecessary here (this is
 * display context, not a scored baseline), but the maturity refusal is
 * identical doctrine.
 */
export function typicalFareFor(db: DB, c: {
  tripType: TripType
  origin: string; destination: string; nights: number | null; cabin: string; currency: string
}): TypicalFare | TypicalFareRefusal {
  const cfg = loadFareRadarConfig().baselines
  const buckets = loadStaysConfig().anomaly.baseline.nightsBuckets
  if (c.tripType === "ONE_WAY") {
    const rows = db.prepare(`
      SELECT price_amount, fetched_at
      FROM flight_prices
      WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
        AND return_date IS NULL
    `).all(c.origin, c.destination, c.cabin, c.currency) as
      { price_amount: number; fetched_at: string }[]
    return maturityGated(cfg, rows)
  }
  if (c.nights === null) {
    return { mature: false, reason: "a ROUND_TRIP typical fare requires nights — refusing to bucket a missing dimension" }
  }
  const bucket = nightsBucketLabel(c.nights, buckets)
  const rows = db.prepare(`
    SELECT price_amount, fetched_at, departure_date, return_date
    FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
      AND return_date IS NOT NULL
  `).all(c.origin, c.destination, c.cabin, c.currency) as
    { price_amount: number; fetched_at: string; departure_date: string; return_date: string }[]
  const matching = rows.filter(r => {
    const nights = Math.round((Date.parse(r.return_date) - Date.parse(r.departure_date)) / 86_400_000)
    return nightsBucketLabel(nights, buckets) === bucket
  })
  return maturityGated(cfg, matching)
}

function maturityGated(
  cfg: { minObservations: number; minDistinctFetchDays: number },
  matching: { price_amount: number; fetched_at: string }[],
): TypicalFare | TypicalFareRefusal {
  const days = new Set(matching.map(r => r.fetched_at.slice(0, 10)))
  if (matching.length < cfg.minObservations) {
    return { mature: false, reason: `only ${matching.length}/${cfg.minObservations} observations` }
  }
  if (days.size < cfg.minDistinctFetchDays) {
    return { mature: false, reason: `only ${days.size}/${cfg.minDistinctFetchDays} distinct fetch days` }
  }
  const prices = matching.map(r => r.price_amount).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  return {
    median: prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
    samples: matching.length,
    distinctFetchDays: days.size,
    mature: true,
  }
}
