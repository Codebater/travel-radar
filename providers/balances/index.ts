/**
 * Loyalty balances — AwardWallet behind a cache.
 *
 * Balances change when the user earns or burns points, not minute by minute, so
 * they are fetched at most once per LOYALTY_BALANCE_TTL_HOURS (default 12) and
 * served from the latest balance_snapshots batch in between. A search never
 * triggers a fetch while a fresh snapshot exists; an explicit refresh does.
 *
 * SENSITIVITY: balances are personal financial/travel metadata. They live only
 * in the git-ignored local database, are never logged individually (counts and
 * ages only), and tests use synthetic values — see tests/mocks.ts.
 */

import fs from "fs"
import path from "path"
import os from "os"
import { getDb, type DB } from "../../db/index.js"
import {
  latestBalanceSnapshot, saveBalanceSnapshot, recordCallAttempt, recordCallOutcome, readUsage,
  type BalanceRow,
} from "../../db/repositories.js"
import type { ProviderHealth } from "../cash-flights/types.js"

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

const CREDENTIALS_PATH = path.join(homeDir(), ".openclaw", "credentials", "awardwallet.json")

export interface PointsBalance extends BalanceRow {
  displayBalance: string
}

export interface BalancesResult {
  balances: PointsBalance[]
  /** awardwallet-live | awardwallet-cached | fallback */
  source: string
  fetchedAt: string | null
  ageMinutes: number | null
}

function balanceTtlHours(): number {
  const raw = Number(process.env.LOYALTY_BALANCE_TTL_HOURS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 12
}

function enabled(): boolean {
  return (process.env.ENABLE_AWARDWALLET ?? "true") !== "false"
}

function configured(): boolean {
  return enabled() && fs.existsSync(CREDENTIALS_PATH)
}

function display(rows: BalanceRow[]): PointsBalance[] {
  return rows.map(r => ({ ...r, displayBalance: r.balance.toLocaleString() }))
}

/** Program display name → transfer-graph key. Moved verbatim from search.ts. */
export function mapProgramKey(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes("chase") || lower.includes("ultimate rewards")) return "chase-ur"
  if (lower.includes("amex") || lower.includes("membership rewards")) return "amex-mr"
  if (lower.includes("flying blue") || lower.includes("air france")) return "FLYING_BLUE"
  if (lower.includes("aeroplan") || lower.includes("air canada")) return "AEROPLAN"
  if (lower.includes("alaska")) return "ALASKA"
  if (lower.includes("united")) return "UNITED"
  if (lower.includes("delta")) return "DELTA"
  if (lower.includes("british") || lower.includes("avios")) return "BRITISH_AIRWAYS"
  if (lower.includes("iberia")) return "IBERIA"
  if (lower.includes("emirates") && lower.includes("skywards")) return "EMIRATES"
  if (lower.includes("qatar")) return "QATAR"
  if (lower.includes("qantas")) return "QANTAS"
  if (lower.includes("virgin") && lower.includes("atlantic")) return "VIRGIN_ATLANTIC"
  if (lower.includes("miles & more") || lower.includes("miles and more") || lower.includes("lufthansa")) return "MILES_AND_MORE"
  if (lower.includes("lifemiles") || lower.includes("avianca")) return "LIFEMILES"
  if (lower.includes("krisflyer") || lower.includes("singapore")) return "SINGAPORE"
  if (lower.includes("marriott")) return "marriott"
  if (lower.includes("hilton")) return "hilton"
  if (lower.includes("southwest")) return "southwest"
  if (lower.includes("bilt")) return "bilt"
  // Hotel keys match transfer-partners.ts exactly ("hyatt" lower, "IHG" upper)
  // so a snapshot row can be joined to its transfer edges without a second map.
  if (lower.includes("hyatt")) return "hyatt"
  if (lower.includes("ihg") || lower.includes("one rewards")) return "IHG"
  return lower.replace(/\s+/g, "-")
}

/**
 * Fallback balances when AwardWallet is not configured. Inherited from the
 * upstream project (already public in its repository); kept so the dashboard
 * remains functional without credentials. Not snapshotted — snapshots record
 * real fetches only.
 */
const FALLBACK_BALANCES: BalanceRow[] = [
  { program: "Chase UR", programKey: "chase-ur", balance: 1315295 },
  { program: "Flying Blue", programKey: "FLYING_BLUE", balance: 851165 },
  { program: "Marriott Bonvoy", programKey: "marriott", balance: 1392260 },
  { program: "Hilton Honors", programKey: "hilton", balance: 734242 },
  { program: "Aeroplan", programKey: "AEROPLAN", balance: 475663 },
  { program: "Delta SkyMiles", programKey: "DELTA", balance: 293430 },
  { program: "Southwest RR", programKey: "southwest", balance: 144250 },
  { program: "Alaska Mileage Plan", programKey: "ALASKA", balance: 87685 },
  { program: "BA Avios", programKey: "BRITISH_AIRWAYS", balance: 71449 },
  { program: "United MileagePlus", programKey: "UNITED", balance: 70000 },
  { program: "Virgin Atlantic", programKey: "VIRGIN_ATLANTIC", balance: 60728 },
  { program: "Bilt Rewards", programKey: "bilt", balance: 59390 },
]

const AW_BASE = "https://business.awardwallet.com/api/export/v1"

interface AwCreds { apiKey?: string; api_key?: string; userId?: string | number; user_id?: string | number }

function readCreds(): { apiKey: string | null; userId: string | null } {
  try {
    const c = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")) as AwCreds
    const userId = c.userId ?? c.user_id
    return { apiKey: c.apiKey || c.api_key || null, userId: userId != null ? String(userId) : null }
  } catch (err) {
    console.warn(`⚠️ AwardWallet credentials unreadable: ${(err as Error).message}`)
    return { apiKey: null, userId: null }
  }
}

/** Persist a discovered userId so the lookup happens once, not every refresh. */
function cacheUserId(userId: string): void {
  try {
    const c = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")) as AwCreds
    c.userId = userId
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(c, null, 2) + "\n")
  } catch { /* best effort — a failed write just means we rediscover next time */ }
}

async function awFetch(apiKey: string, path: string, timeoutMs = 20_000): Promise<{ status: number; body: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${AW_BASE}${path}`, {
      headers: { "X-Authentication": apiKey, Accept: "application/json" },
      signal: controller.signal,
    })
    const text = await resp.text()
    let body: any = null
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 200) } }
    return { status: resp.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turn an AwardWallet error body into something the operator can act on.
 * IP_DENIED in particular is a dashboard setting, not a bad key — saying
 * "unauthorized" there would send someone hunting the wrong problem.
 */
function describeAwError(status: number, body: any): string {
  const code = body?.code
  if (code === "IP_DENIED") {
    // The vendor's machine code is kept in the text on purpose: the failure
    // classifier that decides "auth problem" vs "server error" reads this
    // string, and a purely human sentence would be filed as a transient error.
    return "IP_DENIED: IP not whitelisted for this AwardWallet key — add this machine's public IP " +
           "under AwardWallet Business → API settings (the NAS will need its own entry later)"
  }
  // Observed live 2026-08-27 once the IP whitelist was in place. The key and
  // the IP are both accepted; the account plan is the gate, and the vendor
  // hands back the exact remedy, so it is passed straight through.
  if (code === "BUSINESS_ADMINS_REQUIRE_PLUS") {
    const fix = body?.how_to_fix ?? {}
    return "BUSINESS_ADMINS_REQUIRE_PLUS: AwardWallet accepts this key and this IP, but every admin on the business account must " +
           "hold AwardWallet Plus before the API returns data" +
           (fix.check_admins_url ? ` — check admins at ${fix.check_admins_url}` : "") +
           (fix.upgrade_url ? `, upgrade at ${fix.upgrade_url}` : "")
  }
  if (status === 401) return `unauthorized (${code || "check the API key"})`
  return `HTTP ${status}${code ? ` ${code}` : ""}${body?.message ? `: ${String(body.message).slice(0, 120)}` : ""}`
}

/**
 * Find the connected user whose accounts we read. Only the key was supplied,
 * and the balances endpoint is per-user, so the id is discovered once from
 * /connections and then cached into the credentials file.
 */
async function discoverUserId(apiKey: string): Promise<{ userId: string | null; error: string | null }> {
  const { status, body } = await awFetch(apiKey, "/connections")
  if (status === 404) {
    // This plan does not expose /connections at all. Reporting its 404 would
    // send someone hunting a wrong URL, so ask the endpoint we actually need
    // and report ITS answer — which is where the real gate lives, and which
    // starts succeeding by itself once the account is upgraded.
    const probe = await awFetch(apiKey, "/connectedUser")
    return {
      userId: null,
      error: probe.status === 404
        ? "AwardWallet exposes neither /connections nor /connectedUser for this key — set userId in the credentials file manually"
        : describeAwError(probe.status, probe.body),
    }
  }
  if (status !== 200) return { userId: null, error: describeAwError(status, body) }

  const list: any[] = Array.isArray(body) ? body : (body?.connections ?? body?.users ?? [])
  if (!Array.isArray(list) || list.length === 0) {
    return { userId: null, error: "no connected users on this AwardWallet account" }
  }
  // Prefer the connection with the most accounts — that is the real profile.
  const best = [...list].sort((a, b) => (b.accounts?.length ?? 0) - (a.accounts?.length ?? 0))[0]
  const id = best?.userId ?? best?.id
  return id != null ? { userId: String(id), error: null } : { userId: null, error: "connection carried no userId" }
}

async function fetchFromAwardWallet(db: DB): Promise<BalanceRow[] | null> {
  const creds = readCreds()
  if (!creds.apiKey) return null

  recordCallAttempt(db, "awardwallet")
  try {
    let userId = creds.userId
    if (!userId) {
      const discovered = await discoverUserId(creds.apiKey)
      if (!discovered.userId) {
        recordCallOutcome(db, "awardwallet", { ok: false, error: discovered.error })
        console.warn(`⚠️ AwardWallet: ${discovered.error}`)
        return null
      }
      userId = discovered.userId
      cacheUserId(userId)
      console.log(`BALANCES: discovered AwardWallet connected user, cached for future refreshes`)
    }

    const { status, body } = await awFetch(creds.apiKey, `/connectedUser/${encodeURIComponent(userId)}`)
    if (status !== 200) {
      const error = describeAwError(status, body)
      recordCallOutcome(db, "awardwallet", { ok: false, error })
      console.warn(`⚠️ AwardWallet: ${error}`)
      return null
    }
    if (!body?.accounts) {
      recordCallOutcome(db, "awardwallet", { ok: false, error: "no accounts in response" })
      return null
    }
    recordCallOutcome(db, "awardwallet", { ok: true })
    return body.accounts
      .filter((a: any) => (a.balanceRaw || 0) > 0)
      .map((a: any) => ({
        program: a.displayName || a.name,
        programKey: mapProgramKey(a.displayName || a.name),
        balance: a.balanceRaw || parseInt(String(a.balance).replace(/,/g, ""), 10) || 0,
      }))
      .sort((a: BalanceRow, b: BalanceRow) => b.balance - a.balance)
  } catch (err) {
    recordCallOutcome(db, "awardwallet", { ok: false, error: (err as Error).message })
    return null
  }
}

/**
 * Loyalty balances, cache first. `forceRefresh` bypasses the snapshot TTL —
 * that is the manual-refresh path and the only way to re-fetch early.
 */
export async function getBalances(
  options: { forceRefresh?: boolean; db?: DB } = {},
): Promise<BalancesResult> {
  const db = options.db ?? getDb()
  const ttl = balanceTtlHours()

  if (!options.forceRefresh) {
    const snapshot = latestBalanceSnapshot(db, { maxAgeHours: ttl })
    if (snapshot) {
      console.log(`BALANCE CACHE HIT (${snapshot.balances.length} programs, ${snapshot.ageMinutes}m old)`)
      return {
        balances: display(snapshot.balances),
        source: "awardwallet-cached",
        fetchedAt: snapshot.fetchedAt,
        ageMinutes: snapshot.ageMinutes,
      }
    }
  }

  if (configured()) {
    const fetched = await fetchFromAwardWallet(db)
    if (fetched && fetched.length > 0) {
      const fetchedAt = saveBalanceSnapshot(db, fetched, "awardwallet")
      console.log(`BALANCES REFRESHED (${fetched.length} programs)`)
      return { balances: display(fetched), source: "awardwallet-live", fetchedAt, ageMinutes: 0 }
    }
    // Fetch failed — an older snapshot beyond TTL still beats hardcoded data.
    const stale = latestBalanceSnapshot(db)
    if (stale) {
      console.warn(`⚠️ AwardWallet fetch failed; using stale snapshot (${stale.ageMinutes}m old)`)
      return {
        balances: display(stale.balances),
        source: "awardwallet-cached",
        fetchedAt: stale.fetchedAt,
        ageMinutes: stale.ageMinutes,
      }
    }
    console.warn("⚠️ AwardWallet fetch failed, using fallback balances")
  }

  return { balances: display(FALLBACK_BALANCES), source: "fallback", fetchedAt: null, ageMinutes: null }
}

/** Health line for /api/providers. Reports ages and counts, never balances. */
export function balancesHealth(db: DB = getDb()): ProviderHealth {
  const checkedAt = new Date().toISOString()
  if (!enabled()) {
    return { provider: "awardwallet", status: "unconfigured", detail: "disabled via ENABLE_AWARDWALLET=false", latencyMs: null, checkedAt, quota: null }
  }
  const snapshot = latestBalanceSnapshot(db)
  if (!configured()) {
    return {
      provider: "awardwallet", status: "unconfigured", latencyMs: null, checkedAt, quota: null,
      detail: `no credentials at ${CREDENTIALS_PATH}; fallback balances in use`,
    }
  }
  const usage = readUsage(db, "awardwallet")
  if (snapshot) {
    const hours = Math.round(snapshot.ageMinutes / 6) / 10
    const fresh = snapshot.ageMinutes <= balanceTtlHours() * 60
    return {
      provider: "awardwallet", status: "ok", latencyMs: null, checkedAt, quota: null,
      detail: `${snapshot.balances.length} programs cached, last refresh ${hours}h ago${fresh ? "" : " (stale — next search refreshes)"}`,
    }
  }
  // No snapshot yet: if a fetch has already failed, say WHY rather than
  // implying everything is fine and waiting for a search to fail again.
  if (usage.failed > 0 && usage.lastError) {
    return {
      provider: "awardwallet", status: "degraded", latencyMs: null, checkedAt, quota: null,
      detail: `configured but not yet working — ${usage.lastError.slice(0, 160)}`,
    }
  }
  return {
    provider: "awardwallet", status: "ok", latencyMs: null, checkedAt, quota: null,
    detail: "configured; no snapshot yet — first search will fetch",
  }
}

/** One stored account row, exactly as snapshotted — never merged with another. */
export interface BalancesSnapshotAccount {
  program: string
  programKey: string
  balance: number
  /** en-US thousands grouping of `balance`; presentation only, never re-parsed. */
  displayBalance: string
}

/**
 * Read-only view of the LOCAL balance snapshot for the hotel-awards page.
 *
 * HONESTY: this payload never triggers a fetch and never carries the fallback
 * list — a page that shows balances must show the user's own numbers or none.
 * `state` says which of the two happened:
 *   - "snapshot": `source`, `fetchedAt`, `ageMinutes` are set; `accounts` holds
 *     one row per stored account in stored order. Two accounts of the same
 *     program appear as two rows — nothing is summed, within or across programs.
 *   - "none": `accounts` is empty and `health` carries balancesHealth(db) so
 *     the page can say WHY (unconfigured / degraded / no snapshot yet) in the
 *     provider's own words rather than showing a blank.
 */
export interface BalancesSnapshotPayload {
  disclaimer: string
  state: "snapshot" | "none"
  /** Present only when state === "snapshot". Always "awardwallet-cached" — this path has no live source. */
  source?: "awardwallet-cached"
  /** Present only when state === "snapshot". */
  fetchedAt?: string
  /** Present only when state === "snapshot". Age of `fetchedAt` against Date.now(), whole minutes. */
  ageMinutes?: number
  accounts: BalancesSnapshotAccount[]
  /** Present only when state === "none". */
  health?: ProviderHealth
}

const SNAPSHOT_DISCLAIMER =
  "Local AwardWallet snapshot only — no network call, never demo/fallback numbers. " +
  "One row per account; accounts of one program are listed, never summed; nothing is summed across programs."

/**
 * Local snapshot only, with NO max-age: an old snapshot is still the user's
 * own balance and is served with its age attached; the absence of one is
 * reported as such. No TTL check, no refresh, no network, no substitute list.
 */
export function balancesSnapshotPayload(db: DB): BalancesSnapshotPayload {
  const snapshot = latestBalanceSnapshot(db)
  if (!snapshot) {
    return { disclaimer: SNAPSHOT_DISCLAIMER, state: "none", accounts: [], health: balancesHealth(db) }
  }
  return {
    disclaimer: SNAPSHOT_DISCLAIMER,
    state: "snapshot",
    source: "awardwallet-cached",
    fetchedAt: snapshot.fetchedAt,
    // Age is computed by the repository from fetched_at vs Date.now() — the
    // same number the cache-hit path reports.
    ageMinutes: snapshot.ageMinutes,
    accounts: snapshot.balances.map(r => ({
      program: r.program,
      programKey: r.programKey,
      balance: r.balance,
      displayBalance: r.balance.toLocaleString("en-US"),
    })),
  }
}
