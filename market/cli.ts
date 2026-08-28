#!/usr/bin/env tsx
/**
 * Trip-market admin (Phase 8h).
 *
 *   npx tsx market/cli.ts fx                 fetch + store the configured FX pairs (LIVE, 1 call/pair)
 *   npx tsx market/cli.ts fx-status          stored FX observations + staleness (local)
 *   npx tsx market/cli.ts run [--min-score N]  the market run: ledgers, verdicts,
 *                                            market observations (local, ZERO external calls)
 *   npx tsx market/cli.ts verdicts [--trip N]  current (newest-batch) verdicts
 *   npx tsx market/cli.ts report             BUILD-vs-BUY market report per trip
 *
 * `fx` is the only live command. Verdicts require fresh FX for cross-currency
 * pairs — a stale or missing rate is a named refusal, never a reused number.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { listTrips } from "../trips/store.js"
import { loadMarketConfig } from "./config.js"
import { fetchAndStoreFxRate, isFxStale, latestFxObservation } from "./fx.js"
import {
  currentMarketVerdictsForTrip,
  leadVerdict,
  marketVerdictTotals,
  runMarket,
} from "./verdict.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

async function main() {
  const db = getDb()
  const cfg = loadMarketConfig()

  switch (command) {
    case "fx": {
      for (const [base, quote] of cfg.fx.pairs) {
        const result = await fetchAndStoreFxRate(db, base, quote)
        if (result.ok) {
          const o = result.observation!
          console.log(`${base}→${quote}: ${o.rate} (${o.provider}, reference date ${o.providerDate}) stored as fx#${o.id}`)
        } else {
          console.log(`${base}→${quote}: FAILED — ${result.error}`)
          process.exitCode = 1
        }
      }
      break
    }

    case "fx-status": {
      for (const [base, quote] of cfg.fx.pairs) {
        const obs = latestFxObservation(db, base, quote)
        if (!obs) { console.log(`${base}→${quote}: no observation stored`); continue }
        console.log(
          `${base}→${quote}: ${obs.rate} (fx#${obs.id}, ${obs.provider}, reference ${obs.providerDate}, fetched ${obs.fetchedAt.slice(0, 16)})`
          + (isFxStale(obs) ? " — STALE, refuses numeric verdicts" : " — fresh"),
        )
      }
      break
    }

    case "run": {
      const summary = runMarket(db, { minTripScore: Number(flag("min-score") ?? 0) })
      console.log(`Market run ${summary.computeBatch}:`)
      console.log(`  ${summary.tripsExamined} trips × ${summary.packageVariantsExamined} package variants → ${summary.pairsEvaluated} pairs`)
      console.log(`  verdicts stored: ${summary.verdictsStored}, market observations: ${summary.marketObservationsStored}`)
      for (const [verdict, n] of Object.entries(summary.byVerdict).sort()) console.log(`  ${verdict}: ${n}`)
      for (const [conf, n] of Object.entries(summary.byConfidence).sort()) console.log(`  confidence ${conf}: ${n}`)
      break
    }

    case "verdicts": {
      const tripId = flag("trip")
      const trips = tripId
        ? listTrips(db, { limit: 500 }).filter(t => t.id === Number(tripId))
        : listTrips(db, { limit: 100, status: "interesting" })
      for (const trip of trips) {
        const verdicts = currentMarketVerdictsForTrip(db, trip.id)
        if (verdicts.length === 0) continue
        console.log(`trip #${trip.id} ${trip.tripKey}`)
        for (const v of verdicts) {
          const nums = v.absoluteDifference !== null
            ? ` | DIY ${v.comparisonCurrency} ${v.diyKnownTotal} vs pkg ${v.packageTotal} | Δ ${v.absoluteDifference} (${v.percentDifference}%)`
            : v.diyKnownTotal !== null && v.packageTotal !== null
              ? ` | DIY ${v.comparisonCurrency} ${v.diyKnownTotal} vs pkg ${v.packageTotal}`
              : ""
          console.log(`  obs#${v.packageObservationId}: ${v.comparability} · ${v.confidence} → ${v.verdict}${v.winner ? ` (winner ${v.winner})` : ""}${nums}`)
          console.log(`    ${v.reasons[0] ?? ""}`)
        }
      }
      const totals = marketVerdictTotals(db)
      console.log(`current batch ${totals.currentBatch ?? "none"}: ${totals.verdicts} verdicts ${JSON.stringify(totals.byVerdict)}`)
      break
    }

    case "report": {
      const trips = listTrips(db, { limit: 100, status: "interesting" })
      for (const trip of trips) {
        const verdicts = currentMarketVerdictsForTrip(db, trip.id)
        if (verdicts.length === 0) continue
        const lead = leadVerdict(verdicts)!
        console.log(`\ntrip #${trip.id} ${trip.origin}→${trip.destinationAirport} ${trip.checkIn} ${trip.nights}n ${trip.board}/${trip.cabin}`)
        console.log(`  DIY known: ${lead.diyKnownTotal !== null ? `${lead.comparisonCurrency} ${lead.diyKnownTotal}` : "not computable"}`
          + ` | best comparable package: ${lead.packageTotal !== null ? `${lead.comparisonCurrency} ${lead.packageTotal}` : "?"} (obs#${lead.packageObservationId}, ${lead.comparability})`)
        console.log(`  VERDICT: ${lead.verdict} (${lead.confidence})`)
        for (const r of lead.reasons.slice(0, 3)) console.log(`    - ${r}`)
      }
      break
    }

    default:
      console.log("Unknown command. See the header of market/cli.ts for usage.")
      process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`market/cli ${command ?? ""}: ${(err as Error).message}`)
  process.exitCode = 1
})
