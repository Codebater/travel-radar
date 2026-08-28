/**
 * §44 - the notification layer's acceptance tests.
 *
 * Every one of these asserts a behaviour that a plausible implementation gets
 * WRONG, and most of them exist because a specific field in this database
 * churns in a way that looks stable:
 *
 *   candidate ids, cluster ids and open-jaw pair ids are all re-minted for
 *   identical trips; `observed_at` on an open jaw is the assembly clock rather
 *   than the age of its legs; `deal_feedback` cascades away on withdrawal.
 *
 * Entirely offline. The channel is a test double in every case; no network
 * request is possible, and `NOTIFICATIONS_ENABLED` is irrelevant because the
 * dispatcher is handed the double directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { recordPriceObservations, recordSearchRequest } from "../db/repositories.js"
import { evaluateNewObservations } from "../anomaly/engine.js"
import { evaluateOpenJaws } from "../anomaly/openjaw.js"
import { rebuildClusters } from "../anomaly/clustering.js"
import { getCandidate, listCandidates, recordFeedback, saveCandidate } from "../anomaly/store.js"
import { loadNotificationConfig, deepLinkFor, feedLink, type NotificationConfig } from "../notifications/config.js"
import { evaluateEligibility } from "../notifications/eligibility.js"
import { identityFor, fingerprint, opportunityKey, dateFamily, validIata } from "../notifications/identity.js"
import { measureFreshness } from "../notifications/freshness.js"
import { runNotificationPass } from "../notifications/dispatcher.js"
import { NullChannel, FailingChannel } from "../notifications/providers/null.js"
import { NtfyChannel, readNtfyConfig, isRetryable } from "../notifications/providers/ntfy.js"
import { redactSecrets, containsSecret } from "../notifications/redact.js"
import { scrub, scrubBody } from "../notifications/providers/types.js"
import { renderCandidate, renderTest } from "../notifications/format.js"
import { isQuiet, localDay, digestSlotFor, slotDueAt, timezoneSupported } from "../notifications/quiet-hours.js"
import { listQueue, listNotifications, immediatesToday, recordEvent } from "../notifications/store.js"
import { verifyForNotification } from "../notifications/verify.js"
import { makeFlight } from "./mocks.js"

let db: DB
let config: NotificationConfig
const NOW = new Date("2026-06-01T12:00:00.000Z")   // 14:00 Prague, waking hours
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString()
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
const day = (days: number) => at(days).slice(0, 10)

/**
 * A candidate at a chosen score, written straight into deal_candidates.
 *
 * Going through the real engine would make every test depend on the scorer's
 * weights, which are config and therefore change. These tests are about the
 * notification GATES, so the score is an input.
 */
function makeCandidate(over: Record<string, any> = {}): number {
  const fields = {
    source_table: "flight_prices",
    source_id: over.source_id ?? 1,
    observed_at: hoursAgo(1), as_of: hoursAgo(1), evaluated_at: hoursAgo(1),
    type: "cash", origin: "VIE", destination: "BKK", route: "VIE-BKK",
    departure_date: day(40), return_date: day(54), trip_type: "return", cabin: "business",
    airline: "Qatar Airways", stops: 1, itinerary_hash: "h1",
    loyalty_program: null, price_amount: 1095, price_currency: "EUR",
    points: null, taxes_amount: null, taxes_currency: null,
    baseline_key: "VIE|BKK|business|return|long|connecting", baseline_scope: "strict",
    observed_median: 2080, observed_minimum: 1000, observed_maximum: 3000,
    percent_below_median: 47.4, percentile: 3, sample_size: 40, baseline_confidence: "HIGHER",
    baseline_first_at: at(-60), baseline_last_at: hoursAgo(6), baseline_age_days: 0.25,
    cpp: null, cpp_basis: null, cpp_confidence: null, cash_provenance: null,
    award_provenance: null, program_comparison: null,
    provider: "fast_flights", provider_confidence: "medium", verification_level: "discovered",
    score: 93, score_breakdown: "{}", weights_version: "shadow-2", engine_version: "shadow-2",
    reasons: "[]", features: "{}", presets_matched: "[]", threshold: 70,
    mode: "shadow", status: "candidate", notified: 0, created_at: hoursAgo(1),
    discovered_by: "FIXED_OBSERVER", discovery_run_id: null, cluster_id: null,
    destination_group: "thailand", requires_positioning: 0, positioning: null,
    positioning_penalty: null, true_trip_start_cost: null,
    is_open_jaw: 0, open_jaw: null, absolute_tier: "extreme",
    sanity: "ok", sanity_detail: null, verification_status: "verified",
    trip_length_nights: 14,
    ...over,
  }
  const cols = Object.keys(fields)
  const info = db.prepare(
    `INSERT INTO deal_candidates (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...cols.map(c => (fields as any)[c]))
  return Number(info.lastInsertRowid)
}

/** A real flight_prices row, so freshness has something to measure. */
function makeObservation(over: Record<string, any> = {}): number {
  const requestId = recordSearchRequest(db, {
    origin: over.origin ?? "VIE", destination: over.destination ?? "BKK",
    departureDate: over.departureDate ?? day(40), returnDate: over.returnDate ?? day(54),
    cabin: "business", adults: 1, currency: "EUR",
  }, "observer")
  recordPriceObservations(db, [makeFlight({
    origin: "VIE", destination: "BKK", cabin: "business",
    departureDate: day(40), returnDate: day(54),
    price: { amount: 1095, currency: "EUR" },
    fetchedAt: hoursAgo(1),
    ...over,
  })], { adults: 1, searchRequestId: requestId })
  return (db.prepare(`SELECT MAX(id) id FROM flight_prices`).get() as any).id
}

async function pass(channel: NullChannel | FailingChannel, now = NOW, extra: Record<string, any> = {}) {
  return runNotificationPass({
    db, channel, now, config: { ...config, enabled: true }, holder: "test", ...extra,
  })
}

beforeEach(() => {
  db = createMemoryDb()
  config = loadNotificationConfig(true)
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

// ─── §13 identity: the keys that must not churn ─────────────────────────────

describe("opportunity identity", () => {
  it("survives everything about a candidate that churns", () => {
    // Every field in this list is re-minted for an IDENTICAL trip somewhere in
    // this system, and every one of them is an obvious thing to put in a key.
    const id = makeCandidate()
    const first = getCandidate(db, id)!
    const before = identityFor({ candidate: first })

    const churned = {
      ...first,
      id: first.id + 9999,                 // candidate ids: seq 36,190 for 4,928 rows
      clusterId: 4242,                     // cluster ids: seq 16,275 for 1,503 rows
      sourceId: first.sourceId + 500,      // open-jaw pair ids: seq 226 for 10 rows
      observedAt: at(0), asOf: at(0), evaluatedAt: at(0),
      airline: "Qatar Airways Group",      // upstream free text
      provider: "fast_flights_v2",
      score: first.score + 4,              // a function of weightsVersion
      baseline: { ...first.baseline, count: 99, median: 3000, percentBelowMedian: 61 },
    }
    const after = identityFor({ candidate: churned })

    expect(after.opportunityKey).toBe(before.opportunityKey)
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.cooldownKey).toBe(before.cooldownKey)
  })

  it("changes the fingerprint when the price does, but not the opportunity key", () => {
    // This split is what makes re-alert possible at all: a key containing the
    // price can never match the previous notification, because the price is
    // exactly what changed.
    const id = makeCandidate()
    const c = getCandidate(db, id)!
    const cheaper = { ...c, priceAmount: 800 }
    expect(fingerprint({ candidate: cheaper })).not.toBe(fingerprint({ candidate: c }))
    expect(opportunityKey({ candidate: cheaper })).toBe(opportunityKey({ candidate: c }))
  })

  it("collapses trivial price noise into one identity", () => {
    // Five candidate rows for one LIFEMILES seat, differing only in the
    // surcharge, would otherwise be five fingerprints - and the day's two
    // slots would both go to one award.
    const id = makeCandidate({ type: "award", points: 24000, taxes_amount: 63.8,
      taxes_currency: "USD", loyalty_program: "LIFEMILES", price_amount: null, price_currency: null })
    const c = getCandidate(db, id)!
    const other = { ...c, taxesAmount: 55.9 }
    expect(fingerprint({ candidate: other })).toBe(fingerprint({ candidate: c }))
  })

  it("refuses a route that is not made of airport codes", () => {
    expect(validIata("BKK")).toBe("BKK")
    expect(validIata("bkk")).toBe("BKK")
    expect(validIata("undefined")).toBeNull()
    expect(validIata("BK")).toBeNull()
    expect(validIata(null)).toBeNull()
  })

  it("buckets dates onto a fixed grid rather than a moving cluster boundary", () => {
    expect(dateFamily("2026-10-10")).toBe(dateFamily("2026-10-11"))
    expect(dateFamily("2026-10-10")).not.toBe(dateFamily("2026-11-10"))
  })
})

// ─── §2/§3 eligibility is never score-only ──────────────────────────────────

describe("eligibility gates", () => {
  it("refuses a high score on suspicious data", () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source, score: 99, sanity: "SUSPICIOUS_DATA",
      sanity_detail: "12 EUR is below the business floor" })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.eligible).toBe(false)
    expect(verdict.allBlockers).toContain("SUSPICIOUS_DATA")
  })

  it("collects EVERY hard blocker, not just the first", () => {
    // A candidate can be both stale and garbage, and reporting one hides that
    // the data was garbage as well as old.
    const source = makeObservation({ fetchedAt: hoursAgo(300) })
    const id = makeCandidate({ source_id: source, sanity: "SUSPICIOUS_DATA", sanity_detail: "nope" })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.allBlockers).toContain("SUSPICIOUS_DATA")
    expect(verdict.allBlockers).toContain("STALE")
    expect(verdict.allBlockers.length).toBeGreaterThan(1)
  })

  it("stays silent on a thin baseline that is neither verified nor extraordinary", () => {
    const source = makeObservation()
    const id = makeCandidate({
      source_id: source, sample_size: 2, baseline_confidence: "VERY_LOW",
      verification_status: "unverified", absolute_tier: null,
    })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.eligible).toBe(false)
    expect(verdict.firstBlocker).toBe("THIN_BASELINE")
  })

  it("lets an extraordinary no-history fare through, labelled for what it is", () => {
    // §4 the low-history exception. It exists because a wildcard destination
    // has no history BY DEFINITION, so the fare worth finding most is the one
    // the evidence policy would otherwise silence forever.
    const source = makeObservation()
    const id = makeCandidate({
      source_id: source, sample_size: 0, baseline_confidence: "INSUFFICIENT",
      verification_status: "unverified", absolute_tier: "wtf",
      provider_confidence: "medium", score: 85,
    })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.eligible).toBe(true)
    expect(verdict.evidenceBasis).toBe("absolute-low-history")
    expect(verdict.labels).toContain("LOW BASELINE CONFIDENCE")

    // And the message says so, rather than implying evidence it does not have.
    const message = renderCandidate({
      candidate: getCandidate(db, id)!, dateCount: 1,
      earliestDeparture: day(40), latestDeparture: day(40),
      lowConfidenceLabel: "LOW BASELINE CONFIDENCE", bypass: false, improvement: null,
    }, config)
    expect(message.body).toContain("LOW BASELINE CONFIDENCE")
  })

  it("never lets the low-history exception bypass quiet hours", () => {
    const source = makeObservation()
    const id = makeCandidate({
      source_id: source, sample_size: 0, baseline_confidence: "INSUFFICIENT",
      verification_status: "unverified", absolute_tier: "wtf", score: 99,
    })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.evidenceBasis).toBe("absolute-low-history")
    expect(verdict.kind).not.toBe("bypass")
  })

  it("refuses a candidate whose provider is currently failing", () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, {
      now: NOW, config, brokenProviders: new Set(["fast_flights"]),
    })
    expect(verdict.eligible).toBe(false)
    expect(verdict.allBlockers).toContain("PROVIDER_ERROR")
  })
})

// ─── §35 freshness comes from the observation, never the candidate row ──────

describe("freshness", () => {
  it("refuses a candidate whose observation has aged out", () => {
    const source = makeObservation({ fetchedAt: hoursAgo(200) })
    const id = makeCandidate({ source_id: source })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.allBlockers).toContain("STALE")
  })

  it("refuses a candidate whose observation has been deleted", () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    db.prepare(`DELETE FROM flight_prices WHERE id = ?`).run(source)
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.allBlockers).toContain("WITHDRAWN")
  })

  it("measures an open jaw from its OLDER leg, not from observed_at", () => {
    // The crux. findOpenJaws sets asOf to the FRESHER leg, and
    // buildOpenJawCandidate copies that into observed_at - so a 40-day-old
    // outbound paired with a minutes-old inbound produces a candidate whose
    // observed_at is minutes old. Nothing ever deletes from open_jaw_pairs, so
    // such ghosts live forever with their score and feed position intact.
    const oldLeg = makeObservation({
      origin: "PRG", destination: "BKK", returnDate: null, departureDate: day(40),
      fetchedAt: hoursAgo(40 * 24),
    })
    const freshLeg = makeObservation({
      origin: "BKK", destination: "VIE", returnDate: null, departureDate: day(54),
      fetchedAt: hoursAgo(0.1),
    })
    db.prepare(`
      INSERT INTO open_jaw_pairs (
        pair_key, outbound_price_id, inbound_price_id,
        outbound_origin, outbound_destination, outbound_departure, outbound_price,
        inbound_origin, inbound_destination, inbound_departure, inbound_price,
        cabin, currency, total_price, destination_group, trip_length_nights,
        transfer_cost, friction, usefulness, first_seen_at, updated_at
      ) VALUES (?, ?, ?, 'PRG','BKK',?,467,'BKK','VIE',?,369,'economy','USD',836,'thailand',7,27,0.4,1,?,?)
    `).run(`${oldLeg}:${freshLeg}`, oldLeg, freshLeg, day(40), day(54), at(0), at(0))
    const pairId = (db.prepare(`SELECT MAX(id) id FROM open_jaw_pairs`).get() as any).id

    const id = makeCandidate({
      source_table: "open_jaw", source_id: pairId, is_open_jaw: 1,
      // The assembly clock, exactly as the real engine writes it.
      observed_at: at(0), as_of: at(0),
      route: "PRG-BKK/BKK-VIE", origin: "PRG", destination: "BKK",
    })
    const candidate = getCandidate(db, id)!

    // The row LOOKS seconds old...
    expect(Date.now() - Date.parse(candidate.observedAt)).toBeLessThan(400 * 86_400_000)
    // ...and the freshness measurement is not fooled.
    const fresh = measureFreshness(db, candidate, NOW)
    expect(fresh.legsPresent).toBe(2)
    expect(fresh.oldestAgeHours).toBeGreaterThan(900)

    const verdict = evaluateEligibility(db, candidate, { now: NOW, config })
    expect(verdict.allBlockers).toContain("STALE")
    expect(verdict.reasons.some(r => r.detail.includes("older leg"))).toBe(true)
  })
})

// ─── §6 open jaw, and the live 863-vs-516 regression ────────────────────────

describe("open-jaw alert policy", () => {
  function liveOpenJaw(over: Record<string, any> = {}): number {
    const out = makeObservation({
      origin: "PRG", destination: "HKT", returnDate: null, departureDate: day(30),
      price: { amount: 467, currency: "USD" }, fetchedAt: hoursAgo(2),
    })
    const back = makeObservation({
      origin: "HKT", destination: "VIE", returnDate: null, departureDate: day(37),
      price: { amount: 369, currency: "USD" }, fetchedAt: hoursAgo(2),
    })
    const comparator = makeObservation({
      origin: "PRG", destination: "HKT", departureDate: day(30), returnDate: day(37),
      price: { amount: 516, currency: "USD" }, fetchedAt: hoursAgo(2),
    })
    db.prepare(`
      INSERT INTO open_jaw_pairs (
        pair_key, outbound_price_id, inbound_price_id,
        outbound_origin, outbound_destination, outbound_departure, outbound_price,
        inbound_origin, inbound_destination, inbound_departure, inbound_price,
        cabin, currency, total_price, destination_group, trip_length_nights,
        comparable_round_trip, comparator_price_id, saving, saving_percent,
        transfer_cost, net_saving, friction, usefulness, first_seen_at, updated_at
      ) VALUES (?, ?, ?, 'PRG','HKT',?,467,'HKT','VIE',?,369,'economy','USD',836,'thailand',7,
                516, ?, -320, -62, 27, -347, 0.4, 1, ?, ?)
    `).run(`${out}:${back}`, out, back, day(30), day(37), comparator, at(0), at(0))
    const pairId = (db.prepare(`SELECT MAX(id) id FROM open_jaw_pairs`).get() as any).id
    return makeCandidate({
      source_table: "open_jaw", source_id: pairId, is_open_jaw: 1,
      route: "PRG-HKT/HKT-VIE", origin: "PRG", destination: "HKT", cabin: "economy",
      departure_date: day(30), return_date: day(37), trip_length_nights: 7,
      price_amount: 836, price_currency: "USD",
      baseline_key: "PRG|HKT|economy|return|medium|connecting",
      observed_median: 1085, percent_below_median: 22.9, sample_size: 65,
      baseline_confidence: "HIGHER", absolute_tier: null,
      ...over,
    })
  }

  it("keeps the live PRG-HKT/HKT-VIE jaw silent, and not because of its score", () => {
    // 836 in fares + 27 of transfers = 863 all-in, against a 516 comparable
    // return that was actually observed. The jaw is 347 MORE expensive.
    const id = liveOpenJaw()
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.eligible).toBe(false)
    expect(verdict.allBlockers).toContain("OPEN_JAW_NOT_BENEFICIAL")
    const reason = verdict.reasons.find(r => r.code === "OPEN_JAW_NOT_BENEFICIAL")!
    expect(reason.detail).toContain("863")
    expect(reason.detail).toContain("516")
  })

  it("stays silent even at a score of 99, because the structure gate is not the evidence gate", () => {
    // This is the trap the whole gate exists for. The candidate's own baseline
    // is excellent - HIGHER confidence over 65 observations, 22.9% below a 1085
    // median - so it passes the evidence gate cleanly. But that median is the
    // median of PRG-HKT ROUND TRIPS, while the thing purchasable today is 516.
    // Only the comparator ever sees the 516.
    const id = liveOpenJaw({ score: 99, verification_status: "verified" })
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.eligible).toBe(false)
    expect(verdict.firstBlocker).toBe("OPEN_JAW_NOT_BENEFICIAL")
    // The evidence gate genuinely passed. That is the point.
    expect(verdict.evidenceBasis).toBe("baseline")
  })

  it("allows an open jaw that really is cheaper than the round trip", () => {
    const id = liveOpenJaw()
    const pairId = getCandidate(db, id)!.sourceId
    db.prepare(`
      UPDATE open_jaw_pairs SET total_price = 700, comparable_round_trip = 1200,
        saving = 500, saving_percent = 41.7, net_saving = 473 WHERE id = ?
    `).run(pairId)
    const verdict = evaluateEligibility(db, getCandidate(db, id)!, { now: NOW, config })
    expect(verdict.allBlockers).not.toContain("OPEN_JAW_NOT_BENEFICIAL")
    expect(verdict.eligible).toBe(true)
  })

  it("re-alerts only on the COMBINED total, never on one leg being re-observed", () => {
    const id = liveOpenJaw()
    const candidate = getCandidate(db, id)!
    const before = fingerprint({ candidate, openJawTotal: 863 })
    // A leg is re-observed at the same price: new pair id, new candidate id,
    // new timestamps - and the same trip.
    const after = fingerprint({
      candidate: { ...candidate, id: candidate.id + 77, sourceId: candidate.sourceId + 77,
        observedAt: at(0) },
      openJawTotal: 863,
    })
    expect(after).toBe(before)
    // A genuinely better total is a different fingerprint.
    expect(fingerprint({ candidate, openJawTotal: 700 })).not.toBe(before)
  })
})

// ─── §14 dedup, §15 re-alert ────────────────────────────────────────────────

describe("dedup and re-alert", () => {
  it("sends the same candidate once, however many passes run", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const channel = new NullChannel()

    const first = await pass(channel)
    expect(first.sent).toBe(1)

    const second = await pass(channel)
    expect(second.sent).toBe(0)
    expect(second.blockers.ALREADY_SENT ?? second.blockers.CLUSTER_COOLDOWN).toBeGreaterThan(0)
    expect(channel.sent).toHaveLength(1)
    expect(listNotifications(db).length).toBe(1)
  })

  it("does not re-alert because a timestamp moved", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const channel = new NullChannel()
    await pass(channel)

    // Everything that changes on a re-observation of an unchanged fare.
    db.prepare(`UPDATE deal_candidates SET observed_at = ?, as_of = ?, evaluated_at = ? WHERE id = ?`)
      .run(at(0), at(0), at(0), id)
    db.prepare(`UPDATE flight_prices SET fetched_at = ? WHERE id = ?`).run(at(0), source)

    const again = await pass(channel, new Date(NOW.getTime() + 26 * 3600_000))
    expect(again.sent).toBe(0)
    expect(channel.sent).toHaveLength(1)
  })

  it("re-alerts when the price materially improves", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const channel = new NullChannel()
    await pass(channel)

    // 1095 → 850, a 22% improvement, past the 24h cooldown.
    db.prepare(`UPDATE deal_candidates SET price_amount = 850 WHERE id = ?`).run(id)
    const later = new Date(NOW.getTime() + 26 * 3600_000)
    const again = await pass(channel, later)
    expect(again.sent).toBe(1)
    expect(channel.sent[1]!.body).toContain("Improved")
  })

  it("does not re-alert on a trivial price move", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const channel = new NullChannel()
    await pass(channel)

    db.prepare(`UPDATE deal_candidates SET price_amount = 1070 WHERE id = ?`).run(id)   // -2%
    const again = await pass(channel, new Date(NOW.getTime() + 26 * 3600_000))
    expect(again.sent).toBe(0)
  })

  it("holds the cooldown across a cluster rebuild", async () => {
    // Cluster ids are re-minted on every rebuild - 16,275 issued for 1,503 live
    // rows - so any cooldown keyed on one silently evaporates.
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const channel = new NullChannel()
    await pass(channel)

    const before = (db.prepare(`SELECT cluster_id FROM deal_candidates WHERE id = ?`).get(id) as any).cluster_id
    rebuildClusters(db, { minScore: 0 })
    const after = (db.prepare(`SELECT cluster_id FROM deal_candidates WHERE id = ?`).get(id) as any).cluster_id
    expect(after).not.toBe(before)

    const again = await pass(channel, new Date(NOW.getTime() + 3600_000))
    expect(again.sent).toBe(0)
    expect(channel.sent).toHaveLength(1)
  })
})

// ─── §17/§18/§19 the clock ──────────────────────────────────────────────────

describe("quiet hours and the digest", () => {
  it("knows Prague's wall clock rather than the machine's", () => {
    expect(timezoneSupported("Europe/Prague")).toBe(true)
    // 22:00 UTC in June is midnight in Prague: quiet.
    expect(isQuiet(new Date("2026-06-01T22:00:00.000Z"), config)).toBe(true)
    // 12:00 UTC is 14:00 Prague: not quiet.
    expect(isQuiet(new Date("2026-06-01T12:00:00.000Z"), config)).toBe(false)
  })

  it("resolves the digest instant across a DST change without arithmetic", () => {
    // Prague's 23:00-08:00 window is 8 UTC hours on the March transition night
    // and 10 in October, and both changeovers land inside it. Asserting against
    // a hardcoded UTC string would bake in one of them; re-formatting proves
    // the answer is right in the zone that matters.
    const slot = "2027-03-28"
    const due = slotDueAt(slot, config)!
    const hour = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague", hour12: false, hour: "2-digit",
    }).format(due)
    expect(hour.replace(/\D/g, "")).toBe("08")
  })

  it("queues rather than sends during quiet hours", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const channel = new NullChannel()
    const night = new Date("2026-06-01T22:30:00.000Z")   // 00:30 Prague
    expect(isQuiet(night, config)).toBe(true)

    const result = await pass(channel, night)
    expect(result.sent).toBe(0)
    expect(result.queued).toBe(1)
    expect(channel.sent).toHaveLength(0)
    expect(listQueue(db)[0]!.kind).toBe("digest")
  })

  it("sends ONE digest for a night's worth of queued alerts", async () => {
    for (let i = 0; i < 3; i++) {
      const source = makeObservation({ departureDate: day(40 + i * 10) })
      // The return has to move with the departure. Leaving it behind produced a
      // return date BEFORE the outbound, which the INVALID_ITINERARY gate
      // correctly refused - a fixture bug that the gate caught first.
      makeCandidate({ source_id: source,
        departure_date: day(40 + i * 10), return_date: day(54 + i * 10),
        destination: ["BKK", "CUN", "DPS"][i], route: `VIE-${["BKK", "CUN", "DPS"][i]}` })
    }
    const channel = new NullChannel()
    const night = new Date("2026-06-01T22:30:00.000Z")
    await pass(channel, night)
    expect(listQueue(db).filter(q => q.status === "QUEUED")).toHaveLength(3)

    // 08:00 Prague the next morning.
    const morning = new Date("2026-06-02T06:30:00.000Z")
    const result = await pass(channel, morning)
    expect(result.digestsSent).toBe(1)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]!.title).toContain("opportunit")
  })

  it("lets a 97+ extreme through quiet hours, and only with corroboration", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source, score: 98, verification_status: "verified" })
    const channel = new NullChannel()
    const night = new Date("2026-06-01T22:30:00.000Z")

    const result = await pass(channel, night)
    expect(result.sent).toBe(1)
    expect(channel.sent[0]!.priority).toBe(5)

    // The same score with nothing corroborating it waits for morning.
    db.prepare(`DELETE FROM notifications`).run()
    db.prepare(`DELETE FROM notification_queue`).run()
    db.prepare(`UPDATE deal_candidates SET verification_status='unverified', absolute_tier=NULL WHERE id=?`).run(id)
    const channel2 = new NullChannel()
    const second = await pass(channel2, night)
    expect(second.sent).toBe(0)
    expect(second.queued).toBe(1)
  })
})

// ─── §20 rate limits ────────────────────────────────────────────────────────

describe("rate limits", () => {
  it("sends at most two immediate notifications in one Prague day", async () => {
    for (let i = 0; i < 4; i++) {
      const dest = ["BKK", "CUN", "DPS", "MLE"][i]!
      const source = makeObservation({ destination: dest })
      makeCandidate({ source_id: source, destination: dest, route: `VIE-${dest}` })
    }
    const channel = new NullChannel()
    const result = await pass(channel)
    expect(result.sent).toBe(2)
    expect(channel.sent).toHaveLength(2)
    // The rest are not lost: they are queued for the digest.
    expect(listQueue(db).filter(q => q.status === "QUEUED" && q.kind === "digest").length).toBeGreaterThan(0)
  })

  it("counts in-flight notifications as spent", () => {
    db.prepare(`
      INSERT INTO notification_queue (fingerprint, opportunity_key, cooldown_key, kind, status,
        priority, scheduled_for, attempts, eligibility_json, evidence_json, created_at, updated_at)
      VALUES ('f','o','c','immediate','SENDING',3,?,1,'{}','{}',?,?)
    `).run(at(0), at(0), at(0))
    // Without this, two items claimed in one tick both read zero and both pass
    // a cap of two - which is how "maximum 2" becomes 4.
    expect(immediatesToday(db, localDay(NOW, config))).toBe(1)
  })

  it("keeps one volatile route from taking the whole day's allowance", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source, departure_date: day(40) })
    // A different date family on the SAME route: a different opportunity, but
    // the cooldown key is deliberately broader than the opportunity key.
    const source2 = makeObservation({ departureDate: day(80), returnDate: day(94) })
    makeCandidate({ source_id: source2, departure_date: day(80), return_date: day(94) })

    const channel = new NullChannel()
    const result = await pass(channel)
    expect(result.sent).toBe(1)
    expect(Object.keys(result.blockers)).toContain("CLUSTER_COOLDOWN")
  })
})

// ─── §24/§25/§40 failure ────────────────────────────────────────────────────

describe("delivery failure", () => {
  it("retries on the configured ladder and then gives up", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const channel = new FailingChannel("connection refused", true)

    let now = NOW
    for (let attempt = 0; attempt < 4; attempt++) {
      await pass(channel, now)
      now = new Date(now.getTime() + 61 * 60_000)
    }
    expect(channel.attempts).toBe(config.retry.maxAttempts)
    const row = listQueue(db)[0]!
    expect(row.status).toBe("FAILED")
    expect(row.attempts).toBe(config.retry.maxAttempts)
  })

  it("does not retry a request the server will keep rejecting", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    // 403: the token is wrong. Three attempts change nothing except how long
    // the operator waits to find out.
    const channel = new FailingChannel("forbidden", false, 403)
    await pass(channel)
    expect(listQueue(db)[0]!.status).toBe("FAILED")
    await pass(channel, new Date(NOW.getTime() + 3600_000))
    expect(channel.attempts).toBe(1)
  })

  it("never re-sends a notification that was interrupted mid-send", async () => {
    // ntfy has no idempotency key, so "the POST completed and we died" is
    // indistinguishable from "we died first". At-most-once: the row is recorded
    // as UNKNOWN and never repeated. A missed deal is still on /deals.html; a
    // duplicate teaches the operator to distrust the channel.
    db.prepare(`
      INSERT INTO notification_queue (fingerprint, opportunity_key, cooldown_key, kind, status,
        priority, scheduled_for, attempts, send_started_at, claimed_by,
        eligibility_json, evidence_json, created_at, updated_at)
      VALUES ('f','o','c','immediate','SENDING',3,?,1,?,'dead-holder','{}','{}',?,?)
    `).run(hoursAgo(2), hoursAgo(2), hoursAgo(2), hoursAgo(2))

    const channel = new NullChannel()
    const result = await pass(channel)
    expect(result.reaped.unknown).toBe(1)
    expect(channel.sent).toHaveLength(0)
    expect(listQueue(db)[0]!.status).toBe("UNKNOWN")
    const event = db.prepare(
      `SELECT * FROM notification_events WHERE kind = 'send_outcome_unknown'`,
    ).get() as any
    expect(event).toBeDefined()
  })

  it("cancels a queued alert whose deal died while it waited", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const channel = new NullChannel()
    const night = new Date("2026-06-01T22:30:00.000Z")
    await pass(channel, night)
    expect(listQueue(db)[0]!.status).toBe("QUEUED")

    // The observation is withdrawn overnight.
    db.prepare(`DELETE FROM flight_prices WHERE id = ?`).run(source)
    void id

    const morning = new Date("2026-06-02T06:30:00.000Z")
    const result = await pass(channel, morning)
    expect(channel.sent).toHaveLength(0)
    expect(result.cancelled).toBeGreaterThan(0)
    expect(["CANCELLED", "SUPPRESSED"]).toContain(listQueue(db)[0]!.status)
  })

  it("keeps a queued alert from going out after the operator marks it a bad signal", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source })
    const channel = new NullChannel()
    const night = new Date("2026-06-01T22:30:00.000Z")
    await pass(channel, night)

    recordFeedback(db, id, "BAD_SIGNAL", { note: "not actually a deal" })
    const morning = new Date("2026-06-02T06:30:00.000Z")
    await pass(channel, morning)
    expect(channel.sent).toHaveLength(0)
  })
})

// ─── §26/§27 verification ───────────────────────────────────────────────────

describe("verification before notifying", () => {
  it("refuses to verify an open jaw as a round trip", async () => {
    const source = makeObservation()
    const id = makeCandidate({ source_id: source, is_open_jaw: 1, source_table: "open_jaw" })
    await expect(verifyForNotification(db, getCandidate(db, id)!, config))
      .rejects.toThrow(/open jaw/i)
  })
})

// ─── §9/§39 secrets ─────────────────────────────────────────────────────────

describe("secret handling", () => {
  const TOPIC = "my-private-topic-canary"
  const TOKEN = "tk_supersecrettokencanary"

  beforeEach(() => {
    process.env.NTFY_TOPIC = TOPIC
    process.env.NTFY_TOKEN = TOKEN
    process.env.NTFY_SERVER = "https://ntfy.example.com"
  })
  afterEach(() => {
    delete process.env.NTFY_TOPIC
    delete process.env.NTFY_TOKEN
    delete process.env.NTFY_SERVER
  })

  it("scrubs the topic, the token and any URL out of an error string", () => {
    const raw = `connect ECONNREFUSED https://ntfy.example.com/${TOPIC} Bearer ${TOKEN}`
    const clean = redactSecrets(raw)
    expect(containsSecret(raw)).toBe(true)
    expect(containsSecret(clean)).toBe(false)
    expect(clean).not.toContain(TOPIC)
    expect(clean).not.toContain(TOKEN)
  })

  it("never lets a secret reach any column of the notification tables", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const channel = new FailingChannel(
      `POST https://ntfy.example.com/${TOPIC} failed with Bearer ${TOKEN}`, true)
    await pass(channel)

    for (const table of ["notifications", "notification_queue", "notification_events"]) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as any[]
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") expect(containsSecret(value)).toBe(false)
        }
      }
    }
  })

  it("refuses a destination that would put the token on the wire in the clear", () => {
    process.env.NTFY_SERVER = "http://example.com"
    const result = readNtfyConfig()
    expect(result.ok).toBe(false)
    expect((result as any).reason).toBe("invalid")
  })

  it("refuses a server URL carrying a path, which would publish the private topic", () => {
    // POST https://ntfy.sh/travel is ntfy's PLAIN form, where the body becomes
    // the message text - so the JSON document containing the real topic would
    // be published into whatever topic the path names.
    process.env.NTFY_SERVER = "https://ntfy.sh/someone-elses-topic"
    expect(readNtfyConfig().ok).toBe(false)
    process.env.NTFY_SERVER = "https://ntfy.sh"
    expect(readNtfyConfig().ok).toBe(true)
  })

  it("builds a deep link that cannot escape the configured origin", () => {
    const evil = { ...config, deepLink: { baseUrl: "http://localhost:8888", path: "@evil.example/x?c=" } }
    expect(deepLinkFor(42, evil)).toBeNull()
    const protocolRelative = { ...config, deepLink: { baseUrl: "http://localhost:8888", path: "//evil.example/" } }
    expect(deepLinkFor(42, protocolRelative)).toBeNull()
    expect(deepLinkFor(42, config)).toContain("localhost:8888")
    expect(feedLink(config)).toContain("localhost:8888")
  })

  it("cannot be made to inject a header through a candidate field", () => {
    // JSON publishing closes this structurally; the scrubbing is the second
    // layer, and it is what keeps the phone's notification shade readable too.
    const nasty = 'Air\r\nX-Priority: 5\r\nX-Click: https://evil.example'
    expect(scrub(nasty)).not.toMatch(/[\r\n]/)
    expect(scrubBody("line1\r\nline2\u2028line3")).not.toMatch(/[\r\u2028]/)
    // A body keeps its real newlines: they are the formatting.
    expect(scrubBody("a\nb")).toBe("a\nb")
  })

  it("says which host it is pointed at and never which topic", () => {
    const health = new NtfyChannel().health()
    expect(health.detail).toContain("ntfy.example.com")
    expect(health.detail).not.toContain(TOPIC)
    expect(health.detail).not.toContain(TOKEN)
  })
})

// ─── deployment plumbing: the env-gated overrides ───────────────────────────

describe("deployment overrides", () => {
  afterEach(() => {
    delete process.env.NTFY_ALLOW_HTTP_HOST
    delete process.env.NTFY_SERVER
    delete process.env.NTFY_TOPIC
    delete process.env.NOTIFY_BASE_URL
    loadNotificationConfig(true)
  })

  it("allows plain http to exactly the one named internal host, and nothing else", () => {
    process.env.NTFY_TOPIC = "some-topic"
    process.env.NTFY_SERVER = "http://ntfy:2586"

    // Without the opt-in, the Docker-internal hostname is refused - the rule
    // that protects the token stays the default.
    expect(readNtfyConfig().ok).toBe(false)

    process.env.NTFY_ALLOW_HTTP_HOST = "ntfy"
    const allowed = readNtfyConfig()
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.config.origin).toBe("http://ntfy:2586")

    // The allowance is EXACT: naming one host does not open http generally.
    process.env.NTFY_SERVER = "http://evil.example"
    expect(readNtfyConfig().ok).toBe(false)
    process.env.NTFY_SERVER = "http://ntfy.example.com"
    expect(readNtfyConfig().ok).toBe(false)
  })

  it("overrides the deep-link base URL from the environment, still validated", () => {
    process.env.NOTIFY_BASE_URL = "https://vault71.tailec23df.ts.net:8888"
    const overridden = loadNotificationConfig(true)
    expect(deepLinkFor(42, overridden)).toBe(
      "https://vault71.tailec23df.ts.net:8888/deals.html#candidate=42")

    // A malformed override yields NO link rather than a wrong one - the same
    // buildLink assertions apply to the env value as to the committed file.
    process.env.NOTIFY_BASE_URL = "not a url"
    expect(deepLinkFor(42, loadNotificationConfig(true))).toBeNull()
  })
})

// ─── the test message, and what a dry run may do ────────────────────────────

describe("operational commands", () => {
  it("labels the test message unmistakably and involves no candidate", () => {
    const message = renderTest()
    expect(message.title).toBe("TRAVEL RADAR TEST")
    expect(message.body).toContain("No flight, fare or candidate is involved")
    expect(message.clickUrl).toBeNull()
  })

  it("records a test without spending the day's allowance", () => {
    recordEvent(db, { kind: "test", detail: "test notification delivered" })
    expect(immediatesToday(db, localDay(NOW, config))).toBe(0)
  })

  it("evaluates and records in a dry run, but queues and sends nothing", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const channel = new NullChannel()
    const result = await runNotificationPass({
      db, channel, now: NOW, config: { ...config, enabled: true }, dryRun: true,
    })
    expect(result.evaluated).toBeGreaterThan(0)
    expect(channel.sent).toHaveLength(0)
    expect(listNotifications(db)).toHaveLength(0)
    // Decisions ARE recorded - that is what makes the dry run readable.
    expect((db.prepare(`SELECT COUNT(*) c FROM notification_events`).get() as any).c).toBeGreaterThan(0)
  })

  it("classifies retryable and terminal delivery failures apart", () => {
    expect(isRetryable(429)).toBe(true)
    expect(isRetryable(503)).toBe(true)
    expect(isRetryable(403)).toBe(false)
    expect(isRetryable(400)).toBe(false)
  })
})

// ─── the pass must never be able to hurt anything upstream ──────────────────

describe("isolation", () => {
  it("does not throw into its caller when the channel is broken", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const exploding = {
      name: "exploding",
      isConfigured: () => true,
      health: () => ({ channel: "exploding", status: "ok" as const, detail: "", checkedAt: at(0) }),
      send: async () => { throw new Error("boom") },
    }
    const result = await runNotificationPass({
      db, channel: exploding, now: NOW, config: { ...config, enabled: true },
    })
    expect(result.errors.length).toBeGreaterThan(0)
    // The candidate is not lost: the row records what happened.
    expect(listQueue(db)).toHaveLength(1)
  })

  it("leaves deal_candidates.notified alone", async () => {
    // It exists, it is documented as "always 0 in Phase 5", it is per-candidate
    // and candidate ids churn. Anyone reaching for it gets a flag that means
    // nothing; Phase 7 keeps it at zero forever.
    const source = makeObservation()
    makeCandidate({ source_id: source })
    await pass(new NullChannel())
    expect((db.prepare(`SELECT COUNT(*) c FROM deal_candidates WHERE notified <> 0`).get() as any).c).toBe(0)
  })

  it("holds the whole evaluation without an open transaction at send time", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    let sendHappened = false
    let inTransaction = true
    const watcher = {
      name: "watcher",
      isConfigured: () => true,
      health: () => ({ channel: "watcher", status: "ok" as const, detail: "", checkedAt: at(0) }),
      send: async () => {
        // better-sqlite3 transactions are synchronous: an await inside one
        // either throws or holds the write lock across a network round trip.
        sendHappened = true
        inTransaction = db.inTransaction
        return { ok: true, reference: null, status: 200, latencyMs: 1, error: null, retryable: false }
      },
    }
    await runNotificationPass({ db, channel: watcher, now: NOW, config: { ...config, enabled: true } })
    expect(sendHappened).toBe(true)
    expect(inTransaction).toBe(false)
  })
})

// ─── nothing is delivered while the master switch is off ────────────────────

describe("the master switch", () => {
  it("evaluates but never delivers while notifications are disabled", async () => {
    const source = makeObservation()
    makeCandidate({ source_id: source })
    const channel = new NullChannel()
    const result = await runNotificationPass({ db, channel, now: NOW, config })
    expect(result.evaluated).toBeGreaterThan(0)
    expect(result.sent).toBe(0)
    expect(channel.sent).toHaveLength(0)
  })

  it("does not build up a backlog while it is switched off", async () => {
    // A queue that accumulates while delivery is off turns "enable
    // notifications" into an immediate burst of everything the radar has
    // thought since it was turned off - which is the worst possible first
    // impression for a system whose whole asset is being worth reading.
    const source = makeObservation()
    makeCandidate({ source_id: source })
    for (let i = 0; i < 3; i++) {
      await runNotificationPass({ db, channel: new NullChannel(), now: NOW, config })
    }
    expect(listQueue(db)).toHaveLength(0)
    // The decisions are still recorded: that is the shadow record.
    expect((db.prepare(
      `SELECT COUNT(*) c FROM notification_events WHERE kind='decision'`,
    ).get() as any).c).toBeGreaterThan(0)
  })

  it("keeps the committed config off", () => {
    expect(loadNotificationConfig(true).enabled).toBe(false)
  })
})

// ─── unused imports kept honest ─────────────────────────────────────────────
void evaluateNewObservations
void evaluateOpenJaws
void listCandidates
void saveCandidate
void digestSlotFor
