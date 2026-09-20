/**
 * Hotel Award Radar — read-only data-status pre-flight.
 *
 * Answers "what do I already have, and could a run even start?" WITHOUT
 * spending anything: zero provider calls, zero writes. It is the thing an
 * operator (or the page) looks at BEFORE deciding to press the button that
 * actually calls Roame — never a substitute for that explicit action.
 *
 * Honesty rules the code cannot show on its own:
 *   - the Roame session file is resolved EXACTLY the way the provider does it
 *     (env HOTEL_AWARDS_ROAME_CREDS → cfg.roame.credentialsPath, "~" expanded
 *     via HOME || USERPROFILE || os.homedir()), so this can never report on a
 *     different file than the one a run would use — the resolution is
 *     re-implemented here rather than imported so that roame.ts stays untouched;
 *   - ONLY `sessionExpiresAt` is read from that file. `session` / `csrfSecret`
 *     are never read into memory by this module, never copied into the result,
 *     and the resolved PATH is never placed in the payload either (a status
 *     surface is shared more widely than a provider health detail);
 *   - `present` means "a credentials file exists and parses" — NOT that the
 *     provider would accept it (that needs the session key, which this module
 *     deliberately does not look at). A file without an expiry is present with
 *     unknown expiry, never treated as expired;
 *   - usage is a STRICT read of provider_usage for the current period. The
 *     repository's readUsage() is NOT used because its ensureUsageRow() inserts
 *     a zero row — a status check must leave the database byte-identical;
 *   - observation counts and fetched_at bounds are reported as stored. Nothing
 *     is aggregated across programs or providers, no per-night figure is ever
 *     multiplied into a stay total, and no availability is inferred from the
 *     mere existence of history.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { currentPeriod, type DB } from "../../db/index.js"
import type { HotelAwardsConfig } from "./gondola.js"

/** Must equal RoameHotelAwardsProvider.name — the key recordCallAttempt /
 *  recordCallOutcome write usage under. Kept as a literal so this module needs
 *  nothing from roame.ts (and no provider instance) to read status. */
const ROAME_HOTELS_PROVIDER = "roame_hotels"

const DAY_MS = 86_400_000

export interface RoameSessionHealth { present: boolean; expiresAt: string | null; daysRemaining: number | null; expired: boolean }

export interface HotelAwardsStatus {
  checkedAt: string
  roameSession: RoameSessionHealth
  locations: string[]
  usage: { attempted: number; succeeded: number; failed: number; lastCallAt: string | null; lastSuccessAt: string | null; lastError: string | null } | null
  observations: { total: number; newest: string | null; oldest: string | null }
  limits: { maxPagesPerWindow: number; maxWindowsPerRun: number | null; politenessMs: number }
}

// ── Credentials file resolution (mirror of roame.ts, deliberately local) ─────

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), p.slice(1)) : p
}

/** The same precedence the provider applies: env override, then config.
 *  Null when neither names a file (no roame block, no override). */
function resolveRoameCredentialsPath(cfg: HotelAwardsConfig): string | null {
  const configured = process.env.HOTEL_AWARDS_ROAME_CREDS || cfg.roame?.credentialsPath
  return configured ? expandHome(configured) : null
}

/**
 * Expiry of the Roame session the HOTEL provider would use. Reads one field
 * (`sessionExpiresAt`, epoch-ms number or ISO string) and nothing else.
 * Missing / unreadable / unparsable → not present. Never throws.
 */
export function roameHotelSessionHealth(cfg: HotelAwardsConfig, now: Date = new Date()): RoameSessionHealth {
  const absent: RoameSessionHealth = { present: false, expiresAt: null, daysRemaining: null, expired: false }
  const file = resolveRoameCredentialsPath(cfg)
  if (file === null) return absent
  try {
    // Only the expiry is destructured out of the parsed object; the secrets
    // stay inside a local that goes out of scope at the end of this block.
    const { sessionExpiresAt } = JSON.parse(fs.readFileSync(file, "utf-8")) as { sessionExpiresAt?: number | string | null }
    if (sessionExpiresAt === undefined || sessionExpiresAt === null) return { ...absent, present: true }
    const expiresMs = typeof sessionExpiresAt === "number" ? sessionExpiresAt : Date.parse(String(sessionExpiresAt))
    if (!Number.isFinite(expiresMs)) return { ...absent, present: true }
    const days = Math.floor((expiresMs - now.getTime()) / DAY_MS)
    return {
      present: true,
      expiresAt: new Date(expiresMs).toISOString(),
      daysRemaining: days,
      expired: days < 0,
    }
  } catch {
    // An unreadable or malformed file is the provider's problem to report at
    // run time; here it is simply "no usable session on record".
    return absent
  }
}

/**
 * Strip filesystem locations out of a provider error string before it is
 * served: the configured / env-overridden credentials path (raw and expanded)
 * becomes "<credentials file>", and any other whitespace-led path-like token
 * (~/…, /abs/…, C:\…) becomes "<path>". URLs are untouched (their path part
 * follows a hostname, not whitespace). Null stays null.
 */
export function redactCredentialPaths(text: string | null, cfg: HotelAwardsConfig): string | null {
  if (text === null) return null
  let out = text
  const configured = [process.env.HOTEL_AWARDS_ROAME_CREDS, cfg.roame?.credentialsPath].filter((p): p is string => !!p)
  for (const p of configured) {
    for (const variant of new Set([p, expandHome(p), expandHome(p).replace(/\\/g, "/"), expandHome(p).replace(/\//g, "\\")])) {
      if (variant) out = out.split(variant).join("<credentials file>")
    }
  }
  out = out.replace(/(^|\s)(?:~|[A-Za-z]:)?[\\/][\w.@~-]+(?:[\\/][\w.@~-]+)+/g, "$1<path>")
  return out
}

// ── The status read-out ──────────────────────────────────────────────────────

interface UsageRowRaw {
  attempted: number
  succeeded: number
  failed: number
  last_call_at: string | null
  last_success_at: string | null
  last_error: string | null
}

interface ObservationBoundsRaw { n: number; newest: string | null; oldest: string | null }

/**
 * One read-only snapshot: session expiry, configured bbox locations, this
 * period's Roame call accounting (null when no row — never a synthesized
 * zero row), stored observation bounds, and the run limits the config states.
 * No network, no writes, no credential path or value in the payload.
 */
export function hotelAwardsStatus(db: DB, cfg: HotelAwardsConfig, now: Date = new Date()): HotelAwardsStatus {
  // Only keys whose value is an explicit bbox object count as searchable. A
  // string value (the config's own "note", or a placeholder) is not a location.
  const locations = Object.entries(cfg.roame?.locations ?? {})
    .filter(([, v]) => typeof v === "object" && v !== null)
    .map(([k]) => k)

  // STRICT read — the repository's readUsage() would insert a row first.
  const usageRow = db.prepare(
    "SELECT attempted, succeeded, failed, last_call_at, last_success_at, last_error FROM provider_usage WHERE provider = ? AND period = ?",
  ).get(ROAME_HOTELS_PROVIDER, currentPeriod(now)) as UsageRowRaw | undefined
  const usage: HotelAwardsStatus["usage"] = usageRow
    ? {
      attempted: usageRow.attempted,
      succeeded: usageRow.succeeded,
      failed: usageRow.failed,
      lastCallAt: usageRow.last_call_at,
      lastSuccessAt: usageRow.last_success_at,
      // The provider's own error text may name the credentials file (e.g.
      // "no Roame session at <path>") — redacted BEFORE the 160-char cut.
      lastError: usageRow.last_error === null ? null : (redactCredentialPaths(usageRow.last_error, cfg) ?? "").slice(0, 160),
    }
    : null

  const bounds = db.prepare(
    "SELECT COUNT(*) n, MAX(fetched_at) newest, MIN(fetched_at) oldest FROM hotel_award_observations",
  ).get() as ObservationBoundsRaw

  return {
    checkedAt: now.toISOString(),
    roameSession: roameHotelSessionHealth(cfg, now),
    locations,
    usage,
    observations: { total: bounds.n, newest: bounds.newest, oldest: bounds.oldest },
    limits: {
      maxPagesPerWindow: cfg.roame?.search.maxPages ?? 1,
      maxWindowsPerRun: cfg.roame?.discovery?.maxWindowsPerRun ?? null,
      politenessMs: cfg.budget.politenessMs,
    },
  }
}
