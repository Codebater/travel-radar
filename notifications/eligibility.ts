/**
 * §2 - a score alone can never trigger a notification.
 *
 * The score says "this looks exceptional". The gates below ask the questions a
 * score cannot answer: is the data believable, does the price still exist, on
 * what evidence, is this the same thing we already said, did the operator tell
 * us it was a bad signal, and have we already spent today's attention.
 *
 * Ordering is deliberate: cheap and unfalsifiable first, money last. A
 * candidate blocked by a hard blocker must never reach the code that spends a
 * metered call to confirm it.
 *
 * The evaluator is PURE and SYNCHRONOUS. It performs no network request and
 * spends nothing; verification is SIGNALLED (`needsVerification`) and carried
 * out by the dispatcher, which is the only place allowed to spend. One `now` is
 * threaded through every gate, because freshness, quiet hours and rate limits
 * reading three different clocks is a bug that only appears at a boundary.
 */

import type { DB } from "../db/index.js"
import { confidenceAtLeast, loadAnomalyConfig, type AnomalyConfig } from "../anomaly/config.js"
import type { ConfidenceLabel } from "../anomaly/types.js"
import type { StoredCandidate } from "../anomaly/store.js"
import { assessCashAbsolute } from "../anomaly/absolute.js"
import { groupForDestination, loadDiscoveryConfig } from "../discovery/config.js"
import { amountFor, loadNotificationConfig, type NotificationConfig } from "./config.js"
import { identityFor, validIata } from "./identity.js"
import { measureFreshness, type FreshnessResult } from "./freshness.js"

export type Gate =
  | "HARD_BLOCK" | "FRESHNESS" | "SCORE" | "EVIDENCE" | "STRUCTURE"
  | "DEDUP" | "FEEDBACK" | "REALERT" | "RATE_LIMIT" | "VERIFY"

export interface EvidenceSnapshot {
  score: number
  type: string
  cabin: string
  route: string
  loyaltyProgram: string | null
  currency: string | null
  priceAmount: number | null
  points: number | null
  taxesAmount: number | null
  /** What the trip costs to BEGIN: true start cost, open-jaw all-in, or the fare. */
  effectiveCost: number | null
  openJawTotal: number | null
  openJawNetSaving: number | null
  openJawComparator: number | null
  verificationStatus: string
  baselineConfidence: string
  sampleSize: number
}

export interface Verdict {
  candidateId: number
  eligible: boolean
  kind: "immediate" | "digest" | "bypass" | null
  gatesEvaluated: Gate[]
  firstBlocker: string | null
  /** EVERY blocker that fired, not just the first. */
  allBlockers: string[]
  reasons: { code: string; detail: string }[]
  opportunityKey: string
  fingerprint: string
  cooldownKey: string
  evidenceBasis: "baseline" | "verified" | "cross-verified" | "absolute-low-history" | null
  labels: string[]
  economics: EvidenceSnapshot
  needsVerification: boolean
  /** True for a candidate close enough to the bar that its silence is worth recording. */
  nearMiss: boolean
  isReAlert: boolean
  improvement: string | null
  freshness: FreshnessResult
}

export interface EligibilityOptions {
  now?: Date
  config?: NotificationConfig
  anomalyConfig?: AnomalyConfig
  /** Providers currently in an error/auth-failure state, from the caller's single lookup. */
  brokenProviders?: Set<string>
  /** Opportunity keys the operator has marked BAD_SIGNAL, precomputed once per pass. */
  badSignalKeys?: Set<string>
  /** Immediate notifications already sent or in flight today, Prague time. */
  immediatesToday?: number
  /** The channel's configuration state, so a broken channel is a recorded decision. */
  channelStatus?: "ok" | "unconfigured" | "error"
}

const CONFIDENCE_ORDER: Record<string, number> = { low: 0.3, medium: 0.6, high: 1 }

function snapshot(c: StoredCandidate, openJawTotal: number | null): EvidenceSnapshot {
  const effective = c.isOpenJaw
    ? openJawTotal ?? c.openJaw?.trueTripCost ?? null
    : c.trueTripStartCost ?? c.priceAmount
  return {
    score: c.score,
    type: c.type,
    cabin: c.cabin,
    route: c.route,
    loyaltyProgram: c.loyaltyProgram,
    currency: c.priceCurrency ?? c.taxesCurrency,
    priceAmount: c.priceAmount,
    points: c.points,
    taxesAmount: c.taxesAmount,
    effectiveCost: effective,
    openJawTotal,
    openJawNetSaving: c.openJaw?.netSaving ?? null,
    openJawComparator: c.openJaw?.comparator?.price ?? null,
    verificationStatus: c.verificationStatus,
    baselineConfidence: c.baseline.confidence,
    sampleSize: c.baseline.count,
  }
}

/**
 * The live open-jaw economics, read from `open_jaw_pairs` rather than from the
 * candidate's JSON blob.
 *
 * `saveCandidate`'s upsert rewrites `score` and `sanity` but never
 * `price_amount`, and the open-jaw JSON is written once. The pair row is the
 * thing `evaluateOpenJaws` keeps current, so it is the thing to trust.
 */
function livePairEconomics(db: DB, candidate: StoredCandidate): {
  total: number | null
  netSaving: number | null
  comparator: number | null
  friction: number | null
  currency: string | null
  comparatorCurrency: string | null
  inboundDeparture: string | null
  outboundDeparture: string | null
} {
  if (candidate.sourceTable !== "open_jaw") {
    return {
      total: null, netSaving: null, comparator: null, friction: null,
      currency: null, comparatorCurrency: null, inboundDeparture: null, outboundDeparture: null,
    }
  }
  const row = db.prepare(`
    SELECT p.total_price, p.transfer_cost, p.net_saving, p.comparable_round_trip,
           p.friction, p.currency, p.outbound_departure, p.inbound_departure,
           (SELECT c.price_currency FROM flight_prices c WHERE c.id = p.comparator_price_id) comparatorCurrency,
           p.comparator_price_id
    FROM open_jaw_pairs p WHERE p.id = ?
  `).get(candidate.sourceId) as any
  if (!row) {
    return {
      total: null, netSaving: null, comparator: null, friction: null,
      currency: null, comparatorCurrency: null, inboundDeparture: null, outboundDeparture: null,
    }
  }
  return {
    total: Math.round((row.total_price + (row.transfer_cost ?? 0)) * 100) / 100,
    netSaving: row.net_saving ?? null,
    // A comparator price with no row behind it is "no comparator", not a
    // number worth trusting: comparator_price_id is ON DELETE SET NULL.
    comparator: row.comparator_price_id === null ? null : row.comparable_round_trip ?? null,
    friction: row.friction ?? null,
    currency: row.currency ?? null,
    comparatorCurrency: row.comparatorCurrency ?? null,
    outboundDeparture: row.outbound_departure ?? null,
    inboundDeparture: row.inbound_departure ?? null,
  }
}

/** Providers this candidate actually rests on. Composed strings resolve to legs. */
function providersFor(db: DB, c: StoredCandidate): string[] {
  if (c.sourceTable === "open_jaw") {
    // `deal_candidates.provider` for an open jaw is a composed label
    // ("a + b", "x (two tickets)") that will never equal a provider_events
    // value, so the legs are resolved instead.
    const rows = db.prepare(`
      SELECT DISTINCT fp.provider FROM open_jaw_pairs p
      JOIN flight_prices fp ON fp.id IN (p.outbound_price_id, p.inbound_price_id)
      WHERE p.id = ?
    `).all(c.sourceId) as { provider: string }[]
    return rows.map(r => r.provider)
  }
  return [c.provider]
}

export function evaluateEligibility(
  db: DB, candidate: StoredCandidate, options: EligibilityOptions = {},
): Verdict {
  const now = options.now ?? new Date()
  const config = options.config ?? loadNotificationConfig()
  const anomalyConfig = options.anomalyConfig ?? loadAnomalyConfig()
  const pair = livePairEconomics(db, candidate)
  const identity = identityFor({ candidate, openJawTotal: pair.total })

  const gates: Gate[] = []
  const blockers: string[] = []
  const reasons: { code: string; detail: string }[] = []
  const labels: string[] = []
  const block = (code: string, detail: string) => {
    if (!blockers.includes(code)) blockers.push(code)
    reasons.push({ code, detail })
  }

  const economics = snapshot(candidate, pair.total)

  // ── Gate 1: hard blockers ────────────────────────────────────────────────
  // Runs to COMPLETION rather than returning on the first hit. A candidate can
  // be both STALE and SUSPICIOUS_DATA, and reporting only the first hides that
  // the data was garbage as well as old.
  gates.push("HARD_BLOCK")

  if (candidate.sanity !== "ok") {
    block("SUSPICIOUS_DATA", candidate.sanityDetail || "the engine flagged this observation as implausible")
  }
  if (!validIata(candidate.origin) || !validIata(candidate.destination)) {
    block("SUSPICIOUS_DATA", `route "${candidate.route}" does not consist of IATA codes - a provider is returning something unexpected`)
  }
  if (candidate.verificationStatus === "suspicious") {
    block("VERIFICATION_FAILED", "this price is marked suspicious rather than confirmed")
  }

  // Itinerary shape is RECOMPUTED here rather than inferred from a stored flag.
  const departureMs = Date.parse(`${candidate.departureDate}T00:00:00Z`)
  if (!Number.isFinite(departureMs)) {
    block("INVALID_ITINERARY", `departure date "${candidate.departureDate}" is not a date`)
  }
  if (candidate.returnDate && candidate.returnDate <= candidate.departureDate) {
    block("INVALID_ITINERARY", `the return ${candidate.returnDate} is on or before the outbound ${candidate.departureDate}`)
  }
  if (candidate.tripLengthNights !== null && candidate.tripLengthNights <= 0 && candidate.tripType === "return") {
    block("INVALID_ITINERARY", `${candidate.tripLengthNights} nights is not a trip`)
  }
  if (candidate.sourceTable === "open_jaw" && pair.outboundDeparture && pair.inboundDeparture
      && pair.inboundDeparture <= pair.outboundDeparture) {
    block("INVALID_ITINERARY", `the return leg departs ${pair.inboundDeparture}, on or before the outbound ${pair.outboundDeparture}`)
  }

  // The baseline key records the trip type it was built for. If the decision
  // was judged against the wrong shape, the percentage that got it here is
  // meaningless.
  const baselineTripType = candidate.baseline.key.split("|")[3]
  if (baselineTripType && baselineTripType !== candidate.tripType) {
    block("TRIP_TYPE_MISMATCH", `judged as ${candidate.tripType} against a ${baselineTripType} baseline`)
  }

  // Currency comparisons: adding or comparing two currencies produces a number
  // in neither of them.
  if (candidate.sourceTable === "open_jaw" && pair.currency && pair.comparatorCurrency
      && pair.currency !== pair.comparatorCurrency) {
    block("BAD_CURRENCY_COMPARISON", `the jaw is priced in ${pair.currency} and its comparator in ${pair.comparatorCurrency}`)
  }
  if (candidate.cpp && candidate.cpp.cashProvenance.currency && candidate.taxesCurrency
      && candidate.cpp.cashProvenance.currency !== candidate.taxesCurrency) {
    block("BAD_CURRENCY_COMPARISON", `CPP compares ${candidate.taxesCurrency} surcharges against ${candidate.cpp.cashProvenance.currency} fares`)
  }

  const broken = options.brokenProviders
  if (broken && broken.size > 0) {
    const failing = providersFor(db, candidate).filter(p => broken.has(p))
    if (failing.length > 0) {
      block("PROVIDER_ERROR", `${failing.join(", ")} ${failing.length > 1 ? "are" : "is"} currently failing - its numbers are not worth acting on`)
    }
  }

  if (options.channelStatus === "error") {
    block("CHANNEL_MISCONFIGURED", "the notification channel is configured but unusable")
  }

  // ── Gate 2: freshness, measured from the OBSERVATION ─────────────────────
  gates.push("FRESHNESS")
  const freshness = measureFreshness(db, candidate, now)
  if (freshness.withdrawn) {
    block("WITHDRAWN", freshness.detail)
  } else {
    const limit = candidate.isOpenJaw
      ? config.freshness.maxOpenJawLegAgeHours
      : config.freshness.maxObservationAgeHours
    if (freshness.oldestAgeHours === null) {
      block("STALE", "no observation timestamp could be resolved for this decision")
    } else if (freshness.oldestAgeHours > limit) {
      block("STALE", `${freshness.detail} - older than the ${limit}h limit`)
    }
    if (freshness.comparatorAgeHours !== null
        && freshness.comparatorAgeHours > config.freshness.maxComparatorAgeHours) {
      block("STALE", `the round trip it is compared against was last seen ${freshness.comparatorAgeHours}h ago`)
    }
  }
  if (freshness.departureLeadDays !== null) {
    if (freshness.departureLeadDays < config.freshness.minDepartureLeadDays) {
      block("DEPARTURE_TOO_SOON", `departs in ${freshness.departureLeadDays} days`)
    }
    if (freshness.departureLeadDays > config.freshness.maxDepartureLeadDays) {
      block("DEPARTURE_TOO_FAR", `departs in ${freshness.departureLeadDays} days`)
    }
  }

  // ── Gate 3: score ────────────────────────────────────────────────────────
  //
  // The low-history exception carries its OWN, lower bar, and the score gate
  // has to know about it. config/anomaly.json caps every zero-history candidate
  // at exactly 85 (noHistoryScoreCap), so against a threshold of 90 the
  // exception would be unreachable by construction - the evidence gate would
  // approve a candidate the score gate had already refused. Reaching for the
  // scoring config to fix that would re-score thousands of stored decisions to
  // solve a notification-policy problem.
  gates.push("SCORE")
  const exceptionConfig = config.evidence.absoluteException

  // Worked out before the score gate, because the score gate needs to know
  // whether this candidate is RELYING on the exception. A candidate that has
  // real evidence - a decent baseline, or a confirmed price - faces the full
  // threshold: the exception exists to rescue the population that cannot reach
  // it, not to discount the bar for everybody who happens to be cheap.
  //
  // Without this scoping the live database made the exception the DEFAULT path:
  // a verified PRG-BKK fare with 17 observations was let through at 87.6
  // against a threshold of 90, purely because it also carried a WTF tier.
  const hasOwnEvidence =
    (candidate.baseline.count > 0 && confidenceAtLeast(
      candidate.baseline.confidence as ConfidenceLabel,
      config.evidence.minBaselineConfidence as ConfidenceLabel))
    || (config.evidence.acceptVerified && candidate.verificationStatus === "verified")
    || (config.evidence.acceptCrossVerified && candidate.verificationStatus === "cross-verified")

  const qualifiesForException = exceptionConfig.enabled
    && !hasOwnEvidence
    && candidate.absoluteTier === exceptionConfig.minTier
    && (CONFIDENCE_ORDER[candidate.providerConfidence] ?? 0)
      >= (CONFIDENCE_ORDER[exceptionConfig.minProviderConfidence] ?? 1)
  const scoreBar = qualifiesForException
    ? Math.min(config.threshold, exceptionConfig.minScore ?? config.threshold)
    : config.threshold
  const nearMiss = candidate.score >= scoreBar - (config.pass?.nearMissBand ?? 10)
  if (candidate.score < scoreBar) {
    block("BELOW_NOTIFY_THRESHOLD",
      `${candidate.score} is below the ${scoreBar} notification threshold` +
      (scoreBar !== config.threshold ? ` (the low-history exception's own bar)` : ""))
  }

  // ── Gate 4: evidence ─────────────────────────────────────────────────────
  gates.push("EVIDENCE")
  let evidenceBasis: Verdict["evidenceBasis"] = null
  if (candidate.baseline.count > 0 && confidenceAtLeast(
        candidate.baseline.confidence as ConfidenceLabel,
        config.evidence.minBaselineConfidence as ConfidenceLabel)) {
    evidenceBasis = "baseline"
  } else if (config.evidence.acceptVerified && candidate.verificationStatus === "verified") {
    evidenceBasis = "verified"
  } else if (config.evidence.acceptCrossVerified && candidate.verificationStatus === "cross-verified") {
    evidenceBasis = "cross-verified"
  } else if (exceptionConfig.enabled) {
    // §4 the low-history exception, and the only route by which a candidate
    // with no history at all may speak. Deliberately narrow: the WTF tier
    // means "this should not be possible", and it still gets labelled so the
    // message never implies statistical weight it does not have.
    if (qualifiesForException && candidate.score >= (exceptionConfig.minScore ?? config.threshold)) {
      evidenceBasis = "absolute-low-history"
      labels.push(exceptionConfig.label)
    }
  }
  if (evidenceBasis === null) {
    block("THIN_BASELINE",
      `${candidate.baseline.count} prior comparable observations (${candidate.baseline.confidence}), ` +
      `not verified, and no absolute rule strong enough to stand alone`)
  }

  // ── Gate 5: structure - open jaw and positioning ─────────────────────────
  //
  // NOT redundant with the evidence gate, and the live database proves it. The
  // PRG-HKT/HKT-VIE open jaw has HIGHER confidence over 65 observations and
  // reads 22.9% below a 1085 median - it passes the evidence gate cleanly. But
  // that median is the historical median of PRG-HKT ROUND TRIPS, while the
  // thing actually purchasable that day is a 516 USD return, and the jaw costs
  // 863. Only this gate ever sees the 516.
  gates.push("STRUCTURE")
  if (candidate.isOpenJaw) {
    const oj = config.openJaw
    const currency = pair.currency ?? candidate.priceCurrency
    const net = pair.netSaving
    const comparator = pair.comparator

    if (pair.friction !== null && pair.friction > oj.maxFriction) {
      block("OPEN_JAW_HIGH_FRICTION", `friction ${pair.friction} is above the ${oj.maxFriction} limit`)
    }
    if (comparator === null) {
      if (!oj.allowWithoutComparator) {
        block("OPEN_JAW_NO_COMPARATOR", "no comparable round trip has been observed")
      } else {
        // Without a comparator there is no saving to state, so absolute price
        // is the only honest ground left to stand on.
        const group = groupForDestination(candidate.destination, loadDiscoveryConfig())?.key ?? null
        const absolute = assessCashAbsolute({
          price: pair.total ?? Number.POSITIVE_INFINITY,
          currency: currency ?? "USD", cabin: candidate.cabin, destinationGroup: group,
        }, anomalyConfig)
        if (absolute.tier !== "wtf") {
          block("OPEN_JAW_NOT_BENEFICIAL",
            `no comparable round trip has been observed, and ${pair.total} ${currency ?? ""} does not clear ` +
            `the absolute WTF tier on its own`)
        } else {
          labels.push("NO ROUND-TRIP COMPARATOR")
        }
      }
    } else {
      const percent = comparator > 0 && net !== null
        ? Math.round((net / comparator) * 1000) / 10
        : null
      const floor = amountFor(oj.minNetSaving, currency)
      if (net === null || net <= 0 || percent === null
          || percent < oj.minNetSavingPercent || net < floor) {
        block("OPEN_JAW_NOT_BENEFICIAL",
          `${pair.total} ${currency ?? ""} all-in against a ${comparator} ${currency ?? ""} comparable return - ` +
          `${net === null ? "no saving computed" : net <= 0 ? `it costs ${Math.abs(net)} MORE` : `saves ${net} (${percent}%), below the ${oj.minNetSavingPercent}% / ${floor} floor`}`)
      }
    }
  }

  if (candidate.requiresPositioning) {
    const p = config.positioning
    const positioning = candidate.positioning as any
    if (!positioning) {
      // anomaly/openjaw.ts sets requiresPositioning from the origin while
      // leaving positioning null, so "we never worked out what this really
      // costs" is a block, never a pass.
      block("POSITIONING_UNEVALUATED", "this trip does not start from a home airport and its true start cost was never computed")
    } else {
      if (positioning.worthwhile !== true) {
        block("POSITIONING_NOT_WORTHWHILE", positioning.note || "the saving does not justify the positioning")
      }
      if ((candidate.positioningPenalty ?? 1) > p.maxPenalty) {
        block("POSITIONING_HIGH_PENALTY", `inconvenience ${candidate.positioningPenalty} is above the ${p.maxPenalty} limit`)
      }
      if (p.requireHomeComparator && positioning.comparableHomeFare == null) {
        block("POSITIONING_NO_HOME_FARE", "no fare from a home airport has been observed to compare against")
      } else if (positioning.savingPercent != null && positioning.savingVsHome != null) {
        const floor = amountFor(p.minSaving, positioning.currency ?? candidate.priceCurrency)
        if (positioning.savingPercent < p.minSavingPercent || positioning.savingVsHome < floor) {
          block("POSITIONING_SAVING_TOO_SMALL",
            `${positioning.savingVsHome} (${positioning.savingPercent}%) against the home airport, ` +
            `below the ${p.minSavingPercent}% / ${floor} floor`)
        }
      }
    }
  }

  // ── Gate 6: dedup ────────────────────────────────────────────────────────
  gates.push("DEDUP")
  const already = db.prepare(
    `SELECT id, sent_at, score, effective_cost, points, taxes_amount, open_jaw_total,
            verification_status
     FROM notifications WHERE fingerprint = ? ORDER BY sent_at DESC LIMIT 1`,
  ).get(identity.fingerprint) as any
  if (already) {
    block("ALREADY_SENT", `identical economics were sent at ${already.sent_at}`)
  }

  // A delivery that has already given up must not be re-queued on the next
  // tick. Without this the retry ladder is decorative: three attempts, FAILED,
  // and then a fresh queue row a minute later, forever. UNKNOWN is included for
  // the same reason it exists - it may already have been delivered.
  const abandoned = db.prepare(
    `SELECT status, updated_at FROM notification_queue
     WHERE fingerprint = ? AND status IN ('FAILED','UNKNOWN','SUPPRESSED')
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(identity.fingerprint) as { status: string; updated_at: string } | undefined
  if (abandoned) {
    const since = (now.getTime() - Date.parse(abandoned.updated_at)) / 3600_000
    if (Number.isFinite(since) && since < config.reAlert.cooldownHours) {
      block("RECENTLY_ABANDONED",
        `an identical notification ended as ${abandoned.status} ${Math.round(since)}h ago; ` +
        `not retried until the ${config.reAlert.cooldownHours}h cooldown passes`)
    }
  }

  // ── Gate 7: operator feedback, resolved by OPPORTUNITY ───────────────────
  //
  // Not by candidate id: deal_feedback.candidate_id cascades away when a
  // candidate is withdrawn, and candidate ids churn, so a BAD_SIGNAL would
  // silently evaporate and the same bad deal would alert again under a new id.
  gates.push("FEEDBACK")
  if (options.badSignalKeys?.has(identity.opportunityKey)) {
    block("USER_BAD_SIGNAL", "the operator marked this opportunity as a bad signal")
  }

  // ── Gate 8: re-alert, comparing NUMBERS to numbers ───────────────────────
  gates.push("REALERT")
  const previous = db.prepare(
    `SELECT id, sent_at, score, effective_cost, points, taxes_amount, open_jaw_total,
            verification_status, cooldown_key
     FROM notifications WHERE opportunity_key = ? ORDER BY sent_at DESC LIMIT 1`,
  ).get(identity.opportunityKey) as any

  let isReAlert = false
  let improvement: string | null = null
  if (previous && !already) {
    isReAlert = true
    const r = config.reAlert
    const improvements: string[] = []
    const better = (before: number | null | undefined, after: number | null | undefined, percent: number) =>
      before != null && after != null && before > 0 && ((before - after) / before) * 100 >= percent

    if (candidate.isOpenJaw) {
      // ONLY the combined total. A new pair id, a new candidate id, or one leg
      // being re-observed are not inputs - they change every tick.
      if (better(previous.open_jaw_total, pair.total, r.minOpenJawTotalImprovementPercent)) {
        improvements.push(`total down from ${previous.open_jaw_total} to ${pair.total}`)
      }
    } else if (candidate.type === "award") {
      if (better(previous.points, candidate.points, r.minPointsImprovementPercent)) {
        improvements.push(`${previous.points} → ${candidate.points} points`)
      }
      if (better(previous.taxes_amount, candidate.taxesAmount, r.minTaxesImprovementPercent)) {
        improvements.push(`surcharge ${previous.taxes_amount} → ${candidate.taxesAmount}`)
      }
    } else if (better(previous.effective_cost, economics.effectiveCost, r.minCashImprovementPercent)) {
      improvements.push(`${previous.effective_cost} → ${economics.effectiveCost}`)
    }

    if (r.verificationUpgradeCounts
        && previous.verification_status === "unverified"
        && (candidate.verificationStatus === "verified" || candidate.verificationStatus === "cross-verified")) {
      improvements.push(`now ${candidate.verificationStatus}`)
    }
    if (candidate.score - (previous.score ?? 0) >= r.minScoreImprovement) {
      improvements.push(`score ${previous.score} → ${candidate.score}`)
    }

    if (improvements.length === 0) {
      block("NO_MATERIAL_IMPROVEMENT",
        `already alerted at ${previous.sent_at}; nothing has materially improved since`)
    } else {
      improvement = `Improved: ${improvements.join("; ")}`
    }
  }

  // ── Gate 9: rate limits and the cluster cooldown ─────────────────────────
  gates.push("RATE_LIMIT")
  const cooldownSince = new Date(now.getTime() - config.rateLimits.clusterCooldownHours * 3600_000).toISOString()
  const recentOnRoute = db.prepare(
    `SELECT sent_at FROM notifications WHERE cooldown_key = ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`,
  ).get(identity.cooldownKey, cooldownSince) as { sent_at: string } | undefined
  if (recentOnRoute) {
    block("CLUSTER_COOLDOWN",
      `this route was alerted at ${recentOnRoute.sent_at}, inside the ` +
      `${config.rateLimits.clusterCooldownHours}h cooldown`)
  }

  const quiet = options.immediatesToday ?? 0
  const capReached = quiet >= config.rateLimits.maxImmediatePerDay

  // ── Gate 10: does this want a paid confirmation before it interrupts? ────
  gates.push("VERIFY")
  const needsVerification = config.verifyBeforeNotify.enabled
    && candidate.type === "cash"
    && !candidate.isOpenJaw
    && candidate.verificationStatus === "unverified"

  // ── Assemble ─────────────────────────────────────────────────────────────
  const hardBlocked = blockers.length > 0
  const eligible = !hardBlocked

  // §18 the bypass is about the CLOCK, not the evidence: it still had to pass
  // every gate above to get here.
  const bypassCorroborated = candidate.verificationStatus === "verified"
    || candidate.verificationStatus === "cross-verified"
    || candidate.absoluteTier === "wtf"
    || (isReAlert && improvement !== null)
  const bypass = eligible
    && config.extremeBypass.enabled
    && candidate.score >= config.extremeBypass.minScore
    && bypassCorroborated
    // A low-history absolute exception never bypasses quiet hours: it is the
    // weakest evidence the system accepts at all.
    && evidenceBasis !== "absolute-low-history"

  let kind: Verdict["kind"] = null
  if (eligible) {
    if (bypass) kind = "bypass"
    else if (capReached) kind = "digest"
    else kind = "immediate"
  }
  // The daily cap does not BLOCK; it moves the alert into the digest, which is
  // what "queued/suppressed appropriately" means for a cap rather than a fault.
  if (eligible && capReached && !bypass) {
    reasons.push({
      code: "DAILY_CAP",
      detail: `${quiet}/${config.rateLimits.maxImmediatePerDay} immediate notifications already today - queued for the digest`,
    })
  }

  return {
    candidateId: candidate.id,
    eligible,
    kind,
    gatesEvaluated: gates,
    firstBlocker: blockers[0] ?? null,
    allBlockers: blockers,
    reasons,
    opportunityKey: identity.opportunityKey,
    fingerprint: identity.fingerprint,
    cooldownKey: identity.cooldownKey,
    evidenceBasis,
    labels,
    economics,
    needsVerification: eligible && needsVerification,
    nearMiss,
    isReAlert,
    improvement,
    freshness,
  }
}
