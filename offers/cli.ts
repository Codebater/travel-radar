#!/usr/bin/env tsx
/**
 * Bookable-offer admin (Phase 8i).
 *
 *   npx tsx offers/cli.ts build [--trip N]      build/refresh locators for stored
 *                                               observations (local, ZERO external calls)
 *   npx tsx offers/cli.ts report --trip N       every inspectable offer of one trip,
 *                                               with URLs, states and freshness (local)
 *   npx tsx offers/cli.ts recheck --offer N     re-resolve one offer at its provider
 *                                               (LIVE, budget/politeness-capped)
 *
 * Navigation quality is printed as stored — EXACT_DEEP_LINK only ever means
 * "the provider returned this URL for this offer".
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { listTrips } from "../trips/store.js"
import { assembleAllTripOffers, assembleTripOffers, type InspectableOffer } from "./assemble.js"
import { recheckOffer } from "./recheck.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

function ago(minutes: number | null): string {
  if (minutes === null) return "never"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / (24 * 60))} d ago`
}

function printOffer(label: string, offer: InspectableOffer): void {
  const l = offer.locator
  const v = offer.verification
  console.log(`OFFER  ${label}`)
  console.log(`  provider:      ${l.provider}${l.seller && l.seller !== l.provider ? ` (via ${l.seller})` : ""}`)
  if (l.operator) console.log(`  operator:      ${l.operator}`)
  console.log(`  price observed: ${l.nativeCurrency ?? "?"} ${l.nativePrice ?? "?"}`)
  if (v?.currentPrice != null) {
    console.log(`  price latest:  ${v.currentCurrency ?? "?"} ${v.currentPrice} (${v.status}, checked ${v.checkedAt.slice(0, 16)})`)
    if (v.status === "changed") {
      const diff = v.currentPrice - (v.observedPrice ?? 0)
      console.log(`  PRICE CHANGED: ${diff >= 0 ? "+" : ""}${Math.round(diff * 100) / 100} ${v.currentCurrency}`)
    }
  } else if (v) {
    console.log(`  price latest:  — (${v.status}: ${v.detail})`)
  }
  console.log(`  navigation:    ${l.navigationQuality}`)
  console.log(`  verification:  ${offer.state}`)
  console.log(`  observed:      ${ago(offer.freshness.observedAgoMinutes)}${offer.freshness.staleObservation ? " (STALE — recheck before booking)" : ""}`)
  console.log(`  verified:      ${offer.freshness.verifiedAgoMinutes !== null ? ago(offer.freshness.verifiedAgoMinutes) : "not recently verified"}`)
  const url = l.deepLinkUrl ?? l.searchReplayUrl ?? l.landingUrl
  console.log(`  URL:           ${url ?? "— (UNAVAILABLE)"}`)
  if (l.roomName || l.roomClass) console.log(`  room:          ${l.roomName ?? l.roomClass}`)
  if (l.board) console.log(`  board:         ${l.board}`)
  if (l.transferStatus) console.log(`  transfer:      ${l.transferStatus}`)
  if (l.kind === "flight") {
    console.log(`  flight:        ${l.operator ?? "?"} ${l.origin}→${l.destination} ${l.outboundDate}${l.returnDate ? ` / back ${l.returnDate}` : ""} (${l.cabin})`)
  }
  console.log(`  locator id:    #${l.id}`)
}

async function main() {
  const db = getDb()

  switch (command) {
    case "build": {
      const tripId = flag("trip")
      const bundles = tripId
        ? listTrips(db, { limit: 500 }).filter(t => t.id === Number(tripId)).map(t => assembleTripOffers(db, t))
        : assembleAllTripOffers(db)
      let built = 0
      for (const b of bundles) built += b.packages.length + b.diy.flights.length + b.diy.stays.length
      console.log(`Locators built/refreshed for ${bundles.length} trips: ${built} inspectable offers.`)
      break
    }

    case "report": {
      const tripId = Number(flag("trip"))
      if (!Number.isFinite(tripId)) throw new Error("--trip <id> is required")
      const trip = listTrips(db, { limit: 500 }).find(t => t.id === tripId)
      if (!trip) throw new Error(`no trip with id ${tripId}`)
      const bundle = assembleTripOffers(db, trip)
      console.log(`TRIP #${trip.id}  ${trip.origin}→${trip.destinationAirport}  ${trip.checkIn} ${trip.nights}n ${trip.board}/${trip.cabin} ${trip.adults} adults`)
      console.log(`DIY known total: ${trip.cashTotal ? `${trip.cashTotal.currency} ${trip.cashTotal.amount}` : "mixed currencies (itemised)"}`)
      if (bundle.diy.unknownCosts.length) console.log(`DIY unknown costs: ${bundle.diy.unknownCosts.join("; ")}`)

      console.log(`\n── PACKAGE ALTERNATIVES (${bundle.packages.length}) ──`)
      for (const p of bundle.packages) {
        printOffer(`[${p.verdict.comparability}] ${p.hotelName ?? "?"}`, p)
        console.log(`  match:         ${p.verdict.comparability} · ${p.verdict.confidence} → ${p.verdict.verdict}`)
        console.log("")
      }
      console.log(`── DIY COMPONENTS ──`)
      for (const f of bundle.diy.flights) { printOffer("flight", f); console.log("") }
      for (const s of bundle.diy.stays) { printOffer("hotel", s); console.log("") }
      break
    }

    case "recheck": {
      const offerId = Number(flag("offer"))
      if (!Number.isFinite(offerId)) throw new Error("--offer <locator id> is required")
      const result = await recheckOffer(db, offerId)
      console.log(`recheck #${offerId}: ${result.status}`)
      console.log(`  observed: ${result.observedCurrency ?? "?"} ${result.observedPrice ?? "?"}`)
      if (result.currentPrice != null) console.log(`  current:  ${result.currentCurrency} ${result.currentPrice}`)
      for (const c of result.changes) console.log(`  changed ${c.dimension}: ${c.observed} → ${c.current}`)
      console.log(`  ${result.detail}`)
      if (result.newObservationIds.length) console.log(`  new observations: ${result.newObservationIds.length}`)
      break
    }

    default:
      console.log("Unknown command. See the header of offers/cli.ts for usage.")
      process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`offers/cli ${command ?? ""}: ${(err as Error).message}`)
  process.exitCode = 1
})
