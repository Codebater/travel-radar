#!/usr/bin/env tsx
/**
 * Hotel Award Radar — Phase 1 probe CLI (Gondola MCP only).
 *
 *   npx tsx providers/hotel-awards/cli.ts probe --location "Bangkok"
 *        --check-in 2026-11-21 --check-out 2026-11-26 [--adults 2]
 *        [--hotel "name"] [--chain "Hyatt"] [--dry-run]
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
      const provider = new GondolaHotelAwardsProvider(cfg)

      const planned = provider.plannedCalls()
      console.log(`Request plan: 1 search + ${cfg.budget.detailTopN} × (multi-night confirm + booking link) = ${planned} calls (cap ${cfg.budget.maxCallsPerRun})`)
      if (planned > cfg.budget.maxCallsPerRun) {
        throw new Error(`plan (${planned}) exceeds maxCallsPerRun (${cfg.budget.maxCallsPerRun}) — lower detailTopN`)
      }
      if (has("dry-run")) { console.log("DRY RUN — zero requests were issued."); break }

      recordCallAttempt(db, provider.name)
      const result = await provider.search({
        location, checkIn, checkOut,
        adults: Number(flag("adults") ?? 2),
        hotelName: flag("hotel"),
        chainName: flag("chain"),
      })
      recordCallOutcome(db, provider.name, result.ok ? { ok: true } : { ok: false, error: result.error ?? result.searchState })

      console.log(`${provider.name}: ${result.searchState} — ${result.awards.length} award quotes, ${result.callsSpent} calls, ${result.latencyMs}ms`)
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

    case "list": {
      for (const a of listHotelAwards(db, { limit: Number(flag("limit") ?? 20), program: flag("program") })) {
        console.log(`#${a.id} ${a.fetchedAt.slice(0, 16)} ${a.propertyName} [${a.program}] ${a.checkIn}→${a.checkOut} ` +
          `${a.quoteBasis} ${a.pointsTotal?.toLocaleString() ?? a.pointsPerNight?.toLocaleString() + "/n"} pts · ${a.availabilityState}/${a.searchState}`)
      }
      break
    }

    default:
      console.log("Commands: probe --location X --check-in D --check-out D [--adults N] [--dry-run] | list [--limit N] [--program X]")
      process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`hotel-awards ${command ?? ""}: ${(err as Error).message}`)
  process.exitCode = 1
})
