/**
 * Credentials-path redaction on the status surface.
 *
 * The Roame provider's own error text names the credentials file when no
 * session is on record ("no Roame session at <path> — …"); that string is
 * recorded in provider_usage and would otherwise be echoed by the ungated
 * GET /api/hotel-awards/status. Pinned: the configured path (raw, expanded,
 * either slash style) and any other whitespace-led filesystem path are
 * redacted before serving; URLs are left intact; null stays null.
 */

import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, currentPeriod, type DB } from "../db/index.js"
import { recordCallAttempt, recordCallOutcome } from "../db/repositories.js"
import { loadHotelAwardsConfig } from "../providers/hotel-awards/gondola.js"
import { hotelAwardsStatus, redactCredentialPaths } from "../providers/hotel-awards/status.js"

const CFG = loadHotelAwardsConfig(true)
const NOW = new Date("2026-09-06T12:00:00.000Z")

describe("redactCredentialPaths", () => {
  const saved = process.env.HOTEL_AWARDS_ROAME_CREDS
  afterEach(() => {
    if (saved === undefined) delete process.env.HOTEL_AWARDS_ROAME_CREDS
    else process.env.HOTEL_AWARDS_ROAME_CREDS = saved
  })

  it("replaces the configured credentials path in every spelling", () => {
    delete process.env.HOTEL_AWARDS_ROAME_CREDS
    const configured = CFG.roame!.credentialsPath
    const expanded = configured.startsWith("~")
      ? path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), configured.slice(1))
      : configured
    for (const variant of [configured, expanded, expanded.replace(/\\/g, "/")]) {
      const out = redactCredentialPaths(`no Roame session at ${variant} — sign in and save the session cookie`, CFG)!
      expect(out).not.toContain(variant)
      expect(out).toContain("<credentials file>")
    }
  })

  it("replaces the env-override path and generic path-like tokens, but leaves URLs alone", () => {
    process.env.HOTEL_AWARDS_ROAME_CREDS = path.join(os.tmpdir(), "roame-override.json")
    const out = redactCredentialPaths(`failed reading ${process.env.HOTEL_AWARDS_ROAME_CREDS} then ~/.openclaw/x/y.json and C:\\Users\\me\\secret.json`, CFG)!
    expect(out).not.toContain(process.env.HOTEL_AWARDS_ROAME_CREDS)
    expect(out).not.toContain(".openclaw")
    expect(out).not.toContain("secret.json")
    const url = redactCredentialPaths("HTTP 403 from https://roame.travel/encore/graphql after 1 call", CFG)!
    expect(url).toContain("https://roame.travel/encore/graphql")
    expect(redactCredentialPaths(null, CFG)).toBeNull()
  })
})

describe("hotelAwardsStatus never serves the credentials path", () => {
  let db: DB
  const saved = process.env.HOTEL_AWARDS_ROAME_CREDS
  beforeEach(() => {
    db = createMemoryDb()
    process.env.HOTEL_AWARDS_ROAME_CREDS = path.join(os.tmpdir(), "does-not-exist-roame.json")
  })
  afterEach(() => {
    db.close()
    if (saved === undefined) delete process.env.HOTEL_AWARDS_ROAME_CREDS
    else process.env.HOTEL_AWARDS_ROAME_CREDS = saved
  })

  it("a recorded 'no Roame session at <path>' error reaches the payload redacted", () => {
    const period = currentPeriod(NOW)
    recordCallAttempt(db, "roame_hotels", period)
    recordCallOutcome(db, "roame_hotels", { ok: false, error: `no Roame session at ${CFG.roame!.credentialsPath} — sign in and save the session cookie` }, period)
    recordCallAttempt(db, "roame_hotels", period)
    recordCallOutcome(db, "roame_hotels", { ok: false, error: `cannot read ${process.env.HOTEL_AWARDS_ROAME_CREDS}` }, period)
    const s = hotelAwardsStatus(db, CFG, NOW)
    const json = JSON.stringify(s)
    expect(s.usage!.failed).toBe(2)
    expect(json).not.toContain(CFG.roame!.credentialsPath)
    expect(json).not.toContain(".openclaw")
    expect(json).not.toContain(process.env.HOTEL_AWARDS_ROAME_CREDS!)
    expect(s.usage!.lastError).toContain("<credentials file>")
  })
})
