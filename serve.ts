#!/usr/bin/env tsx
/**
 * Simple HTTP server for the flight search dashboard.
 * Serves dashboard.html and results.json, with optional live search API.
 * 
 * Features:
 * - Flex dates (±1-2 days via Roame's daysAround)
 * - RT direction search (outbound + return as separate searches)
 * - Deep booking links
 * 
 * Usage: npx tsx serve.ts [--port 8888]
 */

import http from "http"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { runSearch, type SearchConfig, type DashboardResults } from "./search.ts"
import { providerHealth } from "./providers/cash-flights/index.js"
import { awardProviderHealth } from "./providers/award-flights/index.js"
import { balancesHealth } from "./providers/balances/index.js"
import { getDb } from "./db/index.js"
import { allUsage, priceHistory, awardPriceHistory, latestSearchResult, saveSearchResult } from "./db/repositories.js"
import { listJobs, listRuns, readLease } from "./observer/store.js"
import { projectMonthlyBudget } from "./observer/budget.js"
import fsSync from "fs"

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === "--port") || "8888")
// Bind to loopback by default — this is a local dev tool holding live loyalty
// sessions and paid API budgets. Pass --host 0.0.0.0 to expose it deliberately.
const HOST = process.argv.find((_, i, a) => a[i-1] === "--host") || "127.0.0.1"
const ROOT = path.dirname(fileURLToPath(import.meta.url))

// ─── Input Validation ────────────────────────────────────────────────────────
// The search parameters flow into outbound HTTP requests and into argv for the
// Python helper scripts, so they are validated at the edge rather than trusted.

const IATA_RE = /^[A-Za-z]{3}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VALID_CLASSES = ["ECON", "PREM", "both"]
const VALID_SOURCES = ["roame", "atf", "google", "hidden-city"]

class BadRequest extends Error {}

/** "1"/"true"/"yes" → true; absent or anything else → false. */
function boolParam(value: string | null): boolean {
  return value !== null && ["1", "true", "yes"].includes(value.toLowerCase())
}

/**
 * Searches already running, keyed by their parameters. A double-clicked
 * "Refresh live price" must join the in-flight search rather than starting a
 * second one and spending a second metered call.
 */
const inFlight = new Map<string, Promise<DashboardResults>>()

function iata(value: string, field: string): string {
  if (!IATA_RE.test(value)) throw new BadRequest(`Invalid ${field}: expected a 3-letter IATA code, got "${value}"`)
  return value.toUpperCase()
}

function isoDate(value: string, field: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`Invalid ${field}: expected YYYY-MM-DD, got "${value}"`)
  }
  return value
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)
  
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  // A search spends real API budget (SerpAPI / ATF) and uses the Roame session,
  // so refuse cross-origin callers. The dashboard is served from this same
  // origin and sends no Origin header, as does curl.
  if (url.pathname.startsWith("/api/") && req.headers.origin) {
    const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]
    if (!allowed.includes(req.headers.origin)) {
      console.warn(`⚠️ Blocked cross-origin API call from ${req.headers.origin}`)
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Cross-origin API requests are not allowed" }))
      return
    }
  }
  
  // Route: /api/providers — provider health, quota and local usage.
  // Never performs a billable call.
  if (url.pathname === "/api/providers") {
    try {
      const db = getDb()
      const [cash, award] = await Promise.all([providerHealth(db), awardProviderHealth(db)])
      const balances = balancesHealth(db)
      const usage = allUsage(db)

      // Verified loyalty-program coverage (see providers/award-flights/coverage.json).
      let coverage: unknown = null
      try {
        coverage = JSON.parse(fsSync.readFileSync(
          path.join(ROOT, "providers", "award-flights", "coverage.json"), "utf-8"))
      } catch { /* coverage file is informational */ }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        checkedAt: new Date().toISOString(),
        cash, awards: award, balances, usage, coverage,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/observer/status — READ-ONLY observer state for the dashboard
  // page. Control (start/stop/run/seed) is deliberately NOT exposed over HTTP:
  // those stay CLI-only, so nothing on the network can drive the scheduler.
  if (url.pathname === "/api/observer/status") {
    try {
      const db = getDb()
      const lease = readLease(db)
      const jobs = listJobs(db)
      const runs = listRuns(db, { limit: 20 })
      const projection = projectMonthlyBudget(db)
      const usage = allUsage(db)
      const observationTotals = {
        cash: (db.prepare("SELECT COUNT(*) c FROM flight_prices").get() as any).c,
        awards: (db.prepare("SELECT COUNT(*) c FROM award_prices").get() as any).c,
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        checkedAt: new Date().toISOString(),
        scheduler: lease
          ? { running: true, holder: lease.holder, heartbeatAt: lease.heartbeatAt, stopRequested: lease.stopRequested }
          : { running: false },
        jobs, runs, projection, usage, observationTotals,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/route-stats — everything observed for one route: cash stats,
  // award stats per program, and the most recent raw observations.
  if (url.pathname === "/api/route-stats") {
    try {
      const origin = iata(url.searchParams.get("from") || "", "from")
      const destination = iata(url.searchParams.get("to") || "", "to")
      const db = getDb()
      const cashStats = priceHistory(db, { origin, destination })
      const awardStats = awardPriceHistory(db, { origin, destination })
      const recentCash = db.prepare(`
        SELECT departure_date, return_date, cabin, airline, price_amount, price_currency,
               provider, verification_level, fetched_at
        FROM flight_prices WHERE origin = ? AND destination = ?
        ORDER BY fetched_at DESC LIMIT 40
      `).all(origin, destination)
      const recentAwards = db.prepare(`
        SELECT departure_date, cabin, loyalty_program, points, taxes_amount, taxes_currency,
               available_seats, provider, verification_level, fetched_at
        FROM award_prices WHERE origin = ? AND destination = ?
        ORDER BY fetched_at DESC LIMIT 40
      `).all(origin, destination)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        origin, destination,
        note: "statistics are prices observed by this radar, not market-wide history",
        cashStats, awardStats, recentCash, recentAwards,
      }, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/results/latest — the most recent persisted search result.
  // This is the dashboard's load-time state since Phase 3; results.json is a
  // debug export only.
  if (url.pathname === "/api/results/latest") {
    try {
      const latest = latestSearchResult(getDb())
      if (!latest) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "no search has been persisted yet" }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(latest.payload))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/price-history — observations accumulated for a route.
  if (url.pathname === "/api/price-history") {
    try {
      const origin = iata(url.searchParams.get("from") || "", "from")
      const destination = iata(url.searchParams.get("to") || "", "to")
      const departureDate = url.searchParams.get("date")
      const cabin = url.searchParams.get("cabin")
      const db = getDb()
      const filter = {
        origin, destination,
        departureDate: departureDate ? isoDate(departureDate, "date") : undefined,
        cabin: cabin || undefined,
      }
      const stats = priceHistory(db, filter)
      // "Points observed by this radar" — our own observations, not market data.
      const awardStats = awardPriceHistory(db, filter)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ origin, destination, cash: stats, awards: awardStats, stats }, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/search — trigger a live search
  if (url.pathname === "/api/search") {
    let from: string, to: string, date: string, ret: string, cls: string, flex: number, sources: string[]
    let refresh = false, verify = false
    try {
      from = iata(url.searchParams.get("from") || "LAX", "from")
      to = iata(url.searchParams.get("to") || "DXB", "to")
      date = isoDate(url.searchParams.get("date") || "2026-04-28", "date")
      const retRaw = url.searchParams.get("return") || ""
      ret = retRaw ? isoDate(retRaw, "return") : ""
      cls = url.searchParams.get("class") || "both"
      if (!VALID_CLASSES.includes(cls)) throw new BadRequest(`Invalid class: expected one of ${VALID_CLASSES.join(", ")}`)
      const flexRaw = parseInt(url.searchParams.get("flex") || "0")
      flex = Math.min(Math.max(Number.isNaN(flexRaw) ? 0 : flexRaw, 0), 2)
      sources = (url.searchParams.get("sources") || "roame,google,hidden-city")
        .split(",").map(s => s.trim()).filter(Boolean)
      const unknown = sources.filter(s => !VALID_SOURCES.includes(s))
      if (unknown.length > 0) throw new BadRequest(`Unknown source(s): ${unknown.join(", ")}. Valid: ${VALID_SOURCES.join(", ")}`)
      if (sources.length === 0) throw new BadRequest("At least one source is required")
      // "Refresh live price" — bypass the cash cache and permit the metered
      // reserve, because a person explicitly asked for a fresh number.
      refresh = boolParam(url.searchParams.get("refresh"))
      // Ask the metered provider to confirm the free provider's prices.
      verify = boolParam(url.searchParams.get("verify"))
    } catch (err) {
      const message = (err as Error).message
      console.warn(`⚠️ Rejected search request: ${message}`)
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: message }))
      return
    }

    console.log(
      `🔍 API search: ${from}→${to} ${date}${ret ? ` ↩${ret}` : ''} ${cls} flex±${flex}` +
      `${refresh ? " [refresh]" : ""}${verify ? " [verify]" : ""}`
    )

    // Collapse duplicate concurrent requests for the same search. Without this a
    // double-clicked refresh button issues two metered verifications.
    const requestKey = [from, to, date, ret, cls, flex, sources.join(","), refresh, verify].join("|")
    const running = inFlight.get(requestKey)
    if (running) {
      console.log("   ↩ joining identical in-flight search (no extra provider calls)")
      try {
        const shared = await running
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(shared))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
      return
    }

    try {
      // Build outbound search config
      const outboundConfig: SearchConfig = {
        origin: from,
        destination: to,
        departureDate: date,
        returnDate: ret || undefined,
        searchClass: cls as any,
        sources,
        output: path.join(ROOT, "results.json"),
        verbose: true,
        flexDays: flex,
        forceRefresh: refresh,
        userInitiated: refresh,
        verifyPrices: verify,
        source: "api",
      }

      // Run outbound search
      const work = runSearch(outboundConfig)
      inFlight.set(requestKey, work)
      let outboundResults: DashboardResults
      try {
        outboundResults = await work
      } finally {
        inFlight.delete(requestKey)
      }
      
      // Tag all outbound flights
      for (const flight of outboundResults.flights) {
        flight.direction = flight.direction || "outbound"
        // Ensure travelDate is set from departureTime if missing
        if (!flight.travelDate && flight.departureTime) {
          const match = flight.departureTime.match(/^(\d{4}-\d{2}-\d{2})/)
          flight.travelDate = match ? match[1] : date
        }
        if (!flight.travelDate) flight.travelDate = date
      }
      
      // If round trip, also search return direction
      if (ret) {
        console.log(`🔍 Searching return: ${to}→${from} ${ret}`)
        const returnConfig: SearchConfig = {
          origin: to,
          destination: from,
          departureDate: ret,
          searchClass: cls as any,
          sources,
          output: path.join(ROOT, "results-return.json"),
          verbose: true,
          flexDays: flex,
          forceRefresh: refresh,
          userInitiated: refresh,
          verifyPrices: verify,
          source: "api",
          // The reversed leg must never become the dashboard's "latest result";
          // the merged payload is persisted after the merge instead.
          persistResults: false,
        }
        
        const returnResults = await runSearch(returnConfig)
        
        // Tag and merge return flights
        for (const flight of returnResults.flights) {
          flight.direction = "return"
          if (!flight.travelDate && flight.departureTime) {
            const match = flight.departureTime.match(/^(\d{4}-\d{2}-\d{2})/)
            flight.travelDate = match ? match[1] : ret
          }
          if (!flight.travelDate) flight.travelDate = ret
          outboundResults.flights.push(flight)
        }
        
        // Update meta
        outboundResults.meta.totalFlights = outboundResults.flights.length
      }
      
      // Persist the merged payload as the search's result. Each runSearch
      // persisted its own leg already; without this re-save the return leg
      // (persisted last) would be the dashboard's "latest result" and a reload
      // would show only the reversed route.
      if (ret && outboundResults.meta.searchRequestId != null) {
        try {
          saveSearchResult(getDb(), outboundResults.meta.searchRequestId, outboundResults)
        } catch (err) {
          console.warn(`⚠️ could not persist merged RT result: ${(err as Error).message}`)
        }
      }

      // Debug export only since Phase 3 - the application state lives in SQLite.
      fs.writeFileSync(path.join(ROOT, "results.json"), JSON.stringify(outboundResults, null, 2))
      
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(outboundResults))
    } catch (err) {
      console.error("❌ Search error:", (err as Error).message)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }
  
  // Static file serving
  const filePath = url.pathname === "/" ? "/dashboard.html" : decodeURIComponent(url.pathname)
  const fullPath = path.resolve(ROOT, "." + filePath)

  // Security: don't serve outside ROOT (path.resolve normalises any ../ first).
  if (fullPath !== ROOT && !fullPath.startsWith(ROOT + path.sep)) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }

  // Security: never serve dotfiles or dot-directories. Without this the server
  // hands out .env — and with it SERP_API_KEY / ATF_API_KEY — to anything that
  // can reach this port, including any page open in the user's browser.
  const segments = filePath.split(/[\\/]/)
  if (segments.some(segment => segment.startsWith("."))) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }

  // Security: only serve the content types the dashboard actually loads, so a
  // stray credential or key file in the project folder is not downloadable.
  const ext = path.extname(filePath)
  if (!MIME_TYPES[ext]) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }

  try {
    const content = fs.readFileSync(fullPath)
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end("Not Found")
  }
})

server.listen(PORT, HOST, () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`)
  console.log(`🔍 API:       http://localhost:${PORT}/api/search?from=LAX&to=DXB&date=2026-04-28&flex=1`)
  console.log(`\nPress Ctrl+C to stop`)
})
