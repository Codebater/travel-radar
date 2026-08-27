/**
 * §2 - open-jaw candidate generation.
 *
 * This is the piece that was missing. `findOpenJaws` could always do the
 * arithmetic, but nothing turned the result into a decision: both evaluation
 * sites hard-coded `isOpenJaw: false`, so the column, the reason codes, the
 * clustering split and the detail panel were all unreachable, and the only
 * caller was a manual CLI command.
 *
 * The obstacle was identity. Every other candidate is a decision ABOUT ONE
 * OBSERVATION - `deal_candidates` is unique on (source_table, source_id) and
 * each row points at one `flight_prices` or `award_prices` id. An open jaw is
 * a decision about TWO observations, and there was nothing for it to point at.
 * So a pair gets a row of its own in `open_jaw_pairs`, holding both leg ids as
 * foreign keys, and the candidate points at that. Everything downstream - the
 * upsert, feedback, withdrawal, clustering, the feed - then works unchanged.
 *
 * Three things this module refuses to do:
 *   - present the pair as one round trip from one seller (§3). Both legs keep
 *     their own price, provider, cabin and timestamp, all the way to the UI;
 *   - invent a saving when no comparable round trip has been observed (§6).
 *     The component is dropped and the reason says so;
 *   - let two cheap one-way fares between unrelated cities become a "deal"
 *     (§7/§8). Cross-city pairings must be configured to exist at all, and the
 *     usefulness of the pairing is scored, not assumed.
 *
 * Like the rest of the engine it is pure database work: no provider is called,
 * so re-judging a year of pairs costs nothing.
 */

import { getDb, nowIso, type DB } from "../db/index.js"
import { loadAnomalyConfig, type AnomalyConfig } from "./config.js"
import { assessCashAbsolute, routeDesirability } from "./absolute.js"
import { checkCashSanity, checkOpenJawSanity } from "./sanity.js"
import { buildComparabilityKey, featuresFor } from "./comparability.js"
import { cashBaselineRows, buildBaseline, noHistoryBaseline } from "./baseline.js"
import { scoreOpenJaw, reasonsFor, matchPresets } from "./scoring.js"
import { saveCandidate } from "./store.js"
import { findOpenJaws } from "../discovery/openjaw.js"
import {
  loadDiscoveryConfig, groupForDestination, isPrimaryOrigin, type DiscoveryConfig,
} from "../discovery/config.js"
import type { OpenJawOption } from "../discovery/types.js"
import type { DealCandidate, OpenJawDetail, OpenJawLegDetail } from "./types.js"

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export interface OpenJawEvaluationSummary {
  arrivalsScanned: number
  combinationsFound: number
  combinationsStored: number
  candidates: number
  belowThreshold: number
  suspicious: number
  noComparator: number
  topScore: number | null
  durationMs: number
}

function emptySummary(): OpenJawEvaluationSummary {
  return {
    arrivalsScanned: 0, combinationsFound: 0, combinationsStored: 0,
    candidates: 0, belowThreshold: 0, suspicious: 0, noComparator: 0,
    topScore: null, durationMs: 0,
  }
}

/**
 * Every arrival airport worth assembling open jaws for: the ones discovery
 * deliberately collects legs for, plus any airport named as the arrival side
 * of a configured cross-city pairing.
 */
export function openJawArrivals(config: DiscoveryConfig): { arrive: string; group: string }[] {
  const sampling = config.openJaw.sampling
  const out = new Map<string, string>()
  for (const group of sampling?.groups ?? []) {
    for (const code of sampling?.airports?.[group] ?? []) out.set(code.toUpperCase(), group)
    for (const pair of config.openJaw.destinationPairs ?? []) {
      if (pair.group === group) out.set(pair.arrive.toUpperCase(), group)
    }
  }
  return [...out.entries()].map(([arrive, group]) => ({ arrive, group }))
}

function toLegDetail(leg: OpenJawOption["outbound"]): OpenJawLegDetail {
  return {
    priceId: leg.priceId,
    origin: leg.origin,
    destination: leg.destination,
    departureDate: leg.departureDate,
    departureTime: leg.departureTime,
    price: leg.price,
    currency: leg.currency,
    provider: leg.provider,
    providerConfidence: leg.providerConfidence,
    verificationLevel: leg.verificationLevel,
    airline: leg.airline,
    stops: leg.stops,
    durationMinutes: leg.durationMinutes,
    baggage: leg.baggage,
    observedAt: leg.observedAt,
  }
}

/**
 * Insert or refresh the pair row. Keyed on the two leg ids, so re-deriving the
 * same combination tomorrow updates one row rather than adding a second - and
 * the candidate that points at it keeps its id, and therefore its feedback.
 */
export function saveOpenJawPair(
  db: DB, option: OpenJawOption, discoveryRunId: number | null,
): number {
  const key = `${option.outbound.priceId}:${option.inbound.priceId}`
  const now = nowIso()
  db.prepare(`
    INSERT INTO open_jaw_pairs (
      pair_key, outbound_price_id, inbound_price_id,
      outbound_origin, outbound_destination, outbound_departure, outbound_price,
      inbound_origin, inbound_destination, inbound_departure, inbound_price,
      cabin, currency, total_price, destination_group, trip_length_nights,
      comparable_round_trip, comparator_price_id, comparator_route, saving, saving_percent,
      transfer_cost, net_saving, friction, usefulness,
      discovery_run_id, first_seen_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(pair_key) DO UPDATE SET
      total_price = excluded.total_price,
      comparable_round_trip = excluded.comparable_round_trip,
      comparator_price_id = excluded.comparator_price_id,
      comparator_route = excluded.comparator_route,
      saving = excluded.saving, saving_percent = excluded.saving_percent,
      transfer_cost = excluded.transfer_cost, net_saving = excluded.net_saving,
      friction = excluded.friction, usefulness = excluded.usefulness,
      destination_group = excluded.destination_group,
      updated_at = excluded.updated_at
  `).run(
    key, option.outbound.priceId, option.inbound.priceId,
    option.outbound.origin, option.outbound.destination, option.outbound.departureDate, option.outbound.price,
    option.inbound.origin, option.inbound.destination, option.inbound.departureDate, option.inbound.price,
    option.cabin, option.currency, option.totalPrice,
    option.destinationPair.group, option.tripLengthNights,
    option.comparableRoundTrip,
    option.comparator?.priceId ?? null,
    option.comparator ? `${option.comparator.origin}-${option.comparator.destination}` : null,
    option.saving, option.savingPercent,
    option.transferCost, option.netSaving, option.friction, option.destinationPair.usefulness,
    discoveryRunId, now, now,
  )
  // NOT lastInsertRowid: an upsert that takes the UPDATE branch leaves it
  // pointing at whatever was inserted last, which would file this candidate
  // against somebody else's pair. The unique key is the only reliable lookup.
  return (db.prepare(`SELECT id FROM open_jaw_pairs WHERE pair_key = ?`).get(key) as { id: number }).id
}

/** Which legs have already been judged unbelievable in their own right. */
function suspiciousLegReasons(
  db: DB, option: OpenJawOption, destinationGroup: string | null, config: AnomalyConfig,
): string[] {
  const out: string[] = []
  for (const [label, leg] of [["outbound", option.outbound], ["inbound", option.inbound]] as const) {
    const own = checkCashSanity({
      price: leg.price, currency: leg.currency, cabin: leg.cabin,
      destinationGroup, stops: leg.stops,
      durationMinutes: leg.durationMinutes, departureDate: leg.departureDate,
    }, config)
    if (own.verdict !== "ok") out.push(`${label} ${leg.origin}-${leg.destination}: ${own.detail}`)

    // And whatever the engine decided about that observation earlier, which may
    // know things this check does not.
    const flagged = db.prepare(`
      SELECT sanity_detail FROM deal_candidates
      WHERE source_table = 'flight_prices' AND source_id = ? AND sanity != 'ok'
    `).get(leg.priceId) as { sanity_detail: string | null } | undefined
    if (flagged) out.push(`${label} leg already flagged: ${flagged.sanity_detail ?? "suspicious"}`)
  }
  return out
}

/** The weaker of two labels, by the config's own ordering. */
function weakest(a: string, b: string, table: Record<string, number>, fallback: number): string {
  return (table[a] ?? fallback) <= (table[b] ?? fallback) ? a : b
}

/** Build the decision for one assembled combination. Never notifies anything. */
export function buildOpenJawCandidate(
  db: DB,
  option: OpenJawOption,
  pairId: number,
  config: AnomalyConfig,
  discoveryConfig: DiscoveryConfig = loadDiscoveryConfig(),
  discoveryRunId: number | null = null,
): DealCandidate {
  const { outbound, inbound } = option
  const asOf = option.asOf
  const group = option.destinationPair.group
    ?? groupForDestination(outbound.destination, discoveryConfig)?.key
    ?? null
  const desirability = group
    ? discoveryConfig.destinationGroups[group]?.desirability ?? 0.75
    : 0.75

  // §6 the baseline is the ROUND TRIP this open jaw competes with, judged from
  // the moment the combination became knowable. Comparing an open-jaw total
  // against a history of one-way fares would be arithmetic between two
  // different things.
  const key = buildComparabilityKey({
    origin: outbound.origin, destination: outbound.destination, cabin: option.cabin,
    departureDate: outbound.departureDate, returnDate: inbound.departureDate,
    stops: Math.max(outbound.stops ?? 0, inbound.stops ?? 0),
  }, config)
  const rows = cashBaselineRows(db, key, asOf, config, option.currency)
  const measured = buildBaseline(rows, key, option.totalPrice, asOf, config)
  const usable = measured && measured.count >= config.minSamplesToEmit ? measured : null
  const baseline = usable ?? noHistoryBaseline(key, asOf)

  // §14 believability, before anything else is allowed to matter.
  const sanity = checkOpenJawSanity({
    outbound: {
      origin: outbound.origin, destination: outbound.destination,
      departureDate: outbound.departureDate, price: outbound.price,
      currency: outbound.currency, cabin: outbound.cabin,
      observedAt: outbound.observedAt, stops: outbound.stops,
      durationMinutes: outbound.durationMinutes,
    },
    inbound: {
      origin: inbound.origin, destination: inbound.destination,
      departureDate: inbound.departureDate, price: inbound.price,
      currency: inbound.currency, cabin: inbound.cabin,
      observedAt: inbound.observedAt, stops: inbound.stops,
      durationMinutes: inbound.durationMinutes,
    },
    totalPrice: option.totalPrice,
    tripLengthNights: option.tripLengthNights,
    destinationGroup: group,
    homeAirports: discoveryConfig.homeRegion.primary,
    suspiciousLegs: suspiciousLegReasons(db, option, group, config),
  }, config)

  const absolute = assessCashAbsolute({
    price: option.totalPrice, currency: option.currency,
    cabin: option.cabin, destinationGroup: group,
  }, config)

  // A pair is only as believable as its weaker half, in both dimensions.
  const providerConfidence = weakest(
    outbound.providerConfidence, inbound.providerConfidence, config.providerConfidenceValues, 0.3)
  const verificationLevel = weakest(
    outbound.verificationLevel, inbound.verificationLevel, config.verificationValues, 0.5)
  const legConfidence = clamp01((
    (config.providerConfidenceValues[providerConfidence] ?? 0.3) +
    (config.verificationValues[verificationLevel] ?? 0.5)
  ) / 2)

  const maxAge = discoveryConfig.openJaw.maxLegAgeDays || 45
  const olderLegAgeDays = Math.max(
    (Date.parse(asOf) - Date.parse(outbound.observedAt)) / 86_400_000,
    (Date.parse(asOf) - Date.parse(inbound.observedAt)) / 86_400_000,
  )
  const legFreshness = clamp01(1 - olderLegAgeDays / maxAge)

  const verificationStatus = sanity.verdict !== "ok"
    ? "suspicious" as const
    : verificationLevel === "verified" ? "verified" as const
    : verificationLevel === "cross-verified" ? "cross-verified" as const
    : "unverified" as const

  const frictionDetail = option.frictionReasons.join("; ")

  const breakdown = scoreOpenJaw({
    totalPrice: option.totalPrice,
    currency: option.currency,
    netSaving: option.netSaving,
    netSavingPercent: option.netSavingPercent,
    baseline,
    legConfidence,
    legConfidenceDetail:
      `weaker leg: ${providerConfidence} confidence, ${verificationLevel} ` +
      `(${outbound.provider} out, ${inbound.provider} back)`,
    legFreshness,
    legFreshnessDetail: `the staler leg was observed ${Math.round(olderLegAgeDays)}d before this ` +
      `combination was assembled (stale at ${maxAge}d)`,
    usefulness: option.destinationPair.usefulness,
    usefulnessDetail: option.destinationPair.arrive === option.destinationPair.depart
      ? `in and out of ${option.destinationPair.arrive}`
      : `${option.destinationPair.arrive} in, ${option.destinationPair.depart} out - ` +
        `${option.destinationPair.note ?? "a configured pairing"}`,
    convenience: option.convenience,
    convenienceDetail: option.convenienceDetail,
    friction: option.friction,
    frictionDetail,
  }, config, {
    absolute,
    routeDesirability: routeDesirability(outbound.destination, group, config, desirability),
    verificationStatus,
  })

  const reasons = reasonsFor({
    type: "cash", cabin: option.cabin,
    stops: Math.max(outbound.stops ?? 0, inbound.stops ?? 0),
    baseline, verificationLevel, config,
    extras: {
      absolute, currency: option.currency, destinationGroup: group,
      discoveredBy: "OPEN_JAW",
      openJaw: {
        saving: option.saving,
        netSaving: option.netSaving,
        savingPercent: option.savingPercent,
        currency: option.currency,
        outboundOrigin: outbound.origin,
        outboundDestination: outbound.destination,
        inboundOrigin: inbound.origin,
        inboundDestination: inbound.destination,
        transferCost: option.transferCost,
        friction: option.friction,
        frictionDetail,
        mixedProvider: option.mixedProvider,
        outboundProvider: outbound.provider,
        inboundProvider: inbound.provider,
      },
      sanity, verificationStatus,
    },
  })

  const detail: OpenJawDetail = {
    pairId,
    outbound: toLegDetail(outbound),
    inbound: toLegDetail(inbound),
    destinationPair: option.destinationPair,
    totalPrice: option.totalPrice,
    transferCost: option.transferCost,
    destinationTransferCost: option.destinationTransferCost,
    homeTransferCost: option.homeTransferCost,
    homeTransfer: option.homeTransfer,
    trueTripCost: option.trueTripCost,
    currency: option.currency,
    tripLengthNights: option.tripLengthNights,
    comparator: option.comparator,
    saving: option.saving,
    savingPercent: option.savingPercent,
    netSaving: option.netSaving,
    netSavingPercent: option.netSavingPercent,
    friction: option.friction,
    frictionReasons: option.frictionReasons,
    mixedProvider: option.mixedProvider,
    legAgeSpreadDays: option.legAgeSpreadDays,
    convenience: option.convenience,
    convenienceDetail: option.convenienceDetail,
    qualifies: option.qualifies,
    note: option.note,
  }

  return {
    sourceTable: "open_jaw",
    sourceId: pairId,
    observedAt: asOf,
    asOf,
    evaluatedAt: new Date().toISOString(),
    type: "cash",
    origin: outbound.origin,
    destination: outbound.destination,
    // Four airports in the route, because four airports is what this trip is.
    // It is also what keeps an open jaw from ever colliding with the ordinary
    // round trip on the same pair in the listing and the clustering (§11).
    route: `${outbound.origin}-${outbound.destination}/${inbound.origin}-${inbound.destination}`,
    departureDate: outbound.departureDate,
    returnDate: inbound.departureDate,
    tripType: "return",
    cabin: option.cabin,
    airline: outbound.airline === inbound.airline ? outbound.airline : null,
    stops: Math.max(outbound.stops ?? 0, inbound.stops ?? 0),
    itineraryHash: `${outbound.itineraryHash}+${inbound.itineraryHash}`,
    loyaltyProgram: null,
    priceAmount: option.totalPrice,
    priceCurrency: option.currency,
    points: null,
    taxesAmount: null,
    taxesCurrency: null,
    baseline,
    cpp: null,
    programComparison: null,
    // §3 never one provider quoting a round trip. Even when both legs came
    // from the same seller, this says out loud that it is two tickets.
    provider: outbound.provider === inbound.provider
      ? `${outbound.provider} (two tickets)`
      : `${outbound.provider} + ${inbound.provider}`,
    providerConfidence,
    verificationLevel,
    score: breakdown.score,
    scoreBreakdown: breakdown,
    reasons,
    features: featuresFor({
      departureDate: outbound.departureDate,
      returnDate: inbound.departureDate,
      observedAt: asOf,
    }),
    presetsMatched: matchPresets({ type: "cash", score: breakdown.score, baseline, config }),
    threshold: config.candidateThreshold,
    status: sanity.verdict === "ok" && breakdown.score >= config.candidateThreshold
      ? "candidate" : "below-threshold",
    engineVersion: config.engineVersion,
    discoveredBy: "OPEN_JAW",
    discoveryRunId,
    destinationGroup: group,
    tripLengthNights: option.tripLengthNights,
    absoluteTier: absolute.tier,
    sanity: sanity.verdict,
    sanityDetail: sanity.detail || null,
    verificationStatus,
    requiresPositioning: !isPrimaryOrigin(outbound.origin, discoveryConfig),
    positioning: null,
    positioningPenalty: null,
    trueTripStartCost: null,
    isOpenJaw: true,
    openJaw: detail,
    clusterId: null,
  }
}

export interface EvaluateOpenJawOptions {
  db?: DB
  config?: AnomalyConfig
  discoveryConfig?: DiscoveryConfig
  discoveryRunId?: number | null
  /** Restrict to these arrival airports. Defaults to every configured one. */
  arrivals?: string[]
  cabins?: string[]
  currency?: string
  /** How far ahead to look for departures. */
  horizonDays?: number
  now?: Date
  quiet?: boolean
}

/**
 * Assemble and judge every configured open-jaw combination.
 *
 * Bounded on purpose. Every combination that clears the saving floor is
 * stored, plus the BEST rejected one for each pairing - so "no open jaw here"
 * is backed by visible arithmetic rather than being a blank (§19), without a
 * hundred near-identical losers filling the table.
 */
export function evaluateOpenJaws(
  options: EvaluateOpenJawOptions = {},
): OpenJawEvaluationSummary {
  const db = options.db ?? getDb()
  const config = options.config ?? loadAnomalyConfig()
  const discoveryConfig = options.discoveryConfig ?? loadDiscoveryConfig()
  const summary = emptySummary()
  const started = Date.now()
  if (!discoveryConfig.openJaw.enabled) return { ...summary, durationMs: Date.now() - started }

  const now = options.now ?? new Date()
  const currency = options.currency ?? process.env.CASH_CURRENCY ?? "USD"
  const cabins = options.cabins ?? ["economy", "business"]
  const horizon = options.horizonDays ?? 200
  const window = {
    from: now.toISOString().slice(0, 10),
    to: new Date(now.getTime() + horizon * 86_400_000).toISOString().slice(0, 10),
  }

  const wanted = options.arrivals?.map(a => a.toUpperCase())
  const arrivals = openJawArrivals(discoveryConfig)
    .filter(a => !wanted || wanted.includes(a.arrive))

  for (const { arrive, group } of arrivals) {
    for (const cabin of cabins) {
      summary.arrivalsScanned++
      const found = findOpenJaws(db, arrive, {
        cabin, currency,
        asOf: now.toISOString(),
        window,
        tripLengths: discoveryConfig.destinationGroups[group]?.tripLengths ?? [7, 10, 14],
        // Losers are wanted here: the engine decides what to keep, and a
        // rejected combination with its arithmetic attached is a far more
        // useful answer than an empty list.
        includeNonQualifying: true,
      }, discoveryConfig)
      summary.combinationsFound += found.length

      const bestRejectedPerPairing = new Map<string, OpenJawOption>()
      const keep: OpenJawOption[] = []
      for (const option of found) {
        const pairing = [
          option.outbound.origin, option.destinationPair.arrive,
          option.destinationPair.depart, option.inbound.destination, option.cabin,
        ].join("|")
        if (option.qualifies) keep.push(option)
        else if (!bestRejectedPerPairing.has(pairing)) bestRejectedPerPairing.set(pairing, option)
      }
      keep.push(...bestRejectedPerPairing.values())

      for (const option of keep) {
        const pairId = saveOpenJawPair(db, option, options.discoveryRunId ?? null)
        const candidate = buildOpenJawCandidate(
          db, option, pairId, config, discoveryConfig, options.discoveryRunId ?? null,
        )
        saveCandidate(db, candidate)
        summary.combinationsStored++
        if (candidate.status === "candidate") summary.candidates++
        else summary.belowThreshold++
        if (candidate.sanity !== "ok") summary.suspicious++
        if (option.comparableRoundTrip === null) summary.noComparator++
        if (summary.topScore === null || candidate.score > summary.topScore) {
          summary.topScore = candidate.score
        }
      }
    }
  }

  summary.durationMs = Date.now() - started
  if (!options.quiet && summary.combinationsStored > 0) {
    console.log(
      `OPEN JAW (shadow, no alerts): ${summary.combinationsFound} combinations assembled from ` +
      `stored legs, ${summary.combinationsStored} recorded, ${summary.candidates} at or above ` +
      `${config.candidateThreshold}, ${summary.noComparator} with no comparable round trip, ` +
      `${summary.durationMs}ms`,
    )
  }
  return summary
}
