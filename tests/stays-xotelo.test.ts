import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { readUsage } from "../db/repositories.js"
import {
  getStayProvider,
  getStayProviders,
  runStayCalendarFetch,
  runStayRateSearch,
  setStayProviders,
} from "../providers/stays/index.js"
import { XoteloProvider, XOTELO_PROVIDER } from "../providers/stays/xotelo.js"
import type { StayRateQuery } from "../providers/stays/types.js"
import { MockStayProvider } from "./stay-mocks.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, "fixtures", "stays")

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8"))
}

/** A fetch stub that records URLs and serves a canned body. */
function stubFetch(body: unknown, opts: { status?: number; text?: string } = {}) {
  const calls: string[] = []
  const impl = (async (url: string | URL) => {
    calls.push(String(url))
    const text = opts.text ?? JSON.stringify(body)
    return new Response(text, { status: opts.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

const QUERY: StayRateQuery = {
  propertyId: "soneva-fushi",
  providerRef: "g3252668-d301967",
  checkIn: "2026-11-10",
  checkOut: "2026-11-15",
  adults: 2,
  children: 0,
  currency: "USD",
}

/** The ok fixture with a provider timestamp fresh enough not to trip staleness. */
function freshOkEnvelope(): Record<string, unknown> {
  const env = fixture("xotelo-rates-ok.json") as Record<string, unknown>
  return { ...env, timestamp: Math.floor(Date.now() / 1000) }
}

describe("xotelo provider", () => {
  let db: DB
  beforeEach(() => { db = createMemoryDb() })

  it("normalizes a good rates response: date-specific, per-OTA, nightly meta prices", async () => {
    const { impl, calls } = stubFetch(freshOkEnvelope())
    const provider = new XoteloProvider({ fetchImpl: impl, db })
    const result = await provider.searchRates(QUERY)

    expect(result.ok).toBe(true)
    expect(result.callsSpent).toBe(1)
    expect(result.rates).toHaveLength(3)
    // The request carried the stay dates — this provider is only in the
    // registry BECAUSE its prices are date-specific; the URL must prove it.
    expect(calls[0]).toContain("chk_in=2026-11-10")
    expect(calls[0]).toContain("chk_out=2026-11-15")
    expect(calls[0]).toContain("hotel_key=g3252668-d301967")

    const booking = result.rates.find(r => r.rateSource === "Booking.com")!
    expect(booking.price).toEqual({ amount: 2393, currency: "USD" })
    expect(booking.priceBasis).toBe("nightly_room")
    expect(booking.sourceClass).toBe("meta")
    expect(booking.nights).toBe(5)
    expect(booking.verificationLevel).toBe("discovered")
    expect(booking.confidence).toBe("medium")
    // Xotelo has no board data; the provider must NOT guess — the registry
    // default is applied later, at record time, where the property is known.
    expect(booking.board).toBe("unknown")
    expect(booking.roomName).toBeNull()

    // A row with a tax figure is "excluded"; without one it is "unknown".
    const expedia = result.rates.find(r => r.rateSource === "Expedia.com")!
    expect(expedia.taxesFees).toBe("excluded")
    expect(expedia.taxesFeesAmount).toBe(310)
    expect(booking.taxesFees).toBe("unknown")
  })

  it("omits the raw payload unless capture was requested", async () => {
    const provider = new XoteloProvider({ fetchImpl: stubFetch(freshOkEnvelope()).impl, db })
    const plain = await provider.searchRates(QUERY)
    expect(plain.raw).toBeUndefined()
    const captured = await provider.searchRates(QUERY, { captureRaw: true })
    expect(captured.raw).toBeDefined()
  })

  it("downgrades confidence when the provider's own data timestamp is stale", async () => {
    const env = fixture("xotelo-rates-ok.json") as Record<string, unknown>
    env.timestamp = Math.floor(Date.now() / 1000) - 5 * 24 * 3600      // five days old
    const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(true)
    expect(result.rates.every(r => r.confidence === "low")).toBe(true)
    expect(result.rates[0].providerAsOf).not.toBeNull()
  })

  it("trusts the RESPONSE currency over the requested one when they disagree", async () => {
    const env = freshOkEnvelope()
    ;(env.result as Record<string, unknown>).currency = "THB"
    const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(true)
    // Recording 2393 THB as 2393 USD would poison the baseline silently; the
    // truth about the numbers is whatever the response says they are.
    expect(result.rates.every(r => r.price.currency === "THB")).toBe(true)
  })

  it("rejects a response priced for different dates than requested", async () => {
    // The failure mode that disqualified keyless Google Hotels: a server that
    // silently prices its own default window. Xotelo echoes the dates it
    // priced; a mismatch must never enter the stay's history.
    const env = freshOkEnvelope()
    ;(env.result as Record<string, unknown>).chk_in = "2026-09-18"
    ;(env.result as Record<string, unknown>).chk_out = "2026-09-19"
    const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("date mismatch")
  })

  it("parses every LIVE-captured fixture without error (parser regression)", async () => {
    // The observe CLI's --capture writes real responses here; whatever shape
    // the live service produced must keep parsing forever. Skipped quietly on
    // a checkout that has no captures yet.
    const captured = path.join(FIXTURES, "captured")
    if (!fs.existsSync(captured)) return
    const rateFiles = fs.readdirSync(captured).filter(f => f.startsWith("xotelo-rates-") && f.endsWith(".json"))
    for (const file of rateFiles) {
      const env = JSON.parse(fs.readFileSync(path.join(captured, file), "utf-8")) as Record<string, unknown>
      const result = env.result as Record<string, unknown> | null
      const checkIn = typeof result?.chk_in === "string" ? result.chk_in : QUERY.checkIn
      const checkOut = typeof result?.chk_out === "string" ? result.chk_out : QUERY.checkOut
      const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
      const parsed = await provider.searchRates({ ...QUERY, checkIn, checkOut })
      // A capture may legitimately hold an empty or error response — the
      // parser's job is to classify it calmly, never to throw.
      if (parsed.ok) {
        expect(parsed.rates.length).toBeGreaterThan(0)
        expect(parsed.rates.every(r => r.price.amount > 0)).toBe(true)
        expect(parsed.rates.every(r => r.checkIn === checkIn)).toBe(true)
      } else {
        expect(parsed.reason).toBeDefined()
      }
    }
  })

  it("rejects a response for a different property outright", async () => {
    const env = freshOkEnvelope()
    ;(env.result as Record<string, unknown>).hotel_key = "g999-d888"
    const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toContain("identity mismatch")
  })

  it("drops unpriced/unnamed rate rows instead of inventing zeros", async () => {
    const env = freshOkEnvelope()
    ;(env.result as Record<string, unknown>).rates = [
      { code: "X", name: "Ghost OTA" },                       // no rate
      { code: "Y", rate: 100 },                               // no name
      { code: "Z", name: "Real OTA", rate: 1200, tax: null },
      { code: "N", name: "Negative", rate: -5, tax: null },   // nonsense
    ]
    const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(true)
    expect(result.rates).toHaveLength(1)
    expect(result.rates[0].rateSource).toBe("Real OTA")
  })

  it("returns no-results for an API-reported error, without throwing", async () => {
    const provider = new XoteloProvider({
      fetchImpl: stubFetch({ error: { code: "NOT_FOUND", message: "unknown hotel_key" }, result: null }).impl, db,
    })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("no-results")
    expect(result.error).toContain("NOT_FOUND")
  })

  it("returns no-results when the response prices nothing", async () => {
    const env = freshOkEnvelope()
    ;(env.result as Record<string, unknown>).rates = []
    const provider = new XoteloProvider({ fetchImpl: stubFetch(env).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("no-results")
  })

  it("survives malformed non-JSON responses", async () => {
    const provider = new XoteloProvider({
      fetchImpl: stubFetch(null, { text: "<html>503 varnish</html>" }).impl, db,
    })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toContain("not JSON")
  })

  it("survives a valid-JSON response with the wrong shape", async () => {
    const provider = new XoteloProvider({ fetchImpl: stubFetch({ unexpected: true }).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no result object")
  })

  it("survives an HTTP error status (outage)", async () => {
    const provider = new XoteloProvider({ fetchImpl: stubFetch(null, { status: 503, text: "down" }).impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toContain("503")
  })

  it("survives the network being gone entirely", async () => {
    const impl = (async () => { throw new Error("getaddrinfo ENOTFOUND data.xotelo.com") }) as typeof fetch
    const provider = new XoteloProvider({ fetchImpl: impl, db })
    const result = await provider.searchRates(QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
  })

  it("times out a hung request and says so", async () => {
    const impl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      })) as unknown as typeof fetch
    const provider = new XoteloProvider({ fetchImpl: impl, db })
    const result = await provider.searchRates(QUERY, { timeoutMs: 25 })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("timeout")
  })

  it("refuses bad inputs BEFORE spending a request", async () => {
    const { impl, calls } = stubFetch(freshOkEnvelope())
    const provider = new XoteloProvider({ fetchImpl: impl, db })

    const badRef = await provider.searchRates({ ...QUERY, providerRef: "soneva fushi!!" })
    expect(badRef.ok).toBe(false)
    expect(badRef.callsSpent).toBe(0)

    const badDates = await provider.searchRates({ ...QUERY, checkIn: "11/10/2026" })
    expect(badDates.ok).toBe(false)

    const inverted = await provider.searchRates({ ...QUERY, checkIn: "2026-11-15", checkOut: "2026-11-10" })
    expect(inverted.ok).toBe(false)

    expect(calls).toHaveLength(0)
    expect(readUsage(db, XOTELO_PROVIDER).attempted).toBe(0)
  })

  it("counts usage: attempt recorded before the fetch, outcome after", async () => {
    const okProvider = new XoteloProvider({ fetchImpl: stubFetch(freshOkEnvelope()).impl, db })
    await okProvider.searchRates(QUERY)
    let usage = readUsage(db, XOTELO_PROVIDER)
    expect(usage.attempted).toBe(1)
    expect(usage.succeeded).toBe(1)

    const downProvider = new XoteloProvider({ fetchImpl: stubFetch(null, { status: 500 }).impl, db })
    await downProvider.searchRates(QUERY)
    usage = readUsage(db, XOTELO_PROVIDER)
    expect(usage.attempted).toBe(2)
    expect(usage.failed).toBe(1)
  })

  it("parses a heatmap into classified days", async () => {
    const provider = new XoteloProvider({ fetchImpl: stubFetch(fixture("xotelo-heatmap-ok.json")).impl, db })
    const result = await provider.fetchCalendar({ propertyId: "soneva-fushi", providerRef: QUERY.providerRef, horizonDays: 90 })
    expect(result.ok).toBe(true)
    expect(result.days).toHaveLength(10)
    expect(result.days.filter(d => d.dayClass === "cheap")).toHaveLength(4)
    expect(result.days.filter(d => d.dayClass === "high")).toHaveLength(3)
    expect(result.days.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true)
  })

  it("fails a heatmap without a heatmap, without throwing", async () => {
    const provider = new XoteloProvider({ fetchImpl: stubFetch({ error: null, result: {} }).impl, db })
    const result = await provider.fetchCalendar({ propertyId: "soneva-fushi", providerRef: QUERY.providerRef, horizonDays: 90 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no heatmap")
  })

  it("health never fetches", async () => {
    const impl = (async () => { throw new Error("health must not fetch") }) as typeof fetch
    const provider = new XoteloProvider({ fetchImpl: impl, db })
    const health = await provider.health()
    expect(health.provider).toBe(XOTELO_PROVIDER)
    expect(["ok", "degraded"]).toContain(health.status)
  })
})

describe("stay provider registry", () => {
  afterEach(() => setStayProviders(null))

  it("registers xotelo by default", () => {
    setStayProviders(null)
    const providers = getStayProviders()
    expect(providers.map(p => p.name)).toContain(XOTELO_PROVIDER)
    expect(getStayProvider(XOTELO_PROVIDER)?.kind).toBe("free")
  })

  it("the test seam swaps the whole registry", () => {
    const mock = new MockStayProvider({ name: "fake" })
    setStayProviders([mock])
    expect(getStayProviders()).toHaveLength(1)
    expect(getStayProvider("fake")).toBe(mock)
    expect(getStayProvider(XOTELO_PROVIDER)).toBeUndefined()
  })

  it("the defensive wrapper turns a throwing provider into a failed result", async () => {
    const mock = new MockStayProvider({ throws: true })
    const result = await runStayRateSearch(mock, {
      propertyId: "x", providerRef: "g1-d1", checkIn: "2026-11-10", checkOut: "2026-11-12",
      adults: 2, children: 0, currency: "USD",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toContain("exploded")
  })

  it("the calendar wrapper handles providers without the capability", async () => {
    const mock = new MockStayProvider({ capabilities: { calendar: false } })
    const result = await runStayCalendarFetch(mock, { propertyId: "x", providerRef: "g1-d1", horizonDays: 90 })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("unconfigured")
  })
})
