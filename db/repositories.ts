/**
 * Data access for the cache, the price history and provider accounting.
 *
 * Every counter update is a single atomic SQL statement inside a transaction —
 * Phase 1's JSON counter lost increments whenever two processes searched at
 * once, and could not distinguish an attempted call from a successful one.
 */

import type { DB } from "./index.js"
import { nowIso, currentPeriod } from "./index.js"
import type {
  CashFlightQuery,
  NormalizedCashFlight,
  ProviderStatus,
} from "../providers/cash-flights/types.js"
import type { NormalizedAwardFlight } from "../providers/award-flights/types.js"

// ─── search_requests ─────────────────────────────────────────────────────────

export function recordSearchRequest(
  db: DB,
  // Structurally a CashFlightQuery, but `cabin` is widened: the unified search
  // row also records award search classes ("ECON"/"PREM"/"both").
  query: Omit<CashFlightQuery, "cabin"> & { cabin: string },
  source: "api" | "cli" | "test" | "observer" = "api",
): number {
  const info = db.prepare(`
    INSERT INTO search_requests (origin, destination, departure_date, return_date, cabin, adults, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    query.origin.toUpperCase(), query.destination.toUpperCase(), query.departureDate,
    query.returnDate || null, query.cabin, query.adults, source, nowIso(),
  )
  return Number(info.lastInsertRowid)
}

// ─── search_cache ────────────────────────────────────────────────────────────

/** What the cache row records about the originating query. Cash and award
 *  searches both satisfy this; `cabin` carries the award search class for
 *  award entries. */
export interface CacheQueryMeta {
  origin: string
  destination: string
  departureDate: string
  returnDate?: string | null
  cabin: string
  adults: number
}

export interface CacheEntry<T = NormalizedCashFlight> {
  cacheKey: string
  provider: string
  flights: T[]
  createdAt: string
  expiresAt: string
  isExpired: boolean
  ageMinutes: number
}

export function readCache<T = NormalizedCashFlight>(db: DB, cacheKey: string, at: Date = new Date()): CacheEntry<T> | null {
  const row = db.prepare(`SELECT * FROM search_cache WHERE cache_key = ?`).get(cacheKey) as any
  if (!row) return null

  let flights: T[]
  try {
    flights = JSON.parse(row.payload)
  } catch {
    // A corrupt payload is treated as a miss rather than crashing a search.
    db.prepare(`DELETE FROM search_cache WHERE cache_key = ?`).run(cacheKey)
    return null
  }

  const createdAt = new Date(row.created_at).getTime()
  return {
    cacheKey: row.cache_key,
    provider: row.provider,
    flights,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    isExpired: at.getTime() >= new Date(row.expires_at).getTime(),
    ageMinutes: Math.max(0, Math.round((at.getTime() - createdAt) / 60_000)),
  }
}

export function writeCache(
  db: DB,
  cacheKey: string,
  provider: string,
  query: CacheQueryMeta,
  flights: unknown[],
  expiresAt: string,
): void {
  db.prepare(`
    INSERT INTO search_cache
      (cache_key, provider, origin, destination, departure_date, return_date, cabin, adults,
       payload, result_count, created_at, expires_at, hit_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload = excluded.payload,
      result_count = excluded.result_count,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      hit_count = 0
  `).run(
    cacheKey, provider, query.origin.toUpperCase(), query.destination.toUpperCase(),
    query.departureDate, query.returnDate || null, query.cabin, query.adults,
    JSON.stringify(flights), flights.length, nowIso(), expiresAt,
  )
}

export function recordCacheHit(db: DB, cacheKey: string): void {
  db.prepare(`UPDATE search_cache SET hit_count = hit_count + 1 WHERE cache_key = ?`).run(cacheKey)
}

/** Remove expired rows. Returns how many went. */
export function pruneCache(db: DB, at: Date = new Date()): number {
  return db.prepare(`DELETE FROM search_cache WHERE expires_at < ?`).run(at.toISOString()).changes
}

export function clearCache(db: DB, provider?: string): number {
  return provider
    ? db.prepare(`DELETE FROM search_cache WHERE provider = ?`).run(provider).changes
    : db.prepare(`DELETE FROM search_cache`).run().changes
}

// ─── flight_prices (append-only history) ─────────────────────────────────────

/**
 * Append observations. Never updates: two providers disagreeing about the price
 * of one itinerary is the signal we are collecting, not a conflict to resolve.
 */
export function recordPriceObservations(
  db: DB,
  flights: NormalizedCashFlight[],
  opts: { adults: number; rawRef?: string | null; searchRequestId?: number | null } = { adults: 1 },
): number {
  if (flights.length === 0) return 0

  const stmt = db.prepare(`
    INSERT INTO flight_prices (
      itinerary_hash, origin, destination, departure_date, return_date, cabin, adults,
      airline, flight_numbers, stops, duration_minutes, departure_time, arrival_time,
      price_amount, price_currency, taxes_amount, taxes_currency, baggage, booking_url,
      provider, verification_level, provider_confidence, price_level, raw_ref, fetched_at,
      search_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const tx = db.transaction((rows: NormalizedCashFlight[]) => {
    for (const f of rows) {
      stmt.run(
        f.itineraryHash, f.origin, f.destination, f.departureDate, f.returnDate,
        f.cabin, opts.adults, f.airline, f.flightNumbers.join(",") || null, f.stops,
        f.durationMinutes, f.departureTime, f.arrivalTime,
        f.price.amount, f.price.currency,
        f.taxes?.amount ?? null, f.taxes?.currency ?? null,
        f.baggage ? JSON.stringify(f.baggage) : null,
        f.bookingUrl, f.provider, f.verificationLevel, f.providerConfidence,
        f.priceLevel, opts.rawRef ?? null, f.fetchedAt, opts.searchRequestId ?? null,
      )
    }
  })
  tx(flights)
  return flights.length
}

export interface PriceStats {
  currency: string
  observations: number
  min: number
  max: number
  median: number
  average: number
  latest: number
  latestAt: string
  firstAt: string
}

/**
 * Aggregate observations for a route. Grouped by currency: comparing a EUR
 * observation with a USD one without conversion would be misleading, so this
 * returns one stats block per currency rather than a single blended number.
 */
export function priceHistory(
  db: DB,
  filter: {
    origin: string
    destination: string
    departureDate?: string
    cabin?: string
    since?: string
    provider?: string
  },
): PriceStats[] {
  const where: string[] = ["origin = ?", "destination = ?"]
  const params: any[] = [filter.origin.toUpperCase(), filter.destination.toUpperCase()]

  if (filter.departureDate) { where.push("departure_date = ?"); params.push(filter.departureDate) }
  if (filter.cabin)         { where.push("cabin = ?");          params.push(filter.cabin) }
  if (filter.provider)      { where.push("provider = ?");       params.push(filter.provider) }
  if (filter.since)         { where.push("fetched_at >= ?");    params.push(filter.since) }

  const rows = db.prepare(`
    SELECT price_amount, price_currency, fetched_at
    FROM flight_prices
    WHERE ${where.join(" AND ")}
    ORDER BY fetched_at ASC
  `).all(...params) as { price_amount: number; price_currency: string; fetched_at: string }[]

  const byCurrency = new Map<string, { price_amount: number; fetched_at: string }[]>()
  for (const r of rows) {
    if (!byCurrency.has(r.price_currency)) byCurrency.set(r.price_currency, [])
    byCurrency.get(r.price_currency)!.push(r)
  }

  const out: PriceStats[] = []
  for (const [currency, group] of byCurrency) {
    const amounts = group.map(g => g.price_amount).sort((a, b) => a - b)
    const mid = Math.floor(amounts.length / 2)
    const median = amounts.length % 2 === 0
      ? (amounts[mid - 1]! + amounts[mid]!) / 2
      : amounts[mid]!
    const last = group[group.length - 1]!
    out.push({
      currency,
      observations: group.length,
      min: amounts[0]!,
      max: amounts[amounts.length - 1]!,
      median: Math.round(median * 100) / 100,
      average: Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 100) / 100,
      latest: last.price_amount,
      latestAt: last.fetched_at,
      firstAt: group[0]!.fetched_at,
    })
  }
  return out.sort((a, b) => b.observations - a.observations)
}

// ─── provider_usage ──────────────────────────────────────────────────────────

export interface UsageRow {
  provider: string
  period: string
  attempted: number
  succeeded: number
  failed: number
  lastCallAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  reportedRemaining: number | null
  reportedLimit: number | null
  reportedAt: string | null
}

function ensureUsageRow(db: DB, provider: string, period: string): void {
  db.prepare(`
    INSERT INTO provider_usage (provider, period) VALUES (?, ?)
    ON CONFLICT(provider, period) DO NOTHING
  `).run(provider, period)
}

export function readUsage(db: DB, provider: string, period = currentPeriod()): UsageRow {
  ensureUsageRow(db, provider, period)
  const r = db.prepare(
    `SELECT * FROM provider_usage WHERE provider = ? AND period = ?`
  ).get(provider, period) as any
  return {
    provider: r.provider, period: r.period,
    attempted: r.attempted, succeeded: r.succeeded, failed: r.failed,
    lastCallAt: r.last_call_at, lastSuccessAt: r.last_success_at, lastError: r.last_error,
    reportedRemaining: r.reported_remaining, reportedLimit: r.reported_limit, reportedAt: r.reported_at,
  }
}

/**
 * Count an attempt. Called immediately before a billable request so a crash
 * mid-flight still leaves a trace; `recordCallOutcome` then resolves it into a
 * success or a failure. Attempted is the conservative number the budget guard
 * uses, so a failed call can never be silently reclaimed as free.
 */
export function recordCallAttempt(db: DB, provider: string, period = currentPeriod(), count = 1): number {
  const tx = db.transaction(() => {
    ensureUsageRow(db, provider, period)
    db.prepare(`
      UPDATE provider_usage SET attempted = attempted + ?, last_call_at = ?
      WHERE provider = ? AND period = ?
    `).run(Math.max(1, count), nowIso(), provider, period)
    return (db.prepare(
      `SELECT attempted FROM provider_usage WHERE provider = ? AND period = ?`
    ).get(provider, period) as any).attempted as number
  })
  return tx()
}

export function recordCallOutcome(
  db: DB,
  provider: string,
  outcome: { ok: boolean; error?: string | null },
  period = currentPeriod(),
): void {
  const tx = db.transaction(() => {
    ensureUsageRow(db, provider, period)
    if (outcome.ok) {
      db.prepare(`
        UPDATE provider_usage SET succeeded = succeeded + 1, last_success_at = ?
        WHERE provider = ? AND period = ?
      `).run(nowIso(), provider, period)
    } else {
      db.prepare(`
        UPDATE provider_usage SET failed = failed + 1, last_error = ?
        WHERE provider = ? AND period = ?
      `).run((outcome.error || "unknown").slice(0, 300), provider, period)
    }
  })
  tx()
}

/**
 * Store the quota the provider itself reported. Kept in its own columns so it
 * is never confused with our local estimate.
 */
export function recordReportedQuota(
  db: DB,
  provider: string,
  reported: { remaining: number | null; limit: number | null },
  period = currentPeriod(),
): void {
  const tx = db.transaction(() => {
    ensureUsageRow(db, provider, period)
    db.prepare(`
      UPDATE provider_usage SET reported_remaining = ?, reported_limit = ?, reported_at = ?
      WHERE provider = ? AND period = ?
    `).run(reported.remaining, reported.limit, nowIso(), provider, period)
  })
  tx()
}

export function allUsage(db: DB, period = currentPeriod()): UsageRow[] {
  const rows = db.prepare(
    `SELECT provider FROM provider_usage WHERE period = ? ORDER BY provider`
  ).all(period) as { provider: string }[]
  return rows.map(r => readUsage(db, r.provider, period))
}

// ─── provider_health ─────────────────────────────────────────────────────────

export function recordHealth(
  db: DB,
  provider: string,
  status: ProviderStatus,
  detail: string,
  latencyMs: number | null,
): void {
  db.prepare(`
    INSERT INTO provider_health (provider, status, detail, checked_at, latency_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      status = excluded.status, detail = excluded.detail,
      checked_at = excluded.checked_at, latency_ms = excluded.latency_ms
  `).run(provider, status, detail.slice(0, 300), nowIso(), latencyMs)
}

// ─── award_prices (append-only history) ──────────────────────────────────────

/**
 * Append award observations — "points observed by this radar", not market data.
 * Never updates: the same flight priced by four programs is four rows, and the
 * same program observed on two days is two rows. That accumulation is the
 * entire point.
 */
export function recordAwardObservations(
  db: DB,
  flights: NormalizedAwardFlight[],
  opts: { rawRef?: string | null; searchRequestId?: number | null } = {},
): number {
  if (flights.length === 0) return 0

  const stmt = db.prepare(`
    INSERT INTO award_prices (
      itinerary_hash, origin, destination, departure_date, return_date,
      departure_time, arrival_time, airline, operating_airlines, flight_numbers,
      stops, duration_minutes, cabin, loyalty_program, points,
      taxes_amount, taxes_currency, available_seats, booking_url,
      provider, verification_level, provider_confidence, raw_ref, fetched_at,
      search_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const tx = db.transaction((rows: NormalizedAwardFlight[]) => {
    for (const f of rows) {
      stmt.run(
        f.itineraryHash, f.origin, f.destination, f.departureDate, f.returnDate,
        f.departureTime, f.arrivalTime, f.airline,
        f.operatingAirlines.join(",") || null, f.flightNumbers.join(",") || null,
        f.stops, f.durationMinutes, f.cabin, f.loyaltyProgram, f.points,
        f.taxes?.amount ?? null, f.taxes?.currency ?? null, f.availableSeats,
        f.bookingUrl, f.provider, f.verificationLevel, f.providerConfidence,
        opts.rawRef ?? null, f.fetchedAt, opts.searchRequestId ?? null,
      )
    }
  })
  tx(flights)
  return flights.length
}

export interface AwardPriceStats {
  loyaltyProgram: string
  cabin: string
  observations: number
  minPoints: number
  maxPoints: number
  medianPoints: number
  averagePoints: number
  latestPoints: number
  latestAt: string
  firstAt: string
  /** Lowest surcharge observed, per its currency. Null when never reported. */
  minTaxes: number | null
  minTaxesCurrency: string | null
}

/**
 * Points observed BY THIS RADAR for a route, grouped by loyalty program and
 * cabin. Not market-wide history — only what our own searches have seen.
 */
export function awardPriceHistory(
  db: DB,
  filter: {
    origin: string
    destination: string
    departureDate?: string
    cabin?: string
    loyaltyProgram?: string
    provider?: string
    since?: string
  },
): AwardPriceStats[] {
  const where: string[] = ["origin = ?", "destination = ?"]
  const params: any[] = [filter.origin.toUpperCase(), filter.destination.toUpperCase()]

  if (filter.departureDate)  { where.push("departure_date = ?");  params.push(filter.departureDate) }
  if (filter.cabin)          { where.push("cabin = ?");           params.push(filter.cabin) }
  if (filter.loyaltyProgram) { where.push("loyalty_program = ?"); params.push(filter.loyaltyProgram) }
  if (filter.provider)       { where.push("provider = ?");        params.push(filter.provider) }
  if (filter.since)          { where.push("fetched_at >= ?");     params.push(filter.since) }

  const rows = db.prepare(`
    SELECT loyalty_program, cabin, points, taxes_amount, taxes_currency, fetched_at
    FROM award_prices
    WHERE ${where.join(" AND ")}
    ORDER BY fetched_at ASC
  `).all(...params) as {
    loyalty_program: string; cabin: string; points: number
    taxes_amount: number | null; taxes_currency: string | null; fetched_at: string
  }[]

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.loyalty_program}|${r.cabin}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const out: AwardPriceStats[] = []
  for (const [key, group] of groups) {
    const [loyaltyProgram, cabin] = key.split("|") as [string, string]
    const points = group.map(g => g.points).sort((a, b) => a - b)
    const mid = Math.floor(points.length / 2)
    const median = points.length % 2 === 0 ? (points[mid - 1]! + points[mid]!) / 2 : points[mid]!
    const last = group[group.length - 1]!

    // Lowest taxes tracked within a single currency — never compared across.
    let minTaxes: number | null = null
    let minTaxesCurrency: string | null = null
    for (const g of group) {
      if (g.taxes_amount === null) continue
      if (minTaxes === null || (g.taxes_currency === minTaxesCurrency && g.taxes_amount < minTaxes)) {
        minTaxes = g.taxes_amount
        minTaxesCurrency = g.taxes_currency
      }
    }

    out.push({
      loyaltyProgram, cabin,
      observations: group.length,
      minPoints: points[0]!,
      maxPoints: points[points.length - 1]!,
      medianPoints: Math.round(median),
      averagePoints: Math.round(points.reduce((a, b) => a + b, 0) / points.length),
      latestPoints: last.points,
      latestAt: last.fetched_at,
      firstAt: group[0]!.fetched_at,
      minTaxes, minTaxesCurrency,
    })
  }
  return out.sort((a, b) => b.observations - a.observations)
}

// ─── balance_snapshots ───────────────────────────────────────────────────────

export interface BalanceRow {
  program: string
  programKey: string
  balance: number
}

/** Append one snapshot batch. Only real fetches are recorded, never fallbacks. */
export function saveBalanceSnapshot(db: DB, balances: BalanceRow[], source: string): string {
  const fetchedAt = nowIso()
  const stmt = db.prepare(`
    INSERT INTO balance_snapshots (program, program_key, balance, source, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    for (const b of balances) stmt.run(b.program, b.programKey, b.balance, source, fetchedAt)
  })
  tx()
  return fetchedAt
}

/**
 * The most recent snapshot batch, with its age. Null when nothing was ever
 * snapshotted (or nothing young enough when maxAgeHours is given).
 */
export function latestBalanceSnapshot(
  db: DB,
  opts: { maxAgeHours?: number } = {},
): { balances: BalanceRow[]; fetchedAt: string; ageMinutes: number } | null {
  const latest = db.prepare(
    `SELECT MAX(fetched_at) m FROM balance_snapshots`
  ).get() as { m: string | null }
  if (!latest.m) return null

  const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(latest.m).getTime()) / 60_000))
  if (opts.maxAgeHours !== undefined && ageMinutes > opts.maxAgeHours * 60) return null

  const rows = db.prepare(
    `SELECT program, program_key, balance FROM balance_snapshots WHERE fetched_at = ? ORDER BY balance DESC`
  ).all(latest.m) as { program: string; program_key: string; balance: number }[]

  return {
    balances: rows.map(r => ({ program: r.program, programKey: r.program_key, balance: r.balance })),
    fetchedAt: latest.m,
    ageMinutes,
  }
}

// ─── search_results (persisted result payloads) ──────────────────────────────

/** Persist the full result payload for a search — the dashboard's state. */
export function saveSearchResult(db: DB, searchRequestId: number, payload: unknown): void {
  db.prepare(`
    INSERT INTO search_results (search_request_id, payload, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(search_request_id) DO UPDATE SET
      payload = excluded.payload, created_at = excluded.created_at
  `).run(searchRequestId, JSON.stringify(payload), nowIso())
}

/** The most recent persisted search result, or null when none exists yet. */
export function latestSearchResult(db: DB): { searchRequestId: number; payload: unknown; createdAt: string } | null {
  const row = db.prepare(
    `SELECT search_request_id, payload, created_at FROM search_results ORDER BY created_at DESC, search_request_id DESC LIMIT 1`
  ).get() as { search_request_id: number; payload: string; created_at: string } | undefined
  if (!row) return null
  try {
    return { searchRequestId: row.search_request_id, payload: JSON.parse(row.payload), createdAt: row.created_at }
  } catch {
    return null
  }
}
