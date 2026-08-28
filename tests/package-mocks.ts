/**
 * Shared package-offer factory for tests — the Lily Beach VIE/November AI
 * package as observed live 2026-08-28, overridable per test.
 */

import { nowIso } from "../db/index.js"
import type { NormalizedPackageOffer } from "../providers/packages/types.js"

export function makeOffer(over: Partial<NormalizedPackageOffer> = {}): NormalizedPackageOffer {
  return {
    propertyId: "lily-beach-resort",
    providerPropertyRef: "16356",
    giataId: 16356,
    hotelName: "Lily Beach Resort & Spa",
    origin: "VIE",
    destinationAirport: "MLE",
    destinationRegion: null,
    checkIn: "2026-11-19",
    checkOut: "2026-11-24",
    nights: 5,
    tripDeparture: "2026-11-18T15:15:00.000+01:00",
    tripReturn: "2026-11-24T20:55:00.000+05:00",
    tripDays: 7,
    adults: 2,
    children: 0,
    roomName: "Beach Villa",
    roomClass: "villa",
    board: "all_inclusive",
    boardSource: "structured",
    cabin: "economy",
    outboundSegments: [],
    returnSegments: [],
    flightPricePerPerson: 909,
    hotelPricePerPerson: null,
    priceSplitSource: "provider",
    baggage: "unknown",
    transfer: "included",
    cancellation: "refundable",
    totalPrice: { amount: 6628, currency: "EUR" },
    pricePerPerson: 3314,
    taxesFees: "included",
    unknownInclusions: ["baggage allowance not stated in offer"],
    tourOperator: "LTUR",
    providerIds: {},
    providerUrls: {},
    provider: "tui_packages",
    fetchedAt: nowIso(),
    verificationLevel: "discovered",
    confidence: "medium",
    ...over,
  }
}
