/**
 * Cache TTLs and the SerpAPI budget, all configurable through the environment.
 *
 * CACHE answers "what did we recently fetch?" and expires.
 * HISTORY answers "what prices have we observed over time?" and never expires.
 * They are separate stores on purpose — see db/migrations/001_init.sql.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`⚠️ ${name}="${raw}" is not a non-negative number; using ${fallback}`)
    return fallback
  }
  return parsed
}

export interface CachePolicy {
  cashTtlHours: number
  awardTtlHours: number
  staleWhileRevalidate: boolean
}

export function cachePolicy(): CachePolicy {
  return {
    // Cash fares move on a scale of hours, not minutes.
    cashTtlHours: num("CASH_CACHE_TTL_HOURS", 8),
    // Award seats appear and vanish far faster, so they get a shorter life.
    awardTtlHours: num("AWARD_CACHE_TTL_HOURS", 2),
    staleWhileRevalidate: (process.env.CACHE_STALE_WHILE_REVALIDATE ?? "true") !== "false",
  }
}

export interface SerpApiBudget {
  monthlyBudget: number
  reserveCalls: number
  /** Ceiling automated code may reach: budget minus the reserve. */
  automationCeiling: number
}

export function serpApiBudget(): SerpApiBudget {
  const monthlyBudget = num("SERPAPI_MONTHLY_BUDGET", 90)
  const reserveCalls = Math.min(num("SERPAPI_RESERVE_CALLS", 10), monthlyBudget)
  return {
    monthlyBudget,
    reserveCalls,
    automationCeiling: Math.max(0, monthlyBudget - reserveCalls),
  }
}

export function ttlToExpiry(hours: number, from: Date = new Date()): string {
  return new Date(from.getTime() + hours * 3600_000).toISOString()
}
