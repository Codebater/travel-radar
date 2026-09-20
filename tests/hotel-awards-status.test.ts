/**
 * Hotel Award Radar — read-only data-status pre-flight.
 *
 * Pins that the status read-out spends nothing and leaks nothing: the Roame
 * session file is resolved the way the provider resolves it, only its expiry
 * is read (secrets and the path never reach the payload), a missing / broken /
 * expiry-less file degrades to a structured state instead of a throw, usage is
 * a STRICT read that never creates a provider_usage row, observation bounds
 * are reported as stored, and the limits echo the config verbatim.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, currentPeriod, type DB } from "../db/index.js"
import { recordCallAttempt, recordCallOutcome } from "../db/repositories.js"
import { loadHotelAwardsConfig, type HotelAwardsConfig } from "../providers/hotel-awards/gondola.js"
import { hotelAwardsStatus, roameHotelSessionHealth } from "../providers/hotel-awards/status.js"
import { insertHotelAwards } from "../providers/hotel-awards/store.js"
import type { NormalizedHotelAward } from "../providers/hotel-awards/types.js"

const CFG = loadHotelAwardsConfig(true)
const NOW = new Date("2026-09-06T12:00:00.000Z")
const DAY_MS = 86_400_000
const SESSION_CANARY = "SESSION_CANARY"
const CSRF_CANARY = "CSRF_CANARY"

// One temp dir for the whole file (OS temp, never the repo); each test writes
// its own uniquely named credentials file inside it.
let tmpDir: string
let credsFile: string
const savedCredsEnv = process.env.HOTEL_AWARDS_ROAME_CREDS

beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotel-awards-status-")) })
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (savedCredsEnv === undefined) delete process.env.HOTEL_AWARDS_ROAME_CREDS
  else process.env.HOTEL_AWARDS_ROAME_CREDS = savedCredsEnv
})
afterEach(() => {
  if (savedCredsEnv === undefined) delete process.env.HOTEL_AWARDS_ROAME_CREDS
  else process.env.HOTEL_AWARDS_ROAME_CREDS = savedCredsEnv
})

let credsCounter = 0
/** Writes a credentials file carrying canary secrets plus the given expiry
 *  and points the env override at it. Returns the absolute path. */
function pointAtCreds(body: Record<string, unknown> | string): string {
  const p = path.join(tmpDir, `roame-${process.pid}-${credsCounter++}.json`)
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify({ session: SESSION_CANARY, csrfSecret: CSRF_CANARY, ...body }))
  process.env.HOTEL_AWARDS_ROAME_CREDS = p
  return p
}

function award(over: Partial<NormalizedHotelAward> = {}): NormalizedHotelAward {
  return {
    provider: "roame_hotels", providerPropertyRef: "bkkzs", propertyId: null,
    propertyName: "Hyatt Place Bangkok", chain: "PLACE",
    program: "WORLD_OF_HYATT", sourceProgramName: "HYATT",
    checkIn: "2026-11-21", checkOut: "2026-11-26", nights: 5,
    quoteBasis: "per_night", roomClass: "GuestRoom", roomName: "1 King Bed",
    pointsTotal: null, pointsPerNight: 4500,
    taxesFeesAmount: null, taxesFeesCurrency: null, taxesFeesState: "unknown",
    awardType: "points", cashComparisonAmount: 104, cashComparisonCurrency: "USD",
    availabilityState: "unknown", searchState: "complete", verificationLevel: "discovered",
    sourceFreshness: "2026-08-28T04:21:19Z", bookingUrl: null,
    fetchedAt: "2026-08-28T21:00:00.000Z",
    ...over,
  }
}

describe("roameHotelSessionHealth — same file as the provider, expiry only", () => {
  it("a live session 4 days out: present, 4 days remaining, not expired — and no secret or path in the result", () => {
    const expiresMs = NOW.getTime() + 4 * DAY_MS
    credsFile = pointAtCreds({ sessionExpiresAt: expiresMs })
    const h = roameHotelSessionHealth(CFG, NOW)
    expect(h).toEqual({ present: true, expiresAt: new Date(expiresMs).toISOString(), daysRemaining: 4, expired: false })
    const json = JSON.stringify(h)
    expect(json).not.toContain(SESSION_CANARY)
    expect(json).not.toContain(CSRF_CANARY)
    expect(json).not.toContain(credsFile)
    expect(json).not.toContain(tmpDir)
  })

  it("a past sessionExpiresAt is expired with a negative daysRemaining", () => {
    pointAtCreds({ sessionExpiresAt: NOW.getTime() - 3 * DAY_MS })
    const h = roameHotelSessionHealth(CFG, NOW)
    expect(h.present).toBe(true)
    expect(h.expired).toBe(true)
    expect(h.daysRemaining).toBe(-3)
  })

  it("expiry math floors partial days (3.9 days out reports 3)", () => {
    pointAtCreds({ sessionExpiresAt: NOW.getTime() + Math.round(3.9 * DAY_MS) })
    expect(roameHotelSessionHealth(CFG, NOW).daysRemaining).toBe(3)
  })

  it("an ISO-string sessionExpiresAt parses the same as epoch ms", () => {
    const iso = new Date(NOW.getTime() + 10 * DAY_MS).toISOString()
    pointAtCreds({ sessionExpiresAt: iso })
    const h = roameHotelSessionHealth(CFG, NOW)
    expect(h).toEqual({ present: true, expiresAt: iso, daysRemaining: 10, expired: false })
  })

  it("a file without sessionExpiresAt is present with unknown expiry — never expired", () => {
    pointAtCreds({})
    expect(roameHotelSessionHealth(CFG, NOW)).toEqual({ present: true, expiresAt: null, daysRemaining: null, expired: false })
  })

  it("an unparsable expiry value is present with unknown expiry", () => {
    pointAtCreds({ sessionExpiresAt: "not a date" })
    expect(roameHotelSessionHealth(CFG, NOW)).toEqual({ present: true, expiresAt: null, daysRemaining: null, expired: false })
  })

  it("a missing file is not present — structured, never a throw", () => {
    process.env.HOTEL_AWARDS_ROAME_CREDS = path.join(tmpDir, "does-not-exist.json")
    expect(roameHotelSessionHealth(CFG, NOW)).toEqual({ present: false, expiresAt: null, daysRemaining: null, expired: false })
  })

  it("an unparsable file is not present — structured, never a throw", () => {
    pointAtCreds("{ this is not json")
    expect(roameHotelSessionHealth(CFG, NOW)).toEqual({ present: false, expiresAt: null, daysRemaining: null, expired: false })
  })

  it("with no env override and no roame block there is no file to read — not present", () => {
    delete process.env.HOTEL_AWARDS_ROAME_CREDS
    const noRoame: HotelAwardsConfig = { gondola: CFG.gondola, budget: CFG.budget, programMap: CFG.programMap }
    expect(roameHotelSessionHealth(noRoame, NOW)).toEqual({ present: false, expiresAt: null, daysRemaining: null, expired: false })
  })

  it("honours the provider's precedence: the env override wins over cfg.roame.credentialsPath", () => {
    // cfg names a file that does not exist; env names the real temp file.
    const cfg: HotelAwardsConfig = { ...CFG, roame: { ...CFG.roame!, credentialsPath: path.join(tmpDir, "config-path-never-read.json") } }
    pointAtCreds({ sessionExpiresAt: NOW.getTime() + 2 * DAY_MS })
    expect(roameHotelSessionHealth(cfg, NOW).daysRemaining).toBe(2)
  })

  it("falls back to cfg.roame.credentialsPath when the env override is unset, expanding a leading ~", () => {
    delete process.env.HOTEL_AWARDS_ROAME_CREDS
    const home = fs.mkdtempSync(path.join(tmpDir, "home-"))
    fs.mkdirSync(path.join(home, ".creds"))
    fs.writeFileSync(path.join(home, ".creds", "roame.json"), JSON.stringify({ session: SESSION_CANARY, sessionExpiresAt: NOW.getTime() + 6 * DAY_MS }))
    const savedHome = process.env.HOME
    process.env.HOME = home
    try {
      const cfg: HotelAwardsConfig = { ...CFG, roame: { ...CFG.roame!, credentialsPath: "~/.creds/roame.json" } }
      const h = roameHotelSessionHealth(cfg, NOW)
      expect(h.present).toBe(true)
      expect(h.daysRemaining).toBe(6)
      expect(JSON.stringify(h)).not.toContain(SESSION_CANARY)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })
})

describe("hotelAwardsStatus — one read-only snapshot, zero writes", () => {
  let db: DB
  beforeEach(() => {
    db = createMemoryDb()
    // Deterministic regardless of the developer machine: no session on record
    // unless a test writes one.
    process.env.HOTEL_AWARDS_ROAME_CREDS = path.join(tmpDir, "does-not-exist.json")
  })
  afterEach(() => { db.close() })

  const rowCount = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n

  it("an empty DB with the real config: no observations, no usage row, the configured bbox locations, config limits", () => {
    const s = hotelAwardsStatus(db, CFG, NOW)
    expect(s.checkedAt).toBe(NOW.toISOString())
    expect(s.observations).toEqual({ total: 0, newest: null, oldest: null })
    expect(s.usage).toBeNull()                                    // no row → null, never a synthesized zero row
    expect(s.locations).toEqual(["bangkok"])                      // the "note" string is not a location
    expect(s.roameSession).toEqual({ present: false, expiresAt: null, daysRemaining: null, expired: false })
    expect(s.limits).toEqual({
      maxPagesPerWindow: CFG.roame!.search.maxPages,
      maxWindowsPerRun: CFG.roame!.discovery!.maxWindowsPerRun,
      politenessMs: CFG.budget.politenessMs,
    })
  })

  it("is a strict read: calling it creates no provider_usage row and no observation", () => {
    expect(rowCount("provider_usage")).toBe(0)
    hotelAwardsStatus(db, CFG, NOW)
    hotelAwardsStatus(db, CFG, NOW)
    expect(rowCount("provider_usage")).toBe(0)
    expect(rowCount("hotel_award_observations")).toBe(0)
    expect(rowCount("offer_locators")).toBe(0)
  })

  it("after one stored observation: total 1, newest and oldest are that row's fetchedAt", () => {
    const a = award()
    expect(insertHotelAwards(db, [a]).inserted).toBe(1)
    const s = hotelAwardsStatus(db, CFG, NOW)
    expect(s.observations.total).toBe(1)
    expect(s.observations.newest).toBe(a.fetchedAt)
    expect(s.observations.oldest).toBe(a.fetchedAt)
  })

  it("bounds are MAX/MIN of fetched_at as stored — nothing aggregated across programs", () => {
    insertHotelAwards(db, [
      award({ fetchedAt: "2026-08-28T21:00:00.000Z" }),
      award({ providerPropertyRef: "h2", program: "HILTON_HONORS", sourceProgramName: "HILTON", fetchedAt: "2026-09-01T08:00:00.000Z" }),
    ])
    const s = hotelAwardsStatus(db, CFG, NOW)
    expect(s.observations).toEqual({ total: 2, newest: "2026-09-01T08:00:00.000Z", oldest: "2026-08-28T21:00:00.000Z" })
    // The read-out carries no points figures at all — per-night can never be
    // multiplied into a total by a surface that never sees it.
    expect(JSON.stringify(s)).not.toMatch(/points/i)
  })

  it("reads this period's roame_hotels usage row as written, lastError bounded to 160 chars", () => {
    const period = currentPeriod(NOW)
    recordCallAttempt(db, "roame_hotels", period, 2)
    recordCallOutcome(db, "roame_hotels", { ok: true }, period)
    recordCallOutcome(db, "roame_hotels", { ok: false, error: "x".repeat(300) }, period)
    const s = hotelAwardsStatus(db, CFG, NOW)
    expect(s.usage).not.toBeNull()
    expect(s.usage!.attempted).toBe(2)
    expect(s.usage!.succeeded).toBe(1)
    expect(s.usage!.failed).toBe(1)
    expect(s.usage!.lastCallAt).toBeTypeOf("string")
    expect(s.usage!.lastSuccessAt).toBeTypeOf("string")
    expect(s.usage!.lastError).toBe("x".repeat(160))
  })

  it("a usage row for another provider or another period is not this provider's usage", () => {
    recordCallAttempt(db, "gondola_hotels", currentPeriod(NOW))
    recordCallAttempt(db, "roame_hotels", "2020-01")
    expect(hotelAwardsStatus(db, CFG, NOW).usage).toBeNull()
  })

  it("carries the session health without secrets or the credentials path", () => {
    const file = pointAtCreds({ sessionExpiresAt: NOW.getTime() + 4 * DAY_MS })
    const s = hotelAwardsStatus(db, CFG, NOW)
    expect(s.roameSession).toEqual({ present: true, expiresAt: new Date(NOW.getTime() + 4 * DAY_MS).toISOString(), daysRemaining: 4, expired: false })
    const json = JSON.stringify(s)
    expect(json).not.toContain(SESSION_CANARY)
    expect(json).not.toContain(CSRF_CANARY)
    expect(json).not.toContain(file)
    expect(json).not.toContain(CFG.roame!.credentialsPath)
  })

  it("degrades to explicit defaults when the roame block is absent", () => {
    const noRoame: HotelAwardsConfig = { gondola: CFG.gondola, budget: CFG.budget, programMap: CFG.programMap }
    const s = hotelAwardsStatus(db, noRoame, NOW)
    expect(s.locations).toEqual([])
    expect(s.limits).toEqual({ maxPagesPerWindow: 1, maxWindowsPerRun: null, politenessMs: CFG.budget.politenessMs })
    expect(s.roameSession.present).toBe(false)
  })

  it("a location whose value is a string placeholder is not searchable and is left out", () => {
    const cfg: HotelAwardsConfig = {
      ...CFG,
      roame: { ...CFG.roame!, locations: { bangkok: CFG.roame!.locations.bangkok, tokyo: "pending — no bbox yet", note: "x" } },
    }
    expect(hotelAwardsStatus(db, cfg, NOW).locations).toEqual(["bangkok"])
  })
})
