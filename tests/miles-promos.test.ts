/**
 * Miles Promo Feed — enrichment metadata only, parsed from a CAPTURED fixture
 * of AwardWallet's public promotions page (2026-08-28). No live web in tests.
 *
 * Under test: bonus/discount/up-to parsing, explicit program mapping (never
 * fuzzy), expiry semantics, hotel exclusion, never-invented effective cost,
 * anomaly states on format drift, never-throw blocked/transport handling, and
 * the TTL cache that makes a bot-wall unretryable.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getMilesPromoFeed,
  loadMilesPromosConfig,
  parsePromoPage,
  resetMilesPromoCache,
  type MilesPromo,
} from "../providers/promos/awardwallet-blog.js"

const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "promos", "awardwallet-current-promos.html"),
  "utf-8",
)
const CFG = loadMilesPromosConfig(true)
const NOW = new Date("2026-08-28T18:00:00Z")
const OPTS = { now: NOW, fetchedAt: NOW.toISOString() }

function byName(promos: MilesPromo[], fragment: string): MilesPromo {
  const hit = promos.find(p => p.sourceProgramName.includes(fragment))
  if (!hit) throw new Error(`no promo row matching "${fragment}"`)
  return hit
}

describe("parsing the captured airline table", () => {
  const { promos, anomaly } = parsePromoPage(FIXTURE, CFG, OPTS)

  it("parses the airline rows without an anomaly", () => {
    expect(anomaly).toBeNull()
    expect(promos.length).toBeGreaterThanOrEqual(8)
  })

  it("a flat bonus parses with upTo false and a known end date", () => {
    const lufthansa = byName(promos, "Miles and More")
    expect(lufthansa.bonusPercent).toBe(50)
    expect(lufthansa.discountPercent).toBeNull()
    expect(lufthansa.upTo).toBe(false)
  })

  it("a discount parses as discountPercent, never as bonus", () => {
    const southwest = byName(promos, "Rapid Rewards")
    expect(southwest.discountPercent).toBe(45)
    expect(southwest.bonusPercent).toBeNull()
    expect(southwest.validUntil).toBe("2026-08-31")
    expect(southwest.endDateKnown).toBe(true)
  })

  it('"up to" is a tiered maximum and is flagged as such', () => {
    const flyingBlue = byName(promos, "Flying Blue")
    expect(flyingBlue.bonusPercent).toBe(80)
    expect(flyingBlue.upTo).toBe(true)
    expect(flyingBlue.validUntil).toBe("2026-09-16")
  })

  it("a missing end date stays active but says so explicitly", () => {
    const virgin = byName(promos, "Flying Club")
    expect(virgin.validUntil).toBeNull()
    expect(virgin.endDateKnown).toBe(false)
    expect(virgin.active).toBe(true)
  })

  it("programs map ONLY through the explicit config map", () => {
    expect(byName(promos, "Flying Blue").loyaltyProgram).toBe("FLYING_BLUE")
    expect(byName(promos, "Flying Club").loyaltyProgram).toBe("VIRGIN_ATLANTIC")
    expect(byName(promos, "TrueBlue").loyaltyProgram).toBe("JETBLUE")
    expect(byName(promos, "AAdvantage").loyaltyProgram).toBe("AMERICAN")
  })

  it("an unmapped source program is preserved but enriches nothing", () => {
    const copa = byName(promos, "ConnectMiles")
    expect(copa.loyaltyProgram).toBeNull()
    expect(copa.discountPercent).toBe(45)
  })

  it("hotel rows never leak into the airline feed", () => {
    for (const p of promos) {
      expect(p.sourceProgramName).not.toMatch(/Bonvoy|Honors|IHG|One Rewards/)
    }
  })

  it("effective cost is never invented — the current page states no airline rate, so every row is null", () => {
    for (const p of promos) {
      expect(p.effectiveCostPerMile).toBeNull()
      expect(p.currency).toBeNull()
    }
  })

  it("effective cost is echoed when (and only when) the source states one for that program", () => {
    // Simulate the page's highlight table carrying an airline rate.
    const withRate = FIXTURE.replace(
      "</table>",
      "<tr><td>KLM (Flying Blue)</td><td>80% bonus</td><td>1.69¢</td><td>September 16, 2026</td><td>Buy now</td></tr></table>",
    )
    const parsed = parsePromoPage(withRate, CFG, OPTS)
    const flyingBlue = byName(parsed.promos, "Flying Blue")
    expect(flyingBlue.effectiveCostPerMile).toBe(1.69)
    expect(flyingBlue.currency).toBe("USD")
    expect(byName(parsed.promos, "TrueBlue").effectiveCostPerMile).toBeNull()
  })

  it("an expired dated promotion is inactive; undated rows survive the same clock", () => {
    const later = parsePromoPage(FIXTURE, CFG, { now: new Date("2026-09-20T09:00:00Z"), fetchedAt: "2026-09-20T09:00:00Z" })
    expect(byName(later.promos, "Rapid Rewards").active).toBe(false)   // ended 8/31
    expect(byName(later.promos, "Flying Blue").active).toBe(false)     // ended 9/16
    expect(byName(later.promos, "TrueBlue").active).toBe(true)         // ends 10/1
    expect(byName(later.promos, "Flying Club").active).toBe(true)      // no end date stated
  })
})

describe("format drift — anomalies, never guesses", () => {
  it("a page without the airline heading is a format-change anomaly", () => {
    const { promos, anomaly } = parsePromoPage("<html><body><h2>Something else</h2></body></html>", CFG, OPTS)
    expect(promos).toHaveLength(0)
    expect(anomaly).toMatch(/format changed/)
  })

  it("a present heading with zero parseable rows is a format-change anomaly, not 'no promos'", () => {
    const html = `<html><body><h2>Buy Miles Promotions From Airlines</h2><div class="different-markup"></div><h2>Next</h2></body></html>`
    const { promos, anomaly } = parsePromoPage(html, CFG, OPTS)
    expect(promos).toHaveLength(0)
    expect(anomaly).toMatch(/zero promo rows/)
  })
})

describe("fetch behavior — never throws, blocked is cached, refresh is explicit", () => {
  beforeEach(() => resetMilesPromoCache())
  afterEach(() => { vi.unstubAllGlobals() })

  function stubFetch(status: number, body = "<html></html>"): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => new Response(body, { status }))
    vi.stubGlobal("fetch", fn)
    return fn
  }

  it("a 403 bot-wall returns a structured blocked state and is NOT retried within the TTL", async () => {
    const fn = stubFetch(403)
    const first = await getMilesPromoFeed({ now: NOW })
    expect(first.ok).toBe(false)
    expect(first.reason).toBe("blocked")
    expect(first.promos).toHaveLength(0)
    const second = await getMilesPromoFeed({ now: new Date(NOW.getTime() + 60_000) })
    expect(second.fromCache).toBe(true)
    expect(second.reason).toBe("blocked")
    expect(fn).toHaveBeenCalledTimes(1)          // the wall was asked exactly once
  })

  it("a transport failure is a structured state, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET") }))
    const feed = await getMilesPromoFeed({ now: NOW })
    expect(feed.ok).toBe(false)
    expect(feed.reason).toBe("transport-error")
    expect(feed.detail).toContain("ECONNRESET")
  })

  it("a good page is parsed, cached for the TTL, and refetched only on forceRefresh", async () => {
    const fn = stubFetch(200, FIXTURE)
    const first = await getMilesPromoFeed({ now: NOW })
    expect(first.ok).toBe(true)
    expect(first.promos.length).toBeGreaterThanOrEqual(8)
    expect(first.fromCache).toBe(false)

    const cached = await getMilesPromoFeed({ now: new Date(NOW.getTime() + 3600_000) })
    expect(cached.fromCache).toBe(true)
    expect(cached.ageMinutes).toBe(60)
    expect(fn).toHaveBeenCalledTimes(1)

    const refreshed = await getMilesPromoFeed({ forceRefresh: true, now: new Date(NOW.getTime() + 3600_000) })
    expect(refreshed.fromCache).toBe(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("a drifted live page yields the format-changed state with zero promos", async () => {
    stubFetch(200, "<html><body>redesigned page</body></html>")
    const feed = await getMilesPromoFeed({ now: NOW })
    expect(feed.ok).toBe(false)
    expect(feed.reason).toBe("format-changed")
    expect(feed.promos).toHaveLength(0)
  })
})
