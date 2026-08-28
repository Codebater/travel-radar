import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  getPackageProviders,
  runPackageCalendarFetch,
  runPackageOfferSearch,
} from "../providers/packages/index.js"
import {
  parseTuiCalendarResponse,
  parseTuiOffersResponse,
  TuiPackagesProvider,
} from "../providers/packages/tui.js"
import { Check24PackagesProvider, parseCheck24OfferResponse } from "../providers/packages/check24.js"
import type {
  PackageCalendarQuery,
  PackageOffersQuery,
  PackageProvider,
} from "../providers/packages/types.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, "fixtures", "packages")

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8")) as Record<string, unknown>
}

function stubFetch(body: unknown, opts: { status?: number; text?: string; headers?: Record<string, string> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(opts.text ?? JSON.stringify(body), { status: opts.status ?? 200, headers: opts.headers })
  }) as typeof fetch
  return { impl, calls }
}

/** Sequential responses — one per call, last repeats. */
function stubFetchSeq(responses: { body?: unknown; status?: number; text?: string; headers?: Record<string, string> }[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]
    return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers })
  }) as typeof fetch
  return { impl, calls }
}

const CAL_QUERY: PackageCalendarQuery = {
  propertyId: "lily-beach-resort",
  providerRef: "16356",
  origin: "VIE",
  nights: 5,
  adults: 2,
  children: 0,
  board: "all_inclusive",
  rangeStart: "2026-10-01",
  rangeEnd: "2027-03-31",
  currency: "EUR",
}

const OFFERS_QUERY: PackageOffersQuery = {
  propertyId: "lily-beach-resort",
  providerRef: "16356",
  origin: "VIE",
  checkInFrom: "2026-11-15",
  checkInTo: "2026-11-30",
  nights: 5,
  adults: 2,
  children: 0,
  board: "all_inclusive",
  currency: "EUR",
}

const C24_QUERY: PackageOffersQuery = {
  propertyId: "lily-beach-resort",
  providerRef: "3541",
  origin: "VIE",
  checkInFrom: "2026-11-19",
  checkInTo: "2026-11-24",
  nights: 5,
  tripDeparture: "2026-11-19",
  tripReturn: "2026-11-24",
  adults: 2,
  children: 0,
  board: "all_inclusive",
  currency: "EUR",
}

let db: DB

beforeEach(() => {
  db = createMemoryDb()
})

describe("TUI calendar parsing", () => {
  it("normalizes a seasonal calendar into dated offers with the package total as the authoritative price", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), CAL_QUERY, "tui_packages")
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.offers).toHaveLength(4)

    const cheapest = parsed.offers.find(o => o.checkIn === "2026-11-08")!
    expect(cheapest.totalPrice).toEqual({ amount: 6392, currency: "EUR" })
    expect(cheapest.pricePerPerson).toBe(3196)
    expect(cheapest.nights).toBe(5)
    expect(cheapest.board).toBe("all_inclusive")
    expect(cheapest.cabin).toBe("economy")
    expect(cheapest.transfer).toBe("included")           // rooms[0].transferIncluded === true
    expect(cheapest.baggage).toBe("unknown")             // never inferred
    expect(cheapest.taxesFees).toBe("included")
    expect(cheapest.verificationLevel).toBe("discovered")
    expect(cheapest.tourOperator).toBe("LTUR")
    expect(cheapest.adults).toBe(2)
    expect(cheapest.unknownInclusions).toContain("baggage allowance not stated in offer")
  })

  it("keeps the seller-supplied flight split but NEVER derives a hotel price", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), CAL_QUERY, "tui_packages")
    if ("error" in parsed) throw new Error(parsed.error)
    const offer = parsed.offers[0]
    expect(offer.flightPricePerPerson).not.toBeNull()
    expect(offer.priceSplitSource).toBe("provider")
    expect(offer.hotelPricePerPerson).toBeNull()
  })

  it("rejects a response priced in a different currency", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), { ...CAL_QUERY, currency: "USD" }, "tui_packages")
    expect(parsed).toHaveProperty("error")
    expect((parsed as { error: string }).error).toMatch(/currency mismatch/)
  })

  it("rejects a response priced for a different party size", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), { ...CAL_QUERY, adults: 3 }, "tui_packages")
    expect((parsed as { error: string }).error).toMatch(/travellers mismatch/)
  })

  it("rejects offers whose nights differ from the requested duration", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), { ...CAL_QUERY, nights: 7 }, "tui_packages")
    expect((parsed as { error: string }).error).toMatch(/nights mismatch/)
  })

  it("rejects offers departing a different airport than asked", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), { ...CAL_QUERY, origin: "MUC" }, "tui_packages")
    expect((parsed as { error: string }).error).toMatch(/origin mismatch/)
  })

  it("rejects offers whose board differs from the requested board — AI never slips through as HB", () => {
    const parsed = parseTuiCalendarResponse(fixture("tui-calendar-ok.json"), { ...CAL_QUERY, board: "half_board" }, "tui_packages")
    expect((parsed as { error: string }).error).toMatch(/board mismatch/)
  })

  it("treats a malformed response as an error, not an empty observation", () => {
    expect(parseTuiCalendarResponse({}, CAL_QUERY, "tui_packages")).toHaveProperty("error")
    expect(parseTuiCalendarResponse({ offers: "nope" }, CAL_QUERY, "tui_packages")).toHaveProperty("error")
    // Offers present but no currency: unpriceable, refused.
    const noCcy = { ...fixture("tui-calendar-ok.json"), currency: "" }
    expect((parseTuiCalendarResponse(noCcy, CAL_QUERY, "tui_packages") as { error: string }).error).toMatch(/no currency/)
  })
})

describe("TUI offers parsing", () => {
  it("normalizes dated offers with hotel identity echo, room class and flight segments", () => {
    const parsed = parseTuiOffersResponse(fixture("tui-offers-ok.json"), OFFERS_QUERY, "tui_packages")
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.offers.length).toBe(3)

    const nov19 = parsed.offers.find(o => o.checkIn === "2026-11-19")!
    expect(nov19.verificationLevel).toBe("confirmed")
    expect(nov19.giataId).toBe(16356)
    expect(nov19.hotelName).toBe("Lily Beach Resort & Spa")
    expect(nov19.roomClass).toBe("suite")                // "Beach Suite with Jaccuzi"
    expect(nov19.totalPrice.amount).toBe(9498)
    expect(nov19.outboundSegments.length).toBeGreaterThan(0)
    expect(nov19.outboundSegments[0].from).toBe("VIE")
    expect(nov19.destinationAirport).toBe("MLE")

    const nov16 = parsed.offers.find(o => o.checkIn === "2026-11-16")!
    expect(nov16.roomClass).toBe("villa")                // "Beach Villa"
    expect(nov16.totalPrice.amount).toBe(6628)
  })

  it("rejects a response for a different hotel — numbers must not enter the wrong history", () => {
    const parsed = parseTuiOffersResponse(fixture("tui-offers-ok.json"), { ...OFFERS_QUERY, providerRef: "99999" }, "tui_packages")
    expect((parsed as { error: string }).error).toMatch(/identity mismatch/)
  })

  it("selects only offers inside the requested check-in window — the request asks a wider trip envelope on purpose", () => {
    const narrow = { ...OFFERS_QUERY, checkInFrom: "2026-11-19", checkInTo: "2026-11-19" }
    const parsed = parseTuiOffersResponse(fixture("tui-offers-ok.json"), narrow, "tui_packages")
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.offers).toHaveLength(1)
    expect(parsed.offers[0].checkIn).toBe("2026-11-19")
  })
})

describe("TUI provider transport", () => {
  it("treats HTTP 403 as blocked — a host rotation/health failure, never a scrape-something-else fallback", async () => {
    const stub = stubFetch({}, { status: 403 })
    const provider = new TuiPackagesProvider({ fetchImpl: stub.impl, db })
    const result = await provider.fetchCalendar(CAL_QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("blocked")
    expect(result.error).toMatch(/config\/packages\.json/)
  })

  it("treats an HTML answer as a provider error naming the rotation symptom", async () => {
    const stub = stubFetch(null, { text: "<html>moved</html>" })
    const provider = new TuiPackagesProvider({ fetchImpl: stub.impl, db })
    const result = await provider.fetchCalendar(CAL_QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("provider-error")
    expect(result.error).toMatch(/not JSON/)
    // The failure is on the health record, not swallowed.
    const events = db.prepare("SELECT * FROM provider_events WHERE provider = 'tui_packages'").all()
    expect(events.length).toBeGreaterThan(0)
  })

  it("refuses a malformed query before spending anything", async () => {
    const stub = stubFetch({})
    const provider = new TuiPackagesProvider({ fetchImpl: stub.impl, db })
    const result = await provider.fetchCalendar({ ...CAL_QUERY, providerRef: "g123-nope" })
    expect(result.ok).toBe(false)
    expect(result.callsSpent).toBe(0)
    expect(stub.calls.length).toBe(0)
  })
})

describe("CHECK24 offer parsing", () => {
  it("normalizes multi-operator offers: allocation TOTAL is authoritative, per-person separate", () => {
    const parsed = parseCheck24OfferResponse(fixture("check24-offer-success.json"), C24_QUERY, "check24_packages", "EUR")
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.offers.length).toBe(3)

    const cheapest = [...parsed.offers].sort((a, b) => a.totalPrice.amount - b.totalPrice.amount)[0]
    expect(cheapest.totalPrice).toEqual({ amount: 6193, currency: "EUR" })
    expect(cheapest.pricePerPerson).toBe(3096.5)          // half the total — never confused
    expect(cheapest.verificationLevel).toBe("verified")   // independent second seller
    expect(cheapest.board).toBe("all_inclusive")
    expect(cheapest.cabin).toBe("economy")                // "EconomyClass" segment label
  })

  it("derives hotel nights from EVIDENCE: outbound arrival date + overnightStays, not the trip envelope", () => {
    const parsed = parseCheck24OfferResponse(fixture("check24-offer-success.json"), C24_QUERY, "check24_packages", "EUR")
    if ("error" in parsed) throw new Error(parsed.error)
    const offer = parsed.offers[0]
    // Trip departs Nov 19, lands Nov 20 → 4 hotel nights inside a 6-day trip.
    expect(offer.checkIn).toBe("2026-11-20")
    expect(offer.nights).toBe(4)
    expect(offer.checkOut).toBe("2026-11-24")
    expect(offer.tripDays).toBe(6)
  })

  it("maps transfer by evidence: stated 'Transfer' → included, absent key → unknown — never inferred", () => {
    const parsed = parseCheck24OfferResponse(fixture("check24-offer-success.json"), C24_QUERY, "check24_packages", "EUR")
    if ("error" in parsed) throw new Error(parsed.error)
    const withTransfer = parsed.offers.find(o => o.tourOperator === "FERIEN Touristik")!
    const withoutKey = parsed.offers.find(o => o.tourOperator === "AurumTours")!
    expect(withTransfer.transfer).toBe("included")
    expect(withoutKey.transfer).toBe("unknown")
    expect(withoutKey.unknownInclusions).toContain("transfer inclusion not stated")
  })

  it("normalizes AllInclusivePlus to all_inclusive (amenity level, not a board basis)", () => {
    const parsed = parseCheck24OfferResponse(fixture("check24-offer-success.json"), C24_QUERY, "check24_packages", "EUR")
    if ("error" in parsed) throw new Error(parsed.error)
    const plus = parsed.offers.find(o => o.tourOperator === "FERIEN Touristik")!
    expect(plus.board).toBe("all_inclusive")
  })

  it("skips better-board offers instead of comparing them: half_board query keeps zero AI offers", () => {
    const parsed = parseCheck24OfferResponse(fixture("check24-offer-success.json"), { ...C24_QUERY, board: "half_board" }, "check24_packages", "EUR")
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.offers).toHaveLength(0)
  })

  it("rejects a response priced for a different party — the 1-adult/2-adult allocation trap", () => {
    const parsed = parseCheck24OfferResponse(fixture("check24-offer-success.json"), { ...C24_QUERY, adults: 1 }, "check24_packages", "EUR")
    expect((parsed as { error: string }).error).toMatch(/occupancy mismatch/)
  })

  it("rejects items priced for different trip dates", () => {
    const parsed = parseCheck24OfferResponse(
      fixture("check24-offer-success.json"),
      { ...C24_QUERY, tripDeparture: "2026-11-20", tripReturn: "2026-11-25" },
      "check24_packages", "EUR",
    )
    expect((parsed as { error: string }).error).toMatch(/date mismatch/)
  })
})

describe("CHECK24 provider flow", () => {
  const instantSleep = async () => {}

  it("polls Pending → Success as ONE logical search and builds the correct 2-adult allocation", async () => {
    const stub = stubFetchSeq([
      { body: { status: "Pending" } },
      { body: { status: "Pending" } },
      { body: fixture("check24-offer-success.json") },
    ])
    const provider = new Check24PackagesProvider({ fetchImpl: stub.impl, db, sleepImpl: instantSleep })
    const result = await provider.searchOffers(C24_QUERY)
    expect(result.ok).toBe(true)
    expect(result.callsSpent).toBe(1)                     // three POSTs, one spend
    expect(stub.calls.length).toBe(3)
    // The searchUrl is a form value, so its own query encoding survives one
    // decode — decode twice to read the inner search parameters.
    const form = decodeURIComponent(decodeURIComponent(String(stub.calls[0].init?.body)))
    expect(form).toMatch(/roomAllocation=A-A/)
    expect(form).toMatch(/days=exact/)
    expect(form).toMatch(/cateringList=allinclusive,allinclusivePlus/)
  })

  it("treats Empty as a valid zero-offer answer (no-results), immediately", async () => {
    const stub = stubFetchSeq([{ body: { status: "Empty" } }])
    const provider = new Check24PackagesProvider({ fetchImpl: stub.impl, db, sleepImpl: instantSleep })
    const result = await provider.searchOffers(C24_QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("no-results")
    expect(stub.calls.length).toBe(1)
  })

  it("stops on a bot-wall answer: 403 → blocked, HTML challenge → blocked, no retries", async () => {
    for (const opts of [{ status: 403 }, { text: "<!DOCTYPE html><html>challenge</html>" }]) {
      const freshDb = createMemoryDb()
      const stub = stubFetch({}, opts)
      const provider = new Check24PackagesProvider({ fetchImpl: stub.impl, db: freshDb, sleepImpl: instantSleep })
      const result = await provider.searchOffers(C24_QUERY)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe("blocked")
      expect(stub.calls.length).toBe(1)                   // the poll loop did NOT continue
      const events = freshDb.prepare("SELECT kind FROM provider_events WHERE provider = 'check24_packages'").all() as { kind: string }[]
      expect(events.some(e => e.kind === "auth")).toBe(true)
    }
  })

  it("also treats a challenge header as blocked even on HTTP 200", async () => {
    const stub = stubFetch({}, { headers: { "cf-mitigated": "challenge" } })
    const provider = new Check24PackagesProvider({ fetchImpl: stub.impl, db, sleepImpl: instantSleep })
    const result = await provider.searchOffers(C24_QUERY)
    expect(result.reason).toBe("blocked")
  })

  it("refuses to guess the trip envelope: missing tripDeparture/tripReturn fails before any network call", async () => {
    const stub = stubFetch({})
    const provider = new Check24PackagesProvider({ fetchImpl: stub.impl, db, sleepImpl: instantSleep })
    const rest: PackageOffersQuery = { ...C24_QUERY }
    delete rest.tripDeparture
    delete rest.tripReturn
    const result = await provider.searchOffers(rest)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/tripDeparture/)
    expect(stub.calls.length).toBe(0)
  })

  it("gives up after maxPolls without a terminal status", async () => {
    const stub = stubFetch({ status: "Pending" })
    const provider = new Check24PackagesProvider({ fetchImpl: stub.impl, db, sleepImpl: instantSleep })
    const result = await provider.searchOffers(C24_QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("timeout")
  })
})

describe("registry and wrappers", () => {
  it("registers both sellers in funnel order", () => {
    const providers = getPackageProviders()
    expect(providers.map(p => p.name)).toEqual(["tui_packages", "check24_packages"])
  })

  it("a provider that THROWS becomes a failed result, never a crashed run", async () => {
    const bomb: PackageProvider = {
      name: "bomb", kind: "free", confidence: "low",
      capabilities: { calendar: true, datedOffers: true, multiOperator: false, flightIdentity: false, priceSplit: false, taxesFees: "unknown" },
      isConfigured: () => true,
      health: async () => ({ provider: "bomb", status: "ok", detail: "", latencyMs: null, checkedAt: "", quota: null }),
      quota: () => null,
      fetchCalendar: async () => { throw new Error("boom") },
      searchOffers: async () => { throw new Error("boom") },
    }
    const cal = await runPackageCalendarFetch(bomb, CAL_QUERY)
    expect(cal.ok).toBe(false)
    expect(cal.reason).toBe("provider-error")
    const off = await runPackageOfferSearch(bomb, OFFERS_QUERY)
    expect(off.ok).toBe(false)
  })

  it("a missing capability is an unconfigured result — check24 has no calendar", async () => {
    const check24 = getPackageProviders().find(p => p.name === "check24_packages")!
    const result = await runPackageCalendarFetch(check24, CAL_QUERY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("unconfigured")
  })
})
