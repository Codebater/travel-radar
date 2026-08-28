/**
 * Package provider registry — same pattern as stays: a module-level registry,
 * a test seam, and defensive wrappers so a provider that throws is a failed
 * result, never a crashed run.
 */

import { Check24PackagesProvider } from "./check24.js"
import { TuiPackagesProvider } from "./tui.js"
import type {
  PackageCalendarQuery,
  PackageOffersQuery,
  PackageProvider,
  PackageSearchOptions,
  PackageSearchResult,
} from "./types.js"

let registry: PackageProvider[] | null = null

export function getPackageProviders(): PackageProvider[] {
  if (!registry) {
    // Funnel order: TUI (Tier 0 calendar + Tier 1 offers), CHECK24 (Tier 2
    // cross-seller confirmation).
    registry = [new TuiPackagesProvider(), new Check24PackagesProvider()]
  }
  return registry
}

export function getPackageProvider(name: string): PackageProvider | undefined {
  return getPackageProviders().find(p => p.name === name)
}

/** Test seam: replace the registry, or pass null to restore the default. */
export function setPackageProviders(providers: PackageProvider[] | null): void {
  registry = providers
}

export async function runPackageCalendarFetch(
  provider: PackageProvider,
  query: PackageCalendarQuery,
  options?: PackageSearchOptions,
): Promise<PackageSearchResult> {
  if (!provider.capabilities.calendar || !provider.fetchCalendar) {
    return {
      provider: provider.name, ok: false, offers: [],
      reason: "unconfigured", error: `${provider.name} does not support calendar fetches`,
      callsSpent: 0, latencyMs: 0,
    }
  }
  try {
    return await provider.fetchCalendar(query, options)
  } catch (err) {
    return {
      provider: provider.name, ok: false, offers: [],
      reason: "provider-error", error: (err as Error).message,
      callsSpent: 0, latencyMs: 0,
    }
  }
}

export async function runPackageOfferSearch(
  provider: PackageProvider,
  query: PackageOffersQuery,
  options?: PackageSearchOptions,
): Promise<PackageSearchResult> {
  if (!provider.capabilities.datedOffers || !provider.searchOffers) {
    return {
      provider: provider.name, ok: false, offers: [],
      reason: "unconfigured", error: `${provider.name} does not support dated offer searches`,
      callsSpent: 0, latencyMs: 0,
    }
  }
  try {
    return await provider.searchOffers(query, options)
  } catch (err) {
    return {
      provider: provider.name, ok: false, offers: [],
      reason: "provider-error", error: (err as Error).message,
      callsSpent: 0, latencyMs: 0,
    }
  }
}
