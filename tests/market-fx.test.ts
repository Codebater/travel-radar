import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, nowIso, type DB } from "../db/index.js"
import {
  convertVia,
  convertWith,
  fetchAndStoreFxRate,
  getFxObservation,
  isFxRefusal,
  isFxStale,
  latestFxObservation,
} from "../market/fx.js"

function stubFetch(body: unknown, opts: { status?: number; text?: string } = {}) {
  const calls: { url: string }[] = []
  const impl = (async (url: string | URL) => {
    calls.push({ url: String(url) })
    return new Response(opts.text ?? JSON.stringify(body), { status: opts.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

/** Direct insert for read-side tests — provider_date controls staleness. */
function seedFx(db: DB, over: { rate?: number; providerDate?: string; base?: string; quote?: string } = {}): number {
  const result = db.prepare(`
    INSERT INTO fx_rate_observations (base_currency, quote_currency, rate, provider, provider_date, fetched_at)
    VALUES (?, ?, ?, 'frankfurter_ecb', ?, ?)
  `).run(over.base ?? "USD", over.quote ?? "EUR", over.rate ?? 0.85874,
    over.providerDate ?? new Date().toISOString().slice(0, 10), nowIso())
  return Number(result.lastInsertRowid)
}

let db: DB

beforeEach(() => {
  db = createMemoryDb()
})

describe("FX fetch + store", () => {
  const OK_BODY = { amount: 1.0, base: "USD", date: "2026-08-27", rates: { EUR: 0.85874 } }

  it("stores a fetched rate append-only with provider, reference date and our clock", async () => {
    const stub = stubFetch(OK_BODY)
    const result = await fetchAndStoreFxRate(db, "USD", "EUR", { fetchImpl: stub.impl })
    expect(result.ok).toBe(true)
    const obs = result.observation!
    expect(obs.rate).toBe(0.85874)
    expect(obs.provider).toBe("frankfurter_ecb")
    expect(obs.providerDate).toBe("2026-08-27")
    expect(latestFxObservation(db, "USD", "EUR")!.id).toBe(obs.id)
  })

  it("rejects a response about a different base — echo-check like every provider", async () => {
    const stub = stubFetch({ ...OK_BODY, base: "GBP" })
    const result = await fetchAndStoreFxRate(db, "USD", "EUR", { fetchImpl: stub.impl })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/base mismatch/)
    expect(latestFxObservation(db, "USD", "EUR")).toBeNull()
  })

  it("rejects malformed responses and HTTP errors without storing anything", async () => {
    for (const opts of [
      { text: "<html>" }, { status: 500 },
      { body: { base: "USD", date: "2026-08-27", rates: {} } },
      { body: { base: "USD", rates: { EUR: 0.85 } } },        // no reference date
    ] as { text?: string; status?: number; body?: unknown }[]) {
      const freshDb = createMemoryDb()
      const stub = stubFetch(opts.body ?? {}, opts)
      const result = await fetchAndStoreFxRate(freshDb, "USD", "EUR", { fetchImpl: stub.impl })
      expect(result.ok).toBe(false)
      expect(latestFxObservation(freshDb, "USD", "EUR")).toBeNull()
    }
  })

  it("provider unavailable is a failed result, never a throw (unroutable test host)", async () => {
    const result = await fetchAndStoreFxRate(db, "USD", "EUR", { timeoutMs: 2000 })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe("conversion — reproducible, refusing, never chaining", () => {
  it("same currency needs no FX: identity, no observation consumed", () => {
    const converted = convertVia(db, 4851, "EUR", "EUR")   // empty fx table on purpose
    expect(isFxRefusal(converted)).toBe(false)
    if (!isFxRefusal(converted)) {
      expect(converted.amount).toBe(4851)
      expect(converted.fxObservationId).toBe(0)
    }
  })

  it("converts through the newest stored observation and returns its id", () => {
    seedFx(db, { rate: 0.9 })
    const id2 = seedFx(db, { rate: 0.85874 })
    const converted = convertVia(db, 4851, "USD", "EUR")
    expect(isFxRefusal(converted)).toBe(false)
    if (!isFxRefusal(converted)) {
      expect(converted.fxObservationId).toBe(id2)
      expect(converted.amount).toBe(4165.75)              // 4851 × 0.85874, cents
    }
  })

  it("is historically reproducible: an old observation row yields its own number forever", () => {
    const oldId = seedFx(db, { rate: 0.9 })
    seedFx(db, { rate: 0.85874 })                         // newer rate arrives
    const oldObs = getFxObservation(db, oldId)!
    expect(convertWith(4851, oldObs)).toBe(4365.9)        // still the OLD arithmetic
    expect(convertWith(4851, oldObs)).toBe(convertWith(4851, oldObs))
  })

  it("refuses when no observation exists — a missing rate is never invented", () => {
    const converted = convertVia(db, 100, "USD", "EUR")
    expect(isFxRefusal(converted)).toBe(true)
    if (isFxRefusal(converted)) expect(converted.reason).toBe("no_observation")
  })

  it("refuses a stale observation by the rate's own reference date", () => {
    seedFx(db, { providerDate: "2026-08-01" })            // weeks old
    const converted = convertVia(db, 100, "USD", "EUR", new Date("2026-08-28T12:00:00Z"))
    expect(isFxRefusal(converted)).toBe(true)
    if (isFxRefusal(converted)) {
      expect(converted.reason).toBe("stale_observation")
      expect(converted.detail).toMatch(/no numeric winner/)
    }
  })

  it("refuses unconfigured pairs — no implicit chaining through a third currency", () => {
    seedFx(db, { base: "GBP", quote: "EUR" })
    const converted = convertVia(db, 100, "GBP", "EUR")
    expect(isFxRefusal(converted)).toBe(true)
    if (isFxRefusal(converted)) expect(converted.reason).toBe("missing_pair")
  })

  it("staleness is computed from provider_date, not fetch time", () => {
    const id = seedFx(db, { providerDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) })
    expect(isFxStale(getFxObservation(db, id)!)).toBe(false)
    const idOld = seedFx(db, { providerDate: "2026-01-01" })
    expect(isFxStale(getFxObservation(db, idOld)!, new Date("2026-08-28T00:00:00Z"))).toBe(true)
  })
})
