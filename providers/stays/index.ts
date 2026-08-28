/**
 * Stay provider registry.
 *
 * Same pattern as cash/award flights: a module-level registry, a test seam,
 * and a defensive wrapper so a provider that throws is a failed result, not a
 * crashed scheduler. Registered: Xotelo (discovery tier) and Agoda
 * (confirmation tier). The verification (SerpAPI Hotels) and corroboration
 * (LiteAPI) tiers are later phases — they plug in here, nothing else changes.
 */

import { AgodaProvider } from "./agoda.js"
import { SerpApiHotelsProvider } from "./serpapi-hotels.js"
import { XoteloProvider } from "./xotelo.js"
import type {
  StayCalendarQuery,
  StayCalendarResult,
  StayProvider,
  StayRateQuery,
  StayRateSearchResult,
  StaySearchOptions,
} from "./types.js"

let registry: StayProvider[] | null = null

export function getStayProviders(): StayProvider[] {
  if (!registry) {
    // The funnel order: discovery, confirmation, metered verification.
    // Corroboration (LiteAPI) is a later phase.
    registry = [new XoteloProvider(), new AgodaProvider(), new SerpApiHotelsProvider()]
  }
  return registry
}

export function getStayProvider(name: string): StayProvider | undefined {
  return getStayProviders().find(p => p.name === name)
}

/** Test seam: replace the registry, or pass null to restore the default. */
export function setStayProviders(providers: StayProvider[] | null): void {
  registry = providers
}

/**
 * Run one provider's rate search without letting an exception escape. The
 * contract says providers never throw; this wrapper is the belt to that
 * suspenders — a bug in one provider must degrade that provider, not the run.
 */
export async function runStayRateSearch(
  provider: StayProvider,
  query: StayRateQuery,
  options?: StaySearchOptions,
): Promise<StayRateSearchResult> {
  try {
    return await provider.searchRates(query, options)
  } catch (err) {
    return {
      provider: provider.name,
      ok: false,
      rates: [],
      reason: "provider-error",
      error: (err as Error).message,
      callsSpent: 0,
      latencyMs: 0,
    }
  }
}

/** Same defensive wrapper for the calendar capability. */
export async function runStayCalendarFetch(
  provider: StayProvider,
  query: StayCalendarQuery,
  options?: StaySearchOptions,
): Promise<StayCalendarResult> {
  if (!provider.capabilities.calendar || !provider.fetchCalendar) {
    return {
      provider: provider.name,
      ok: false,
      propertyId: query.propertyId,
      days: [],
      reason: "unconfigured",
      error: `${provider.name} does not support calendar fetches`,
      callsSpent: 0,
      latencyMs: 0,
    }
  }
  try {
    return await provider.fetchCalendar(query, options)
  } catch (err) {
    return {
      provider: provider.name,
      ok: false,
      propertyId: query.propertyId,
      days: [],
      reason: "provider-error",
      error: (err as Error).message,
      callsSpent: 0,
      latencyMs: 0,
    }
  }
}
