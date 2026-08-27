/**
 * §14/§15 - the only path from discovery to a metered call.
 *
 * Discovery is deliberately built on a free provider that reports fares it has
 * not been paid to confirm. That is the right trade for breadth, but it means a
 * candidate at the top of the feed carries a price nobody has verified. For a
 * small number of exceptional candidates it is worth paying to check.
 *
 * Three gates, all of which must pass:
 *   1. the candidate must clear an explicit score AND anomaly threshold, on a
 *      baseline that is not thin;
 *   2. the run must have metered headroom left;
 *   3. the DISCOVERY POOL must have headroom this month — a fraction of the
 *      automation ceiling, which is itself the monthly budget minus the
 *      operator's manual reserve.
 *
 * The manual reserve is unreachable from here by construction, not by care:
 * the pool is computed from `automationCeiling`, which already has the reserve
 * subtracted, and `userInitiated` is never set on this path.
 */

import type { DB } from "../db/index.js"
import { confidenceAtLeast, loadAnomalyConfig } from "../anomaly/config.js"
import { searchCashFlights } from "../providers/cash-flights/index.js"
import { evaluateNewObservations } from "../anomaly/engine.js"
import { recordSearchRequest } from "../db/repositories.js"
import type { DiscoveryConfig } from "./config.js"
import { canSpend, spend, note, discoveryVerificationPool, type RunBudgetState } from "./budget.js"
import type { DiscoveryJob } from "./types.js"

export interface VerificationOutcome {
  calls: number
  verified: { candidateId: number; route: string; before: number; after: number | null }[]
  skipped: string[]
  errors: string[]
}

interface VerifiableCandidate {
  id: number
  route: string
  origin: string
  destination: string
  departure_date: string
  return_date: string | null
  cabin: string
  score: number
  percent_below_median: number
  baseline_confidence: string
  price_amount: number | null
  price_currency: string | null
}

/**
 * Which candidates from this run deserve a paid confirmation, most convincing
 * first. Deliberately restricted to cash: a metered call confirms a cash fare,
 * and there is no metered award source to confirm anything with.
 */
export function selectForVerification(
  db: DB, runId: number | null, config: DiscoveryConfig,
): VerifiableCandidate[] {
  if (runId === null) return []
  const v = config.verification
  const rows = db.prepare(`
    SELECT id, route, origin, destination, departure_date, return_date, cabin, score,
           percent_below_median, baseline_confidence, price_amount, price_currency
    FROM deal_candidates
    WHERE discovery_run_id = ? AND type = 'cash' AND sanity = 'ok'
      AND verification_status = 'unverified'
      AND score >= ? AND percent_below_median >= ?
    ORDER BY score DESC
    LIMIT ?
  `).all(runId, v.minScore, v.minPercentBelowMedian, v.maxVerificationsPerRun * 4) as VerifiableCandidate[]

  // A thin baseline means the percentage that got it here is itself unreliable,
  // so paying to confirm the price would be confirming the wrong thing.
  return rows
    .filter(r => confidenceAtLeast(r.baseline_confidence as any, v.minBaselineConfidence as any))
    .slice(0, v.maxVerificationsPerRun)
}

/**
 * Confirm the strongest candidates of a run with the metered provider, within
 * every budget. Returns what it spent and why it stopped.
 */
export async function maybeVerify(
  db: DB,
  runId: number | null,
  job: DiscoveryJob,
  budget: RunBudgetState,
  config: DiscoveryConfig,
): Promise<VerificationOutcome> {
  const outcome: VerificationOutcome = { calls: 0, verified: [], skipped: [], errors: [] }
  if (runId === null) return outcome

  const pool = discoveryVerificationPool(db, config)
  if (pool.remaining <= 0) {
    const message =
      `no SerpAPI verification left in the discovery pool ` +
      `(${pool.used}/${pool.discoveryCeiling} used; ${pool.manualReserve} calls stay reserved for manual use)`
    outcome.skipped.push(message)
    note(budget, message)
    return outcome
  }

  const candidates = selectForVerification(db, runId, config)
  if (candidates.length === 0) {
    outcome.skipped.push(
      `no candidate cleared the verification gate ` +
      `(score >= ${config.verification.minScore}, ` +
      `>= ${config.verification.minPercentBelowMedian}% below median, ` +
      `baseline at least ${config.verification.minBaselineConfidence})`,
    )
    return outcome
  }

  for (const candidate of candidates) {
    if (!canSpend(budget, job, "metered")) break
    if (outcome.calls >= pool.remaining) {
      outcome.skipped.push("discovery verification pool exhausted mid-run")
      break
    }

    try {
      const searchRequestId = recordSearchRequest(db, {
        origin: candidate.origin, destination: candidate.destination,
        departureDate: candidate.departure_date, returnDate: candidate.return_date,
        cabin: candidate.cabin as any, adults: 1,
        currency: candidate.price_currency ?? "USD",
      }, "discovery", { discoveryMethod: "FLEXIBLE_DATE", discoveryRunId: runId, discoveryStage: 3 })

      const result = await searchCashFlights({
        origin: candidate.origin, destination: candidate.destination,
        departureDate: candidate.departure_date, returnDate: candidate.return_date,
        cabin: candidate.cabin as any, adults: 1,
        currency: candidate.price_currency ?? "USD",
      }, {
        source: "discovery",
        searchRequestId,
        // The point of this call is a metered confirmation, so the fallback is
        // allowed here and ONLY here...
        allowMeteredFallback: true,
        // ...but never as a "user initiated" call, which is what would unlock
        // the manual reserve. An automated path must not be able to reach it.
        userInitiated: false,
        forceRefresh: true,
        db,
      })

      const spent = Math.max(0, result.callsSpent)
      outcome.calls += spent
      spend(budget, "metered", Math.max(1, spent))

      const verifiedPrice = result.flights.length > 0
        ? Math.min(...result.flights.map(f => f.price.amount))
        : null

      outcome.verified.push({
        candidateId: candidate.id,
        route: candidate.route,
        before: candidate.price_amount ?? 0,
        after: verifiedPrice,
      })

      // The verification produced new observations; re-judging them is what
      // lets a confirmed price carry a `verified` status into the feed.
      evaluateNewObservations({ db, quiet: true, config: loadAnomalyConfig() })
    } catch (err) {
      outcome.errors.push(`verify ${candidate.route}: ${(err as Error).message}`)
    }
  }

  return outcome
}
