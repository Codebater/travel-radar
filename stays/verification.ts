/**
 * The verification gate: which candidates deserve a PAID SerpAPI call, and
 * why. Every metered request must be able to answer "why did we spend money
 * on this?" — so the gate reason and its arithmetic are recorded BEFORE the
 * request, refusals included.
 *
 * A random observation can never reach here: only decisions inside the
 * near-miss band with at least one nameable gate reason qualify, one paid
 * verification per opportunity per cooldown, under a per-run ceiling, a
 * per-day ceiling, and the provider's own monthly ceiling — all separate
 * from (and unreachable by) the flight radar's SerpAPI budget and reserve.
 */

import { readState, writeState } from "../anomaly/store.js"
import { nowIso, type DB } from "../db/index.js"
import { runStayRateSearch } from "../providers/stays/index.js"
import { SERPAPI_HOTELS_PROVIDER } from "../providers/stays/serpapi-hotels.js"
import type { StayProvider } from "../providers/stays/types.js"
import type { StaysConfig } from "./config.js"
import { evaluateStayObservations } from "./engine.js"
import { getStayProperty } from "./registry.js"
import { recordRateObservations, recordRawResponse, recordStaySearchRequest } from "./store.js"

export type GateReason =
  | "RELATIVE_ANOMALY_NEAR_THRESHOLD"
  | "ABSOLUTE_VALUE_NEAR_THRESHOLD"
  | "ANOMALY_AND_ABSOLUTE_VALUE"
  | "SUSTAINED_CHEAP_WINDOW"
  | "META_AGODA_CORROBORATED"

export interface VerificationTarget {
  candidateId: number
  opportunityKey: string
  propertyId: string
  checkIn: string
  checkOut: string
  score: number
  gateReason: GateReason
  gateDetail: string
}

interface CandidateRow {
  id: number
  opportunity_key: string
  property_id: string
  check_in: string
  check_out: string
  score: number
  relative_score: number | null
  absolute_value_score: number | null
  actionability_score: number | null
  confirmation_state: string
  verification_status: string
  reasons: string
}

/**
 * Pure selection: the qualifying candidates, best first, gate reasons named.
 * Spends nothing — the runner decides how many of these to actually buy.
 */
export function selectVerificationTargets(db: DB, config: StaysConfig, at = new Date()): VerificationTarget[] {
  const v = config.anomaly.verification
  const minScore = config.anomaly.candidateThreshold - v.nearMissBand
  const rows = db.prepare(`
    SELECT id, opportunity_key, property_id, check_in, check_out, score,
           relative_score, absolute_value_score, actionability_score,
           confirmation_state, verification_status, reasons
    FROM stay_candidates
    WHERE status != 'suspicious'
      AND verification_status = 'unverified'
      AND verification_level != 'verified'
      AND score >= ?
      AND check_in > ?
    ORDER BY score DESC, id ASC
    LIMIT 40
  `).all(minScore, at.toISOString().slice(0, 10)) as CandidateRow[]
  // verification_level != 'verified' is load-bearing: a verified observation
  // IS the paid answer — letting it qualify as a target would buy the same
  // answer again every pass, a self-perpetuating spend loop (caught by test).

  const targets: VerificationTarget[] = []
  const seenOpportunities = new Set<string>()
  for (const row of rows) {
    if (seenOpportunities.has(row.opportunity_key)) continue
    if (recentlyVerified(db, row.opportunity_key, v.opportunityCooldownDays, at)) continue

    const gate = gateReasonFor(row, config)
    if (!gate) continue                     // near the band but no nameable reason: no spend
    seenOpportunities.add(row.opportunity_key)
    targets.push({
      candidateId: row.id,
      opportunityKey: row.opportunity_key,
      propertyId: row.property_id,
      checkIn: row.check_in,
      checkOut: row.check_out,
      score: row.score,
      gateReason: gate.reason,
      gateDetail: gate.detail,
    })
  }
  return targets
}

function gateReasonFor(
  row: CandidateRow,
  config: StaysConfig,
): { reason: GateReason; detail: string } | null {
  const v = config.anomaly.verification
  const relative = (row.relative_score ?? 0) / 100
  const absolute = (row.absolute_value_score ?? 0) / 100
  const reasons = JSON.parse(row.reasons || "[]") as string[]

  const strongRelative = relative >= v.minRelativeForGate
  const strongAbsolute = absolute >= v.minAbsoluteForGate

  if (strongRelative && strongAbsolute) {
    return {
      reason: "ANOMALY_AND_ABSOLUTE_VALUE",
      detail: `relative ${Math.round(relative * 100)} and absolute ${Math.round(absolute * 100)} both strong at score ${row.score}`,
    }
  }
  if (row.confirmation_state === "retail_confirmed" && strongRelative) {
    return {
      reason: "META_AGODA_CORROBORATED",
      detail: `meta anomaly (relative ${Math.round(relative * 100)}) with an Agoda confirmation already on record`,
    }
  }
  if (strongRelative) {
    return {
      reason: "RELATIVE_ANOMALY_NEAR_THRESHOLD",
      detail: `relative ${Math.round(relative * 100)} >= ${Math.round(v.minRelativeForGate * 100)} at score ${row.score} (threshold ${config.anomaly.candidateThreshold})`,
    }
  }
  if (strongAbsolute) {
    return {
      reason: "ABSOLUTE_VALUE_NEAR_THRESHOLD",
      detail: `absolute value ${Math.round(absolute * 100)} >= ${Math.round(v.minAbsoluteForGate * 100)} at score ${row.score}`,
    }
  }
  if ((row.actionability_score ?? 0) >= 99 && reasons.includes("SUSTAINED_CHEAP_WINDOW")) {
    return {
      reason: "SUSTAINED_CHEAP_WINDOW",
      detail: `sustained cheap window (actionability ${row.actionability_score}) at score ${row.score}`,
    }
  }
  return null
}

function recentlyVerified(db: DB, opportunityKey: string, cooldownDays: number, at: Date): boolean {
  const since = new Date(at.getTime() - cooldownDays * 86_400_000).toISOString()
  const row = db.prepare(`
    SELECT 1 FROM stay_verifications
    WHERE opportunity_key = ? AND status IN ('spent', 'failed', 'no_match') AND requested_at >= ?
    LIMIT 1
  `).get(opportunityKey, since)
  return row !== undefined
}

// ─── The runner ─────────────────────────────────────────────────────────────

export interface VerificationPassResult {
  considered: number
  spent: number
  refused: number
  confirmed: number
  details: string[]
}

const DAILY_KEY_PREFIX = "stays.verifications."

export function verificationsUsedToday(db: DB, at = new Date()): number {
  return Number(readState(db, `${DAILY_KEY_PREFIX}${at.toISOString().slice(0, 10)}`) ?? "0")
}

/**
 * Spend up to the ceilings on the best gate-qualified targets. Daily counter
 * incremented BEFORE the await (reserve-before-await); every decision —
 * spends AND refusals — lands in stay_verifications.
 */
export async function runVerificationPass(options: {
  db: DB
  config: StaysConfig
  provider: StayProvider | null
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}): Promise<VerificationPassResult> {
  const { db, config } = options
  const v = config.anomaly.verification
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = options.now ?? (() => new Date())
  const result: VerificationPassResult = { considered: 0, spent: 0, refused: 0, confirmed: 0, details: [] }

  const provider = options.provider
  if (!provider || !provider.isConfigured()) {
    result.details.push("verification provider unavailable — nothing spent")
    return result
  }

  const targets = selectVerificationTargets(db, config, now())
  result.considered = targets.length

  for (const target of targets) {
    if (result.spent >= v.maxPerRun) {
      recordDecision(db, target, "refused_budget", null, { note: `per-run ceiling (${v.maxPerRun}) reached` })
      result.refused++
      continue
    }
    const day = now().toISOString().slice(0, 10)
    const dailyKey = `${DAILY_KEY_PREFIX}${day}`
    const usedToday = Number(readState(db, dailyKey) ?? "0")
    if (usedToday >= v.maxPerDay) {
      recordDecision(db, target, "refused_budget", null, { note: `daily ceiling (${v.maxPerDay}) reached` })
      result.refused++
      continue
    }
    // Reserve before the await: a crash mid-request still counts as spent.
    writeState(db, dailyKey, String(usedToday + 1))

    const property = getStayProperty(db, target.propertyId)
    if (!property) {
      recordDecision(db, target, "failed", null, { note: "property vanished from registry" })
      result.refused++
      continue
    }

    await sleep(1000)
    const search = await runStayRateSearch(provider, {
      propertyId: property.id,
      providerRef: property.refs[SERPAPI_HOTELS_PROVIDER] ?? `q:${property.name}`,
      checkIn: target.checkIn, checkOut: target.checkOut,
      adults: config.observation.adults, children: config.observation.children,
      currency: config.observation.currency,
    }, { captureRaw: true })

    if (search.callsSpent > 0) result.spent++

    if (search.ok) {
      const requestId = recordStaySearchRequest(db, {
        propertyId: property.id, kind: "rates",
        checkIn: target.checkIn, checkOut: target.checkOut,
        adults: config.observation.adults, children: config.observation.children,
        currency: config.observation.currency, source: "observer",
      })
      if (search.raw !== undefined) {
        recordRawResponse(db, {
          provider: provider.name, kind: "rates", propertyId: property.id,
          searchRequestId: requestId, payload: search.raw,
        }, config.budgets.rawRetention)
      }
      const summary = recordRateObservations(db, property, requestId, search.rates, config.sanity)
      const nightlies = search.rates
        .filter(r => r.priceBasis === "nightly_room")
        .map(r => r.price.amount)
      recordDecision(db, target, "spent", requestId, {
        observations: summary.inserted,
        verifiedMinNightly: nightlies.length ? Math.min(...nightlies) : null,
      })
      db.prepare("UPDATE stay_candidates SET verification_status = 'verified', verification_gate_reason = ? WHERE id = ?")
        .run(target.gateReason, target.candidateId)
      result.confirmed++
      result.details.push(`${target.propertyId} ${target.checkIn}: verified (${target.gateReason})`)
    } else if (search.reason === "budget-exhausted") {
      recordDecision(db, target, "refused_budget", null, { note: search.error })
      result.refused++
      result.details.push(`${target.propertyId}: ${search.error}`)
    } else if (search.reason === "no-results") {
      recordDecision(db, target, "no_match", null, { note: search.error })
      db.prepare("UPDATE stay_candidates SET verification_status = 'verification_failed', verification_gate_reason = ? WHERE id = ?")
        .run(target.gateReason, target.candidateId)
      result.details.push(`${target.propertyId}: no match (${search.error})`)
    } else {
      recordDecision(db, target, "failed", null, { note: search.error })
      db.prepare("UPDATE stay_candidates SET verification_status = 'verification_failed', verification_gate_reason = ? WHERE id = ?")
        .run(target.gateReason, target.candidateId)
      result.details.push(`${target.propertyId}: failed (${search.error})`)
      // Deliberately NO retry: one gate decision, at most one request.
    }
  }

  // New verified observations change evidence for the whole property window —
  // re-judge so candidates carry the paid answer.
  if (result.confirmed > 0) {
    evaluateStayObservations({ db, config, fromScratch: true })
  }
  return result
}

function recordDecision(
  db: DB,
  target: VerificationTarget,
  status: "spent" | "refused_budget" | "refused_cooldown" | "failed" | "no_match",
  searchRequestId: number | null,
  summary: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO stay_verifications
      (candidate_id, opportunity_key, property_id, check_in, check_out,
       gate_reason, gate_detail, status, search_request_id, result_summary, requested_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    target.candidateId, target.opportunityKey, target.propertyId,
    target.checkIn, target.checkOut,
    target.gateReason, target.gateDetail, status, searchRequestId,
    JSON.stringify(summary), nowIso(), nowIso(),
  )
}

export interface StoredVerification {
  id: number
  propertyId: string
  checkIn: string
  checkOut: string
  gateReason: string
  gateDetail: string
  status: string
  resultSummary: Record<string, unknown>
  requestedAt: string
}

export function listVerifications(db: DB, opts: { limit?: number } = {}): StoredVerification[] {
  const rows = db.prepare(`
    SELECT * FROM stay_verifications ORDER BY id DESC LIMIT ?
  `).all(opts.limit ?? 20) as Record<string, unknown>[]
  return rows.map(r => ({
    id: r.id as number,
    propertyId: r.property_id as string,
    checkIn: r.check_in as string,
    checkOut: r.check_out as string,
    gateReason: r.gate_reason as string,
    gateDetail: r.gate_detail as string,
    status: r.status as string,
    resultSummary: JSON.parse((r.result_summary as string) ?? "{}") as Record<string, unknown>,
    requestedAt: r.requested_at as string,
  }))
}
