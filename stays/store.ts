/**
 * Stay observation persistence.
 *
 * History is append-only: recording the same stay twice writes two rows, on
 * purpose — that IS the time series. Dedup is the future baseline's job
 * (sibling exclusion by search_request_id, exactly as the flight engine does
 * it), never the writer's. The only mutation this module performs is stamping
 * stay_property_refs.verified_at when a ref demonstrably returned data.
 */

import { nowIso, type DB } from "../db/index.js"
import type {
  NormalizedStayRate,
  StayCalendarDay,
} from "../providers/stays/types.js"
import {
  boardFor,
  checkStaySanity,
  isBaselineEligible,
  type StaySanityConfig,
} from "./normalize.js"
import type { StoredStayProperty } from "./registry.js"

export interface StaySearchRequestInput {
  propertyId: string
  kind: "rates" | "calendar"
  checkIn?: string | null
  checkOut?: string | null
  adults?: number
  children?: number
  currency: string
  source: "cli" | "observer" | "test"
}

export function recordStaySearchRequest(db: DB, input: StaySearchRequestInput): number {
  const info = db.prepare(`
    INSERT INTO stay_search_requests
      (property_id, kind, check_in, check_out, adults, children, currency, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.propertyId, input.kind,
    input.checkIn ?? null, input.checkOut ?? null,
    input.adults ?? 2, input.children ?? 0,
    input.currency, input.source, nowIso(),
  )
  return Number(info.lastInsertRowid)
}

export interface RecordRatesSummary {
  inserted: number
  suspicious: number
  baselineEligible: number
}

/**
 * Append rate observations. Board resolution and sanity run HERE, at the
 * moment of recording, because both need the property (registry metadata)
 * and the provider must stay ignorant of it: a provider normalizes what it
 * saw; the store decides what a bare price means at THIS property.
 */
export function recordRateObservations(
  db: DB,
  property: StoredStayProperty,
  searchRequestId: number | null,
  rates: NormalizedStayRate[],
  sanityConfig: StaySanityConfig,
): RecordRatesSummary {
  const insert = db.prepare(`
    INSERT INTO stay_rate_observations (
      property_id, provider, provider_property_ref,
      check_in, check_out, nights, adults, children,
      room_name, room_class, board, board_source, refundable, cancellation_deadline,
      rate_source, source_class, price_amount, price_currency, price_basis,
      taxes_fees, taxes_fees_amount, before_tax_nightly,
      verification_level, confidence, provider_as_of, sanity, sanity_detail,
      fetched_at, search_request_id
    ) VALUES (
      @propertyId, @provider, @providerPropertyRef,
      @checkIn, @checkOut, @nights, @adults, @children,
      @roomName, @roomClass, @board, @boardSource, @refundable, @cancellationDeadline,
      @rateSource, @sourceClass, @priceAmount, @priceCurrency, @priceBasis,
      @taxesFees, @taxesFeesAmount, @beforeTaxNightly,
      @verificationLevel, @confidence, @providerAsOf, @sanity, @sanityDetail,
      @fetchedAt, @searchRequestId
    )
  `)

  const summary: RecordRatesSummary = { inserted: 0, suspicious: 0, baselineEligible: 0 }
  const tx = db.transaction(() => {
    for (const rate of rates) {
      // Guard against a provider bug crossing property wires: an observation
      // recorded under the wrong property poisons that property's history in
      // a way no later step can detect.
      if (rate.propertyId !== property.id) {
        throw new Error(
          `refusing to record: rate is for ${rate.propertyId}, recording under ${property.id}`)
      }
      const { board, boardSource } = boardFor(property, rate.board === "unknown" ? null : rate.board)
      const judged: NormalizedStayRate = { ...rate, board, boardSource }
      const sanity = checkStaySanity(judged, sanityConfig)
      insert.run({
        propertyId: judged.propertyId,
        provider: judged.provider,
        providerPropertyRef: judged.providerPropertyRef,
        checkIn: judged.checkIn,
        checkOut: judged.checkOut,
        nights: judged.nights,
        adults: judged.adults,
        children: judged.children,
        roomName: judged.roomName,
        roomClass: judged.roomClass,
        board: judged.board,
        boardSource: judged.boardSource,
        refundable: judged.refundable === null ? null : (judged.refundable ? 1 : 0),
        cancellationDeadline: judged.cancellationDeadline,
        rateSource: judged.rateSource,
        sourceClass: judged.sourceClass,
        priceAmount: judged.price.amount,
        priceCurrency: judged.price.currency,
        priceBasis: judged.priceBasis,
        taxesFees: judged.taxesFees,
        taxesFeesAmount: judged.taxesFeesAmount,
        beforeTaxNightly: beforeTaxNightlyOf(judged),
        verificationLevel: judged.verificationLevel,
        confidence: judged.confidence,
        providerAsOf: judged.providerAsOf,
        sanity: sanity.verdict,
        sanityDetail: sanity.reasons.length ? sanity.reasons.join("; ") : null,
        fetchedAt: judged.fetchedAt,
        searchRequestId,
      })
      summary.inserted++
      if (sanity.verdict !== "ok") summary.suspicious++
      if (isBaselineEligible(judged, sanity)) summary.baselineEligible++
    }
    if (rates.length > 0) {
      markRefVerified(db, property.id, rates[0].provider)
    }
  })
  tx()
  return summary
}

export function recordCalendarObservations(
  db: DB,
  property: StoredStayProperty,
  provider: string,
  providerRef: string,
  searchRequestId: number | null,
  days: StayCalendarDay[],
): number {
  const insert = db.prepare(`
    INSERT INTO stay_calendar_observations
      (property_id, provider, provider_property_ref, stay_date, day_class, fetched_at, search_request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const fetchedAt = nowIso()
  const tx = db.transaction(() => {
    for (const d of days) {
      insert.run(property.id, provider, providerRef, d.date, d.dayClass, fetchedAt, searchRequestId)
    }
    if (days.length > 0) markRefVerified(db, property.id, provider)
  })
  tx()
  return days.length
}

/**
 * The before-tax nightly a provider GENUINELY stated: an inclusive price
 * minus its stated tax, per night. Derived only — a missing tax figure means
 * null, never an estimate.
 */
function beforeTaxNightlyOf(rate: NormalizedStayRate): number | null {
  if (rate.taxesFees !== "included" || rate.taxesFeesAmount === null) return null
  if (rate.priceBasis === "nightly_room") {
    const value = rate.price.amount - rate.taxesFeesAmount
    return value > 0 ? Math.round(value * 100) / 100 : null
  }
  if ((rate.priceBasis === "stay_total" || rate.priceBasis === "stay_room") && rate.nights > 0) {
    const value = (rate.price.amount - rate.taxesFeesAmount) / rate.nights
    return value > 0 ? Math.round(value * 100) / 100 : null
  }
  return null
}

function markRefVerified(db: DB, propertyId: string, provider: string): void {
  db.prepare(`
    UPDATE stay_property_refs
    SET verified_at = ?, empty_streak = 0
    WHERE property_id = ? AND provider = ?
  `).run(nowIso(), propertyId, provider)
}

// ─── Phase 8b: ref health, raw retention, confirmation triggers ─────────────

/**
 * An empty rates answer for a cold-cache source means "retry later", never
 * "dead property" — only a streak marks a ref suspect. Returns the new streak.
 */
export function recordEmptyRatesResult(db: DB, propertyId: string, provider: string): number {
  db.prepare(`
    UPDATE stay_property_refs SET empty_streak = empty_streak + 1
    WHERE property_id = ? AND provider = ?
  `).run(propertyId, provider)
  const row = db.prepare(
    "SELECT empty_streak FROM stay_property_refs WHERE property_id = ? AND provider = ?",
  ).get(propertyId, provider) as { empty_streak: number } | undefined
  return row?.empty_streak ?? 0
}

/**
 * A semantic calendar failure (HTTP 200, API said no). At the threshold the
 * ref is marked calendar-unsupported and the planner stops asking; rates are
 * unaffected. Returns true when this failure crossed the threshold.
 */
export function recordCalendarFailure(db: DB, propertyId: string, provider: string, unsupportedAfter: number): boolean {
  db.prepare(`
    UPDATE stay_property_refs SET calendar_failures = calendar_failures + 1
    WHERE property_id = ? AND provider = ?
  `).run(propertyId, provider)
  const row = db.prepare(
    "SELECT calendar_failures FROM stay_property_refs WHERE property_id = ? AND provider = ?",
  ).get(propertyId, provider) as { calendar_failures: number } | undefined
  if ((row?.calendar_failures ?? 0) >= unsupportedAfter) {
    db.prepare(`
      UPDATE stay_property_refs SET calendar_status = 'unsupported'
      WHERE property_id = ? AND provider = ?
    `).run(propertyId, provider)
    return true
  }
  return false
}

export function recordCalendarSuccess(db: DB, propertyId: string, provider: string): void {
  db.prepare(`
    UPDATE stay_property_refs SET calendar_failures = 0, calendar_status = NULL
    WHERE property_id = ? AND provider = ?
  `).run(propertyId, provider)
}

export function calendarSupported(db: DB, propertyId: string, provider: string): boolean {
  const row = db.prepare(
    "SELECT calendar_status FROM stay_property_refs WHERE property_id = ? AND provider = ?",
  ).get(propertyId, provider) as { calendar_status: string | null } | undefined
  return row?.calendar_status !== "unsupported"
}

/** Reset calendar-unsupported marks (CLI escape hatch for when a provider fixes itself). */
export function resetCalendarStatus(db: DB, propertyId?: string): number {
  const info = propertyId
    ? db.prepare("UPDATE stay_property_refs SET calendar_failures = 0, calendar_status = NULL WHERE property_id = ?").run(propertyId)
    : db.prepare("UPDATE stay_property_refs SET calendar_failures = 0, calendar_status = NULL").run()
  return info.changes
}

/**
 * Keep the raw payload, bounded: prune to the newest `retention` rows. Raw
 * payloads are diagnostics for parser regressions — the normalized
 * observations are the history, and those are never pruned.
 */
export function recordRawResponse(
  db: DB,
  input: { provider: string; kind: "rates" | "calendar"; propertyId: string; searchRequestId: number | null; payload: unknown },
  retention: number,
): void {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO stay_raw_responses (provider, kind, property_id, search_request_id, payload, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.provider, input.kind, input.propertyId, input.searchRequestId,
      JSON.stringify(input.payload), nowIso())
    db.prepare(`
      DELETE FROM stay_raw_responses WHERE id NOT IN (
        SELECT id FROM stay_raw_responses ORDER BY id DESC LIMIT ?
      )
    `).run(Math.max(1, retention))
  })
  tx()
}

export interface TriggerRowInput {
  propertyId: string
  runId: number | null
  checkIn: string
  checkOut: string
  reason: string
  evidence: Record<string, unknown>
}

export function recordConfirmationTrigger(db: DB, input: TriggerRowInput): number {
  const info = db.prepare(`
    INSERT INTO stay_confirmation_triggers
      (property_id, run_id, check_in, check_out, reason, evidence, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(input.propertyId, input.runId, input.checkIn, input.checkOut,
    input.reason, JSON.stringify(input.evidence), nowIso())
  return Number(info.lastInsertRowid)
}

export function resolveConfirmationTrigger(
  db: DB, triggerId: number,
  status: "confirmed" | "no_rates" | "failed" | "skipped_budget" | "skipped_breaker" | "skipped_no_ref" | "skipped_unconfigured",
  confirmingSearchRequestId: number | null = null,
): void {
  db.prepare(`
    UPDATE stay_confirmation_triggers
    SET status = ?, confirming_search_request_id = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, confirmingSearchRequestId, nowIso(), triggerId)
}

export interface StoredTrigger {
  id: number
  propertyId: string
  checkIn: string
  checkOut: string
  reason: string
  evidence: Record<string, unknown>
  status: string
  confirmingSearchRequestId: number | null
  createdAt: string
  resolvedAt: string | null
}

export function listConfirmationTriggers(db: DB, opts: { limit?: number } = {}): StoredTrigger[] {
  const rows = db.prepare(`
    SELECT * FROM stay_confirmation_triggers ORDER BY id DESC LIMIT ?
  `).all(opts.limit ?? 30) as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as number,
    propertyId: r.property_id as string,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    reason: r.reason as string,
    evidence: JSON.parse((r.evidence as string) ?? "{}") as Record<string, unknown>,
    status: r.status as string,
    confirmingSearchRequestId: (r.confirming_search_request_id as number) ?? null,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string) ?? null,
  }))
}

// ── Reads (CLI/reporting) ────────────────────────────────────────────────────

export interface StayRateRow {
  id: number
  propertyId: string
  provider: string
  checkIn: string
  checkOut: string
  nights: number
  board: string
  rateSource: string | null
  priceAmount: number
  priceCurrency: string
  priceBasis: string
  taxesFees: string
  sanity: string
  fetchedAt: string
  searchRequestId: number | null
}

export function rateHistory(
  db: DB,
  opts: { propertyId?: string; limit?: number } = {},
): StayRateRow[] {
  const rows = db.prepare(`
    SELECT id, property_id, provider, check_in, check_out, nights, board, rate_source,
           price_amount, price_currency, price_basis, taxes_fees, sanity, fetched_at,
           search_request_id
    FROM stay_rate_observations
    ${opts.propertyId ? "WHERE property_id = @propertyId" : ""}
    ORDER BY fetched_at DESC, id DESC
    LIMIT @limit
  `).all({ propertyId: opts.propertyId, limit: opts.limit ?? 50 }) as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as number,
    propertyId: r.property_id as string,
    provider: r.provider as string,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    nights: r.nights as number,
    board: r.board as string,
    rateSource: (r.rate_source as string) ?? null,
    priceAmount: r.price_amount as number,
    priceCurrency: r.price_currency as string,
    priceBasis: r.price_basis as string,
    taxesFees: r.taxes_fees as string,
    sanity: r.sanity as string,
    fetchedAt: r.fetched_at as string,
    searchRequestId: (r.search_request_id as number) ?? null,
  }))
}

export interface StayObservationCounts {
  properties: number
  activeProperties: number
  refs: number
  searchRequests: number
  rateObservations: number
  suspiciousRates: number
  calendarObservations: number
  lastFetchAt: string | null
}

export function stayObservationCounts(db: DB): StayObservationCounts {
  const one = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n
  const lastFetch = db.prepare(`
    SELECT MAX(fetched_at) AS at FROM (
      SELECT fetched_at FROM stay_rate_observations
      UNION ALL
      SELECT fetched_at FROM stay_calendar_observations
    )
  `).get() as { at: string | null }
  return {
    properties: one("SELECT COUNT(*) AS n FROM stay_properties"),
    activeProperties: one("SELECT COUNT(*) AS n FROM stay_properties WHERE active = 1"),
    refs: one("SELECT COUNT(*) AS n FROM stay_property_refs"),
    searchRequests: one("SELECT COUNT(*) AS n FROM stay_search_requests"),
    rateObservations: one("SELECT COUNT(*) AS n FROM stay_rate_observations"),
    suspiciousRates: one("SELECT COUNT(*) AS n FROM stay_rate_observations WHERE sanity != 'ok'"),
    calendarObservations: one("SELECT COUNT(*) AS n FROM stay_calendar_observations"),
    lastFetchAt: lastFetch.at,
  }
}
