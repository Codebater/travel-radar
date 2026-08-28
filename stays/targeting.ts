/**
 * Targeted sampling: what the sparse grid should look at NEXT, based on what
 * the radar already knows. Two sources, both cheap to compute and both
 * database-only:
 *
 *   CHEAP WINDOWS   runs of consecutive 'cheap' days in the latest calendar
 *                   snapshot. The grid is blind between its points; the
 *                   provider's own calendar is not — a run of cheap days IS
 *                   the shortlist of stays worth pricing.
 *   NEIGHBORS       check-ins adjacent to an unusually low recent observation.
 *                   An isolated glitch and a bookable cheap window look
 *                   identical until the dates around them are observed —
 *                   and actionability scoring NEEDS those neighbours.
 *
 * Both respect a re-sampling cooldown: a targeted sample must add NEW
 * information, never re-measure what was measured days ago.
 */

import type { DB } from "../db/index.js"
import type { StaysConfig } from "./config.js"
import type { StoredStayProperty } from "./registry.js"

export interface TargetedSample {
  property: StoredStayProperty
  checkIn: string
  nights: number
  kind: "cheap-window" | "neighbor" | "window-probe"
  detail: string
}

export function gatherTargetedSamples(
  db: DB,
  properties: StoredStayProperty[],
  config: StaysConfig,
  anchor: Date,
): TargetedSample[] {
  const t = config.sampling.targeted
  const horizonEnd = isoShift(anchor, config.sampling.horizonDays)
  const earliest = isoShift(anchor, Math.max(3, Math.floor(config.sampling.firstCheckInOffsetDays / 3)))
  const samples: TargetedSample[] = []

  for (const property of properties) {
    const nights = property.typicalStayNights[0] ?? config.observation.defaultNights

    // ── Cheap windows from the latest calendar ────────────────────────────
    const days = latestCalendarDays(db, property.id)
    const cheapRuns = consecutiveRuns(
      days.filter(d => d.dayClass === "cheap").map(d => d.date),
    ).filter(run => run.length >= t.minCheapRunNights)
    for (const run of cheapRuns.slice(0, t.cheapWindowSamplesPerRun)) {
      const checkIn = run[0]
      if (checkIn < earliest || checkIn > horizonEnd) continue
      samples.push({
        property, checkIn, nights,
        kind: "cheap-window",
        detail: `calendar shows ${run.length} consecutive cheap days from ${checkIn}`,
      })
    }

    // ── Neighbours of unusually low recent observations ───────────────────
    const lows = recentLows(db, property.id, t.neighborTriggerPercentBelow)
    for (const low of lows.slice(0, 2)) {
      for (const offset of t.neighborOffsetsDays.slice(0, t.neighborSamplesPerRun)) {
        const checkIn = isoShiftDay(low.checkIn, offset)
        if (checkIn < earliest || checkIn > horizonEnd) continue
        samples.push({
          property, checkIn, nights: low.nights,
          kind: "neighbor",
          detail: `${low.nightly} ${low.currency}/nt on ${low.checkIn} was ${low.percentBelow}% below median — probing ${offset > 0 ? "+" : ""}${offset}d`,
        })
      }
    }
  }

  // ── Window probes: map the EDGES of promising opportunity windows ───────
  // A window classified isolated/short may simply be under-observed. For the
  // strongest current windows, probe one day before the first known cheap
  // check-in and one/three days after the last — the cheapest way to learn
  // whether "two cheap check-ins" is really a bookable week.
  const propertyById = new Map(properties.map(p => [p.id, p]))
  const windows = db.prepare(`
    SELECT property_id, board, first_check_in, last_check_in, nights_min, persistence, best_score
    FROM stay_opportunity_windows
    WHERE persistence != 'sustained' AND best_score >= 40
    ORDER BY best_score DESC LIMIT 5
  `).all() as {
    property_id: string; board: string; first_check_in: string; last_check_in: string
    nights_min: number; persistence: string; best_score: number
  }[]
  for (const w of windows) {
    const property = propertyById.get(w.property_id)
    if (!property) continue
    for (const checkIn of [isoShiftDay(w.first_check_in, -1), isoShiftDay(w.last_check_in, 1), isoShiftDay(w.last_check_in, 3)]) {
      if (checkIn < earliest || checkIn > horizonEnd) continue
      samples.push({
        property, checkIn, nights: w.nights_min,
        kind: "window-probe",
        detail: `mapping the ${w.persistence} window ${w.first_check_in}→${w.last_check_in} (score ${w.best_score})`,
      })
    }
  }

  // Cooldown + in-plan dedupe: one question per (property, check-in).
  const seen = new Set<string>()
  return samples.filter(s => {
    const key = `${s.property.id}|${s.checkIn}`
    if (seen.has(key)) return false
    seen.add(key)
    return !recentlySampled(db, s.property.id, s.checkIn, t.recentSampleCooldownDays, anchor)
  })
}

/** Was this (property, check-in) asked about within the cooldown? */
export function recentlySampled(
  db: DB, propertyId: string, checkIn: string, cooldownDays: number, at: Date,
): boolean {
  const since = new Date(at.getTime() - cooldownDays * 86_400_000).toISOString()
  const row = db.prepare(`
    SELECT 1 FROM stay_search_requests
    WHERE property_id = ? AND kind = 'rates' AND check_in = ? AND created_at >= ?
    LIMIT 1
  `).get(propertyId, checkIn, since)
  return row !== undefined
}

function latestCalendarDays(db: DB, propertyId: string): { date: string; dayClass: string }[] {
  return db.prepare(`
    SELECT o.stay_date AS date, o.day_class AS dayClass
    FROM stay_calendar_observations o
    WHERE o.property_id = ?
      AND o.id = (
        SELECT MAX(i.id) FROM stay_calendar_observations i
        WHERE i.property_id = o.property_id AND i.stay_date = o.stay_date
      )
    ORDER BY o.stay_date ASC
  `).all(propertyId) as { date: string; dayClass: string }[]
}

interface RecentLow {
  checkIn: string
  nights: number
  nightly: number
  currency: string
  percentBelow: number
}

/**
 * Recent observations materially below their own comparable median. The
 * median here is a quick planning heuristic over the same hard dimensions —
 * the real baseline machinery renders the judgement; this only decides where
 * to LOOK next, and it looks with free requests.
 */
function recentLows(db: DB, propertyId: string, minPercentBelow: number): RecentLow[] {
  const rows = db.prepare(`
    SELECT check_in, nights, price_amount, price_currency, source_class, board, taxes_fees, fetched_at
    FROM stay_rate_observations
    WHERE property_id = ? AND sanity = 'ok' AND price_basis = 'nightly_room'
      AND fetched_at >= datetime('now', '-7 days')
    ORDER BY fetched_at DESC LIMIT 40
  `).all(propertyId) as {
    check_in: string; nights: number; price_amount: number; price_currency: string
    source_class: string; board: string; taxes_fees: string; fetched_at: string
  }[]

  const lows: RecentLow[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.check_in)) continue
    const priors = db.prepare(`
      SELECT price_amount FROM stay_rate_observations
      WHERE property_id = ? AND source_class = ? AND board = ? AND price_currency = ?
        AND taxes_fees = ?
        AND sanity = 'ok' AND price_basis = 'nightly_room' AND fetched_at < ?
    `).all(propertyId, r.source_class, r.board, r.price_currency, r.taxes_fees, r.fetched_at) as { price_amount: number }[]
    if (priors.length < 5) continue
    const sorted = priors.map(p => p.price_amount).sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    if (median <= 0) continue
    const percentBelow = Math.round((1 - r.price_amount / median) * 1000) / 10
    if (percentBelow >= minPercentBelow) {
      seen.add(r.check_in)
      lows.push({
        checkIn: r.check_in, nights: r.nights, nightly: r.price_amount,
        currency: r.price_currency, percentBelow,
      })
    }
  }
  return lows
}

/** Consecutive-day runs within a sorted list of YYYY-MM-DD dates. */
export function consecutiveRuns(dates: string[]): string[][] {
  const sorted = [...new Set(dates)].sort()
  const runs: string[][] = []
  let current: string[] = []
  for (const date of sorted) {
    if (current.length === 0 || Date.parse(date) - Date.parse(current[current.length - 1]) === 86_400_000) {
      current.push(date)
    } else {
      runs.push(current)
      current = [date]
    }
  }
  if (current.length) runs.push(current)
  return runs.sort((a, b) => b.length - a.length)
}

function isoShift(anchor: Date, days: number): string {
  return new Date(anchor.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}
function isoShiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
