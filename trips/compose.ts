/**
 * The Trip Composer: join flight opportunities to stay opportunities into
 * feasible complete trips, and judge the TRIP.
 *
 * Search discipline: never a Cartesian product. Composition starts from stay
 * opportunity WINDOWS (already the strong end of the stay side), fetches
 * only flights touching each window's airports and date range, keeps the
 * best few flight options per stay, and stops at hard ceilings — every
 * ceiling that bites is reported.
 *
 * Judgement discipline (all inherited): components drop-and-renormalise when
 * uncomputable and keep real zeros; complexity is a PENALTY (subtracted,
 * never outvoted); an absurdly overpriced component kills the trip no matter
 * how good its partner is; cash and miles never blend; unknown costs are
 * named, never zeroed.
 */

import type { DB } from "../db/index.js"
import { loadAnomalyConfig } from "../anomaly/config.js"
import { assessCashAbsolute, assessAwardAbsolute } from "../anomaly/absolute.js"
import { loadStaysConfig } from "../stays/config.js"
import { listStayWindows, type StayWindowRow } from "../stays/windows.js"
import { getStayCandidate, listStayCandidates } from "../stays/candidates.js"
import { getStayProperty } from "../stays/registry.js"
import type { TripsConfig } from "./config.js"
import { tripKey, reasonsFor } from "./identity.js"
import { upsertTrip } from "./store.js"
import type {
  CashComponent,
  ComposedTrip,
  ComposeSummary,
  FlightSide,
  StaySide,
  TripCost,
} from "./types.js"

interface FlightPriceRow {
  id: number
  origin: string
  destination: string
  departure_date: string
  return_date: string | null
  cabin: string
  airline: string | null
  stops: number | null
  price_amount: number
  price_currency: string
  taxes_amount: number | null
  verification_level: string
  fetched_at: string
}

interface AwardPriceRow {
  id: number
  origin: string
  destination: string
  departure_date: string
  cabin: string
  airline: string | null
  stops: number | null
  taxes_amount: number | null
  taxes_currency: string | null
  verification_level: string
  loyalty_program: string
  points: number
}

export function composeTrips(db: DB, config: TripsConfig): ComposeSummary {
  const started = Date.now()
  const anomalyConfig = loadAnomalyConfig()
  const staysConfig = loadStaysConfig()
  const summary: ComposeSummary = {
    stayWindowsConsidered: 0, flightOptionsConsidered: 0, combinationsExamined: 0,
    feasible: 0, admitted: 0, stored: 0, rejected: {}, ceilingsHit: [], durationMs: 0,
  }
  const reject = (why: string): void => { summary.rejected[why] = (summary.rejected[why] ?? 0) + 1 }

  const windows = listStayWindows(db, { limit: config.matching.maxStayWindows })
    .filter(w => w.bestScore >= 25)
  summary.stayWindowsConsidered = windows.length

  const freshCutoff = new Date(Date.now() - config.matching.maxFlightAgeDays * 86_400_000).toISOString()
  let stored = 0

  for (const window of windows) {
    if (stored >= config.matching.maxTripsPerCompose) {
      summary.ceilingsHit.push(`maxTripsPerCompose (${config.matching.maxTripsPerCompose})`)
      break
    }
    const stay = staySideFor(db, window)
    if (!stay) { reject("stay window without a readable best candidate"); continue }

    const memberCheckIns = (window.evidence.checkIns as string[] | undefined) ?? [window.firstCheckIn]

    // ── Flight options touching this stay ────────────────────────────────
    const flightOptions: FlightSide[] = [
      ...cashRoundTrips(db, config, stay, memberCheckIns, freshCutoff, anomalyConfig),
      ...awardPairs(db, config, stay, memberCheckIns, freshCutoff, anomalyConfig),
    ]
    summary.flightOptionsConsidered += flightOptions.length
    if (flightOptions.length === 0) { reject("no fresh compatible flight for the window"); continue }

    // Best few per stay: by quality, then keep construction variety.
    const kept = flightOptions
      .sort((a, b) => b.quality - a.quality)
      .slice(0, config.matching.maxFlightsPerStay)
    if (flightOptions.length > kept.length) {
      summary.ceilingsHit.push(`maxFlightsPerStay trimmed ${flightOptions.length - kept.length} option(s)`)
    }

    for (const flight of kept) {
      summary.combinationsExamined++
      const trip = judgeTrip(db, config, staysConfig, flight, stay, memberCheckIns)
      if (trip === null) { reject("failed admission gates (ordinary × ordinary)"); continue }
      summary.feasible++
      if (trip.status === "interesting") summary.admitted++
      else reject(trip.rejectionReason ?? "rejected")
      upsertTrip(db, trip)
      stored++
    }
  }

  summary.stored = stored
  summary.durationMs = Date.now() - started
  return summary
}

// ── Stay side ────────────────────────────────────────────────────────────────

function staySideFor(db: DB, window: StayWindowRow): StaySide | null {
  const best = window.bestCandidateId !== null ? getStayCandidate(db, window.bestCandidateId) : null
  if (!best) return null
  const property = getStayProperty(db, window.propertyId)
  if (!property) return null

  const members = listStayCandidates(db, { propertyId: window.propertyId, limit: 100 })
    .filter(c => c.board === window.board && c.sourceClass === window.sourceClass
      && c.checkIn >= window.firstCheckIn && c.checkIn <= window.lastCheckIn)

  return {
    windowKey: window.windowKey,
    propertyId: property.id,
    propertyName: property.name,
    destinationGroup: property.destinationGroup,
    nearestAirports: property.nearestAirports,
    checkIn: best.checkIn,
    checkOut: best.checkOut,
    nights: best.nights,
    board: best.board,
    roomClass: best.roomClass,
    roomName: best.roomName,
    nightly: best.nightlyAmount,
    stayTotal: best.stayTotal ?? Math.round(best.nightlyAmount * best.nights * 100) / 100,
    currency: best.priceCurrency,
    taxStatus: best.taxesFees,
    verificationStatus: best.verificationStatus,
    persistence: window.persistence,
    refundable: refundableOf(best.evidence),
    quality: Math.min(1, best.score / 100),
    qualityDetail: `stay opportunity score ${best.score} (${best.reasons.slice(0, 4).join(" ")})`,
    candidateId: best.id,
    observationIds: members.map(m => m.sourceId),
  }
}

function refundableOf(evidence: Record<string, unknown>): boolean | null {
  const cancellation = (evidence as { cancellation?: { refundable?: boolean } }).cancellation
  return typeof cancellation?.refundable === "boolean" ? cancellation.refundable : null
}

// ── Flight options ───────────────────────────────────────────────────────────

function cashRoundTrips(
  db: DB, config: TripsConfig, stay: StaySide, memberCheckIns: string[],
  freshCutoff: string, anomalyConfig: ReturnType<typeof loadAnomalyConfig>,
): FlightSide[] {
  const earliest = shiftDay(minDay(memberCheckIns), -config.matching.maxArrivalLeadDays)
  const latestDeparture = maxDay(memberCheckIns)
  const rows = db.prepare(`
    SELECT id, origin, destination, departure_date, return_date, cabin, airline, stops,
           price_amount, price_currency, taxes_amount, verification_level, fetched_at
    FROM flight_prices
    WHERE origin IN (${config.origins.map(() => "?").join(",")})
      AND destination IN (${stay.nearestAirports.map(() => "?").join(",")})
      AND return_date IS NOT NULL
      AND departure_date >= ? AND departure_date <= ?
      AND fetched_at >= ?
    ORDER BY price_amount ASC
    LIMIT 200
  `).all(...config.origins, ...stay.nearestAirports, earliest, latestDeparture, freshCutoff) as FlightPriceRow[]

  // Cheapest per (origin, cabin, exact date pair) — dedupe of re-observations.
  const byKey = new Map<string, FlightPriceRow>()
  for (const r of rows) {
    const key = `${r.origin}|${r.cabin}|${r.departure_date}|${r.return_date}`
    if (!byKey.has(key)) byKey.set(key, r)
  }

  const options: FlightSide[] = []
  for (const r of byKey.values()) {
    const candidate = flightCandidateScore(db, "flight_prices", r.id)
    const absolute = assessCashAbsolute({
      price: r.price_amount, currency: r.price_currency, cabin: r.cabin,
      destinationGroup: flightGroupFor(stay.destinationGroup),
    }, anomalyConfig)
    // A sane, current fare is REASONABLE by default (the floor): an
    // exceptional stay may pair with it. Anomaly/absolute judgements raise
    // quality above the floor; the overpriced kill handles absurd fares.
    const quality = Math.max(
      candidate !== null ? candidate / 100 : 0,
      absolute.rulePath !== "none" ? absolute.score : 0,
      config.admission.reasonableComponent,
    )
    options.push({
      construction: "cash",
      origin: r.origin,
      destinationAirport: r.destination,
      outboundDeparture: r.departure_date,
      returnDeparture: r.return_date,
      cabin: r.cabin,
      legs: [{
        direction: "outbound", airline: r.airline, stops: r.stops,
        price: { amount: r.price_amount, currency: r.price_currency },
        points: null,
        taxes: r.taxes_amount !== null ? { amount: r.taxes_amount, currency: r.price_currency } : null,
        sourceId: r.id, sourceTable: "flight_prices", verificationLevel: r.verification_level,
      }],
      quality,
      qualityDetail: candidate !== null
        ? `flight candidate score ${candidate}`
        : absolute.rulePath !== "none" ? absolute.detail : "no flight judgement available — quality 0",
      candidateScore: candidate,
    })
  }
  return options
}

/** Award fares are ONE-WAY (measured in Phase 5): pair outbound + return. */
function awardPairs(
  db: DB, config: TripsConfig, stay: StaySide, memberCheckIns: string[],
  freshCutoff: string, anomalyConfig: ReturnType<typeof loadAnomalyConfig>,
): FlightSide[] {
  const earliest = shiftDay(minDay(memberCheckIns), -config.matching.maxArrivalLeadDays)
  const latestDeparture = maxDay(memberCheckIns)
  const select = (outbound: boolean) => db.prepare(`
    SELECT id, origin, destination, departure_date, cabin, airline, stops,
           taxes_amount, taxes_currency, verification_level, loyalty_program, points
    FROM award_prices
    WHERE origin IN (${(outbound ? config.origins : stay.nearestAirports).map(() => "?").join(",")})
      AND destination IN (${(outbound ? stay.nearestAirports : config.origins).map(() => "?").join(",")})
      AND fetched_at >= ?
    ORDER BY points ASC LIMIT 100
  `)
  const outbounds = (select(true).all(...config.origins, ...stay.nearestAirports, freshCutoff) as AwardPriceRow[])
    .filter(r => r.departure_date >= earliest && r.departure_date <= latestDeparture)
  const returns = (select(false).all(...stay.nearestAirports, ...config.origins, freshCutoff) as AwardPriceRow[])

  const options: FlightSide[] = []
  for (const out of outbounds.slice(0, 10)) {
    // The matching member check-in for this outbound decides the return window.
    const checkIn = memberCheckIns.find(ci => compatibleOutbound(out.departure_date, ci, config) !== null)
    if (!checkIn) continue
    const checkOut = shiftDay(checkIn, stay.nights)
    const back = returns
      .filter(r => r.cabin === out.cabin
        && r.departure_date >= checkOut
        && r.departure_date <= shiftDay(checkOut, config.matching.maxReturnLagDays)
        && r.destination === out.origin)
      .sort((a, b) => a.points - b.points)[0]
    if (!back) continue

    const outCandidate = flightCandidateScore(db, "award_prices", out.id)
    const outAbsolute = assessAwardAbsolute({
      points: out.points, taxesAmount: out.taxes_amount, taxesCurrency: out.taxes_currency,
      cabin: out.cabin, loyaltyProgram: out.loyalty_program,
    }, anomalyConfig)
    const quality = Math.max(
      outCandidate !== null ? outCandidate / 100 : 0,
      outAbsolute.rulePath !== "none" ? outAbsolute.score : 0,
      config.admission.reasonableComponent,
    )

    options.push({
      construction: "award",
      origin: out.origin,
      destinationAirport: out.destination,
      outboundDeparture: out.departure_date,
      returnDeparture: back.departure_date,
      cabin: out.cabin,
      legs: [
        {
          direction: "outbound", airline: out.airline, stops: out.stops, price: null,
          points: { program: out.loyalty_program, miles: out.points },
          taxes: out.taxes_amount !== null ? { amount: out.taxes_amount, currency: out.taxes_currency ?? "USD" } : null,
          sourceId: out.id, sourceTable: "award_prices", verificationLevel: out.verification_level,
        },
        {
          direction: "return", airline: back.airline, stops: back.stops, price: null,
          points: { program: back.loyalty_program, miles: back.points },
          taxes: back.taxes_amount !== null ? { amount: back.taxes_amount, currency: back.taxes_currency ?? "USD" } : null,
          sourceId: back.id, sourceTable: "award_prices", verificationLevel: back.verification_level,
        },
      ],
      quality,
      qualityDetail: outCandidate !== null
        ? `award candidate score ${outCandidate}`
        : outAbsolute.rulePath !== "none" ? outAbsolute.detail : "no award judgement available — quality 0",
      candidateScore: outCandidate,
    })
  }
  return options
}

function flightCandidateScore(db: DB, table: "flight_prices" | "award_prices", id: number): number | null {
  const row = db.prepare(`
    SELECT score FROM deal_candidates
    WHERE source_table = ? AND source_id = ? AND sanity = 'ok'
  `).get(table, id) as { score: number } | undefined
  return row ? row.score : null
}

/** Stay destination groups → the flight anomaly config's group keys. */
function flightGroupFor(stayGroup: string): string | null {
  const map: Record<string, string> = { "riviera-maya": "mexico", "los-cabos": "mexico", "thailand-beach": "thailand" }
  return map[stayGroup] ?? null      // null → the flight config's `default` table
}

// ── Judgement ────────────────────────────────────────────────────────────────

function judgeTrip(
  db: DB,
  config: TripsConfig,
  staysConfig: ReturnType<typeof loadStaysConfig>,
  flight: FlightSide,
  stay: StaySide,
  memberCheckIns: string[],
): ComposedTrip | null {
  // ── Feasibility: real dates only ─────────────────────────────────────────
  const matched = bestDateMatch(flight, stay, memberCheckIns, config)
  if (!matched) return null
  const { checkIn, compatibility } = matched
  const checkOut = shiftDay(checkIn, stay.nights)
  const stayForDates: StaySide = { ...stay, checkIn, checkOut }

  // ── Admission gates ──────────────────────────────────────────────────────
  const a = config.admission
  const fq = flight.quality
  const sq = stay.quality
  const cost = buildCost(config, flight, stayForDates)
  const tripAbsolute = assessTripAbsolute(config, flight, stayForDates, cost)

  // The overpriced kill is computed BEFORE admission so an absurd component
  // attached to a strong partner is stored VISIBLY as a killed trip — "why is
  // this great flight not a trip?" deserves a stored answer, not silence.
  const overpriced = overpricedComponent(db, config, flight, stayForDates)

  let gate: string | null = null
  if (fq >= a.exceptionalComponent && sq >= a.reasonableComponent) gate = "EXCEPTIONAL_FLIGHT_REASONABLE_STAY"
  else if (sq >= a.exceptionalComponent && fq >= a.reasonableComponent) gate = "EXCEPTIONAL_STAY_REASONABLE_FLIGHT"
  else if (fq >= a.strongPair && sq >= a.strongPair) gate = "STRONG_FLIGHT_STRONG_STAY"
  else if (tripAbsolute.score >= a.tripAbsoluteAlone) gate = "EXCEPTIONAL_TRIP_ABSOLUTE_VALUE"
  if (!gate) {
    if (overpriced && Math.max(fq, sq) >= a.strongPair) gate = "KILLED_BEFORE_ADMISSION"
    else return null
  }

  // ── Components ───────────────────────────────────────────────────────────
  const w = config.scoring.weights
  const evidence = evidenceValue(staysConfig, flight, stay)
  const usability = usabilityValue(stay)

  const parts: Record<string, { raw: number | null; weight: number; detail: string }> = {
    strongestComponent: {
      raw: Math.max(fq, sq), weight: w.strongestComponent,
      detail: fq >= sq ? `flight leads: ${flight.qualityDetail}` : `stay leads: ${stay.qualityDetail}`,
    },
    weakerComponent: {
      raw: Math.min(fq, sq), weight: w.weakerComponent,
      detail: fq < sq ? flight.qualityDetail : stay.qualityDetail,
    },
    tripAbsolute: tripAbsolute.rulePath !== "none"
      ? { raw: tripAbsolute.score, weight: w.tripAbsolute, detail: tripAbsolute.detail }
      : { raw: null, weight: w.tripAbsolute, detail: tripAbsolute.detail },
    dateCompatibility: { raw: compatibility.value, weight: w.dateCompatibility, detail: compatibility.detail },
    evidence: { raw: evidence.value, weight: w.evidence, detail: evidence.detail },
    usability: { raw: usability.value, weight: w.usability, detail: usability.detail },
  }

  const usable = Object.values(parts).filter(p => p.raw !== null)
  const totalWeight = usable.reduce((sum, p) => sum + p.weight, 0)
  const breakdown: Record<string, unknown> = {}
  let score = 0
  for (const [name, part] of Object.entries(parts)) {
    if (part.raw === null || totalWeight === 0) {
      breakdown[name] = { raw: null, weight: 0, points: 0, detail: `not available — ${part.detail}` }
      continue
    }
    const weight = part.weight / totalWeight
    const points = Math.round(part.raw * weight * 1000) / 10
    breakdown[name] = { raw: part.raw, weight: Math.round(weight * 1000) / 1000, points, detail: part.detail }
    score += points
  }

  // Complexity penalty: subtracted, never a component.
  const complexity = complexityOf(config, flight)
  if (complexity.penalty > 0) {
    breakdown.complexityPenalty = {
      raw: null, weight: 0, points: -Math.round(complexity.penalty * 1000) / 10,
      detail: `flags: ${complexity.flags.join(", ")}`,
    }
    score -= complexity.penalty * 100
  }

  let status: "interesting" | "rejected" = "interesting"
  let rejectionReason: string | null = null
  if (overpriced) {
    const cap = config.scoring.overpricedKill.capScore
    if (score > cap) {
      breakdown.overpricedKill = { raw: null, weight: 0, points: cap - Math.round(score * 10) / 10, detail: overpriced }
      score = cap
    }
    status = "rejected"
    rejectionReason = overpriced
  }

  score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10

  const partial: Omit<ComposedTrip, "reasons" | "tripKey"> = {
    flight, stay: stayForDates, adults: config.travellers.adults, cost,
    dateCompatibility: compatibility, complexity, tripAbsolute,
    evidenceValue: evidence.value, usabilityValue: usability.value,
    admissionGate: gate, score, scoreBreakdown: breakdown,
    status, rejectionReason,
  }
  const reasons = reasonsFor(partial)
  if (overpriced) reasons.push("COMPONENT_OVERPRICED")

  return { ...partial, reasons, tripKey: tripKey(flight, stayForDates, config.travellers.adults) }
}

// ── Feasibility helpers ──────────────────────────────────────────────────────

/**
 * Arrival must precede check-in, conservatively: a long-haul flight departing
 * on the check-in date may land AFTER it, so day-of departures earn reduced
 * credit and a caution, day-before/two-before earn full credit. Dates are
 * only ever taken from stored observations.
 */
function compatibleOutbound(
  departure: string, checkIn: string, config: TripsConfig,
): { value: number; detail: string } | null {
  const lead = Math.round((Date.parse(checkIn) - Date.parse(departure)) / 86_400_000)
  if (lead < 0 || lead > config.matching.maxArrivalLeadDays) return null
  if (lead === 0) {
    return { value: 0.5, detail: `departs ON check-in day ${checkIn} — overnight arrival may miss the first night` }
  }
  return { value: 1, detail: `departs ${departure}, ${lead} day(s) before check-in ${checkIn}` }
}

function bestDateMatch(
  flight: FlightSide, stay: StaySide, memberCheckIns: string[], config: TripsConfig,
): { checkIn: string; compatibility: { value: number; detail: string } } | null {
  let best: { checkIn: string; compatibility: { value: number; detail: string } } | null = null
  for (const checkIn of memberCheckIns) {
    const outbound = compatibleOutbound(flight.outboundDeparture, checkIn, config)
    if (!outbound) continue
    const checkOut = shiftDay(checkIn, stay.nights)
    if (flight.returnDeparture === null) continue
    const lag = Math.round((Date.parse(flight.returnDeparture) - Date.parse(checkOut)) / 86_400_000)
    if (lag < 0 || lag > config.matching.maxReturnLagDays) continue
    const value = Math.min(outbound.value, lag === 0 ? 1 : 0.7)
    const detail = `${outbound.detail}; return ${flight.returnDeparture}` +
      (lag > 0 ? ` (${lag} unplanned night(s) after check-out ${checkOut})` : ` on check-out day`)
    if (!best || value > best.compatibility.value) best = { checkIn, compatibility: { value, detail } }
  }
  return best
}

// ── Cost ─────────────────────────────────────────────────────────────────────

function buildCost(config: TripsConfig, flight: FlightSide, stay: StaySide): TripCost {
  const cash: CashComponent[] = []
  const miles: TripCost["milesComponents"] = []
  const unknown: string[] = []

  for (const leg of flight.legs) {
    if (leg.price) {
      cash.push({
        kind: "airfare",
        amount: Math.round(leg.price.amount * config.travellers.adults * 100) / 100,
        currency: leg.price.currency,
        detail: `${leg.direction} fare × ${config.travellers.adults} adults`,
      })
    }
    if (leg.points) {
      miles.push({
        program: leg.points.program,
        miles: leg.points.miles * config.travellers.adults,
        legs: leg.direction,
      })
      if (leg.taxes) {
        cash.push({
          kind: "award_taxes",
          amount: Math.round(leg.taxes.amount * config.travellers.adults * 100) / 100,
          currency: leg.taxes.currency,
          detail: `${leg.direction} award taxes/fees × ${config.travellers.adults}`,
        })
      } else {
        unknown.push(`${leg.direction} award taxes unknown`)
      }
    }
  }

  cash.push({
    kind: "stay",
    amount: stay.stayTotal,
    currency: stay.currency,
    detail: `${stay.nights} nights × ${stay.nightly} (taxes ${stay.taxStatus})`,
  })
  if (stay.taxStatus !== "included") unknown.push(`hotel taxes/fees ${stay.taxStatus}`)
  unknown.push("resort/airport transfer not priced")

  // Merge programs (outbound + return on one program become one line).
  const byProgram = new Map<string, { program: string; miles: number; legs: string[] }>()
  for (const m of miles) {
    const entry = byProgram.get(m.program) ?? { program: m.program, miles: 0, legs: [] }
    entry.miles += m.miles
    entry.legs.push(m.legs)
    byProgram.set(m.program, entry)
  }

  const currencies = new Set(cash.map(c => c.currency))
  const cashTotal = currencies.size === 1
    ? {
      amount: Math.round(cash.reduce((sum, c) => sum + c.amount, 0) * 100) / 100,
      currency: cash[0].currency,
    }
    : null       // mixed currencies stay itemised — never converted

  return {
    cashComponents: cash,
    cashTotal,
    milesComponents: [...byProgram.values()].map(e => ({ program: e.program, miles: e.miles, legs: e.legs.join("+") })),
    unknownCosts: unknown,
  }
}

// ── Trip-level absolute value ────────────────────────────────────────────────

function assessTripAbsolute(
  config: TripsConfig, flight: FlightSide, stay: StaySide, cost: TripCost,
): ComposedTrip["tripAbsolute"] {
  const none = (detail: string): ComposedTrip["tripAbsolute"] =>
    ({ tier: null, score: 0, rulePath: "none", perNight: null, detail })

  // A cash bar prices complete trips; it cannot price miles. Award trips are
  // uncomputable here — their cash portion excludes the transport's value.
  if (flight.construction !== "cash" && flight.construction !== "positioning_cash") {
    return none("award constructions carry miles — a cash-per-night bar cannot judge them")
  }
  if (!cost.cashTotal) return none("mixed cash currencies — never converted, so no single per-night figure")
  if (cost.cashTotal.currency !== config.absolute.currency) {
    return none(`trip cash is in ${cost.cashTotal.currency}; bars are stated in ${config.absolute.currency} only`)
  }

  const cabinBand = flight.cabin === "business" || flight.cabin === "first" ? "business" : "economy"
  const rule =
    config.absolute.rules[`${stay.destinationGroup}|${stay.board}|${cabinBand}`]
    ?? config.absolute.rules[`${stay.destinationGroup}|any|${cabinBand}`]
  if (!rule) return none(`no trip-class bar for ${stay.destinationGroup}|${stay.board}|${cabinBand}`)

  const rulePath = `${stay.destinationGroup}|${stay.board}|${cabinBand}`
  const perNight = Math.round((cost.cashTotal.amount / stay.nights) * 100) / 100
  if (perNight > rule.interesting) {
    return {
      tier: null, score: 0, rulePath, perNight,
      detail: `${perNight}/night all-known-cash for ${config.travellers.adults} is above the ${rule.interesting} bar — a rule ran and said ordinary`,
    }
  }
  const span = Math.max(1, rule.interesting - rule.wtf)
  const score = Math.max(0, Math.min(1, (rule.interesting - perNight) / span))
  const tier = perNight <= rule.wtf ? "wtf" : perNight <= rule.extreme ? "extreme" : "interesting"
  return {
    tier, score: Math.round(score * 1000) / 1000, rulePath, perNight,
    detail: `${perNight}/night all-known-cash for ${config.travellers.adults} crosses the ${tier} bar ` +
      `(interesting ${rule.interesting} / extreme ${rule.extreme} / wtf ${rule.wtf})` +
      (cost.unknownCosts.length ? `; unknowns remain: ${cost.unknownCosts.join(", ")}` : ""),
  }
}

// ── Kill, evidence, usability, complexity ────────────────────────────────────

/** A component priced ABOVE its own comparable median by the kill multiple.
 *  Exported for direct testing — in composition it is the second line of
 *  defence behind the windows-first search (an absurd stay usually never
 *  forms a considered window at all). */
export function overpricedComponent(
  db: DB, config: TripsConfig, flight: FlightSide, stay: StaySide,
): string | null {
  const kill = config.scoring.overpricedKill

  const stayCandidate = stay.candidateId !== null ? getStayCandidate(db, stay.candidateId) : null
  if (stayCandidate?.observedMedian && stay.nightly >= stayCandidate.observedMedian * kill.multipleOfMedian) {
    return `stay at ${stay.nightly} is ≥${kill.multipleOfMedian}× its own median ${stayCandidate.observedMedian} — absurd for a deal radar`
  }

  const cashLeg = flight.legs.find(l => l.price)
  if (cashLeg?.price) {
    const median = flightRouteMedian(db, flight, cashLeg.price.currency)
    if (median !== null && cashLeg.price.amount >= median * kill.multipleOfMedian) {
      return `flight at ${cashLeg.price.amount} ${cashLeg.price.currency} is ≥${kill.multipleOfMedian}× the route median ${median}`
    }
  }
  return null
}

function flightRouteMedian(db: DB, flight: FlightSide, currency: string): number | null {
  const rows = db.prepare(`
    SELECT price_amount FROM flight_prices
    WHERE origin = ? AND destination = ? AND cabin = ? AND price_currency = ?
      AND return_date IS NOT NULL
  `).all(flight.origin, flight.destinationAirport, flight.cabin, currency) as { price_amount: number }[]
  if (rows.length < 5) return null
  const values = rows.map(r => r.price_amount).sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
}

function evidenceValue(
  staysConfig: ReturnType<typeof loadStaysConfig>, flight: FlightSide, stay: StaySide,
): { value: number; detail: string } {
  const ev = staysConfig.anomaly.evidenceValues
  const levelValue = (level: string): number =>
    level === "verified" ? ev.verified : level === "confirmed" || level === "cross-verified" ? ev.confirmed : ev.discovered
  const flightValue = Math.min(...flight.legs.map(l => levelValue(l.verificationLevel)))
  const stayValue = stay.verificationStatus === "verified" ? ev.verified
    : levelValue(stay.verificationStatus === "unverified" ? "discovered" : stay.verificationStatus)
  const value = Math.round(((flightValue + stayValue) / 2) * 1000) / 1000
  return {
    value,
    detail: `flight ${flight.legs.map(l => l.verificationLevel).join("/")} + stay ${stay.verificationStatus}`,
  }
}

function usabilityValue(stay: StaySide): { value: number; detail: string } {
  const persistence = stay.persistence === "sustained" ? 1 : stay.persistence === "short" ? 0.6 : 0.2
  const value = Math.min(1, persistence + (stay.refundable === true ? 0.2 : 0))
  return {
    value,
    detail: `${stay.persistence} stay window` +
      (stay.refundable === true ? ", refundable" : stay.refundable === false ? ", NON-refundable" : ""),
  }
}

function complexityOf(config: TripsConfig, flight: FlightSide): { flags: string[]; penalty: number } {
  const p = config.scoring.complexityPenalties
  const flags: string[] = []
  let penalty = 0
  if (flight.construction === "positioning_cash") { flags.push("positioning"); penalty += p.positioning }
  if (flight.construction === "open_jaw") { flags.push("open_jaw"); penalty += p.openJaw }
  // Award pairing already enforces returning to the outbound origin, so the
  // airportChange penalty currently fires only for future constructions that
  // genuinely land elsewhere.
  if (flight.legs.some(l => (l.stops ?? 0) >= 2)) { flags.push("long_layover"); penalty += p.longLayover }
  return { flags, penalty: Math.min(penalty, p.maxTotal) }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
function minDay(days: string[]): string {
  return [...days].sort()[0]
}
function maxDay(days: string[]): string {
  return [...days].sort()[days.length - 1]
}
