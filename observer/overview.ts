/**
 * Project-wide Observer overview — the reconciliation slice.
 *
 * The Observer is the Extreme Travel Radar's background observation/status
 * umbrella. This module only REPORTS: it aggregates the run ledgers, leases
 * and observation tables that already exist, and never invents state —
 * a domain with no scheduler shows no next run, a module that is driven by
 * hand says so, and a table that does not exist yet reads "unavailable"
 * rather than zero. Nothing here schedules, merges leases or spends.
 */

import { type DB } from "../db/index.js"
import { readLease, listJobs, listRuns } from "./store.js"
import { readStayLease } from "../stays/lease.js"
import { notificationsEnabled, loadNotificationConfig } from "../notifications/config.js"

export type DomainScheduling =
  | "scheduled"        // runs on the main Observer scheduler
  | "own-scheduler"    // runs on its own (deliberately separate) scheduler
  | "manual-only"      // CLI/API-driven; no background job exists
  | "not-configured"

export interface DomainStatus {
  domain: string
  title: string
  scheduling: DomainScheduling
  /** One honest sentence about who drives this domain today. */
  note: string
  lastRunAt: string | null
  lastRunStatus: string | null
  /** Meaningful observation count, or null when none applies / unavailable. */
  observations: number | null
  observationsLabel: string | null
  /** ONLY when a real scheduler has actually computed one — never fabricated. */
  nextRunAt: string | null
  /** Set when a status source is missing (e.g. table not migrated). */
  unavailable: string | null
}

export interface ObserverOverview {
  checkedAt: string
  domains: DomainStatus[]
  /** Things that are deliberately NOT observer jobs, with the reason. */
  excluded: { name: string; reason: string }[]
}

function count(db: DB, sql: string): number | null {
  try { return (db.prepare(sql).get() as { c: number }).c } catch { return null }
}
function one<T>(db: DB, sql: string): T | null {
  try { return (db.prepare(sql).get() as T) ?? null } catch { return null }
}

export function buildObserverOverview(db: DB): ObserverOverview {
  const domains: DomainStatus[] = []

  // ── Flights (cash + award observation, discovery, open-jaw) ───────────────
  {
    let lease: ReturnType<typeof readLease> | null = null
    let nextRunAt: string | null = null
    let lastRunAt: string | null = null
    let lastRunStatus: string | null = null
    try {
      lease = readLease(db)
      // A next run exists only while the scheduler actually holds the lease.
      if (lease) {
        const jobs = listJobs(db, { enabledOnly: true })
        const upcoming = jobs.map(j => j.nextRunAt).filter((t): t is string => t !== null).sort()
        nextRunAt = upcoming[0] ?? null
      }
      const run = listRuns(db, { limit: 1 })[0] as { startedAt?: string; status?: string } | undefined
      lastRunAt = run?.startedAt ?? null
      lastRunStatus = run?.status ?? null
    } catch { /* reported below via unavailable */ }
    const cash = count(db, "SELECT COUNT(*) c FROM flight_prices")
    const awards = count(db, "SELECT COUNT(*) c FROM award_prices")
    domains.push({
      domain: "flights",
      title: "Flights (cash + award, discovery, open-jaw)",
      scheduling: "scheduled",
      note: lease
        ? `main Observer scheduler RUNNING (holder ${lease.holder})`
        : "main Observer scheduler (currently stopped — start via observer:start; production runs it on Vault71)",
      lastRunAt, lastRunStatus,
      observations: cash !== null && awards !== null ? cash + awards : cash ?? awards,
      observationsLabel: `${cash ?? "?"} cash + ${awards ?? "?"} award prices`,
      nextRunAt,
      unavailable: cash === null ? "flight observation tables unavailable" : null,
    })
  }

  // ── Stays (cash rates — deliberately separate scheduler since Phase 8b) ───
  {
    let leaseNote = "own scheduler (separate lease by design) — currently stopped; start via stays:start"
    try {
      const lease = readStayLease(db)
      if (lease.holder) {
        leaseNote = `own scheduler (separate lease by design) — RUNNING (holder ${lease.holder})`
      }
    } catch { /* stays lease table absent */ }
    const run = one<{ started_at: string; status: string }>(db,
      "SELECT started_at, status FROM stay_observation_runs ORDER BY id DESC LIMIT 1")
    const rates = count(db, "SELECT COUNT(*) c FROM stay_rate_observations")
    domains.push({
      domain: "stays",
      title: "Stays (cash hotel rates)",
      scheduling: "own-scheduler",
      note: leaseNote,
      lastRunAt: run?.started_at ?? null,
      lastRunStatus: run?.status ?? null,
      observations: rates,
      observationsLabel: "rate observations",
      nextRunAt: null,   // interval-driven; no persisted next-run exists, so none is shown
      unavailable: rates === null ? "stay tables unavailable" : null,
    })
  }

  // ── Business fare radar (Phase 8j/8k) ─────────────────────────────────────
  {
    const run = one<{ created_at: string; finished_at: string | null; trip_type: string; calls_spent: number }>(db,
      "SELECT created_at, finished_at, trip_type, calls_spent FROM fare_radar_runs ORDER BY id DESC LIMIT 1")
    const candidates = count(db, "SELECT COUNT(*) c FROM fare_radar_candidates")
    domains.push({
      domain: "fare-radar",
      title: "Business Fare Radar (flexible sweeps)",
      scheduling: "manual-only",
      note: "local/manual — run via flights:radar or the fares.html SEARCH button; no background job exists",
      lastRunAt: run?.created_at ?? null,
      lastRunStatus: run ? (run.finished_at ? `finished (${run.trip_type}, ${run.calls_spent} billable)` : "unfinished") : null,
      observations: candidates,
      observationsLabel: "radar candidates (prices live in flight_prices)",
      nextRunAt: null,
      unavailable: candidates === null ? "fare radar tables unavailable" : null,
    })
  }

  // ── Packages + market verdicts (Phase 8g/8h) ──────────────────────────────
  {
    const pkg = one<{ fetched_at: string }>(db, "SELECT fetched_at FROM package_offer_observations ORDER BY id DESC LIMIT 1")
    const verdict = one<{ computed_at: string }>(db, "SELECT computed_at FROM market_verdicts ORDER BY id DESC LIMIT 1")
    const obs = count(db, "SELECT COUNT(*) c FROM package_offer_observations")
    domains.push({
      domain: "packages-market",
      title: "Packages + market checks (BUILD vs BUY)",
      scheduling: "manual-only",
      note: "local/manual — packages:* and market:run CLIs; budget-capped per run, never scheduled",
      lastRunAt: pkg?.fetched_at ?? null,
      lastRunStatus: verdict ? `verdicts computed ${verdict.computed_at.slice(0, 16)}` : null,
      observations: obs,
      observationsLabel: "package offer observations",
      nextRunAt: null,
      unavailable: obs === null ? "package tables unavailable" : null,
    })
  }

  // ── FX (ECB reference rates) ──────────────────────────────────────────────
  {
    const fx = one<{ fetched_at: string; provider_date: string }>(db,
      "SELECT fetched_at, provider_date FROM fx_rate_observations ORDER BY id DESC LIMIT 1")
    const obs = count(db, "SELECT COUNT(*) c FROM fx_rate_observations")
    domains.push({
      domain: "fx",
      title: "FX (ECB reference rates)",
      scheduling: "manual-only",
      note: "local/manual — market:fx CLI; a rate older than 7 days by its own reference date refuses numeric verdicts",
      lastRunAt: fx?.fetched_at ?? null,
      lastRunStatus: fx ? `latest reference date ${fx.provider_date}` : null,
      observations: obs,
      observationsLabel: "stored rates (append-only, provenance-referenced)",
      nextRunAt: null,
      unavailable: obs === null ? "fx tables unavailable" : null,
    })
  }

  // ── Hotel Awards (Phase 1 — probe only) ───────────────────────────────────
  {
    const last = one<{ fetched_at: string; search_state: string }>(db,
      "SELECT fetched_at, search_state FROM hotel_award_observations ORDER BY id DESC LIMIT 1")
    const obs = count(db, "SELECT COUNT(*) c FROM hotel_award_observations")
    domains.push({
      domain: "hotel-awards",
      title: "Hotel Awards (points stays)",
      scheduling: "manual-only",
      note: "probe/manual only — hotel-awards:probe CLI (Gondola MCP); Phase 1, no background job",
      lastRunAt: last?.fetched_at ?? null,
      lastRunStatus: last?.search_state ?? null,
      observations: obs,
      observationsLabel: "award-stay observations",
      nextRunAt: null,
      unavailable: obs === null ? "hotel award tables unavailable" : null,
    })
  }

  // ── Notifications (Phase 7 — observer-owned tick step) ────────────────────
  {
    let enabled = false
    let configNote = "delivery config unavailable"
    try {
      enabled = notificationsEnabled(loadNotificationConfig())
      configNote = enabled ? "delivery ENABLED" : "delivery DISABLED (decisions still recorded)"
    } catch { /* keep unavailable note */ }
    const sent = count(db, "SELECT COUNT(*) c FROM notifications")
    const last = one<{ created_at: string }>(db, "SELECT created_at FROM notifications ORDER BY id DESC LIMIT 1")
    domains.push({
      domain: "notifications",
      title: "Notifications (ntfy)",
      scheduling: "scheduled",
      note: `runs as the main Observer tick's last step — ${configNote}`,
      lastRunAt: last?.created_at ?? null,
      lastRunStatus: null,
      observations: sent,
      observationsLabel: "delivered notifications",
      nextRunAt: null,   // rides the flight tick; it has no schedule of its own
      unavailable: sent === null ? "notification tables unavailable" : null,
    })
  }

  return {
    checkedAt: new Date().toISOString(),
    domains,
    excluded: [
      { name: "Deal Radar", reason: "read-only projection over stored decisions — renders at request time, never a background job" },
      { name: "Trips / offers / verdict pages", reason: "read-time views and user-initiated rechecks — interactive, never scheduled" },
      { name: "Miles promo feed", reason: "TTL-cached enrichment metadata, fetched on page use — not an observation stream" },
      { name: "Dashboard searches", reason: "user-initiated and may spend the metered reserve — must never run unattended" },
    ],
  }
}
