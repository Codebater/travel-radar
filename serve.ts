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

import "./load-env.js"
import http from "http"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { runSearch, resolveTripSearch, planSearchLegs, type SearchConfig, type DashboardResults } from "./search.ts"
import { providerHealth } from "./providers/cash-flights/index.js"
import { awardProviderHealth } from "./providers/award-flights/index.js"
import { balancesHealth } from "./providers/balances/index.js"
import { getDb } from "./db/index.js"
import { allUsage, priceHistory, awardPriceHistory, latestSearchResult, saveSearchResult } from "./db/repositories.js"
import { listJobs, listRuns, readLease } from "./observer/store.js"
import { projectMonthlyBudget } from "./observer/budget.js"
import { observerHealth } from "./observer/health.js"
import { buildObserverOverview } from "./observer/overview.js"
import { listCandidates, getCandidate, recordFeedback } from "./anomaly/store.js"
import { buildReport } from "./anomaly/report.js"
import { loadAnomalyConfig } from "./anomaly/config.js"
import { buildFeed, dealDetail, takeMeAnywhere } from "./anomaly/feed.js"
import { listClusters } from "./anomaly/clustering.js"
import { listDiscoveryJobs, listDiscoveryRuns } from "./discovery/store.js"
import { projectDiscoveryBudget } from "./discovery/budget.js"
import { loadDiscoveryConfig } from "./discovery/config.js"
import { loadNotificationConfig, notificationsEnabled } from "./notifications/config.js"
import { NtfyChannel } from "./notifications/providers/ntfy.js"
import { immediatesToday, listEvents, listNotifications, listQueue } from "./notifications/store.js"
import { isQuiet, localDay } from "./notifications/quiet-hours.js"
import { credentialWarnings } from "./notifications/credentials.js"
import { listStayCandidates, stayCandidateTotals } from "./stays/candidates.js"
import { listHotelAwards } from "./providers/hotel-awards/store.js"
import { applicablePerks, loadEntitlements, loadHotelPerkRules, type PerkBadge } from "./providers/hotel-awards/perks.js"
import { loadStayUniverse } from "./stays/registry.js"
import { loadStaysConfig } from "./stays/config.js"
import { listStayWindows } from "./stays/windows.js"
import { buildStayOpportunities } from "./stays/opportunities.js"
import { listTrips, tripTotals } from "./trips/store.js"
import { getPackageObservation, latestComparisonsForTrip, packageTotals } from "./packages/store.js"
import { currentMarketVerdictsForTrip, marketVerdictTotals } from "./market/verdict.js"
import { assembleAllTripOffers } from "./offers/assemble.js"
import { loadFareRadarConfig, parseTripType, TRIP_TYPES } from "./fareradar/config.js"
import { buildDealRadarFeed } from "./dealradar/feed.js"
import { getMilesPromoFeed } from "./providers/promos/awardwallet-blog.js"
import { recheckTopFares, runFareRadar } from "./fareradar/engine.js"
import { candidatesForRun, latestFareRadarRun } from "./fareradar/store.js"
import { getLocator as getOfferLocator } from "./offers/locators.js"
import { recheckOffer } from "./offers/recheck.js"
import fsSync from "fs"

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === "--port") || "8888")

// Deployment plumbing, not a policy change. In the Docker deployment the
// dashboard is reached via the LAN IP and the Tailscale hostname, and the
// container sees every client as the bridge gateway rather than as loopback -
// so both the Origin allowlist and the feedback write gate need to know which
// non-local origins the OPERATOR trusts. Empty by default, which leaves the
// original loopback-only behaviour byte-for-byte intact. The trust boundary
// this extends to is the LAN plus the tailnet; nothing here is ever public.
const TRUSTED_ORIGINS = (process.env.RADAR_TRUSTED_ORIGINS || "")
  .split(",")
  .map(o => o.trim().replace(/\/+$/, ""))
  .filter(o => {
    if (!o) return false
    try {
      const url = new URL(o)
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === o
    } catch { return false }
  })
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
  
  // CORS: only this server's own origins, never "*".
  //
  // The wildcard used to go out on EVERY path while the Origin allowlist below
  // guarded only /api/*, so any page in any tab could read /deals.html and
  // /alerts.html cross-origin. Those pages carry no secrets by design - but
  // "carries no secrets today" is a property that quietly stops being true.
  const selfOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...TRUSTED_ORIGINS]
  const requestOrigin = req.headers.origin
  if (requestOrigin && selfOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin)
    res.setHeader("Vary", "Origin")
  }
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
    if (!selfOrigins.includes(req.headers.origin)) {
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

  // Route: /api/observer/overview — the PROJECT-WIDE observation status
  // umbrella: which domain is scheduled where, last runs, observation counts.
  // Pure reporting over existing ledgers — schedules nothing, invents nothing.
  if (url.pathname === "/api/observer/overview") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(buildObserverOverview(getDb()), null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/observer/health — §C/§D unattended-operation health.
  // Read-only and cheap: pure SQL over tables the system already writes.
  if (url.pathname === "/api/observer/health") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(observerHealth(getDb()), null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/anomaly/candidates — §V the shadow deal list.
  // EXPERIMENTAL. These are stored decisions, not alerts: nothing was sent to
  // anybody, and this endpoint is the only way to see them.
  if (url.pathname === "/api/anomaly/candidates") {
    try {
      const db = getDb()
      const config = loadAnomalyConfig()
      const min = Number(url.searchParams.get("min") ?? config.candidateThreshold)
      const limitRaw = Number(url.searchParams.get("limit") ?? 25)
      const typeRaw = url.searchParams.get("type")
      if (typeRaw && !["cash", "award"].includes(typeRaw)) throw new BadRequest("type must be cash or award")
      const candidates = listCandidates(db, {
        minScore: Number.isFinite(min) ? min : config.candidateThreshold,
        limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 25,
        type: (typeRaw as "cash" | "award") ?? undefined,
        status: "candidate",
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        mode: "shadow",
        alertsEnabled: false,
        disclaimer: "EXPERIMENTAL — scores are this radar's own opinion of its own observations. No alerts are sent.",
        threshold: config.candidateThreshold,
        engineVersion: config.engineVersion,
        weightsVersion: config.weightsVersion,
        candidates,
      }, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/stays/deals — Phase 8c stay opportunities. Read-only over
  // decisions that already exist: runs no search, spends no budget. Meta
  // (Xotelo) and retail (Agoda) numbers are DIFFERENT PRODUCTS and are served
  // labelled, never blended — the page must not present a meta quote as
  // bookable unless a retail confirmation exists.
  if (url.pathname === "/api/stays/deals") {
    try {
      const db = getDb()
      const config = loadStaysConfig()
      const minRaw = url.searchParams.get("min")
      const limitRaw = Number(url.searchParams.get("limit") ?? 25)
      const candidates = listStayCandidates(db, {
        minScore: minRaw !== null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : 0,
        limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25,
      }).filter(c => c.status !== "suspicious")
      // Explicit hotel-loyalty affiliations from config — DATA the page joins
      // hotel buy-points promos on; never inferred from property names.
      const propertyLoyalty: Record<string, string> = {}
      for (const p of loadStayUniverse().properties) {
        if (p.loyaltyProgram) propertyLoyalty[p.id] = p.loyaltyProgram
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        mode: "shadow",
        disclaimer: "EXPERIMENTAL — scores are this radar's own opinion of its own observations. Meta prices are aggregator sightings, not confirmed bookable rates.",
        threshold: config.anomaly.candidateThreshold,
        engineVersion: config.anomaly.engineVersion,
        totals: stayCandidateTotals(db),
        windows: listStayWindows(db, { limit: 15 }),
        opportunities: buildStayOpportunities(db, { limit: 15 }),
        propertyLoyalty,
        candidates,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/trips — Phase 8f composed complete-trip opportunities.
  // Read-only over stored compositions: runs no search, spends no budget.
  // Cash and miles are served as SEPARATE figures, never blended.
  if (url.pathname === "/api/trips") {
    try {
      const db = getDb()
      const limitRaw = Number(url.searchParams.get("limit") ?? 20)
      const minRaw = url.searchParams.get("min")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        mode: "shadow",
        disclaimer: "EXPERIMENTAL — composed from this radar's own observations. Meta prices are sightings, not confirmed bookable rates; unknown costs are named, never zeroed.",
        totals: tripTotals(db),
        trips: listTrips(db, {
          minScore: minRaw !== null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : 0,
          limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20,
          status: url.searchParams.get("all") !== null ? undefined : "interesting",
        }),
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/fares/config — the radar's configuration surface for the UI.
  if (url.pathname === "/api/fares/config") {
    const cfg = loadFareRadarConfig()
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      homeAirports: cfg.homeAirports,
      watchlists: Object.fromEntries(Object.entries(cfg.watchlists).filter(([, v]) => Array.isArray(v))),
      tripTypes: TRIP_TYPES,
      window: cfg.window,
      budget: { maxSearchesPerRun: cfg.budget.maxSearchesPerRun, currency: cfg.budget.currency },
    }, null, 2))
    return
  }

  // Route: /api/fares/radar — the latest finished run, candidates + locators.
  // Read-only; runs nothing, spends nothing.
  if (url.pathname === "/api/fares/radar") {
    try {
      const db = getDb()
      const run = latestFareRadarRun(db)
      if (!run) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ run: null, candidates: [] }))
        return
      }
      const candidates = candidatesForRun(db, run.id).slice(0, 60).map(c => {
        const locator = c.locatorId !== null ? getOfferLocator(db, c.locatorId) : null
        return {
          ...c,
          navigationQuality: locator?.navigationQuality ?? "UNAVAILABLE",
          url: locator ? (locator.deepLinkUrl ?? locator.searchReplayUrl ?? locator.landingUrl) : null,
        }
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        disclaimer: "Observed fares from planned free-provider sweeps. Cabin labels are evidence-based: BUSINESS_UNVERIFIED means the provider states no per-segment cabin. RECHECK finalists before booking.",
        run, candidates,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: POST /api/fares/run — plan + execute a sweep (FREE provider only,
  // hard-capped by the stored plan; the metered tier is unreachable).
  if (url.pathname === "/api/fares/run") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
      res.end(JSON.stringify({ error: "POST only" }))
      return
    }
    try {
      const origins = (url.searchParams.get("origins") ?? "").split(",").map(o => o.trim()).filter(Boolean)
      const destination = url.searchParams.get("destination") ?? undefined
      const watchlistName = url.searchParams.get("watchlist") ?? undefined
      const anywhere = boolParam(url.searchParams.get("anywhere"))
      // tripType is a strict enum; absent = ROUND_TRIP (existing clients keep
      // their pre-8k behaviour). ONE_WAY rejects nights — no trip length exists.
      const tripTypeRaw = url.searchParams.get("tripType")
      const tripType = tripTypeRaw === null ? undefined : parseTripType(tripTypeRaw)
      if (tripTypeRaw !== null && !tripType) {
        throw new BadRequest(`unknown tripType "${tripTypeRaw}" — expected one of ${TRIP_TYPES.join(", ")}`)
      }
      if (tripType === "ONE_WAY" && (url.searchParams.get("minNights") || url.searchParams.get("maxNights"))) {
        throw new BadRequest("minNights/maxNights do not apply to tripType ONE_WAY — a one-way has no trip length")
      }
      const summary = await runFareRadar(getDb(), {
        tripType: tripType ?? undefined,
        origins: origins.length ? origins.map(o => iata(o, "origins")) : undefined,
        destination: destination ? iata(destination, "destination") : undefined,
        watchlistName,
        anywhere,
        nextDays: url.searchParams.get("nextDays") ? Number(url.searchParams.get("nextDays")) : undefined,
        minNights: url.searchParams.get("minNights") ? Number(url.searchParams.get("minNights")) : undefined,
        maxNights: url.searchParams.get("maxNights") ? Number(url.searchParams.get("maxNights")) : undefined,
        maxSearches: url.searchParams.get("maxCalls") ? Number(url.searchParams.get("maxCalls")) : undefined,
        source: "api",
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ runId: summary.runId, planLines: summary.plan.lines, searchesIssued: summary.searchesIssued, candidates: summary.candidatesStored }, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: POST /api/fares/recheck-top — re-confirm the finalists (free tier).
  if (url.pathname === "/api/fares/recheck-top") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
      res.end(JSON.stringify({ error: "POST only" }))
      return
    }
    try {
      const db = getDb()
      const run = latestFareRadarRun(db)
      if (!run) throw new BadRequest("no finished fare-radar run")
      const results = await recheckTopFares(db, run.id, Number(url.searchParams.get("top") ?? 5))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ results }, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/promos/miles — the Miles Promo Feed: airline buy-miles
  // promotions from AwardWallet's public promotions page. Enrichment metadata
  // only; award results stay the source of truth. Cached for the configured
  // TTL (a blocked answer included — no retry storms); ?refresh=1 refetches.
  if (url.pathname === "/api/promos/miles") {
    try {
      const feed = await getMilesPromoFeed({ forceRefresh: boolParam(url.searchParams.get("refresh")) })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(feed, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/hotel-awards — Phase HA-1 read-out. READ-ONLY over the
  // append-only hotel_award_observations; no valuation, no ranking, no merge
  // with cash stays. Points are per-night as stored (never a synthesized
  // total); cash is context, never a comparison. limit + program only.
  if (url.pathname === "/api/hotel-awards") {
    try {
      const db = getDb()
      const limitRaw = Number(url.searchParams.get("limit") ?? 100)
      const program = url.searchParams.get("program") ?? undefined
      // Verified perk badges are DISPLAY-ONLY enrichment: a config problem
      // degrades to no badges plus a stated error — never a broken read-out,
      // and never any effect on the observations themselves.
      let perkRules: ReturnType<typeof loadHotelPerkRules> | null = null
      let entitlements: ReturnType<typeof loadEntitlements> | null = null
      let perksError: string | null = null
      try {
        perkRules = loadHotelPerkRules()
        entitlements = loadEntitlements()
      } catch (err) {
        perksError = (err as Error).message
      }
      const observations = listHotelAwards(db, {
        limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100,
        program,
      }).map(o => {
        const locator = o.locatorId !== null ? getOfferLocator(db, o.locatorId) : null
        const perks: PerkBadge[] = perkRules && entitlements
          ? applicablePerks({ program: o.program, chain: o.chain, nights: o.nights, checkIn: o.checkIn }, perkRules, entitlements)
          : []
        return {
          ...o,
          perks,
          navigation: locator
            ? {
                quality: locator.navigationQuality,
                url: locator.deepLinkUrl ?? locator.searchReplayUrl ?? locator.landingUrl,
              }
            : { quality: "UNAVAILABLE", url: null },
        }
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        disclaimer: "Points STAYS observed by this radar, append-only and SEPARATE from cash stays. Points are per-night as the source stated them — never a synthesized stay total. Cash figures are context only, never a comparison. Availability 'unknown' means a historical/period observation, not a live hold.",
        programs: [...new Set(listHotelAwards(db, { limit: 500 }).map(o => o.program))].sort(),
        providers: [...new Set(listHotelAwards(db, { limit: 500 }).map(o => o.provider))].sort(),
        perksError,
        count: observations.length,
        observations,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/dealradar — Phase 8l-a discovery feed. READ-ONLY over
  // decisions that already exist: package verdicts, fare candidates + typical
  // fares, stay candidates and composed trips. Runs no search, spends nothing;
  // the only writes are the same deterministic locator upserts /api/offers does.
  if (url.pathname === "/api/dealradar") {
    try {
      const db = getDb()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(buildDealRadarFeed(db), null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/offers — Phase 8i inspectable offers per trip. Building
  // locators is deterministic local work; no provider is contacted here.
  if (url.pathname === "/api/offers") {
    try {
      const db = getDb()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        disclaimer: "Navigation quality is honest: EXACT_DEEP_LINK only ever means the provider returned that URL for that offer. Prices are observations; RECHECK before booking.",
        trips: assembleAllTripOffers(db, { limit: 30 }),
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: POST /api/offers/recheck?id=N — re-resolve one stored offer at its
  // provider (budget/politeness-capped; blocked ends immediately, no retries).
  // Same POST discipline as the feedback endpoint: POST-only, same-origin.
  if (url.pathname === "/api/offers/recheck") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
      res.end(JSON.stringify({ error: "POST only" }))
      return
    }
    try {
      const id = Number(url.searchParams.get("id"))
      if (!Number.isFinite(id) || id <= 0) throw new BadRequest("id must be a positive locator id")
      const result = await recheckOffer(getDb(), id)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(result, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/market — Phase 8h BUILD-vs-BUY market verdicts. Read-only
  // over the newest compute batch: superseded rows never surface here.
  // Currencies converted only through stored FX observations; a verdict
  // without sufficient confidence carries no winner and no savings number.
  if (url.pathname === "/api/market") {
    try {
      const db = getDb()
      const trips = listTrips(db, { minScore: 0, limit: 100, status: "interesting" })
      const LEVEL_ORDER: Record<string, number> = { EXACT_MATCH: 0, CLOSE_MATCH: 1, DESTINATION_LEVEL_ONLY: 2 }
      const byTrip = trips.map(trip => {
        const verdicts = currentMarketVerdictsForTrip(db, trip.id)
          .filter(v => v.comparability !== "NOT_COMPARABLE")
          .sort((a, b) =>
            (LEVEL_ORDER[a.comparability] ?? 9) - (LEVEL_ORDER[b.comparability] ?? 9)
            || (a.packageTotal ?? Infinity) - (b.packageTotal ?? Infinity))
          .slice(0, 5)
          .map(v => {
            const obs = getPackageObservation(db, v.packageObservationId)
            return {
              ...v,
              package: obs && {
                provider: obs.provider, tourOperator: obs.tourOperator,
                hotelName: obs.hotelName, checkIn: obs.checkIn, nights: obs.nights,
                board: obs.board, cabin: obs.cabin, roomName: obs.roomName,
                transfer: obs.transfer, baggage: obs.baggage,
                totalPrice: obs.totalPrice, currency: obs.currency,
                verificationLevel: obs.verificationLevel,
              },
            }
          })
        return { tripId: trip.id, tripKey: trip.tripKey, verdicts }
      }).filter(t => t.verdicts.length > 0)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        disclaimer: "EXPERIMENTAL — verdicts only at sufficient confidence; UNKNOWN costs are named, never zeroed; conversions reference stored FX observations; native prices preserved.",
        totals: marketVerdictTotals(db),
        trips: byTrip,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/packages — Phase 8g BUILD-vs-BUY. Read-only over stored
  // comparisons: runs no search, spends no budget. Currencies are NEVER
  // converted — a cross-currency pair is reported as such, side by side.
  if (url.pathname === "/api/packages") {
    try {
      const db = getDb()
      const trips = listTrips(db, { minScore: 0, limit: 100, status: "interesting" })
      const LEVEL_ORDER: Record<string, number> = { EXACT_MATCH: 0, CLOSE_MATCH: 1, DESTINATION_LEVEL_ONLY: 2 }
      const byTrip = trips.map(trip => {
        // The panel shows judgements, not the audit trail: NOT_COMPARABLE
        // rows stay queryable via the CLI but are noise here, and per trip
        // only the strongest few package alternatives are rendered.
        const comparisons = latestComparisonsForTrip(db, trip.id)
          .filter(c => c.comparability !== "NOT_COMPARABLE")
          .sort((a, b) =>
            (LEVEL_ORDER[a.comparability] ?? 9) - (LEVEL_ORDER[b.comparability] ?? 9)
            || a.packageTotal - b.packageTotal)
          .slice(0, 5)
          .map(c => {
          const obs = getPackageObservation(db, c.packageObservationId)
          return {
            ...c,
            package: obs && {
              provider: obs.provider, tourOperator: obs.tourOperator,
              hotelName: obs.hotelName, propertyId: obs.propertyId,
              origin: obs.origin, checkIn: obs.checkIn, nights: obs.nights,
              tripDays: obs.tripDays, board: obs.board, cabin: obs.cabin,
              roomName: obs.roomName, transfer: obs.transfer, baggage: obs.baggage,
              cancellation: obs.cancellation, totalPrice: obs.totalPrice,
              pricePerPerson: obs.pricePerPerson, currency: obs.currency,
              verificationLevel: obs.verificationLevel, fetchedAt: obs.fetchedAt,
            },
          }
        })
        return { tripId: trip.id, tripKey: trip.tripKey, comparisons }
      }).filter(t => t.comparisons.length > 0)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        disclaimer: "EXPERIMENTAL — package quotes are observations from unofficial seller APIs, not confirmed bookable rates. Verdicts are quantified only at strong comparability; unknown costs are named, never zeroed; currencies are never converted.",
        totals: packageTotals(db),
        trips: byTrip,
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/deals — §29 the extreme deal feed.
  //
  // Read-only over decisions that already exist: it runs no search, spends no
  // budget, and cannot trigger one. Everything it shows can be traced to a
  // stored score breakdown.
  if (url.pathname === "/api/deals") {
    try {
      const limitRaw = Number(url.searchParams.get("limit") ?? 12)
      const minRaw = url.searchParams.get("min")
      const feed = buildFeed(getDb(), {
        limitPerSection: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 12,
        minScore: minRaw !== null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : undefined,
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(feed, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/deals/detail — §31 everything behind one card.
  if (url.pathname === "/api/deals/detail") {
    try {
      const id = Number(url.searchParams.get("id"))
      if (!Number.isInteger(id) || id <= 0) throw new BadRequest("id must be a positive integer")
      const detail = dealDetail(getDb(), id)
      if (!detail) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `no candidate ${id}` }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(detail, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/deals/anywhere — §11/§32 TAKE ME ANYWHERE.
  //
  // Deliberately answered from STORED discovery data. Fanning out live across
  // every wildcard destination on request is the brute force the engine exists
  // to avoid, and it would put an unbounded provider bill behind one HTTP GET.
  if (url.pathname === "/api/deals/anywhere") {
    try {
      const discoveryConfig = loadDiscoveryConfig()
      const originsRaw = url.searchParams.get("origins")
      const origins = originsRaw
        ? originsRaw.split(",").map(o => iata(o.trim(), "origins"))
        : discoveryConfig.homeRegion.primary

      const months = Number(url.searchParams.get("months") ?? 6)
      const budgetRaw = url.searchParams.get("budget")
      const cabin = url.searchParams.get("cabin")
      const tripLengthRaw = url.searchParams.get("tripLength")
      const minScoreRaw = url.searchParams.get("minScore")
      const limitRaw = Number(url.searchParams.get("limit") ?? 20)

      if (cabin && !["economy", "premium_economy", "business", "first"].includes(cabin)) {
        throw new BadRequest("cabin must be economy, premium_economy, business or first")
      }

      const result = takeMeAnywhere(getDb(), {
        origins,
        withinMonths: Number.isFinite(months) ? Math.min(Math.max(months, 1), 12) : 6,
        maxPrice: budgetRaw !== null && Number.isFinite(Number(budgetRaw)) ? Number(budgetRaw) : null,
        currency: process.env.CASH_CURRENCY || "USD",
        cabin: cabin || null,
        tripLengthNights: tripLengthRaw !== null && Number.isFinite(Number(tripLengthRaw))
          ? Number(tripLengthRaw) : null,
        minScore: minScoreRaw !== null && Number.isFinite(Number(minScoreRaw))
          ? Number(minScoreRaw) : loadAnomalyConfig().candidateThreshold,
        limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20,
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(result, null, 2))
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 500
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/discovery/status — read-only discovery state.
  // Control stays CLI-only, exactly as the observer's does: nothing on the
  // network can start a cycle that spends provider budget.
  if (url.pathname === "/api/discovery/status") {
    try {
      const db = getDb()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        checkedAt: new Date().toISOString(),
        jobs: listDiscoveryJobs(db),
        runs: listDiscoveryRuns(db, { limit: 20 }),
        projection: projectDiscoveryBudget(db),
        clusters: listClusters(db, { minScore: 0, limit: 40 }),
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/alerts — §30 what the notification layer has done and decided.
  //
  // GET only, read-only, no side effects, and deliberately NO write route
  // anywhere in this phase. The /api/ Origin guard only fires when an Origin
  // header is present, and <img>, <script> and plain navigations send none - so
  // a forged send would be reachable from any page in any tab. And the damage
  // is not "an unwanted notification": with a cap of two per day and a 24-hour
  // cooldown, two forged sends silence the radar for the rest of the day.
  // Sending stays CLI-only, exactly as observer:start and discovery:run do.
  //
  // Nothing here may carry a server, topic, token, credential path or publish
  // URL. The channel reports its HOST and its status; the topic is withheld.
  if (url.pathname === "/api/alerts") {
    try {
      const db = getDb()
      const config = loadNotificationConfig()
      const channel = new NtfyChannel()
      const health = channel.health()
      const now = new Date()
      const day = localDay(now, config)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        checkedAt: now.toISOString(),
        enabled: notificationsEnabled(config),
        channel: { name: health.channel, status: health.status, detail: health.detail },
        policy: {
          threshold: config.threshold,
          quietHours: `${config.quietHours.start}-${config.quietHours.end} ${config.quietHours.timezone}`,
          quietNow: isQuiet(now, config),
          maxImmediatePerDay: config.rateLimits.maxImmediatePerDay,
          clusterCooldownHours: config.rateLimits.clusterCooldownHours,
          extremeBypassScore: config.extremeBypass.minScore,
        },
        today: { localDay: day, immediatesUsed: immediatesToday(db, day) },
        notifications: listNotifications(db, 50),
        queue: listQueue(db, 50),
        decisions: listEvents(db, 60, "decision"),
        recent: listEvents(db, 60),
        warnings: credentialWarnings(config, now),
      }, null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: /api/anomaly/report — §X false-positive analysis.
  if (url.pathname === "/api/anomaly/report") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(buildReport(getDb(), { since: url.searchParams.get("since") || undefined }), null, 2))
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Route: POST /api/anomaly/feedback — §W the ONLY write endpoint on this
  // server, and deliberately the narrowest one possible: it records a verdict
  // from a fixed vocabulary against an existing candidate. It cannot start,
  // stop or schedule anything; scheduler control stays CLI-only.
  //
  // Three gates, because a browser tab on this machine is a real attacker:
  //   1. loopback only  — nothing on the LAN can reach it
  //   2. JSON only      — blocks the form POST that needs no CORS preflight
  //   3. POST is never advertised in Allow-Methods, so a cross-origin fetch
  //      fails its preflight before the request is ever made
  if (url.pathname === "/api/anomaly/feedback") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
      res.end(JSON.stringify({ error: "POST only" }))
      return
    }
    const remote = req.socket.remoteAddress || ""
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
    // Behind Docker the client is never loopback - the bridge NAT rewrites it -
    // so a browser on a trusted origin proves itself with its Origin header
    // instead. Browsers always send Origin on POST and never let a page forge
    // it; a non-browser caller on the LAN could, but a LAN caller can equally
    // run the CLI, which is the same trust boundary.
    const trustedWrite = TRUSTED_ORIGINS.length > 0
      && TRUSTED_ORIGINS.includes(req.headers.origin || "")
    if (!isLoopback && !trustedWrite) {
      console.warn(`⚠️ Blocked non-loopback feedback write from ${remote}`)
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "feedback may only be recorded from this machine" }))
      return
    }
    if (!(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Content-Type must be application/json" }))
      return
    }

    let body = ""
    let tooLarge = false
    req.on("data", chunk => {
      body += chunk
      if (body.length > 4096) { tooLarge = true; req.destroy() }
    })
    req.on("end", () => {
      if (tooLarge) return
      try {
        const payload = JSON.parse(body || "{}")
        const id = Number(payload.candidateId)
        const verdict = String(payload.verdict || "")
        if (!Number.isInteger(id) || id <= 0) throw new BadRequest("candidateId must be a positive integer")
        // §33 WOULD_BOOK is the verdict that matters most: "good deal" is an
        // opinion about the algorithm, "would book" is an opinion about the trip.
        if (!["GOOD_DEAL", "NORMAL", "BAD_SIGNAL", "WOULD_BOOK"].includes(verdict)) {
          throw new BadRequest("verdict must be GOOD_DEAL, NORMAL, BAD_SIGNAL or WOULD_BOOK")
        }
        const note = typeof payload.note === "string" ? payload.note.slice(0, 500) : null
        recordFeedback(getDb(), id, verdict as any, { note, source: "ui" })
        const updated = getCandidate(getDb(), id)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, candidateId: id, verdict, feedback: updated?.feedback ?? null }))
      } catch (err) {
        const status = err instanceof BadRequest ? 400 : 500
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })
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
    let tripType: import("./fareradar/config.js").TripType
    let refresh = false, verify = false
    try {
      from = iata(url.searchParams.get("from") || "LAX", "from")
      to = iata(url.searchParams.get("to") || "DXB", "to")
      date = isoDate(url.searchParams.get("date") || "2026-04-28", "date")
      const retRaw = url.searchParams.get("return") || ""
      ret = retRaw ? isoDate(retRaw, "return") : ""
      // Explicit tripType is strict; omitted keeps the legacy inference
      // (return present = round trip, absent = one way). Phase 8k enum reused.
      const resolution = resolveTripSearch(url.searchParams.get("tripType"), ret)
      if (resolution.error) throw new BadRequest(resolution.error)
      tripType = resolution.tripType!
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
      `🔍 API search: ${from}→${to} ${date}${ret ? ` ↩${ret}` : ' ONE WAY'} ${cls} flex±${flex}` +
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
      // Build outbound search config from the validated leg plan: ONE_WAY is
      // exactly one search with no return date; ROUND_TRIP keeps its reversed
      // return-leg search below, unchanged.
      const legPlan = planSearchLegs(tripType, from, to, date, ret)
      const outboundConfig: SearchConfig = {
        origin: legPlan.outbound.origin,
        destination: legPlan.outbound.destination,
        departureDate: legPlan.outbound.departureDate,
        returnDate: legPlan.outbound.returnDate,
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
      if (legPlan.returnLeg) {
        console.log(`🔍 Searching return: ${legPlan.returnLeg.origin}→${legPlan.returnLeg.destination} ${legPlan.returnLeg.departureDate}`)
        const returnConfig: SearchConfig = {
          origin: legPlan.returnLeg.origin,
          destination: legPlan.returnLeg.destination,
          departureDate: legPlan.returnLeg.departureDate,
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
