/**
 * §26 - paying to confirm a fare that is about to interrupt somebody.
 *
 * This is the one place in the notification layer that can spend money, and it
 * is deliberately built from the primitives one level below `maybeVerify`
 * rather than calling it. `maybeVerify` wants a `DiscoveryJob` and a
 * `RunBudgetState`, and fabricating those would be worse than duplicating a
 * dozen lines: `note()` writes into `scopeReduced`, which is persisted as
 * `discovery_runs.scope_reduced` and read by the operator as "the market was
 * quiet". A notification must never be able to write into that sentence.
 *
 * Three budget guarantees:
 *   - `userInitiated: false` keeps `serpApiBudget().reserveCalls` - the manual
 *     reserve - unreachable, exactly as it has been since Phase 2;
 *   - the discovery pool must have room, checked before anything is spent;
 *   - a notify-specific sub-cap, counted from `search_requests` where
 *     `source='notify'`, so this path cannot quietly eat the automation
 *     ceiling that discovery depends on.
 *
 * And one correctness guarantee: an open jaw is never verified here. Phase 6.5
 * established that re-searching one as a single round trip confirms a trip that
 * does not exist; `selectForVerification`'s guard protects that query only, so
 * this one carries its own - as a THROW, because a silent skip would look like
 * "verification passed" to a careless caller.
 */

import type { DB } from "../db/index.js"
import { currentPeriod } from "../db/index.js"
import { recordSearchRequest } from "../db/repositories.js"
import { searchCashFlights } from "../providers/cash-flights/index.js"
import { discoveryVerificationPool } from "../discovery/budget.js"
import { loadDiscoveryConfig } from "../discovery/config.js"
import type { StoredCandidate } from "../anomaly/store.js"
import type { NotificationConfig } from "./config.js"

export interface VerificationOutcome {
  attempted: boolean
  ok: boolean
  callsSpent: number
  /** The confirmed cheapest fare, when one came back. */
  price: number | null
  currency: string | null
  reason: string
}

/** How many metered calls the notification path has spent this month. */
export function notifyVerificationsThisPeriod(db: DB, period = currentPeriod()): number {
  return (db.prepare(
    `SELECT COUNT(*) c FROM search_requests
     WHERE source = 'notify' AND created_at >= ?`,
  ).get(`${period}-01`) as any).c as number
}

export async function verifyForNotification(
  db: DB, candidate: StoredCandidate, config: NotificationConfig,
): Promise<VerificationOutcome> {
  if (candidate.isOpenJaw || candidate.sourceTable === "open_jaw") {
    throw new Error(
      "an open jaw cannot be verified as a single round trip - those four fields describe " +
      "a trip that does not exist (Phase 6.5)",
    )
  }
  if (candidate.type !== "cash") {
    return { attempted: false, ok: false, callsSpent: 0, price: null, currency: null, reason: "not a cash fare" }
  }

  const discoveryConfig = loadDiscoveryConfig()
  const pool = discoveryVerificationPool(db, discoveryConfig)
  if (pool.remaining <= 0) {
    return {
      attempted: false, ok: false, callsSpent: 0, price: null, currency: null,
      reason: `the discovery verification pool is exhausted (${pool.used}/${pool.discoveryCeiling} used; ` +
        `${pool.manualReserve} calls stay reserved for manual use and are never reachable from here)`,
    }
  }

  const subCap = Math.max(1, Math.floor(pool.discoveryCeiling * (config.verifyBeforeNotify.poolShare ?? 0.15)))
  const spentByNotify = notifyVerificationsThisPeriod(db)
  if (spentByNotify >= subCap) {
    return {
      attempted: false, ok: false, callsSpent: 0, price: null, currency: null,
      reason: `notification verification has used its ${subCap}-call share of the pool this month`,
    }
  }

  const currency = candidate.priceCurrency ?? "USD"
  let searchRequestId: number | null = null
  try {
    searchRequestId = recordSearchRequest(db, {
      origin: candidate.origin, destination: candidate.destination,
      departureDate: candidate.departureDate, returnDate: candidate.returnDate,
      cabin: candidate.cabin, adults: 1, currency,
    }, "notify")
  } catch { /* the search still happens; only the provenance row is missing */ }

  try {
    const outcome = await searchCashFlights({
      origin: candidate.origin, destination: candidate.destination,
      departureDate: candidate.departureDate, returnDate: candidate.returnDate,
      cabin: candidate.cabin as any, adults: 1, currency,
    }, {
      source: "discovery",
      searchRequestId: searchRequestId ?? undefined,
      // The whole point of this call is a paid confirmation, so the metered
      // provider is allowed - here and nowhere else in this layer.
      allowMeteredFallback: true,
      // NOT user-initiated: this is what keeps the manual reserve out of reach.
      userInitiated: false,
      forceRefresh: true,
      db,
    })

    const cheapest = outcome.flights.length > 0
      ? Math.min(...outcome.flights.map(f => f.price.amount))
      : null

    if (cheapest === null) {
      return {
        attempted: true, ok: false, callsSpent: outcome.callsSpent, price: null, currency,
        reason: "the paid confirmation found no fare at all on this route and date",
      }
    }
    return {
      attempted: true, ok: true, callsSpent: outcome.callsSpent, price: cheapest, currency,
      reason: `confirmed at ${cheapest} ${currency}`,
    }
  } catch (err) {
    return {
      attempted: true, ok: false, callsSpent: 0, price: null, currency,
      reason: `verification failed: ${(err as Error).message}`,
    }
  }
}
