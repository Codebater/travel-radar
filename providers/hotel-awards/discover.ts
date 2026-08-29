/**
 * Discovery executor — runs a sparse WindowPlan (planner.ts) through a hotel
 * award provider and the append-only store. Shared by the CLI `discover`
 * command and POST /api/hotel-awards/discover so the loop exists ONCE.
 *
 * Honesty rules carried through:
 *   - each window is one independent exact-window search — windows never
 *     blend and nothing here computes across them;
 *   - per-window outcomes (incomplete, night_clamped, blocked, empty) are
 *     reported verbatim, and a BLOCKED result stops the run immediately —
 *     no retries, no continuing into a bot-wall;
 *   - storage is the same append-only insertHotelAwards path the single
 *     probe uses; no synthetic totals can appear because nothing here
 *     creates observations — it only stores what the provider returned.
 */

import { type DB } from "../../db/index.js"
import { recordCallAttempt, recordCallOutcome } from "../../db/repositories.js"
import { insertHotelAwards } from "./store.js"
import { type HotelAwardProvider } from "./types.js"
import { type PlannedWindow, type WindowPlan } from "./planner.js"

export interface WindowRunResult {
  window: PlannedWindow
  ok: boolean
  searchState: string
  quotes: number
  callsSpent: number
  stored: number
  reason?: string
  error?: string
}

export interface DiscoveryRunSummary {
  windowsPlanned: number
  /** Windows that ran and returned ok (any honest searchState). */
  windowsCompleted: number
  providerCalls: number
  observationsStored: number
  distinctHotels: number
  programs: string[]
  /** True when a blocked window stopped the run early — never retried. */
  stoppedOnBlock: boolean
  results: WindowRunResult[]
}

export async function executeWindowPlan(
  db: DB,
  provider: HotelAwardProvider,
  plan: WindowPlan,
  opts: { location: string; adults: number; politenessMs: number; onWindow?: (r: WindowRunResult) => void },
): Promise<DiscoveryRunSummary> {
  const results: WindowRunResult[] = []
  const hotels = new Set<string>()
  const programs = new Set<string>()
  let providerCalls = 0
  let observationsStored = 0
  let windowsCompleted = 0
  let stoppedOnBlock = false

  for (const w of plan.windows) {
    recordCallAttempt(db, provider.name)
    const result = await provider.search({
      location: opts.location, checkIn: w.checkIn, checkOut: w.checkOut,
      adults: opts.adults, minNights: w.nights,
    })
    recordCallOutcome(db, provider.name, result.ok ? { ok: true } : { ok: false, error: result.error ?? result.searchState })
    providerCalls += result.callsSpent

    let r: WindowRunResult
    if (result.ok) {
      const summary = insertHotelAwards(db, result.awards)
      observationsStored += summary.inserted
      windowsCompleted++
      for (const a of result.awards) {
        hotels.add(`${a.provider}|${a.providerPropertyRef}`)
        programs.add(a.program)
      }
      r = { window: w, ok: true, searchState: result.searchState, quotes: result.awards.length, callsSpent: result.callsSpent, stored: summary.inserted }
    } else {
      r = { window: w, ok: false, searchState: result.searchState, quotes: 0, callsSpent: result.callsSpent, stored: 0, reason: result.reason, error: result.error }
    }
    results.push(r)
    opts.onWindow?.(r)

    if (!result.ok && result.reason === "blocked") { stoppedOnBlock = true; break }
    if (opts.politenessMs > 0) await new Promise(res => setTimeout(res, opts.politenessMs))
  }

  return {
    windowsPlanned: plan.windows.length,
    windowsCompleted,
    providerCalls,
    observationsStored,
    distinctHotels: hotels.size,
    programs: [...programs].sort(),
    stoppedOnBlock,
    results,
  }
}
