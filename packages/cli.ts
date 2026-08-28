#!/usr/bin/env tsx
/**
 * Package tier admin (Phase 8g).
 *
 *   npx tsx packages/cli.ts calendar --property id [--origin VIE] [--nights 5]
 *                                    [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        Tier 0: one seasonal calendar sweep for one property (LIVE, 1 call)
 *   npx tsx packages/cli.ts offers --property id --from YYYY-MM-DD --to YYYY-MM-DD
 *                                    [--origin VIE] [--nights 5]
 *        Tier 1: dated offers around an interesting window (LIVE, 1 call)
 *   npx tsx packages/cli.ts confirm --property id --depart YYYY-MM-DD --return YYYY-MM-DD
 *                                    [--origin VIE]
 *        Tier 2: CHECK24 cross-seller confirmation for exact trip dates
 *        (LIVE, one poll-search; Agoda-style caps)
 *   npx tsx packages/cli.ts compare [--min-score N]
 *        BUILD-vs-BUY: judge stored trips against fresh package observations
 *        (local database work, ZERO external calls)
 *   npx tsx packages/cli.ts observations [--property id] [--limit N]
 *   npx tsx packages/cli.ts comparisons [--limit N]
 *   npx tsx packages/cli.ts status
 *   npx tsx packages/cli.ts report [--property id]
 *
 * `calendar`/`offers`/`confirm` contact sellers; everything else is local.
 * All spending is ceiling-guarded (reserve-before-await) and a blocked
 * response STOPS the command — no retries against a bot wall, ever. Nothing
 * here books, pre-books or holds anything — this system only looks.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { getPackageProvider, runPackageCalendarFetch, runPackageOfferSearch } from "../providers/packages/index.js"
import { TUI_PACKAGES_PROVIDER } from "../providers/packages/tui.js"
import { CHECK24_PACKAGES_PROVIDER } from "../providers/packages/check24.js"
import type { BoardBasis } from "../providers/packages/types.js"
import { readUsage } from "../db/repositories.js"
import { loadPackagesConfig } from "./config.js"
import { capsFor, reservePackageSearch } from "./budget.js"
import { runCompetition } from "./competition.js"
import {
  latestPackageObservations,
  listComparisons,
  listPackageObservations,
  packageSearchesToday,
  packageTotals,
  recordPackageObservations,
  recordPackageRaw,
} from "./store.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

interface PropertyRow {
  id: string
  name: string
  destination_group: string
  default_board: string
}

function requireProperty(db: ReturnType<typeof getDb>, id: string | undefined): PropertyRow {
  if (!id) throw new Error("--property <id> is required")
  const row = db.prepare(
    "SELECT id, name, destination_group, default_board FROM stay_properties WHERE id = ?",
  ).get(id) as PropertyRow | undefined
  if (!row) throw new Error(`unknown property "${id}" — run stays:seed first`)
  return row
}

function requireRef(db: ReturnType<typeof getDb>, propertyId: string, provider: string): string {
  const row = db.prepare(
    "SELECT ref FROM stay_property_refs WHERE property_id = ? AND provider = ?",
  ).get(propertyId, provider) as { ref: string } | undefined
  if (!row) {
    throw new Error(
      `property "${propertyId}" has no ${provider} ref — add it to config/stay-properties.json refs and re-run stays:seed`,
    )
  }
  return row.ref
}

function boardFor(property: PropertyRow): BoardBasis {
  const board = (flag("board") ?? property.default_board) as BoardBasis
  return board
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

function printOffers(offers: { checkIn: string; nights: number; board: string; cabin: string; roomName: string | null; transfer: string; tourOperator: string | null; totalPrice: { amount: number; currency: string }; pricePerPerson: number | null }[], limit = 10): void {
  for (const o of offers.slice(0, limit)) {
    console.log(
      `  ${o.checkIn} ${o.nights}n ${o.board}/${o.cabin} ${o.roomName ?? "?"}`
      + ` | ${o.tourOperator ?? "?"} | transfer ${o.transfer}`
      + ` | ${o.totalPrice.currency} ${o.totalPrice.amount} total`
      + (o.pricePerPerson !== null ? ` (${o.pricePerPerson} pp)` : ""),
    )
  }
  if (offers.length > limit) console.log(`  … ${offers.length - limit} more`)
}

async function main() {
  const db = getDb()
  const cfg = loadPackagesConfig()

  switch (command) {
    case "calendar": {
      const property = requireProperty(db, flag("property"))
      const providerRef = requireRef(db, property.id, TUI_PACKAGES_PROVIDER)
      const provider = getPackageProvider(TUI_PACKAGES_PROVIDER)!
      const query = {
        propertyId: property.id,
        providerRef,
        origin: flag("origin") ?? "VIE",
        nights: Number(flag("nights") ?? 5),
        adults: cfg.travellers.adults,
        children: 0,
        board: boardFor(property),
        rangeStart: flag("from") ?? addDays(30),
        rangeEnd: flag("to") ?? addDays(210),
        currency: cfg.tui.currency,
      }
      const reservation = reservePackageSearch(db, {
        provider: provider.name, kind: "calendar", propertyId: property.id,
        origin: query.origin, rangeStart: query.rangeStart, rangeEnd: query.rangeEnd,
        nights: query.nights, adults: query.adults, children: 0,
        currency: query.currency, source: "cli",
      }, 0)
      if (!reservation.ok) { console.log(`REFUSED: ${reservation.reason}`); break }

      console.log(`Tier 0 calendar: ${property.name} ex ${query.origin}, ${query.nights}n ${query.board}, ${query.rangeStart}..${query.rangeEnd}`)
      const result = await runPackageCalendarFetch(provider, query, { captureRaw: true })
      if (!result.ok) {
        console.log(`FAILED (${result.reason}): ${result.error}`)
        if (result.reason === "blocked") console.log("Blocked — stopping. Do not retry; see config/packages.json hostsNote/blockNote.")
        break
      }
      if (result.raw !== undefined) recordPackageRaw(db, provider.name, "calendar", property.id, reservation.searchRequestId, result.raw)
      const ids = recordPackageObservations(db, result.offers, reservation.searchRequestId)
      const prices = result.offers.map(o => o.totalPrice.amount).sort((a, b) => a - b)
      console.log(`Stored ${ids.length} dated offers (${result.latencyMs}ms).`)
      console.log(`Seasonal range: ${result.offers[0].totalPrice.currency} ${prices[0]} .. ${prices[prices.length - 1]} total for ${query.adults} adults.`)
      const cheapest = [...result.offers].sort((a, b) => a.totalPrice.amount - b.totalPrice.amount)
      printOffers(cheapest, 5)
      break
    }

    case "offers": {
      const property = requireProperty(db, flag("property"))
      const providerRef = requireRef(db, property.id, TUI_PACKAGES_PROVIDER)
      const provider = getPackageProvider(TUI_PACKAGES_PROVIDER)!
      const from = flag("from"); const to = flag("to") ?? from
      if (!from) throw new Error("--from YYYY-MM-DD is required (check-in window start)")
      const query = {
        propertyId: property.id,
        providerRef,
        origin: flag("origin") ?? "VIE",
        checkInFrom: from,
        checkInTo: to!,
        nights: Number(flag("nights") ?? 5),
        adults: cfg.travellers.adults,
        children: 0,
        board: boardFor(property),
        currency: cfg.tui.currency,
      }
      const reservation = reservePackageSearch(db, {
        provider: provider.name, kind: "offers", propertyId: property.id,
        origin: query.origin, rangeStart: query.checkInFrom, rangeEnd: query.checkInTo,
        nights: query.nights, adults: query.adults, children: 0,
        currency: query.currency, source: "cli",
      }, 0)
      if (!reservation.ok) { console.log(`REFUSED: ${reservation.reason}`); break }

      console.log(`Tier 1 offers: ${property.name} ex ${query.origin}, check-in ${from}..${to}, ${query.nights}n ${query.board}`)
      const result = await runPackageOfferSearch(provider, query, { captureRaw: true })
      if (!result.ok) {
        console.log(`FAILED (${result.reason}): ${result.error}`)
        break
      }
      if (result.raw !== undefined) recordPackageRaw(db, provider.name, "offers", property.id, reservation.searchRequestId, result.raw)
      const ids = recordPackageObservations(db, result.offers, reservation.searchRequestId)
      console.log(`Stored ${ids.length} offers (${result.latencyMs}ms). Cheapest first:`)
      printOffers([...result.offers].sort((a, b) => a.totalPrice.amount - b.totalPrice.amount))
      break
    }

    case "confirm": {
      const property = requireProperty(db, flag("property"))
      const providerRef = requireRef(db, property.id, CHECK24_PACKAGES_PROVIDER)
      const provider = getPackageProvider(CHECK24_PACKAGES_PROVIDER)!
      const depart = flag("depart"); const ret = flag("return")
      if (!depart || !ret) throw new Error("--depart and --return YYYY-MM-DD are required (trip envelope dates)")
      const query = {
        propertyId: property.id,
        providerRef,
        origin: flag("origin") ?? "VIE",
        // Hotel check-in window is derived by the provider from evidence; the
        // envelope bounds are what this seller actually prices.
        checkInFrom: depart, checkInTo: ret,
        nights: Number(flag("nights") ?? 5),
        tripDeparture: depart, tripReturn: ret,
        adults: cfg.travellers.adults,
        children: 0,
        board: boardFor(property),
        currency: cfg.check24.currency,
      }
      const usedToday = packageSearchesToday(db, provider.name)
      console.log(`Tier 2 confirmation: ${property.name} ex ${query.origin}, trip ${depart}..${ret} (${usedToday}/${capsFor(provider.name).perDay} searches used today)`)
      const reservation = reservePackageSearch(db, {
        provider: provider.name, kind: "confirmation", propertyId: property.id,
        origin: query.origin, rangeStart: depart, rangeEnd: ret,
        nights: query.nights, adults: query.adults, children: 0,
        currency: query.currency, source: "cli",
      }, 0)
      if (!reservation.ok) { console.log(`REFUSED: ${reservation.reason}`); break }

      const result = await runPackageOfferSearch(provider, query, { captureRaw: true })
      if (!result.ok) {
        console.log(`FAILED (${result.reason}): ${result.error}`)
        if (result.reason === "blocked") console.log("Blocked — stopping and degrading. Do not retry (config blockNote).")
        break
      }
      if (result.raw !== undefined) recordPackageRaw(db, provider.name, "confirmation", property.id, reservation.searchRequestId, result.raw)
      const ids = recordPackageObservations(db, result.offers, reservation.searchRequestId)
      const operators = [...new Set(result.offers.map(o => o.tourOperator ?? "?"))]
      console.log(`Stored ${ids.length} offers from ${operators.length} operators (${operators.join(", ")}) in ${result.latencyMs}ms.`)
      printOffers([...result.offers].sort((a, b) => a.totalPrice.amount - b.totalPrice.amount))
      break
    }

    case "compare": {
      const summary = runCompetition(db, { minTripScore: Number(flag("min-score") ?? 0) })
      console.log(`BUILD-vs-BUY: ${summary.tripsExamined} trips × ${summary.packagesExamined} fresh package observations`)
      console.log(`  pairs evaluated: ${summary.pairsEvaluated}, comparisons stored: ${summary.comparisonsStored}`)
      if (summary.stalePackagesSkipped > 0) {
        console.log(`  stale package observations excluded: ${summary.stalePackagesSkipped} (older than ${loadPackagesConfig().competition.maxPackageAgeDays}d)`)
      }
      for (const [verdict, n] of Object.entries(summary.byVerdict).sort()) console.log(`  ${verdict}: ${n}`)
      break
    }

    case "observations": {
      const rows = flag("property")
        ? listPackageObservations(db, { propertyId: flag("property"), limit: Number(flag("limit") ?? 25) })
        : listPackageObservations(db, { limit: Number(flag("limit") ?? 25) })
      if (rows.length === 0) { console.log("No package observations recorded yet."); break }
      for (const o of rows) {
        console.log(
          `#${o.id} [${o.provider}${o.tourOperator ? `/${o.tourOperator}` : ""}] ${o.hotelName ?? o.propertyId ?? o.providerPropertyRef}`
          + ` ${o.origin}→${o.destinationAirport ?? "?"} ${o.checkIn} ${o.nights}n ${o.board}/${o.cabin}`
          + ` | ${o.currency} ${o.totalPrice} total | transfer ${o.transfer} | ${o.verificationLevel} | fetched ${o.fetchedAt.slice(0, 16)}`,
        )
      }
      break
    }

    case "comparisons": {
      const rows = listComparisons(db, { limit: Number(flag("limit") ?? 25) })
      if (rows.length === 0) { console.log("No comparisons yet — run packages:compare."); break }
      for (const c of rows) {
        const diff = c.knownDifference !== null
          ? ` | Δ ${c.packageCurrency} ${c.knownDifference} (${c.knownDifferencePct}%)`
          : ""
        console.log(`#${c.id} trip ${c.tripId} vs obs ${c.packageObservationId}: ${c.comparability} → ${c.verdict}${diff}`)
        console.log(`    why: ${c.verdictReasons[0] ?? c.comparabilityReasons[0] ?? "-"}`)
      }
      break
    }

    case "status": {
      const totals = packageTotals(db)
      console.log(`Package observations: ${totals.observations} (${totals.distinctKeys} distinct products)`)
      for (const [provider, n] of Object.entries(totals.byProvider)) {
        const caps = capsFor(provider)
        const usage = readUsage(db, provider)
        console.log(
          `  ${provider}: ${n} observations | today ${packageSearchesToday(db, provider)}/${caps.perDay} searches`
          + ` | lifetime attempts ${usage.attempted} ok ${usage.succeeded} failed ${usage.failed}`,
        )
      }
      for (const name of [TUI_PACKAGES_PROVIDER, CHECK24_PACKAGES_PROVIDER]) {
        const provider = getPackageProvider(name)!
        const health = await provider.health()
        console.log(`  ${name} health: ${health.status} — ${health.detail}`)
      }
      console.log(`Comparisons: ${totals.comparisons}`)
      for (const [verdict, n] of Object.entries(totals.byVerdict).sort()) console.log(`  ${verdict}: ${n}`)
      break
    }

    case "report": {
      const propertyId = flag("property")
      const fresh = propertyId
        ? latestPackageObservations(db, { propertyId })
        : latestPackageObservations(db, {})
      if (fresh.length === 0) { console.log("No package observations to report on."); break }
      const byProperty = new Map<string, typeof fresh>()
      for (const o of fresh) {
        const key = o.propertyId ?? `unmapped:${o.providerPropertyRef}`
        if (!byProperty.has(key)) byProperty.set(key, [])
        byProperty.get(key)!.push(o)
      }
      for (const [prop, rows] of byProperty) {
        const prices = rows.map(r => r.totalPrice).sort((a, b) => a - b)
        const cheapest = rows.reduce((a, b) => (a.totalPrice <= b.totalPrice ? a : b))
        console.log(`${prop}: ${rows.length} latest dated offers, ${cheapest.currency} ${prices[0]}..${prices[prices.length - 1]}`)
        console.log(
          `  cheapest: ${cheapest.checkIn} ${cheapest.nights}n ${cheapest.board}/${cheapest.cabin}`
          + ` ${cheapest.roomName ?? "?"} via ${cheapest.tourOperator ?? "?"} — ${cheapest.currency} ${cheapest.totalPrice}`
          + ` (transfer ${cheapest.transfer})`,
        )
      }
      break
    }

    default:
      console.log("Unknown command. See the header of packages/cli.ts for usage.")
      process.exitCode = 1
  }
}

main().catch(err => {
  console.error(`packages/cli ${command ?? ""}: ${(err as Error).message}`)
  process.exitCode = 1
})
