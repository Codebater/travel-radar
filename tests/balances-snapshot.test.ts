/**
 * balancesSnapshotPayload — the hotel-awards page's read-only view of the
 * LOCAL AwardWallet snapshot. The contract under test: no network, no TTL,
 * never the fallback list, one row per stored account (never summed), and a
 * health line in the provider's own words when nothing is stored.
 *
 * Also covers the hotel branches of mapProgramKey (hyatt / IHG), whose keys
 * must match transfer-partners.ts exactly. Synthetic data throughout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { createMemoryDb, type DB } from "../db/index.js"
import { saveBalanceSnapshot, type BalanceRow } from "../db/repositories.js"
import { syntheticBalances } from "./mocks.js"

let db: DB
let home: string
const savedEnv = { ...process.env }

/**
 * Loads the balances provider against a throwaway home directory, so the
 * developer's real AwardWallet credentials are never touched and the module
 * constant that points at them is recomputed per test (same pattern as
 * tests/balances-hidden-city.test.ts).
 */
async function loadWithHome(credentials?: object) {
  if (credentials) {
    const dir = path.join(home, ".openclaw", "credentials")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "awardwallet.json"), JSON.stringify(credentials))
  }
  process.env.USERPROFILE = home
  process.env.HOME = home
  vi.resetModules()
  return import("../providers/balances/index.js")
}

beforeEach(() => {
  db = createMemoryDb()
  home = fs.mkdtempSync(path.join(os.tmpdir(), "radar-home-"))
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
  process.env = { ...savedEnv }
  vi.restoreAllMocks()
})

// Three values/names from FALLBACK_BALANCES in providers/balances/index.ts.
// None may ever surface in this payload — they are somebody else's numbers.
const FALLBACK_TELLS = ["1392260", "1315295", "Marriott Bonvoy", "Bilt Rewards"]

const DISCLAIMER =
  "Local AwardWallet snapshot only — no network call, never demo/fallback numbers. " +
  "One row per account; accounts of one program are listed, never summed; nothing is summed across programs."

describe("balancesSnapshotPayload with a stored snapshot", () => {
  it("serves the local snapshot as one displayable row per account", async () => {
    const { balancesSnapshotPayload } = await loadWithHome({ apiKey: "synthetic", userId: "1" })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const fetchedAt = saveBalanceSnapshot(db, syntheticBalances(), "awardwallet")

    const payload = balancesSnapshotPayload(db)

    expect(payload.state).toBe("snapshot")
    expect(payload.source).toBe("awardwallet-cached")
    expect(payload.disclaimer).toBe(DISCLAIMER)
    expect(payload.fetchedAt).toBe(fetchedAt)
    expect(typeof payload.ageMinutes).toBe("number")
    expect(payload.ageMinutes).toBeLessThan(2)
    expect(payload.accounts).toHaveLength(syntheticBalances().length)
    for (const a of payload.accounts) expect(typeof a.displayBalance).toBe("string")
    // en-US grouping, stored (balance DESC) order, no re-parsing of the display string.
    expect(payload.accounts.map(a => a.displayBalance)).toEqual(["100,000", "50,000", "20,000"])
    expect(payload.accounts.map(a => a.programKey)).toEqual(["chase-ur", "AEROPLAN", "FLYING_BLUE"])
    expect(payload.health).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("lists two accounts of the SAME program as two rows — never summed", async () => {
    const { balancesSnapshotPayload } = await loadWithHome()
    const twoCards: BalanceRow[] = [
      { program: "Chase UR (synthetic, card A)", programKey: "chase-ur", balance: 60000 },
      { program: "Chase UR (synthetic, card B)", programKey: "chase-ur", balance: 40000 },
    ]
    saveBalanceSnapshot(db, twoCards, "awardwallet")

    const payload = balancesSnapshotPayload(db)

    expect(payload.state).toBe("snapshot")
    expect(payload.accounts).toHaveLength(2)
    expect(payload.accounts.map(a => a.balance)).toEqual([60000, 40000])
    expect(payload.accounts.map(a => a.displayBalance)).toEqual(["60,000", "40,000"])
    // The per-program total (100,000) must appear nowhere in the payload.
    expect(JSON.stringify(payload)).not.toContain("100000")
    expect(JSON.stringify(payload)).not.toContain("100,000")
  })

  it("serves an OLD snapshot with its age rather than hiding it behind a TTL", async () => {
    process.env.LOYALTY_BALANCE_TTL_HOURS = "0"
    const { balancesSnapshotPayload } = await loadWithHome({ apiKey: "synthetic", userId: "1" })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    saveBalanceSnapshot(db, syntheticBalances(), "awardwallet")
    db.prepare("UPDATE balance_snapshots SET fetched_at = ?").run("2020-01-01T00:00:00.000Z")

    const payload = balancesSnapshotPayload(db)

    expect(payload.state).toBe("snapshot")
    expect(payload.fetchedAt).toBe("2020-01-01T00:00:00.000Z")
    expect(payload.ageMinutes).toBeGreaterThan(60 * 24 * 365)
    expect(payload.accounts).toHaveLength(syntheticBalances().length)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("balancesSnapshotPayload with nothing stored", () => {
  it("reports state 'none' with the provider's health line — never the fallback list", async () => {
    const { balancesSnapshotPayload } = await loadWithHome()
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    const payload = balancesSnapshotPayload(db)

    expect(payload.state).toBe("none")
    expect(payload.accounts).toEqual([])
    expect(payload.disclaimer).toBe(DISCLAIMER)
    expect(payload.source).toBeUndefined()
    expect(payload.fetchedAt).toBeUndefined()
    expect(payload.ageMinutes).toBeUndefined()
    expect(payload.health?.provider).toBe("awardwallet")
    expect(payload.health?.status).toBe("unconfigured")
    expect(payload.health?.detail).toMatch(/no credentials/)
    const json = JSON.stringify(payload)
    for (const tell of FALLBACK_TELLS) expect(json).not.toContain(tell)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not fetch even when credentials ARE configured — provider calls only on explicit action", async () => {
    const { balancesSnapshotPayload } = await loadWithHome({ apiKey: "synthetic", userId: "1" })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not be called"))

    const payload = balancesSnapshotPayload(db)

    expect(payload.state).toBe("none")
    expect(payload.accounts).toEqual([])
    expect(payload.health?.provider).toBe("awardwallet")
    expect(payload.health?.detail).toMatch(/no snapshot yet/)
    const json = JSON.stringify(payload)
    for (const tell of FALLBACK_TELLS) expect(json).not.toContain(tell)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("balancesSnapshotPayload source honesty", () => {
  it("the function body neither calls getBalances( nor touches FALLBACK", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "providers", "balances", "index.ts"), "utf-8")
    const start = src.indexOf("export function balancesSnapshotPayload")
    expect(start).toBeGreaterThan(-1)
    const next = src.indexOf("export ", start + 1)
    const body = src.slice(start, next === -1 ? undefined : next)
    expect(body).not.toContain("getBalances(")
    expect(body).not.toContain("FALLBACK")
    // And it reads the snapshot with NO max-age argument.
    expect(body).toContain("latestBalanceSnapshot(db)")
    expect(body).not.toContain("maxAgeHours")
  })
})

describe("mapProgramKey hotel branches match transfer-partners.ts keys", () => {
  it("maps World of Hyatt and IHG One Rewards to the transfer-graph keys", async () => {
    const { mapProgramKey } = await loadWithHome()
    expect(mapProgramKey("Hyatt (World of Hyatt)")).toBe("hyatt")
    expect(mapProgramKey("IHG Hotels & Resorts (One Rewards)")).toBe("IHG")
  })

  it("leaves the existing mappings unchanged", async () => {
    const { mapProgramKey } = await loadWithHome()
    expect(mapProgramKey("Marriott Bonvoy")).toBe("marriott")
    expect(mapProgramKey("Hilton (Honors)")).toBe("hilton")
    expect(mapProgramKey("Chase (Ultimate Rewards)")).toBe("chase-ur")
  })

  it("uses the same hotel keys the transfer graph uses", async () => {
    const { TRANSFER_PARTNERS } = await import("../transfer-partners.js")
    const keys = new Set(TRANSFER_PARTNERS.map(p => p.to))
    expect(keys.has("hyatt")).toBe(true)
    expect(keys.has("IHG")).toBe(true)
  })
})
