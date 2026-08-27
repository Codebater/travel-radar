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
  latestBalanceSnapshot, saveBalanceSnapshot, recordCallAttempt, recordCallOutcome,
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

async function fetchFromAwardWallet(db: DB): Promise<BalanceRow[] | null> {
  let creds: { apiKey?: string; api_key?: string; userId?: string; user_id?: string }
  try {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"))
  } catch (err) {
    console.warn(`⚠️ AwardWallet credentials unreadable: ${(err as Error).message}`)
    return null
  }
  const apiKey = creds.apiKey || creds.api_key
  const userId = creds.userId || creds.user_id
  if (!apiKey || !userId) return null

  recordCallAttempt(db, "awardwallet")
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    let resp: Response
    try {
      resp = await fetch(`https://business.awardwallet.com/api/export/v1/connectedUser/${userId}`, {
        headers: { "X-Authentication": apiKey, Accept: "application/json" },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!resp.ok) {
      recordCallOutcome(db, "awardwallet", { ok: false, error: `HTTP ${resp.status}` })
      return null
    }
    const data = await resp.json() as any
    if (!data.accounts) {
      recordCallOutcome(db, "awardwallet", { ok: false, error: "no accounts in response" })
      return null
    }
    recordCallOutcome(db, "awardwallet", { ok: true })
    return data.accounts
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
  if (snapshot) {
    const hours = Math.round(snapshot.ageMinutes / 6) / 10
    const fresh = snapshot.ageMinutes <= balanceTtlHours() * 60
    return {
      provider: "awardwallet", status: "ok", latencyMs: null, checkedAt, quota: null,
      detail: `${snapshot.balances.length} programs cached, last refresh ${hours}h ago${fresh ? "" : " (stale — next search refreshes)"}`,
    }
  }
  return {
    provider: "awardwallet", status: "ok", latencyMs: null, checkedAt, quota: null,
    detail: "configured; no snapshot yet — first search will fetch",
  }
}
