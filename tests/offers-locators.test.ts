import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import {
  buildFlightLocator,
  buildPackageLocator,
  buildStayLocator,
  getLocator,
  locatorForSource,
  upsertLocator,
  type FlightPriceRow,
  type StayRateRow,
} from "../offers/locators.js"
import { resolveProviderPath, safeProviderUrl, slugSegment } from "../offers/urls.js"
import { getPackageObservation, recordPackageObservations } from "../packages/store.js"
import { makeOffer } from "./package-mocks.js"
import { seedProperty } from "./market-mocks.js"

const C24_DETAILS_PATH = "/hib/3541/hotel?date=2026-11-21&touroperator=TUR1&offerListParams%5Bairport%5D=VIE"

let db: DB

beforeEach(() => {
  db = createMemoryDb()
  seedProperty(db)
})

function flightRow(over: Partial<FlightPriceRow> = {}): FlightPriceRow {
  return {
    id: 9, provider: "fast_flights", airline: "Qatar Airways", flight_numbers: null,
    origin: "VIE", destination: "MLE", departure_date: "2026-11-20", return_date: "2026-11-26",
    cabin: "economy", adults: 1, price_amount: 723, price_currency: "USD",
    booking_url: "https://www.google.com/travel/flights?q=Flights%20VIE%20to%20MLE%20on%202026-11-20%20returning%202026-11-26",
    fetched_at: "2026-08-28T10:00:00.000Z",
    ...over,
  }
}

function stayRow(over: Partial<StayRateRow> = {}): StayRateRow {
  return {
    id: 481, provider: "xotelo", provider_property_ref: "g6855020-d316979",
    property_id: "lily-beach-resort", rate_source: "Agoda.com", room_name: null, room_class: null,
    board: "all_inclusive", check_in: "2026-11-19", check_out: "2026-11-24", nights: 5, adults: 2,
    price_amount: 818, price_currency: "EUR", fetched_at: "2026-08-28T10:00:00.000Z",
    ...over,
  }
}

describe("URL safety", () => {
  it("accepts only https URLs on the provider's exact allowlisted host", () => {
    expect(safeProviderUrl("check24_packages", "https://urlaub.check24.de/suche/hotel?hotelId=3541")).toBeTruthy()
    expect(safeProviderUrl("check24_packages", "http://urlaub.check24.de/suche/hotel")).toBeNull()
    expect(safeProviderUrl("check24_packages", "https://evil.example/suche/hotel")).toBeNull()
    expect(safeProviderUrl("check24_packages", "https://urlaub.check24.de.evil.example/x")).toBeNull()
    expect(safeProviderUrl("check24_packages", "https://user:pw@urlaub.check24.de/x")).toBeNull()
    expect(safeProviderUrl("check24_packages", "javascript:alert(1)")).toBeNull()
  })

  it("resolves provider-relative paths against the provider origin and asserts the host SURVIVED", () => {
    expect(resolveProviderPath("check24_packages", "https://urlaub.check24.de", C24_DETAILS_PATH))
      .toBe(`https://urlaub.check24.de${C24_DETAILS_PATH}`)
    // Host-smuggling shapes all die:
    expect(resolveProviderPath("check24_packages", "https://urlaub.check24.de", "//evil.example/x")).toBeNull()
    expect(resolveProviderPath("check24_packages", "https://urlaub.check24.de", "https://evil.example/x")).toBeNull()
    expect(resolveProviderPath("check24_packages", "https://urlaub.check24.de", "javascript:alert(1)")).toBeNull()
  })

  it("slugs free text so a hotel name can never become URL-active", () => {
    expect(slugSegment("Lily Beach Resort & Spa", "hotel")).toBe("Lily-Beach-Resort-Spa")
    expect(slugSegment("evil/../..@evil.example?x=", "hotel")).toBe("evil-evil-example-x")
    expect(slugSegment(null, "hotel")).toBe("hotel")
  })
})

describe("package locators", () => {
  it("TUI is honest: SEARCH_REPLAY_LINK with the offer's own dates/travellers/board — never EXACT", () => {
    const [id] = recordPackageObservations(db, [makeOffer()], null)
    const locator = buildPackageLocator(getPackageObservation(db, id)!)
    expect(locator.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    expect(locator.deepLinkUrl).toBeNull()
    const url = new URL(locator.searchReplayUrl!)
    expect(url.hostname).toBe("www.tui.com")
    expect(url.pathname).toContain("/16356/offer/")
    expect(url.searchParams.get("startDate")).toBe("2026-11-19")
    expect(url.searchParams.get("duration")).toBe("5")
    expect(url.searchParams.get("travellers")).toBe("2")
    expect(url.searchParams.get("departureAirports")).toBe("VIE")
    expect(url.searchParams.get("boardTypes")).toBe("GT06-AI")
    expect(url.searchParams.get("operators")).toBe("LTUR")
  })

  it("CHECK24 with a provider-returned detailsUrl is EXACT_DEEP_LINK, preserved verbatim through storage", () => {
    const [id] = recordPackageObservations(db, [makeOffer({
      provider: "check24_packages",
      providerUrls: { detailsPath: C24_DETAILS_PATH },
      providerIds: { itemId: "8378752431358365324", hotelId: "3541" },
    })], null)
    const obs = getPackageObservation(db, id)!
    expect(obs.providerUrls.detailsPath).toBe(C24_DETAILS_PATH)   // storage round-trip intact
    const built = buildPackageLocator(obs)
    expect(built.navigationQuality).toBe("EXACT_DEEP_LINK")
    expect(built.deepLinkUrl).toBe(`https://urlaub.check24.de${C24_DETAILS_PATH}`)

    const locatorId = upsertLocator(db, built)
    const stored = getLocator(db, locatorId)!
    expect(stored.deepLinkUrl).toBe(built.deepLinkUrl)            // retrieval intact
    expect(stored.providerIds.itemId).toBe("8378752431358365324")
  })

  it("CHECK24 without a detailsUrl degrades honestly to SEARCH_REPLAY with correct dates and allocation", () => {
    const [id] = recordPackageObservations(db, [makeOffer({ provider: "check24_packages" })], null)
    const built = buildPackageLocator(getPackageObservation(db, id)!)
    expect(built.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    expect(built.deepLinkUrl).toBeNull()
    const url = new URL(built.searchReplayUrl!)
    expect(url.hostname).toBe("urlaub.check24.de")
    expect(url.searchParams.get("departureDate")).toBe("2026-11-18")   // trip envelope, not check-in
    expect(url.searchParams.get("returnDate")).toBe("2026-11-24")
    expect(url.searchParams.get("roomAllocation")).toBe("A-A")
    expect(url.searchParams.get("days")).toBe("exact")
  })

  it("a MALICIOUS provider-returned path never becomes an exact link — the locator degrades", () => {
    for (const evil of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)"]) {
      const [id] = recordPackageObservations(db, [makeOffer({
        provider: "check24_packages", providerUrls: { detailsPath: evil },
      })], null)
      const built = buildPackageLocator(getPackageObservation(db, id)!)
      expect(built.navigationQuality).toBe("SEARCH_REPLAY_LINK")   // degraded, not repaired
      expect(built.deepLinkUrl).toBeNull()
    }
  })

  it("different sellers of the same product keep SEPARATE locators and separate links", () => {
    const [tuiId] = recordPackageObservations(db, [makeOffer()], null)
    const [c24Id] = recordPackageObservations(db, [makeOffer({
      provider: "check24_packages", tourOperator: "L'TUR",
      providerUrls: { detailsPath: C24_DETAILS_PATH },
    })], null)
    const a = upsertLocator(db, buildPackageLocator(getPackageObservation(db, tuiId)!))
    const b = upsertLocator(db, buildPackageLocator(getPackageObservation(db, c24Id)!))
    expect(a).not.toBe(b)
    const la = getLocator(db, a)!, lb = getLocator(db, b)!
    expect(new URL((la.deepLinkUrl ?? la.searchReplayUrl)!).hostname).toBe("www.tui.com")
    expect(new URL((lb.deepLinkUrl ?? lb.searchReplayUrl)!).hostname).toBe("urlaub.check24.de")
  })

  it("a hotel name full of URL-active characters cannot redirect the TUI replay off-host", () => {
    const [id] = recordPackageObservations(db, [makeOffer({
      hotelName: "https://evil.example/?q=", // hostile display name
    })], null)
    const built = buildPackageLocator(getPackageObservation(db, id)!)
    expect(new URL(built.searchReplayUrl!).hostname).toBe("www.tui.com")
  })
})

describe("flight and stay locators — kinds never mix", () => {
  it("preserves the stored Google Flights URL verbatim as SEARCH_REPLAY — flights are never EXACT", () => {
    const built = buildFlightLocator(flightRow())
    expect(built.kind).toBe("flight")
    expect(built.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    expect(built.deepLinkUrl).toBeNull()
    expect(built.searchReplayUrl).toBe(flightRow().booking_url)   // verbatim
  })

  it("a stored flight URL on a foreign host is dropped and a clean replay is constructed instead", () => {
    const built = buildFlightLocator(flightRow({ booking_url: "https://evil.example/flights" }))
    const url = new URL(built.searchReplayUrl!)
    expect(url.hostname).toBe("www.google.com")
    expect(url.searchParams.get("q")).toContain("VIE to MLE on 2026-11-20")
  })

  it("xotelo stays land on the TripAdvisor hotel page as PROVIDER_LANDING_LINK — never a booking link", () => {
    const built = buildStayLocator(stayRow(), "Lily Beach Resort & Spa")
    expect(built.kind).toBe("stay")
    expect(built.navigationQuality).toBe("PROVIDER_LANDING_LINK")
    expect(built.landingUrl).toBe("https://www.tripadvisor.com/Hotel_Review-g6855020-d316979")
    expect(built.deepLinkUrl).toBeNull()
    expect(built.searchReplayUrl).toBeNull()
  })

  it("agoda stays get a dated SEARCH_REPLAY with the correct occupancy", () => {
    const built = buildStayLocator(stayRow({ provider: "agoda", provider_property_ref: "41483:17759:34" }), "Lily Beach")
    expect(built.navigationQuality).toBe("SEARCH_REPLAY_LINK")
    const url = new URL(built.searchReplayUrl!)
    expect(url.hostname).toBe("www.agoda.com")
    expect(url.searchParams.get("selectedproperty")).toBe("41483")
    expect(url.searchParams.get("checkIn")).toBe("2026-11-19")
    expect(url.searchParams.get("los")).toBe("5")
    expect(url.searchParams.get("adults")).toBe("2")
  })

  it("an unrecognizable ref is UNAVAILABLE — no URL is invented", () => {
    const built = buildStayLocator(stayRow({ provider: "mystery", provider_property_ref: "???" }), "X")
    expect(built.navigationQuality).toBe("UNAVAILABLE")
    expect(built.landingUrl).toBeNull()
    expect(built.searchReplayUrl).toBeNull()
  })

  it("package/flight/stay locators for the same trip stay distinct by (source_table, source_id)", () => {
    const [pkgId] = recordPackageObservations(db, [makeOffer()], null)
    upsertLocator(db, buildPackageLocator(getPackageObservation(db, pkgId)!))
    upsertLocator(db, buildFlightLocator(flightRow({ id: pkgId })))       // same numeric id, different table
    upsertLocator(db, buildStayLocator(stayRow({ id: pkgId }), "Lily"))
    const pkg = locatorForSource(db, "package_offer_observations", pkgId)!
    const flight = locatorForSource(db, "flight_prices", pkgId)!
    const stay = locatorForSource(db, "stay_rate_observations", pkgId)!
    expect(new Set([pkg.id, flight.id, stay.id]).size).toBe(3)
    expect(pkg.kind).toBe("package")
    expect(flight.kind).toBe("flight")
    expect(stay.kind).toBe("stay")
    expect(flight.searchReplayUrl).not.toBe(pkg.searchReplayUrl)
  })
})
