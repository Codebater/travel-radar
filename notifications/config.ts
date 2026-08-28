/**
 * Notification policy loader.
 *
 * The split that matters: POLICY lives in config/notifications.json and is
 * committed, readable and reviewable. SECRETS live in the environment and are
 * never read by this file at all - the channel reads them at send time, so no
 * loaded config object can ever carry a topic or a token into a log line, an
 * API response or a database row (§9).
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "notifications.json")

export interface NotificationConfig {
  enabled: boolean
  channel: string
  threshold: number
  evidence: {
    minBaselineConfidence: string
    acceptVerified: boolean
    acceptCrossVerified: boolean
    absoluteException: {
      enabled: boolean
      minTier: "interesting" | "extreme" | "wtf"
      minProviderConfidence: string
      label: string
      /** Its own, lower score bar - see the note in config/notifications.json. */
      minScore: number
    }
  }
  freshness: {
    maxObservationAgeHours: number
    maxOpenJawLegAgeHours: number
    maxDepartureLeadDays: number
    minDepartureLeadDays: number
    maxComparatorAgeHours: number
  }
  openJaw: {
    minNetSavingPercent: number
    minNetSaving: Record<string, number>
    maxFriction: number
    allowWithoutComparator: boolean
  }
  positioning: {
    minSavingPercent: number
    minSaving: Record<string, number>
    maxPenalty: number
    requireHomeComparator: boolean
  }
  quietHours: {
    timezone: string
    start: string
    end: string
    digestAtEnd: boolean
    maxCatchUpDays: number
  }
  extremeBypass: {
    enabled: boolean
    minScore: number
    requireOneOf: string[]
  }
  rateLimits: {
    maxImmediatePerDay: number
    maxDigestsPerDay: number
    clusterCooldownHours: number
    maxDigestItems: number
  }
  reAlert: {
    enabled: boolean
    minCashImprovementPercent: number
    minPointsImprovementPercent: number
    minTaxesImprovementPercent: number
    minScoreImprovement: number
    verificationUpgradeCounts: boolean
    minOpenJawTotalImprovementPercent: number
    cooldownHours: number
  }
  retry: {
    backoffMinutes: number[]
    maxAttempts: number
    staleClaimMinutes: number
    resendUnknown: boolean
  }
  verifyBeforeNotify: {
    enabled: boolean
    onFailure: "suppress" | "downgrade"
    maxPerDay: number
    maxPerTick: number
    poolShare: number
  }
  pass: {
    maxSendsPerTick: number
    maxCandidatesPerPass: number
    nearMissBand: number
  }
  deepLink: {
    baseUrl: string
    path: string
  }
  credentialWarnings: {
    warnWithinDays: number
  }
}

let cached: NotificationConfig | null = null

export function loadNotificationConfig(force = false): NotificationConfig {
  if (cached && !force) return cached
  cached = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as NotificationConfig
  // Deployment plumbing: the committed config says localhost, but a deployed
  // notification must deep-link to the URL the PHONE can reach - the Tailscale
  // hostname. An env override keeps that out of the committed file, and the
  // value still passes through buildLink's origin assertions like any other,
  // so a malformed override yields no link rather than a wrong one.
  const baseUrlOverride = (process.env.NOTIFY_BASE_URL || "").trim()
  if (baseUrlOverride) {
    cached = { ...cached, deepLink: { ...cached.deepLink, baseUrl: baseUrlOverride } }
  }
  return cached
}

/**
 * Are notifications switched on?
 *
 * Two independent conditions, and both are deliberate. The config flag is the
 * operator's decision; the environment override exists so a test, a dry run or
 * a CI job can be certain nothing will be delivered no matter what the
 * committed config says. Either one being off means off.
 */
export function notificationsEnabled(config = loadNotificationConfig()): boolean {
  if (process.env.NOTIFICATIONS_ENABLED === "false") return false
  return config.enabled === true
}

/**
 * §22 the deep link for one candidate.
 *
 * Built from the configured base URL and an integer, and from nothing else. No
 * candidate field reaches this function, which is the entire point: a provider
 * that starts returning an airline name containing a URL must not be able to
 * change where a notification points.
 */
export function deepLinkFor(candidateId: number, config = loadNotificationConfig()): string | null {
  if (!Number.isInteger(candidateId) || candidateId <= 0) return null
  return buildLink(`${config.deepLink?.path ?? ""}${candidateId}`, config)
}

/** The feed, for a digest covering several candidates. Same rules. */
export function feedLink(config = loadNotificationConfig()): string | null {
  return buildLink("/deals.html", config)
}

/**
 * Build a link from the configured origin and a config-controlled path, and
 * prove it did not escape.
 *
 * Concatenating onto `url.origin` looks safe and is not: a path of
 * `"@evil.example/x?c="` produces `http://localhost:8888@evil.example/x?c=42`,
 * where `localhost:8888` is userinfo and the HOST is evil.example. The config
 * is operator-authored so this is not attacker-reachable - but a notification
 * carrying a wrong link is a phishing message the reader has been trained to
 * trust, which is a bad thing to leave to a typo.
 *
 * Two guards: reject a path that does not start with a single "/", and then
 * assert the parsed result still has the origin we started from.
 */
function buildLink(pathAndSuffix: string, config: NotificationConfig): string | null {
  const base = (config.deepLink?.baseUrl || "").trim()
  if (!base) return null
  if (!pathAndSuffix.startsWith("/") || pathAndSuffix.startsWith("//")) return null
  try {
    const origin = new URL(base)
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null
    const link = new URL(pathAndSuffix, origin.origin)
    // The assertion, not the construction, is what makes this safe.
    return link.origin === origin.origin ? link.toString() : null
  } catch {
    return null
  }
}

/** Currency-keyed floor with a sane fallback — never a silent zero. */
export function amountFor(table: Record<string, number>, currency: string | null): number {
  if (currency && table[currency] !== undefined) return table[currency]!
  if (table.USD !== undefined) return table.USD
  return Object.values(table)[0] ?? 0
}
