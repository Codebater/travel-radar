/**
 * Phase 8k currency defence for the free provider.
 *
 * The Python helper's currency field is an ECHO of the request, not evidence
 * from Google — so the provider must never (a) relabel a stated different
 * currency as the requested one, nor (b) invent the requested currency for a
 * price whose currency is unstated. A one-way EUR radar can therefore never
 * silently store a non-EUR quote as EUR.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeQuery } from "./mocks.js"

vi.mock("../providers/cash-flights/python-bridge.js", () => ({
  resolvePython: () => "python",
  runPythonJsonSync: vi.fn(() => ({ ok: true, data: { ok: true } })),
  runPythonJson: vi.fn(),
}))

import { runPythonJson } from "../providers/cash-flights/python-bridge.js"
import { FastFlightsProvider } from "../providers/cash-flights/fast-flights.js"

const mockedRun = vi.mocked(runPythonJson)

function itinerary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    price: 1140,
    currency: "EUR",
    airlines: ["Qatar Airways"],
    carrierCode: "QR",
    segments: [],
    stops: 1,
    durationMinutes: 780,
    departureTime: "2026-09-19T10:00",
    arrivalTime: "2026-09-20T06:00",
    ...over,
  }
}

function payload(flights: Record<string, unknown>[], currency: string | null = "EUR"): void {
  mockedRun.mockResolvedValue({ ok: true, data: { ok: true, flights, currency } })
}

let provider: FastFlightsProvider

beforeEach(() => {
  mockedRun.mockReset()
  provider = new FastFlightsProvider()
})

describe("fast_flights currency defence", () => {
  it("a price stated in the requested currency passes through with that currency", async () => {
    payload([itinerary()])
    const result = await provider.search(makeQuery({ currency: "EUR", returnDate: null }))
    expect(result.ok).toBe(true)
    expect(result.flights[0].price).toEqual({ amount: 1140, currency: "EUR" })
    expect(result.flights[0].returnDate).toBeNull()
  })

  it("a proven non-EUR quote is never relabelled EUR — it is dropped, and the refusal names the stated currency", async () => {
    payload([itinerary({ currency: "USD" })])
    const result = await provider.search(makeQuery({ currency: "EUR" }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toMatch(/USD/)
    expect(result.error).toMatch(/refusing to label/)
    expect(result.flights).toHaveLength(0)
  })

  it("an unstated currency is unknown, not invented — the search refuses rather than assuming the request", async () => {
    payload([itinerary({ currency: null })], null)
    const result = await provider.search(makeQuery({ currency: "EUR" }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toMatch(/unstated/)
  })

  it("a flight without its own currency may inherit the payload-level statement — still validated against the request", async () => {
    payload([itinerary({ currency: null })], "EUR")
    const ok = await provider.search(makeQuery({ currency: "EUR" }))
    expect(ok.ok).toBe(true)
    expect(ok.flights[0].price.currency).toBe("EUR")

    payload([itinerary({ currency: null })], "CHF")
    const bad = await provider.search(makeQuery({ currency: "EUR" }))
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/CHF/)
  })

  it("a mixed batch keeps only the itineraries proven to be in the requested currency", async () => {
    payload([itinerary(), itinerary({ price: 990, currency: "CHF" })])
    const result = await provider.search(makeQuery({ currency: "EUR" }))
    expect(result.ok).toBe(true)
    expect(result.flights).toHaveLength(1)
    expect(result.flights[0].price).toEqual({ amount: 1140, currency: "EUR" })
  })

  it("currency comparison is case/whitespace-insensitive, never value-insensitive", async () => {
    payload([itinerary({ currency: " eur " })])
    const result = await provider.search(makeQuery({ currency: "EUR" }))
    expect(result.ok).toBe(true)
    expect(result.flights[0].price.currency).toBe("EUR")
  })
})
