#!/usr/bin/env tsx
/**
 * Trip Composer admin (Phase 8f).
 *
 *   npx tsx trips/cli.ts compose             join stored flights × stored stays (database-only)
 *   npx tsx trips/cli.ts list [--min N] [--limit N] [--all]
 *   npx tsx trips/cli.ts show <id>           one trip in full
 *   npx tsx trips/cli.ts report              totals, gates, rejection picture
 *
 * Every command is database-only: no provider is contacted, no budget can be
 * spent, and nobody is notified. The composer judges what the radars have
 * already observed.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { composeTrips } from "./compose.js"
import { loadTripsConfig } from "./config.js"
import { getTrip, listTrips, tripTotals } from "./store.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
function has(name: string): boolean {
  return args.includes(`--${name}`)
}

const fmt = new Intl.NumberFormat("en-US")

function money(amount: number, currency: string): string {
  return `${currency === "USD" ? "$" : currency + " "}${fmt.format(Math.round(amount))}`
}

function main() {
  const db = getDb()

  switch (command) {
    case "compose": {
      const config = loadTripsConfig(true)
      const summary = composeTrips(db, config)
      console.log(`Trip composition (database-only — nothing was searched or spent)\n`)
      console.log(`Stay windows considered   ${summary.stayWindowsConsidered}`)
      console.log(`Flight options considered ${summary.flightOptionsConsidered}`)
      console.log(`Combinations examined     ${summary.combinationsExamined}`)
      console.log(`Feasible                  ${summary.feasible}`)
      console.log(`Admitted (interesting)    ${summary.admitted}`)
      console.log(`Stored                    ${summary.stored}`)
      if (Object.keys(summary.rejected).length) {
        console.log(`\nRejected:`)
        for (const [why, n] of Object.entries(summary.rejected)) console.log(`  ${String(n).padStart(4)}  ${why}`)
      }
      if (summary.ceilingsHit.length) {
        console.log(`\nCeilings hit:`)
        for (const c of [...new Set(summary.ceilingsHit)]) console.log(`  - ${c}`)
      }
      console.log(`\nDuration ${summary.durationMs}ms`)
      break
    }

    case "list": {
      const trips = listTrips(db, {
        minScore: Number(flag("min") ?? 0),
        limit: Number(flag("limit") ?? 15),
        status: has("all") ? undefined : "interesting",
      })
      if (trips.length === 0) { console.log("No composed trips at this bar — run trips:compose."); break }
      for (const t of trips) {
        const miles = t.milesComponents.map(m => `${fmt.format(m.miles)} ${m.program}`).join(" + ")
        const cash = t.cashTotal ? money(t.cashTotal.amount, t.cashTotal.currency) : "(mixed currencies — itemised)"
        console.log(`\n#${t.id}  ${String(t.score).padStart(5)}  ${t.origin} → ${t.destinationAirport} · ${t.nights} nights · ${t.construction}${t.status === "rejected" ? "  [REJECTED: " + t.rejectionReason + "]" : ""}`)
        console.log(`   ${(t.cabin ?? "?").toUpperCase()} + ${t.board.replace(/_/g, " ")} · ${(t.stayDetail.propertyName as string) ?? t.propertyId}`)
        console.log(`   ${t.checkIn} → ${t.checkOut} (fly out ${t.outboundDeparture}${t.returnDeparture ? ", back " + t.returnDeparture : ""})`)
        console.log(`   stay: ${(t.stayDetail.nightly as number)} ${(t.stayDetail.currency as string)}/nt (taxes ${(t.stayDetail.taxStatus as string)}, ${(t.stayDetail.verificationStatus as string)})`)
        console.log(`   TOTAL: ${cash}${miles ? ` + ${miles}` : ""}${t.unknownCosts.length ? `  (+ unknown: ${t.unknownCosts.join("; ")})` : ""}`)
        console.log(`   flight ${t.flightScore ?? "—"} | stay ${t.stayScore ?? "—"} | gate ${t.admissionGate}`)
        console.log(`   ${t.reasons.join(" ")}`)
      }
      break
    }

    case "show": {
      const id = Number(args[0])
      const trip = id ? getTrip(db, id) : null
      if (!trip) { console.error(`Unknown trip: ${args[0]}`); process.exit(1) }
      console.log(JSON.stringify(trip, null, 2))
      break
    }

    case "report": {
      const totals = tripTotals(db)
      console.log(`Trip Composer report\n`)
      console.log(`Trips stored        ${totals.trips} (${totals.interesting} interesting, ${totals.rejected} rejected)`)
      console.log(`Top score           ${totals.topScore ?? "n/a"}`)
      console.log(`\nBy construction:`)
      for (const [k, n] of Object.entries(totals.byConstruction)) console.log(`  ${k.padEnd(18)} ${n}`)
      console.log(`\nBy admission gate:`)
      for (const [k, n] of Object.entries(totals.byGate)) console.log(`  ${k.padEnd(38)} ${n}`)
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  compose                     join stored flight and stay opportunities into trips
  list [--min N] [--limit N] [--all]
  show <id>                   one composed trip in full
  report                      totals, constructions, gates

All commands are database-only. Nothing here searches, spends, or notifies.`)
      process.exit(command ? 1 : 0)
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("trips/cli.ts")
if (isMain) {
  try {
    main()
  } catch (err) {
    console.error("❌", (err as Error).message)
    process.exit(1)
  }
}
