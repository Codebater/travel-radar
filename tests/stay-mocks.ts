/**
 * Mock stay provider + builders. Injected through the registry seam
 * (setStayProviders) exactly like the flight mocks — nothing in tests/
 * reaches Xotelo or any other real service.
 */

import { nowIso } from "../db/index.js"
import type {
  NormalizedStayRate,
  ProviderHealth,
  ProviderQuota,
  StayCalendarQuery,
  StayCalendarResult,
  StayProvider,
  StayProviderCapabilities,
  StayRateQuery,
  StayRateSearchResult,
} from "../providers/stays/types.js"
import type { StoredStayProperty } from "../stays/registry.js"

export interface MockStayOptions {
  name?: string
  kind?: "free" | "metered"
  rates?: NormalizedStayRate[]
  days?: StayCalendarResult["days"]
  fail?: StayRateSearchResult["reason"]
  throws?: boolean
  capabilities?: Partial<StayProviderCapabilities>
}

export class MockStayProvider implements StayProvider {
  readonly name: string
  readonly kind: "free" | "metered"
  readonly confidence = "medium" as const
  readonly verificationLevel = "discovered" as const
  readonly capabilities: StayProviderCapabilities
  searches: StayRateQuery[] = []

  constructor(private readonly options: MockStayOptions = {}) {
    this.name = options.name ?? "mock-stays"
    this.kind = options.kind ?? "free"
    this.capabilities = {
      dateSpecificRates: true,
      calendar: true,
      roomLevel: false,
      structuredBoard: false,
      cancellation: false,
      taxesFees: "unknown",
      ...options.capabilities,
    }
  }

  isConfigured(): boolean { return true }

  async health(): Promise<ProviderHealth> {
    return { provider: this.name, status: "ok", detail: "mock", latencyMs: 1, checkedAt: nowIso(), quota: null }
  }

  quota(): ProviderQuota | null { return null }

  async searchRates(query: StayRateQuery): Promise<StayRateSearchResult> {
    this.searches.push(query)
    if (this.options.throws) throw new Error("mock provider exploded")
    if (this.options.fail) {
      // A real provider spends its call before it learns the answer was bad.
      return { provider: this.name, ok: false, rates: [], reason: this.options.fail, error: `mock ${this.options.fail}`, callsSpent: 1, latencyMs: 1 }
    }
    const rates = (this.options.rates ?? [makeStayRate({ propertyId: query.propertyId, providerPropertyRef: query.providerRef })])
      .map(r => ({ ...r, provider: this.name }))
    return { provider: this.name, ok: true, rates, callsSpent: 1, latencyMs: 1 }
  }

  async fetchCalendar(query: StayCalendarQuery): Promise<StayCalendarResult> {
    if (this.options.throws) throw new Error("mock provider exploded")
    return {
      provider: this.name, ok: true, propertyId: query.propertyId,
      days: this.options.days ?? [{ date: "2026-11-11", dayClass: "cheap" }],
      callsSpent: 1, latencyMs: 1,
    }
  }
}

/** A plausible normalized rate; overrides win. */
export function makeStayRate(overrides: Partial<NormalizedStayRate> = {}): NormalizedStayRate {
  return {
    propertyId: "soneva-fushi",
    providerPropertyRef: "g3252668-d301967",
    checkIn: "2026-11-10",
    checkOut: "2026-11-15",
    nights: 5,
    adults: 2,
    children: 0,
    roomName: null,
    roomClass: null,
    board: "unknown",
    boardSource: "unknown",
    refundable: null,
    cancellationDeadline: null,
    rateSource: "Booking.com",
    sourceClass: "meta",
    price: { amount: 2393, currency: "USD" },
    priceBasis: "nightly_room",
    taxesFees: "unknown",
    taxesFeesAmount: null,
    provider: "mock-stays",
    fetchedAt: nowIso(),
    providerAsOf: null,
    verificationLevel: "discovered",
    confidence: "medium",
    ...overrides,
  }
}

/** A stored property as the registry would return it; overrides win. */
export function makeStoredProperty(overrides: Partial<StoredStayProperty> = {}): StoredStayProperty {
  return {
    id: "soneva-fushi",
    name: "Soneva Fushi",
    destinationGroup: "maldives",
    country: "Maldives",
    region: "Baa Atoll",
    nearestAirports: ["MLE"],
    luxuryTier: "ultra",
    allInclusive: "available",
    defaultBoard: "unknown",
    typicalStayNights: [5, 7],
    priority: 1,
    active: true,
    notes: null,
    refs: { xotelo: "g3252668-d301967" },
    ...overrides,
  }
}
