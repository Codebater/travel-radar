/**
 * Shared builders for the market-layer tests: a Lily-shaped stored trip with
 * real itemized cash components, an FX seeder, and the property row the
 * foreign keys need.
 */

import { nowIso, type DB } from "../db/index.js"
import type { StoredTrip } from "../trips/store.js"

export function seedProperty(db: DB, id = "lily-beach-resort"): void {
  db.prepare(`
    INSERT INTO stay_properties (id, name, destination_group, country, nearest_airports, luxury_tier,
      all_inclusive, default_board, typical_stay_nights, priority, active, created_at, updated_at)
    VALUES (?, 'Lily Beach', 'maldives', 'Maldives', '["MLE"]', 'luxury',
      'only', 'all_inclusive', '[5,7]', 1, 1, ?, ?)
  `).run(id, nowIso(), nowIso())
}

export function tripLiteral(over: Partial<StoredTrip> = {}): StoredTrip {
  return {
    id: 1, tripKey: "k", origin: "VIE", destinationAirport: "MLE", destinationGroup: "maldives",
    propertyId: "lily-beach-resort", checkIn: "2026-11-19", checkOut: "2026-11-24",
    nights: 5, adults: 2, construction: "cash", cabin: "economy", roomClass: "villa",
    board: "all_inclusive", outboundDeparture: "2026-11-18", returnDeparture: "2026-11-24",
    flightDetail: {}, flightScore: 45, flightProvenance: [],
    stayWindowKey: "w", stayDetail: { taxStatus: "included" }, stayScore: 60, stayProvenance: {},
    cashComponents: [
      { kind: "airfare", amount: 1446, currency: "USD", detail: "VIE⇄MLE ×2 adults" },
      { kind: "stay", amount: 3405, currency: "USD", detail: "5n AI villa" },
    ],
    cashTotal: { amount: 4851, currency: "USD" },
    milesComponents: [], unknownCosts: ["resort/airport transfer not priced"],
    score: 71, scoreBreakdown: {}, tripAbsoluteTier: null, tripAbsolutePath: "none",
    complexity: {}, evidence: {}, reasons: [], admissionGate: "g",
    status: "interesting", rejectionReason: null, createdAt: nowIso(), evaluatedAt: nowIso(),
    ...over,
  }
}

export function seedFx(
  db: DB,
  over: { rate?: number; providerDate?: string; base?: string; quote?: string } = {},
): number {
  const r = db.prepare(`
    INSERT INTO fx_rate_observations (base_currency, quote_currency, rate, provider, provider_date, fetched_at)
    VALUES (?, ?, ?, 'frankfurter_ecb', ?, ?)
  `).run(over.base ?? "USD", over.quote ?? "EUR", over.rate ?? 0.85874,
    over.providerDate ?? new Date().toISOString().slice(0, 10), nowIso())
  return Number(r.lastInsertRowid)
}

/** Raw trip_opportunities insert for runMarket end-to-end tests. */
export function insertTripRow(db: DB, over: Partial<Record<string, unknown>> = {}): void {
  const t = {
    trip_key: "k1", origin: "VIE", destination_airport: "MLE", destination_group: "maldives",
    property_id: "lily-beach-resort", check_in: "2026-11-19", check_out: "2026-11-24",
    nights: 5, adults: 2, construction: "cash", cabin: "economy", room_class: "villa",
    board: "all_inclusive", outbound_departure: "2026-11-18", return_departure: "2026-11-24",
    flight_detail: "{}", flight_score: 45, flight_provenance: "[]",
    stay_window_key: "w", stay_detail: JSON.stringify({ taxStatus: "included" }),
    stay_score: 60, stay_provenance: "{}",
    cash_components: JSON.stringify([
      { kind: "airfare", amount: 1446, currency: "USD", detail: "VIE⇄MLE ×2" },
      { kind: "stay", amount: 3405, currency: "USD", detail: "5n AI" },
    ]),
    cash_total_amount: 4851, cash_total_currency: "USD",
    miles_components: "[]", unknown_costs: JSON.stringify(["resort/airport transfer not priced"]),
    score: 71, score_breakdown: "{}", trip_absolute_tier: null, trip_absolute_path: "none",
    complexity: "{}", evidence: "{}", reasons: "[]", admission_gate: "g", status: "interesting",
    rejection_reason: null, created_at: nowIso(), evaluated_at: nowIso(),
    ...over,
  }
  const cols = Object.keys(t)
  db.prepare(
    `INSERT INTO trip_opportunities (${cols.join(",")}) VALUES (${cols.map(c => "@" + c).join(",")})`,
  ).run(t)
}
