#!/usr/bin/env tsx
/**
 * Hotel Award Radar — Phase 1 probe CLI (Gondola MCP only).
 *
 *   npx tsx providers/hotel-awards/cli.ts probe --location "Bangkok"
 *        --check-in 2026-11-21 --check-out 2026-11-26 [--adults 2]
 *        [--hotel "name"] [--chain "Hyatt"] [--min-nights 2] [--dry-run]
 *
 *   npx tsx providers/hotel-awards/cli.ts discover --location "Bangkok"
 *        --check-in 2026-11-01 --check-out 2026-12-01
 *        [--nights 2,4,5,7] [--max-windows 8] [--adults 2] [--dry-run]
 *
 * LIVE-VERIFIED SEMANTICS (2026-08-29): Roame's HotelAvailablePeriods is an
 * EXACT-WINDOW quote engine — it always returns the requested check-in and
 * exact night count; minNights only filters, it never enumerates shorter
 * periods. `probe` is therefore one exact-window observation, and `discover`
 * plans a SPARSE set of exact sub-windows across a long range (planner.ts),
 * prints the full plan before any call, and runs each window as its own
 * independent Roame search. Windows never blend; per-night averages never
 * become totals. Gondola is never used for sweeping — its exact-window
 * verification role and budget are untouched.
 *
 *   npx tsx providers/hotel-awards/cli.ts list [--limit 20] [--program X]
 *
 * The request plan is printed BEFORE anything is spent; --dry-run stops
 * there. Observations are append-only and separate from cash stays; no
 * valuation, no ranking.
 */

import "../../load-env.js"
import { getDb } from "../../db/index.js"
import { recordCallAttempt, recordCallOutcome } from "../../db/repositories.js"
import { GondolaHotelAwardsProvider, loadHotelAwardsConfig } from "./gondola.js"
import { RoameHotelAwardsProvider } from "./roame.js"
import { describeWindow, planStayWindows } from "./planner.js"
import { executeWindowPlan } from "./discover.js"
import { insertHotelAwards, listHotelAwards } from "./store.js"
import { getLocator } from "../../offers/locators.js"

const [command, ...args] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(`--${name}`)

async function main() {
  const db = getDb()
  const cfg = loadHotelAwardsConfig()

  switch (command) {
    case "probe": {
      const location = flag("location")
      const checkIn = flag("check-in")
      const checkOut = flag("check-out")
      if (!location || !checkIn || !checkOut) throw new Error("--location, --check-in and --check-out are required")

      // Provider identity is data: --provider selects which one to probe;
      // default gondola. Roame emits the SAME normalized observations.
      const which = flag("provider") ?? "gondola"
      const provider = which === "roame" ? new RoameHotelAwardsProvider(cfg) : new GondolaHotelAwardsProvider(cfg)

      if (which === "gondola") {
        const planned = (provider as GondolaHotelAwardsProvider).plannedCalls()
        console.log(`Request plan: 1 search + ${cfg.budget.detailTopN} × (multi-night confirm + booking link) = ${planned} calls (cap ${cfg.budget.maxCallsPerRun})`)
        if (planned > cfg.budget.maxCallsPerRun) {
          throw new Error(`plan (${planned}) exceeds maxCallsPerRun (${cfg.budget.maxCallsPerRun}) — lower detailTopN`)
        }
      } else {
        console.log(`Request plan: up to ${cfg.roame?.search.maxPages ?? 1} HotelAvailablePeriods page(s) on /encore/graphql; session=${provider.isConfigured()}`)
      }

      // Optional minNights filter (live-verified: Roame echoes the exact
      // window regardless — this only filters which hotels qualify).
      const minNightsRaw = flag("min-nights")
      const minNights = minNightsRaw !== undefined ? Number(minNightsRaw) : undefined
      if (minNightsRaw !== undefined && (!Number.isInteger(minNights) || minNights! < 1)) {
        throw new Error(`--min-nights must be an integer ≥ 1 (got ${minNightsRaw})`)
      }
      if (minNights !== undefined && which === "gondola") {
        console.log("note: --min-nights applies to the Roame provider only — Gondola keeps its exact-window verification role and ignores it")
      }
      if (has("dry-run")) { console.log("DRY RUN — zero requests were issued."); break }

      recordCallAttempt(db, provider.name)
      const result = await provider.search({
        location, checkIn, checkOut,
        adults: Number(flag("adults") ?? 2),
        hotelName: flag("hotel"),
        chainName: flag("chain"),
        minNights,
      })
      recordCallOutcome(db, provider.name, result.ok ? { ok: true } : { ok: false, error: result.error ?? result.searchState })

      console.log(`${provider.name}: ${result.searchState} — ${result.awards.length} award quotes, ${result.callsSpent} calls, ${result.latencyMs}ms` +
        (result.appliedMinNights !== undefined ? ` (searched minNights ${result.appliedMinNights})` : ""))
      if (!result.ok) { console.log(`  ${result.reason}: ${result.error}`); break }

      const summary = insertHotelAwards(db, result.awards)
      console.log(`Stored ${summary.inserted} observations (append-only)` +
        (summary.rejected.length ? `; REJECTED ${summary.rejected.length}: ${summary.rejected.map(r => `${r.propertyName} (${r.reason})`).join("; ")}` : ""))

      for (const a of listHotelAwards(db, { limit: summary.inserted })) {
        const locator = a.locatorId !== null ? getLocator(db, a.locatorId) : null
        const points = a.quoteBasis === "full_stay"
          ? `${a.pointsTotal!.toLocaleString()} pts total (${a.pointsPerNight?.toLocaleString() ?? "?"} /night stated)`
          : `${a.pointsPerNight!.toLocaleString()} pts/night (no stay total stated)`
        console.log(`#${a.id} ${a.propertyName} [${a.program}]`)
        console.log(`   ${a.checkIn} → ${a.checkOut} (${a.nights}n, ${a.quoteBasis}) · ${points} · taxes ${a.taxesFeesState}`)
        console.log(`   availability ${a.availabilityState} · cash context ${a.cashComparisonAmount !== null ? `${a.cashComparisonCurrency} ${a.cashComparisonAmount} (labelled, never blended)` : "none"}`)
        console.log(`   navigation: ${locator ? locator.navigationQuality : "UNAVAILABLE"}${locator?.searchReplayUrl ? `\n   URL: ${locator.searchReplayUrl}` : ""}`)
      }
      break
    }

    case "discover": {
      const location = flag("location")
      const checkIn = flag("check-in")
      const checkOut = flag("check-out")
      if (!location || !checkIn || !checkOut) throw new Error("--location, --check-in and --check-out are required")

      const disc = cfg.roame?.discovery
      const nightsFlag = flag("nights")
      const candidateNights = nightsFlag !== undefined
        ? nightsFlag.split(",").map(s => Number(s.trim()))
        : disc?.candidateNights
      const maxFlag = flag("max-windows")
      const maxWindows = maxFlag !== undefined ? Number(maxFlag) : disc?.maxWindowsPerRun

      // The full plan — including its explicit budget and anything dropped to
      // meet it — is printed BEFORE any provider call.
      const plan = planStayWindows(checkIn, checkOut, { candidateNights, maxWindows })
      const maxPages = cfg.roame?.search.maxPages ?? 1
      console.log(`Window plan for ${location}, ${plan.rangeStart} → ${plan.rangeEnd} (${plan.totalNights} nights):`)
      console.log(`  ${plan.windows.length} exact Roame window(s) within budget ${plan.budget} — at most ${plan.windows.length * maxPages} HTTP calls (maxPages ${maxPages} each)`)
      for (const w of plan.windows) console.log(`  ${describeWindow(w)}`)
      if (plan.dropped.length > 0) {
        console.log(`  dropped over budget, deterministically (${plan.dropped.length}):`)
        for (const w of plan.dropped) console.log(`    ${describeWindow(w)}`)
      }
      console.log("  Each window is an independent exact-window observation — windows never blend; per-night averages never become stay totals.")
      if (has("dry-run")) { console.log("DRY RUN — zero requests were issued."); break }

      const roame = new RoameHotelAwardsProvider(cfg)
      const summary = await executeWindowPlan(db, roame, plan, {
        location,
        adults: Number(flag("adults") ?? 2),
        politenessMs: cfg.budget.politenessMs,
        onWindow: r => console.log(r.ok
          ? `${describeWindow(r.window)}: ${r.searchState} — ${r.quotes} quotes, ${r.callsSpent} call(s); stored ${r.stored}`
          : `${describeWindow(r.window)}: ${r.searchState} — ${r.reason}: ${r.error}`),
      })
      if (summary.stoppedOnBlock) console.log("BLOCKED — the run stopped, no retries.")
      console.log(`Discover run complete: ${summary.windowsCompleted}/${summary.windowsPlanned} windows, ${summary.providerCalls} provider calls, ` +
        `${summary.observationsStored} observations stored (append-only), ${summary.distinctHotels} distinct hotels, programs: ${summary.programs.join(", ") || "none"}.`)
      break
    }

    case "list": {
      for (const a of listHotelAwards(db, { limit: Number(flag("limit") ?? 20), program: flag("program") })) {
        console.log(`#${a.id} ${a.fetchedAt.slice(0, 16)} ${a.propertyName} [${a.program}] ${a.checkIn}→${a.checkOut} ` +
          `${a.quoteBasis} ${a.pointsTotal?.toLocaleString() ?? a.pointsPerNight?.toLocaleString() + "/n"} pts · ${a.availabilityState}/${a.searchState}`)
      }
      break
    }

    default:
      console.log("Commands: probe --location X --check-in D --check-out D [--min-nights N] [--adults N] [--provider roame|gondola] [--dry-run] | " +
        "discover --location X --check-in D --check-out D [--nights 2,4,5,7] [--max-windows N] [--dry-run] | list [--limit N] [--program X]")
      process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`hotel-awards ${command ?? ""}: ${(err as Error).message}`)
  process.exitCode = 1
})
