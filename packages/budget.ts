/**
 * Package-tier ceilings: reserve-before-await, refusals recorded.
 *
 * The caps are politeness budgets for free unofficial APIs, not billing
 * guards — but the discipline is identical to the metered providers: the
 * reservation happens BEFORE any network await, a refusal reduces scope and
 * records that it did (a skipped event), and nothing downstream may treat a
 * refused call as free capacity to retry.
 */

import { type DB } from "../db/index.js"
import { recordProviderEvent } from "../db/repositories.js"
import { loadPackagesConfig } from "./config.js"
import { createPackageSearchRequest, packageSearchesToday, type PackageSearchRequestInput } from "./store.js"
import { CHECK24_PACKAGES_PROVIDER } from "../providers/packages/check24.js"
import { TUI_PACKAGES_PROVIDER } from "../providers/packages/tui.js"

export interface PackageCaps {
  perRun: number
  perDay: number
}

export function capsFor(provider: string): PackageCaps {
  const cfg = loadPackagesConfig()
  if (provider === TUI_PACKAGES_PROVIDER) return { perRun: cfg.tui.maxCallsPerRun, perDay: cfg.tui.maxCallsPerDay }
  if (provider === CHECK24_PACKAGES_PROVIDER) {
    return { perRun: cfg.check24.maxSearchesPerRun, perDay: cfg.check24.maxSearchesPerDay }
  }
  // An unknown provider gets no budget, not an accidental infinite one.
  return { perRun: 0, perDay: 0 }
}

export interface PackageReservation {
  ok: true
  searchRequestId: number
}

export interface PackageRefusal {
  ok: false
  reason: string
}

/**
 * Reserve one logical search: checks the run and day ceilings, then creates
 * the search-request row (which IS the reservation — day counts are derived
 * from these rows, so a crash after reserve still counts against the cap).
 */
export function reservePackageSearch(
  db: DB,
  input: PackageSearchRequestInput,
  spentThisRun: number,
  now = new Date(),
): PackageReservation | PackageRefusal {
  const caps = capsFor(input.provider)
  if (spentThisRun >= caps.perRun) {
    const reason = `run ceiling reached (${caps.perRun}) for ${input.provider} — scope reduced`
    recordProviderEvent(db, input.provider, "skipped", reason)
    return { ok: false, reason }
  }
  const today = packageSearchesToday(db, input.provider, now)
  if (today >= caps.perDay) {
    const reason = `daily ceiling reached (${today}/${caps.perDay}) for ${input.provider} — scope reduced`
    recordProviderEvent(db, input.provider, "skipped", reason)
    return { ok: false, reason }
  }
  return { ok: true, searchRequestId: createPackageSearchRequest(db, input) }
}
