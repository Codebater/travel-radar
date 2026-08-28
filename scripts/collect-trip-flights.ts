#!/usr/bin/env tsx
/**
 * One-off Phase 8f collection: real cash flight observations aimed at the
 * stay windows the composer will join. Free tier only (fast_flights),
 * metered fallback forbidden, USD to match the stay radar's currency.
 */

import "../load-env.js"
import { searchCashFlights } from "../providers/cash-flights/index.js"
import type { CabinClass } from "../providers/cash-flights/types.js"

const QUERIES: { origin: string; destination: string; departureDate: string; returnDate: string; cabins: CabinClass[] }[] = [
  // Lily Beach window (check-ins Nov 19 & 21, 5 nights)
  { origin: "VIE", destination: "MLE", departureDate: "2026-11-18", returnDate: "2026-11-24", cabins: ["economy", "business"] },
  { origin: "VIE", destination: "MLE", departureDate: "2026-11-20", returnDate: "2026-11-26", cabins: ["economy"] },
  { origin: "PRG", destination: "MLE", departureDate: "2026-11-18", returnDate: "2026-11-24", cabins: ["economy"] },
  // Soneva September window (check-in Sept 8, 5 nights)
  { origin: "VIE", destination: "MLE", departureDate: "2026-09-07", returnDate: "2026-09-13", cabins: ["economy", "business"] },
  // Grand Velas sustained window (check-ins Sept 17-27, 7 nights)
  { origin: "VIE", destination: "CUN", departureDate: "2026-09-16", returnDate: "2026-09-24", cabins: ["economy", "business"] },
  { origin: "VIE", destination: "CUN", departureDate: "2026-09-19", returnDate: "2026-09-27", cabins: ["economy"] },
]

async function main() {
  let calls = 0
  for (const q of QUERIES) {
    for (const cabin of q.cabins) {
      calls++
      const outcome = await searchCashFlights(
        { origin: q.origin, destination: q.destination, departureDate: q.departureDate, returnDate: q.returnDate, cabin, adults: 1, currency: "USD" },
        { source: "cli", allowMeteredFallback: false },
      )
      const cheapest = outcome.flights.length
        ? outcome.flights.reduce((a, b) => (a.price.amount <= b.price.amount ? a : b))
        : null
      console.log(
        `${q.origin}→${q.destination} ${q.departureDate}/${q.returnDate} ${cabin.padEnd(8)}: ` +
        `${outcome.flights.length} fares` +
        (cheapest ? `, low ${cheapest.price.amount} ${cheapest.price.currency} (${cheapest.airline ?? "?"}, ${cheapest.stops ?? "?"} stops)` : "") +
        (outcome.warnings.length ? `  [${outcome.warnings.join("; ")}]` : ""),
      )
      await new Promise(r => setTimeout(r, 1500))
    }
  }
  console.log(`\n${calls} free searches issued (SerpAPI untouched by construction).`)
}

main().catch(err => { console.error("❌", err.message); process.exit(1) })
