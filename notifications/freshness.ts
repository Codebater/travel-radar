/**
 * §35 - is the thing this candidate describes still a thing?
 *
 * A `deal_candidates` row outlives the observation behind it, and for open jaws
 * it outlives it badly:
 *
 *   - `buildOpenJawCandidate` sets `observedAt = asOf = now`, and
 *     `evaluateOpenJaws` re-derives every pair on every tick with no cursor. So
 *     an open jaw assembled from two forty-day-old legs carries an `observed_at`
 *     that is seconds old.
 *   - `oneWayLegs` admits legs up to `openJaw.maxLegAgeDays` (45) apart, and
 *     `assessFriction` only PENALISES the spread. A 44-day-old outbound paired
 *     with a ten-minute-old inbound is a legal candidate.
 *   - nothing ever deletes from `open_jaw_pairs`: `deleteCandidate` is only
 *     called for `flight_prices` and `award_prices`, so a pair whose legs aged
 *     out lives on with its score and its position in the feed intact.
 *
 * Therefore freshness is measured from the UNDERLYING OBSERVATION, never from
 * `observed_at`, `as_of` or `evaluated_at`. And for an open jaw it is measured
 * from the OLDER leg (MIN), not the newer one - the fresher leg tells you
 * nothing about whether the trip can still be bought.
 *
 * Every answer is a value. A missing row - the ON DELETE CASCADE from
 * flight_prices fired and took the pair with it - returns `withdrawn: true`
 * rather than throwing, because this runs inside the scheduler tick.
 */

import type { DB } from "../db/index.js"
import type { StoredCandidate } from "../anomaly/store.js"

export interface FreshnessResult {
  kind: "single" | "openjaw" | "unknown"
  /** The source observation(s) no longer exist. */
  withdrawn: boolean
  /** Open jaws only: how many of the two legs are still present. */
  legsPresent: number | null
  /** The OLDEST observation this candidate rests on. */
  oldestFetchedAt: string | null
  oldestAgeHours: number | null
  /** Open jaws only, and separately gated: the comparator can rot on its own. */
  comparatorFetchedAt: string | null
  comparatorAgeHours: number | null
  /** Days from now until departure. Negative means it has already gone. */
  departureLeadDays: number | null
  detail: string
}

function ageHours(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return null
  return Math.round(((now.getTime() - parsed) / 3600_000) * 10) / 10
}

function leadDays(departureDate: string, now: Date): number | null {
  const parsed = Date.parse(`${departureDate}T00:00:00Z`)
  if (!Number.isFinite(parsed)) return null
  return Math.round((parsed - now.getTime()) / 86_400_000)
}

export function measureFreshness(
  db: DB, candidate: StoredCandidate, now: Date = new Date(),
): FreshnessResult {
  const departureLeadDays = leadDays(candidate.departureDate, now)
  const base = {
    withdrawn: false,
    legsPresent: null as number | null,
    oldestFetchedAt: null as string | null,
    oldestAgeHours: null as number | null,
    comparatorFetchedAt: null as string | null,
    comparatorAgeHours: null as number | null,
    departureLeadDays,
  }

  if (candidate.sourceTable === "open_jaw") {
    // LEFT JOIN and a COUNT, so a leg that has been deleted reads as absent
    // rather than as "no age constraint" - the difference between refusing and
    // silently treating a ghost as fresh.
    const row = db.prepare(`
      SELECT p.id pairId,
             COUNT(fp.id) legsPresent,
             MIN(fp.fetched_at) oldestLegAt,
             (SELECT c.fetched_at FROM flight_prices c WHERE c.id = p.comparator_price_id) comparatorAt
      FROM open_jaw_pairs p
      LEFT JOIN flight_prices fp ON fp.id IN (p.outbound_price_id, p.inbound_price_id)
      WHERE p.id = ?
      GROUP BY p.id
    `).get(candidate.sourceId) as
      { pairId: number; legsPresent: number; oldestLegAt: string | null; comparatorAt: string | null } | undefined

    if (!row) {
      return {
        ...base, kind: "openjaw", withdrawn: true, legsPresent: 0,
        detail: `open-jaw pair ${candidate.sourceId} no longer exists - its legs were removed`,
      }
    }
    const oldest = row.oldestLegAt
    const oldestAge = ageHours(oldest, now)
    return {
      ...base,
      kind: "openjaw",
      withdrawn: row.legsPresent < 2,
      legsPresent: row.legsPresent,
      oldestFetchedAt: oldest,
      oldestAgeHours: oldestAge,
      comparatorFetchedAt: row.comparatorAt,
      comparatorAgeHours: ageHours(row.comparatorAt, now),
      detail: row.legsPresent < 2
        ? `only ${row.legsPresent} of 2 legs still exist`
        : `older leg observed ${oldestAge}h ago` +
          (row.comparatorAt ? `, comparator ${ageHours(row.comparatorAt, now)}h ago` : ", no comparator row"),
    }
  }

  const table = candidate.sourceTable === "award_prices" ? "award_prices" : "flight_prices"
  const row = db.prepare(
    `SELECT fetched_at fetchedAt FROM ${table} WHERE id = ?`,
  ).get(candidate.sourceId) as { fetchedAt: string } | undefined

  if (!row) {
    return {
      ...base, kind: "single", withdrawn: true,
      detail: `the ${table} row behind this decision no longer exists`,
    }
  }
  const age = ageHours(row.fetchedAt, now)
  return {
    ...base,
    kind: "single",
    oldestFetchedAt: row.fetchedAt,
    oldestAgeHours: age,
    detail: `observed ${age}h ago`,
  }
}
