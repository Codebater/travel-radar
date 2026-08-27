/**
 * §37 - a session that expires silently turns half the radar off.
 *
 * The Roame session is the only source of award availability, and today nothing
 * warns before it goes: `RoameAwardProvider.health()` reads
 * `sessionExpiresAt` but only flips to `degraded` AFTER the date has passed. By
 * then award collection has been reporting SKIPPED_AUTH for a while and nobody
 * has looked.
 *
 * So this reads the same file the provider does, and answers a different
 * question: how long have I got? Nothing here renews anything - browser session
 * renewal is a human job, deliberately.
 *
 * The credentials PATH is never printed. `/api/providers` already leaks the
 * absolute path through the provider's own health detail; there is no reason to
 * repeat that on a second surface.
 */

import fs from "fs"
import os from "os"
import path from "path"
import type { NotificationConfig } from "./config.js"

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

export interface CredentialHealth {
  name: string
  present: boolean
  expiresAt: string | null
  daysRemaining: number | null
  expired: boolean
}

export function roameCredentialHealth(now: Date = new Date()): CredentialHealth {
  const file = path.join(homeDir(), ".openclaw", "credentials", "roame.json")
  const base: CredentialHealth = {
    name: "Roame session", present: false, expiresAt: null, daysRemaining: null, expired: false,
  }
  try {
    if (!fs.existsSync(file)) return base
    const creds = JSON.parse(fs.readFileSync(file, "utf-8")) as { sessionExpiresAt?: number | string }
    if (creds.sessionExpiresAt === undefined) return { ...base, present: true }
    const expiresMs = typeof creds.sessionExpiresAt === "number"
      ? creds.sessionExpiresAt
      : Date.parse(String(creds.sessionExpiresAt))
    if (!Number.isFinite(expiresMs)) return { ...base, present: true }
    const days = Math.floor((expiresMs - now.getTime()) / 86_400_000)
    return {
      name: "Roame session",
      present: true,
      expiresAt: new Date(expiresMs).toISOString().slice(0, 10),
      daysRemaining: days,
      expired: days < 0,
    }
  } catch {
    // An unreadable credentials file is the provider's problem to report, not
    // a reason for the notification status command to fail.
    return base
  }
}

/** Warnings worth putting in front of an operator who is checking on things. */
export function credentialWarnings(config: NotificationConfig, now: Date = new Date()): string[] {
  const warnings: string[] = []
  const roame = roameCredentialHealth(now)
  const within = config.credentialWarnings?.warnWithinDays ?? 21

  if (!roame.present) {
    warnings.push("no Roame session is stored - award observations are not being collected")
  } else if (roame.expired) {
    warnings.push(
      `the Roame session expired on ${roame.expiresAt} - award collection is reporting SKIPPED_AUTH ` +
      `and cash collection continues. Log in at roame.travel and save the session again`,
    )
  } else if (roame.daysRemaining !== null && roame.daysRemaining <= within) {
    warnings.push(
      `Roame session expires in ${roame.daysRemaining} day${roame.daysRemaining === 1 ? "" : "s"} ` +
      `(${roame.expiresAt}) - award observations stop when it does`,
    )
  }
  return warnings
}
