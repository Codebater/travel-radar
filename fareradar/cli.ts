#!/usr/bin/env tsx
/**
 * Business fare radar (Phase 8j).
 *
 *   npx tsx fareradar/cli.ts radar --origins VIE,PRG --destination BKK --next-days 30
 *                                  [--min-nights 4] [--max-nights 14] [--cabin business]
 *                                  [--watchlist asia | --anywhere] [--max-calls N]
 *                                  [--extended] [--dry-run]
 *        Plan + run a flexible sweep. FREE provider only; --dry-run prints the
 *        plan and issues ZERO requests.
 *   npx tsx fareradar/cli.ts report            the latest run: cheapest, best value,
 *                                              per-destination and home-airport diffs
 *   npx tsx fareradar/cli.ts recheck [--top 5] re-confirm the finalists (LIVE, free)
 *
 * Origins default to config/fare-radar.json homeAirports — never hard-coded.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { loadFareRadarConfig, homeAirports } from "./config.js"
import { buildSearchPlan, shiftDate } from "./planner.js"
import { recheckTopFares, runFareRadar } from "./engine.js"
import { candidatesForRun, latestFareRadarRun, typicalFareFor, type StoredFareCandidate } from "./store.js"
import { getLocator } from "../offers/locators.js"
import { anywhereDestinations, watchlist } from "./config.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
function has(name: string): boolean {
  return args.includes(`--${name}`)
}

function printCandidate(db: ReturnType<typeof getDb>, c: StoredFareCandidate, rank: number): void {
  const hours = c.durationMinutes !== null ? `${Math.floor(c.durationMinutes / 60)}h ${c.durationMinutes % 60}m` : "?"
  const locator = c.locatorId !== null ? getLocator(db, c.locatorId) : null
  const url = locator ? (locator.deepLinkUrl ?? locator.searchReplayUrl ?? locator.landingUrl) : null
  console.log(`#${rank} — ${c.priceCurrency} ${c.priceAmount}`)
  console.log(`  ${c.origin} → ${c.destination}  ${c.departureDate} → ${c.returnDate}  (${c.nights} nights)`)
  console.log(`  ${c.airline ?? (c.airlines.join("+") || "?")} · ${c.cabinMix}${c.cabinMix !== "BUSINESS_FULL" ? ` (${c.cabinMixDetail})` : ""}`)
  console.log(`  ${c.stops ?? "?"} stop(s) · ${hours} · score ${c.dealScore}` +
    (c.qualityFlags.length ? ` · flags: ${c.qualityFlags.join(", ")}` : ""))
  console.log(`  provider ${c.provider} · observed ${c.observedAt.slice(0, 16)}`)
  console.log(`  navigation: ${locator ? locator.navigationQuality : "UNAVAILABLE"}${url ? `\n  URL: ${url}` : ""}`)
  const typical = typicalFareFor(db, {
    origin: c.origin, destination: c.destination, nights: c.nights,
    cabin: c.cabin, currency: c.priceCurrency,
  })
  if (typical.mature) {
    const pct = Math.round((1 - c.priceAmount / typical.median) * 100)
    console.log(`  typical fare: ${c.priceCurrency} ${typical.median} (${typical.samples} obs/${typical.distinctFetchDays}d) → ${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%`)
  }
}

async function main() {
  const db = getDb()
  const cfg = loadFareRadarConfig()

  switch (command) {
    case "radar": {
      const params = {
        origins: flag("origins")?.split(",").map(s => s.trim()).filter(Boolean),
        destination: flag("destination"),
        watchlistName: flag("watchlist"),
        anywhere: has("anywhere"),
        nextDays: flag("next-days") ? Number(flag("next-days")) : undefined,
        minNights: flag("min-nights") ? Number(flag("min-nights")) : undefined,
        maxNights: flag("max-nights") ? Number(flag("max-nights")) : undefined,
        cabin: (flag("cabin") ?? "business") as "business",
        maxSearches: flag("max-calls") ? Number(flag("max-calls")) : undefined,
        includeExtended: has("extended") ? true : undefined,
        source: "cli" as const,
      }
      if (has("dry-run")) {
        const origins = params.origins?.length ? params.origins : homeAirports(cfg, params.includeExtended)
        const destinations = params.destination ? [params.destination.toUpperCase()]
          : params.watchlistName ? (watchlist(cfg, params.watchlistName) ?? [])
          : params.anywhere ? anywhereDestinations(cfg) : []
        if (!destinations.length) throw new Error("a destination, --watchlist or --anywhere is required")
        const windowStart = shiftDate(new Date().toISOString().slice(0, 10), 1)
        const plan = buildSearchPlan(cfg, {
          origins, destinations,
          windowStart, windowEnd: shiftDate(windowStart, (params.nextDays ?? cfg.window.defaultNextDays) - 1),
          minNights: params.minNights ?? cfg.window.minNights,
          maxNights: params.maxNights ?? cfg.window.maxNights,
          maxSearches: params.maxSearches,
        })
        for (const line of plan.lines) console.log(line)
        console.log("DRY RUN — zero requests were issued.")
        break
      }
      const summary = await runFareRadar(db, params)
      console.log(`\n── CHEAPEST (${summary.destinationMode}) ──`)
      summary.cheapest.slice(0, 5).forEach((c, i) => { printCandidate(db, c, i + 1); console.log("") })
      console.log(`── BEST VALUE ──`)
      summary.bestValue.slice(0, 3).forEach((c, i) => { printCandidate(db, c, i + 1); console.log("") })
      break
    }

    case "report": {
      const run = latestFareRadarRun(db)
      if (!run) { console.log("No finished fare-radar run — run flights:radar first."); break }
      const candidates = candidatesForRun(db, run.id)
      console.log(`Run #${run.id} (${run.destinationMode}) ${run.origins.join(",")} → ${run.destinations.join(",")}`)
      console.log(`  window ${run.windowStart}..${run.windowEnd}, ${run.minNights}-${run.maxNights} nights, ${run.cabin}, ${run.currency}`)
      console.log(`  ${run.searchesIssued} searches issued (planned ${run.callsPlanned}, billable calls ${run.callsSpent}) → ${run.candidatesFound} candidates\n`)

      console.log("── CHEAPEST ──")
      candidates.slice(0, 5).forEach((c, i) => { printCandidate(db, c, i + 1); console.log("") })

      // Per-destination cheapest (the ANYWHERE dashboard, textual).
      const byDest = new Map<string, StoredFareCandidate>()
      for (const c of candidates) if (!byDest.has(c.destination)) byDest.set(c.destination, c)
      if (byDest.size > 1) {
        console.log("── CHEAPEST BUSINESS-CLASS DESTINATIONS ──")
        for (const [dest, c] of [...byDest.entries()].sort((a, b) => a[1].priceAmount - b[1].priceAmount)) {
          console.log(`  ${dest}  ${c.priceCurrency} ${c.priceAmount}  (${c.origin}, ${c.departureDate}, ${c.nights}n, ${c.cabinMix})`)
        }
        console.log("")
      }

      // Home-airport comparison per destination: expose the difference, never
      // invent a positioning cost.
      for (const dest of new Set(candidates.map(c => c.destination))) {
        const perOrigin = new Map<string, StoredFareCandidate>()
        for (const c of candidates.filter(x => x.destination === dest)) {
          if (!perOrigin.has(c.origin)) perOrigin.set(c.origin, c)
        }
        if (perOrigin.size < 2) continue
        const sorted = [...perOrigin.values()].sort((a, b) => a.priceAmount - b.priceAmount)
        console.log(`── HOME AIRPORTS → ${dest} ──`)
        sorted.forEach((c, i) => console.log(`  ${i + 1}. ${c.origin}  ${c.priceCurrency} ${c.priceAmount}  (${c.airline ?? "?"}, ${c.stops ?? "?"} stop(s), ${c.departureDate})`))
        const diff = Math.round((sorted[1].priceAmount - sorted[0].priceAmount) * 100) / 100
        console.log(`  Difference: ${sorted[0].priceCurrency} ${diff} — ${sorted[0].origin} is cheaper; whether travelling to it is worth ${diff} is your call (no ground-transport data is assumed)\n`)
      }
      break
    }

    case "recheck": {
      const run = latestFareRadarRun(db)
      if (!run) { console.log("No finished fare-radar run."); break }
      const results = await recheckTopFares(db, run.id, Number(flag("top") ?? 5))
      for (const r of results) {
        console.log(`candidate #${r.candidateId}: ${r.status}`)
        console.log(`  observed ${r.currency} ${r.observedPrice}` +
          (r.currentPrice !== null ? ` → current ${r.currency} ${r.currentPrice}` : ""))
        if (r.status === "changed" && r.currentPrice !== null) {
          const diff = Math.round((r.currentPrice - r.observedPrice) * 100) / 100
          console.log(`  PRICE CHANGED: ${diff >= 0 ? "+" : ""}${diff} ${r.currency}`)
        }
        console.log(`  ${r.detail}`)
      }
      break
    }

    default:
      console.log("Unknown command. See the header of fareradar/cli.ts for usage.")
      process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`fareradar/cli ${command ?? ""}: ${(err as Error).message}`)
  process.exitCode = 1
})
