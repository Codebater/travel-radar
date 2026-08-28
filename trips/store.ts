/**
 * trip_opportunities persistence: upsert on the durable trip_key, reads for
 * the CLI and the trips page. Prices and scores update in place; created_at
 * and identity survive re-composition.
 */

import { nowIso, type DB } from "../db/index.js"
import type { ComposedTrip } from "./types.js"

export function upsertTrip(db: DB, trip: ComposedTrip): void {
  db.prepare(`
    INSERT INTO trip_opportunities (
      trip_key, origin, destination_airport, destination_group, property_id,
      check_in, check_out, nights, adults, construction, cabin, room_class, board,
      outbound_departure, return_departure, flight_detail, flight_score, flight_provenance,
      stay_window_key, stay_detail, stay_score, stay_provenance,
      cash_components, cash_total_amount, cash_total_currency, miles_components, unknown_costs,
      score, score_breakdown, trip_absolute_tier, trip_absolute_path, complexity, evidence,
      reasons, admission_gate, status, rejection_reason, created_at, evaluated_at
    ) VALUES (
      @tripKey, @origin, @destinationAirport, @destinationGroup, @propertyId,
      @checkIn, @checkOut, @nights, @adults, @construction, @cabin, @roomClass, @board,
      @outboundDeparture, @returnDeparture, @flightDetail, @flightScore, @flightProvenance,
      @stayWindowKey, @stayDetail, @stayScore, @stayProvenance,
      @cashComponents, @cashTotalAmount, @cashTotalCurrency, @milesComponents, @unknownCosts,
      @score, @scoreBreakdown, @tripAbsoluteTier, @tripAbsolutePath, @complexity, @evidence,
      @reasons, @admissionGate, @status, @rejectionReason, @now, @now
    )
    ON CONFLICT(trip_key) DO UPDATE SET
      check_in = excluded.check_in, check_out = excluded.check_out,
      outbound_departure = excluded.outbound_departure, return_departure = excluded.return_departure,
      flight_detail = excluded.flight_detail, flight_score = excluded.flight_score,
      flight_provenance = excluded.flight_provenance,
      stay_window_key = excluded.stay_window_key, stay_detail = excluded.stay_detail,
      stay_score = excluded.stay_score, stay_provenance = excluded.stay_provenance,
      cash_components = excluded.cash_components,
      cash_total_amount = excluded.cash_total_amount, cash_total_currency = excluded.cash_total_currency,
      miles_components = excluded.miles_components, unknown_costs = excluded.unknown_costs,
      score = excluded.score, score_breakdown = excluded.score_breakdown,
      trip_absolute_tier = excluded.trip_absolute_tier, trip_absolute_path = excluded.trip_absolute_path,
      complexity = excluded.complexity, evidence = excluded.evidence,
      reasons = excluded.reasons, admission_gate = excluded.admission_gate,
      status = excluded.status, rejection_reason = excluded.rejection_reason,
      evaluated_at = excluded.evaluated_at
  `).run({
    tripKey: trip.tripKey,
    origin: trip.flight.origin,
    destinationAirport: trip.flight.destinationAirport,
    destinationGroup: trip.stay.destinationGroup,
    propertyId: trip.stay.propertyId,
    checkIn: trip.stay.checkIn,
    checkOut: trip.stay.checkOut,
    nights: trip.stay.nights,
    adults: trip.adults,
    construction: trip.flight.construction,
    cabin: trip.flight.cabin,
    roomClass: trip.stay.roomClass,
    board: trip.stay.board,
    outboundDeparture: trip.flight.outboundDeparture,
    returnDeparture: trip.flight.returnDeparture,
    flightDetail: JSON.stringify({
      cabin: trip.flight.cabin, quality: trip.flight.quality,
      qualityDetail: trip.flight.qualityDetail,
      legs: trip.flight.legs.map(l => ({
        direction: l.direction, airline: l.airline, stops: l.stops,
        price: l.price, points: l.points, taxes: l.taxes,
        verificationLevel: l.verificationLevel,
      })),
    }),
    flightScore: Math.round(trip.flight.quality * 1000) / 10,
    flightProvenance: JSON.stringify(trip.flight.legs.map(l => ({ table: l.sourceTable, id: l.sourceId }))),
    stayWindowKey: trip.stay.windowKey,
    stayDetail: JSON.stringify({
      propertyName: trip.stay.propertyName, nightly: trip.stay.nightly,
      stayTotal: trip.stay.stayTotal, currency: trip.stay.currency,
      taxStatus: trip.stay.taxStatus, roomName: trip.stay.roomName,
      verificationStatus: trip.stay.verificationStatus, persistence: trip.stay.persistence,
      refundable: trip.stay.refundable, qualityDetail: trip.stay.qualityDetail,
    }),
    stayScore: Math.round(trip.stay.quality * 1000) / 10,
    stayProvenance: JSON.stringify({ candidateId: trip.stay.candidateId, observationIds: trip.stay.observationIds }),
    cashComponents: JSON.stringify(trip.cost.cashComponents),
    cashTotalAmount: trip.cost.cashTotal?.amount ?? null,
    cashTotalCurrency: trip.cost.cashTotal?.currency ?? null,
    milesComponents: JSON.stringify(trip.cost.milesComponents),
    unknownCosts: JSON.stringify(trip.cost.unknownCosts),
    score: trip.score,
    scoreBreakdown: JSON.stringify(trip.scoreBreakdown),
    tripAbsoluteTier: trip.tripAbsolute.tier,
    tripAbsolutePath: trip.tripAbsolute.rulePath,
    complexity: JSON.stringify(trip.complexity),
    evidence: JSON.stringify({ evidenceValue: trip.evidenceValue, usabilityValue: trip.usabilityValue }),
    reasons: JSON.stringify(trip.reasons),
    admissionGate: trip.admissionGate,
    status: trip.status,
    rejectionReason: trip.rejectionReason,
    now: nowIso(),
  })
}

export interface StoredTrip {
  id: number
  tripKey: string
  origin: string
  destinationAirport: string
  destinationGroup: string
  propertyId: string
  checkIn: string
  checkOut: string
  nights: number
  adults: number
  construction: string
  cabin: string | null
  roomClass: string | null
  board: string
  outboundDeparture: string
  returnDeparture: string | null
  flightDetail: Record<string, unknown>
  flightScore: number | null
  flightProvenance: unknown
  stayWindowKey: string
  stayDetail: Record<string, unknown>
  stayScore: number | null
  stayProvenance: unknown
  cashComponents: unknown[]
  cashTotal: { amount: number; currency: string } | null
  milesComponents: { program: string; miles: number; legs: string }[]
  unknownCosts: string[]
  score: number
  scoreBreakdown: Record<string, unknown>
  tripAbsoluteTier: string | null
  tripAbsolutePath: string
  complexity: Record<string, unknown>
  evidence: Record<string, unknown>
  reasons: string[]
  admissionGate: string
  status: string
  rejectionReason: string | null
  createdAt: string
  evaluatedAt: string
}

export function listTrips(db: DB, opts: { minScore?: number; limit?: number; status?: string } = {}): StoredTrip[] {
  const rows = db.prepare(`
    SELECT * FROM trip_opportunities
    WHERE score >= @minScore AND (@status IS NULL OR status = @status)
    ORDER BY score DESC, id ASC
    LIMIT @limit
  `).all({ minScore: opts.minScore ?? 0, status: opts.status ?? null, limit: opts.limit ?? 25 }) as
    Record<string, unknown>[]
  return rows.map(hydrate)
}

export function getTrip(db: DB, id: number): StoredTrip | null {
  const row = db.prepare("SELECT * FROM trip_opportunities WHERE id = ?").get(id) as
    Record<string, unknown> | undefined
  return row ? hydrate(row) : null
}

export interface TripTotals {
  trips: number
  interesting: number
  rejected: number
  topScore: number | null
  byConstruction: Record<string, number>
  byGate: Record<string, number>
}

export function tripTotals(db: DB): TripTotals {
  const rows = db.prepare("SELECT construction, admission_gate, status, score FROM trip_opportunities").all() as
    { construction: string; admission_gate: string; status: string; score: number }[]
  const totals: TripTotals = {
    trips: rows.length,
    interesting: rows.filter(r => r.status === "interesting").length,
    rejected: rows.filter(r => r.status === "rejected").length,
    topScore: rows.length ? Math.max(...rows.map(r => r.score)) : null,
    byConstruction: {},
    byGate: {},
  }
  for (const r of rows) {
    totals.byConstruction[r.construction] = (totals.byConstruction[r.construction] ?? 0) + 1
    totals.byGate[r.admission_gate] = (totals.byGate[r.admission_gate] ?? 0) + 1
  }
  return totals
}

function hydrate(r: Record<string, unknown>): StoredTrip {
  const parse = <T>(v: unknown, fallback: T): T => {
    try { return v ? JSON.parse(v as string) as T : fallback } catch { return fallback }
  }
  return {
    id: r.id as number,
    tripKey: r.trip_key as string,
    origin: r.origin as string,
    destinationAirport: r.destination_airport as string,
    destinationGroup: r.destination_group as string,
    propertyId: r.property_id as string,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    nights: r.nights as number,
    adults: r.adults as number,
    construction: r.construction as string,
    cabin: (r.cabin as string) ?? null,
    roomClass: (r.room_class as string) ?? null,
    board: r.board as string,
    outboundDeparture: r.outbound_departure as string,
    returnDeparture: (r.return_departure as string) ?? null,
    flightDetail: parse(r.flight_detail, {}),
    flightScore: (r.flight_score as number) ?? null,
    flightProvenance: parse(r.flight_provenance, []),
    stayWindowKey: r.stay_window_key as string,
    stayDetail: parse(r.stay_detail, {}),
    stayScore: (r.stay_score as number) ?? null,
    stayProvenance: parse(r.stay_provenance, {}),
    cashComponents: parse(r.cash_components, []),
    cashTotal: r.cash_total_amount != null
      ? { amount: r.cash_total_amount as number, currency: r.cash_total_currency as string }
      : null,
    milesComponents: parse(r.miles_components, []),
    unknownCosts: parse(r.unknown_costs, []),
    score: r.score as number,
    scoreBreakdown: parse(r.score_breakdown, {}),
    tripAbsoluteTier: (r.trip_absolute_tier as string) ?? null,
    tripAbsolutePath: r.trip_absolute_path as string,
    complexity: parse(r.complexity, {}),
    evidence: parse(r.evidence, {}),
    reasons: parse(r.reasons, []),
    admissionGate: r.admission_gate as string,
    status: r.status as string,
    rejectionReason: (r.rejection_reason as string) ?? null,
    createdAt: r.created_at as string,
    evaluatedAt: r.evaluated_at as string,
  }
}
