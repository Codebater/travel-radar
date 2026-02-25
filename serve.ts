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
import { runSearch, type SearchConfig, type DashboardResults } from "./search.ts"

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === "--port") || "8888")
const ROOT = path.dirname(new URL(import.meta.url).pathname)

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
  
  // Route: /api/search — trigger a live search
  if (url.pathname === "/api/search") {
    const from = url.searchParams.get("from") || "LAX"
    const to = url.searchParams.get("to") || "DXB"
    const date = url.searchParams.get("date") || "2026-04-28"
    const ret = url.searchParams.get("return") || ""
    const cls = url.searchParams.get("class") || "both"
    const flex = Math.min(parseInt(url.searchParams.get("flex") || "0"), 2)
    const sources = (url.searchParams.get("sources") || "roame,google,hidden-city").split(",")
    
    console.log(`🔍 API search: ${from}→${to} ${date}${ret ? ` ↩${ret}` : ''} ${cls} flex±${flex}`)
    
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
      }
      
      // Run outbound search
      const outboundResults = await runSearch(outboundConfig)
      
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
      
      // Save combined results
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
  let filePath = url.pathname === "/" ? "/dashboard.html" : url.pathname
  const fullPath = path.join(ROOT, filePath)
  
  // Security: don't serve outside ROOT
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }
  
  try {
    const content = fs.readFileSync(fullPath)
    const ext = path.extname(filePath)
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end("Not Found")
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`)
  console.log(`🔍 API:       http://localhost:${PORT}/api/search?from=LAX&to=DXB&date=2026-04-28&flex=1`)
  console.log(`\nPress Ctrl+C to stop`)
})
