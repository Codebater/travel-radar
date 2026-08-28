/**
 * Stay run budgets: reserve-before-await accounting, a daily confirmation
 * ceiling, and a per-provider circuit breaker.
 *
 * The flight engine's lesson, kept verbatim: `canSpend()` followed by
 * `spend()` after the await is not a ceiling when work runs concurrently —
 * reserve up front, settle afterwards. The stay scheduler is currently
 * sequential, but the accounting must not silently rely on that.
 *
 * Breaker doctrine: only TRANSPORT failures (network, HTTP-level) count.
 * A semantic error — HTTP 200 with an API error body, or 200 with nothing
 * priced — proves the transport works and must never open the breaker; it is
 * tracked separately on the run and on the ref.
 */

import { readState, writeState } from "../anomaly/store.js"
import type { DB } from "../db/index.js"
import type { StayBudgetsConfig } from "./config.js"

export interface StayRunBudget {
  observationCeiling: number
  confirmationCeiling: number
  observationCalls: number
  confirmationCalls: number
  scopeReduced: string[]
}

export function newStayRunBudget(observationCeiling: number, confirmationCeiling: number): StayRunBudget {
  return { observationCeiling, confirmationCeiling, observationCalls: 0, confirmationCalls: 0, scopeReduced: [] }
}

/** Dedup'd — a ceiling that bites fifty times is one fact, not fifty. */
export function noteScopeReduced(budget: StayRunBudget, reason: string): void {
  if (!budget.scopeReduced.includes(reason)) budget.scopeReduced.push(reason)
}

/** Reserve one observation-tier call BEFORE the await. False = ceiling reached. */
export function reserveObservationCall(budget: StayRunBudget): boolean {
  if (budget.observationCalls >= budget.observationCeiling) return false
  budget.observationCalls++
  return true
}

/** Refund a reservation that turned out not to be spent (e.g. pre-flight refusal). */
export function refundObservationCall(budget: StayRunBudget): void {
  budget.observationCalls = Math.max(0, budget.observationCalls - 1)
}

/**
 * Reserve one confirmation-tier call: per-run ceiling AND persistent daily
 * ceiling, both checked at reservation time, daily counter incremented
 * BEFORE the await so a crash mid-request still counts as spent.
 */
export function reserveConfirmationCall(
  db: DB, budget: StayRunBudget, config: StayBudgetsConfig, at = new Date(),
): { ok: boolean; reason?: string } {
  if (budget.confirmationCalls >= budget.confirmationCeiling) {
    return { ok: false, reason: `confirmation ceiling (${budget.confirmationCeiling}/run) reached` }
  }
  const day = at.toISOString().slice(0, 10)
  const key = `stays.confirmations.${day}`
  const used = Number(readState(db, key) ?? "0")
  if (used >= config.maxConfirmationsPerDay) {
    return { ok: false, reason: `daily confirmation ceiling (${config.maxConfirmationsPerDay}) reached` }
  }
  writeState(db, key, String(used + 1))
  budget.confirmationCalls++
  return { ok: true }
}

export function confirmationsUsedToday(db: DB, at = new Date()): number {
  return Number(readState(db, `stays.confirmations.${at.toISOString().slice(0, 10)}`) ?? "0")
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

const breakerKey = (provider: string) => `stays.breaker.${provider}`

export interface BreakerState {
  open: boolean
  until: string | null
  reason: string | null
}

export function breakerState(db: DB, provider: string, at = new Date()): BreakerState {
  const raw = readState(db, breakerKey(provider))
  if (!raw) return { open: false, until: null, reason: null }
  try {
    const parsed = JSON.parse(raw) as { until: string; reason: string }
    if (Date.parse(parsed.until) > at.getTime()) {
      return { open: true, until: parsed.until, reason: parsed.reason }
    }
  } catch { /* unreadable state = closed breaker */ }
  return { open: false, until: null, reason: null }
}

export function tripBreaker(
  db: DB, provider: string, reason: string, cooldownMinutes: number, at = new Date(),
): string {
  const until = new Date(at.getTime() + cooldownMinutes * 60_000).toISOString()
  writeState(db, breakerKey(provider), JSON.stringify({ until, reason }))
  return until
}

export function resetBreaker(db: DB, provider: string): void {
  writeState(db, breakerKey(provider), JSON.stringify({ until: new Date(0).toISOString(), reason: "reset" }))
}

/**
 * In-run consecutive transport-failure counter. Kept per run (not persisted):
 * the persisted part is the tripped cooldown, which is what must survive a
 * restart — a half-counted streak should not.
 */
export class TransportFailureCounter {
  private streaks = new Map<string, number>()

  /** Returns the cooldown-until ISO string when this failure tripped the breaker. */
  recordFailure(db: DB, provider: string, config: StayBudgetsConfig, reason: string): string | null {
    const streak = (this.streaks.get(provider) ?? 0) + 1
    this.streaks.set(provider, streak)
    if (streak >= config.breakerThreshold) {
      this.streaks.set(provider, 0)
      return tripBreaker(db, provider,
        `${streak} consecutive transport failures (last: ${reason})`, config.breakerCooldownMinutes)
    }
    return null
  }

  recordSuccess(provider: string): void {
    this.streaks.set(provider, 0)
  }
}
