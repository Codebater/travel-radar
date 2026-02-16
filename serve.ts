#!/usr/bin/env tsx
/**
 * Simple HTTP server for the flight search dashboard.
 * Serves dashboard.html and results.json, with optional live search API.
 * 
 * Usage: npx tsx serve.ts [--port 8888]
 */

import http from "http"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

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
    
    console.log(`🔍 API search: ${from}→${to} ${date} ${cls}`)
    
    try {
      const retFlag = ret ? `--return ${ret}` : ""
      const sources = url.searchParams.get("sources") || "roame,google,hidden-city"
      const cmd = `cd ${ROOT} && npx tsx search.ts --from ${from} --to ${to} --date ${date} ${retFlag} --class ${cls} --sources ${sources} --output results.json 2>&1`
      execSync(cmd, { timeout: 180000 })
      
      // Return results
      const results = fs.readFileSync(path.join(ROOT, "results.json"), "utf-8")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(results)
    } catch (err) {
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
  console.log(`📱 Network:   http://192.168.7.178:${PORT}`)
  console.log(`🔍 API:       http://localhost:${PORT}/api/search?from=LAX&to=DXB&date=2026-04-28`)
  console.log(`\nPress Ctrl+C to stop`)
})
