#!/usr/bin/env tsx
/**
 * Phase 6.5 acceptance: prove open jaw is a real discovery method on the LIVE
 * database, not a schema field nothing writes.
 *
 * Read-only. It calls no provider, spends no budget and changes nothing - it
 * reads back what the engine already decided and checks that the decision, the
 * two legs it was built from, the comparison and the presentation all agree
 * with each other.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { buildFeed, dealDetail } from "../anomaly/feed.js"

const db = getDb()

const candidates = db.prepare(`
  SELECT id, source_table, source_id, route, cabin, departure_date, return_date,
         price_amount, price_currency, score, status, sanity, discovered_by,
         is_open_jaw, cluster_id, provider, open_jaw, reasons, score_breakdown
  FROM deal_candidates WHERE is_open_jaw = 1 ORDER BY score DESC
`).all() as any[]

console.log(`OPEN-JAW CANDIDATES: ${candidates.length}\n`)

for (const c of candidates) {
  const j = JSON.parse(c.open_jaw)
  const reasons = JSON.parse(c.reasons).map((r: any) => r.code)
  const breakdown = JSON.parse(c.score_breakdown)

  console.log(`#${c.id} ${c.route} ${c.cabin} score ${c.score} (${c.status}, sanity ${c.sanity})`)
  console.log(`   is_open_jaw=${c.is_open_jaw}  discovered_by=${c.discovered_by}  ` +
    `source=${c.source_table}#${c.source_id}  cluster=${c.cluster_id}`)
  console.log(`   sold as: ${c.provider}`)

  // Provenance: every figure traced back to the observation that produced it.
  for (const side of ["outbound", "inbound"] as const) {
    const leg = j[side]
    const row = db.prepare(`SELECT * FROM flight_prices WHERE id = ?`).get(leg.priceId) as any
    const agrees = row
      && row.price_amount === leg.price
      && row.provider === leg.provider
      && row.fetched_at === leg.observedAt
      && row.origin === leg.origin
      && row.destination === leg.destination
      && row.departure_date === leg.departureDate
      && row.return_date === null
    console.log(
      `   ${side.toUpperCase().padEnd(8)} ${leg.origin}->${leg.destination} ${leg.departureDate} ` +
      `${leg.price} ${leg.currency} ${leg.provider} seen ${leg.observedAt.slice(0, 10)} ` +
      `[flight_prices#${leg.priceId} ${agrees ? "AGREES" : "MISMATCH"}${row?.return_date ? " NOT-ONE-WAY" : ""}]`,
    )
  }

  const arithmeticOk = Math.abs((j.outbound.price + j.inbound.price) - j.totalPrice) < 0.01
    && Math.abs((j.totalPrice + j.transferCost) - j.trueTripCost) < 0.01
    && (j.comparator === null
      ? j.saving === null
      : Math.abs((j.comparator.price - j.totalPrice) - j.saving) < 0.01)

  if (j.comparator) {
    const cmp = db.prepare(`SELECT * FROM flight_prices WHERE id = ?`).get(j.comparator.priceId) as any
    console.log(
      `   COMPARATOR ${j.comparator.origin}-${j.comparator.destination} ${j.comparator.departureDate}` +
      ` -> ${j.comparator.returnDate} ${j.comparator.price} ${j.comparator.currency} ` +
      `${j.comparator.provider} [flight_prices#${j.comparator.priceId} ` +
      `${cmp && cmp.price_amount === j.comparator.price && cmp.return_date === j.comparator.returnDate ? "AGREES" : "MISMATCH"}]`,
    )
  } else {
    console.log(`   COMPARATOR none observed - saving is null, not zero`)
  }

  console.log(
    `   ARITHMETIC ${j.outbound.price} + ${j.inbound.price} = ${j.totalPrice}` +
    (j.transferCost ? ` (+${j.transferCost} transfers = ${j.trueTripCost})` : "") +
    (j.comparator ? ` vs ${j.comparator.price} -> ${j.saving} (${j.savingPercent}%)` : "") +
    `  [${arithmeticOk ? "CHECKS OUT" : "DOES NOT ADD UP"}]`,
  )
  console.log(`   FRICTION ${j.friction}: ${j.frictionReasons.join("; ")}`)
  console.log(`   REASONS ${reasons.join(" ")}`)
  console.log(
    `   COMPONENTS ${Object.entries(breakdown.components)
      .filter(([, v]: any) => v.weight > 0 || v.points !== 0)
      .map(([k, v]: any) => `${k} ${v.points}`).join(", ")}`,
  )
  console.log("")
}

// §11 an open jaw must never share a family with an ordinary round trip.
const mixed = db.prepare(`
  SELECT cluster_id, COUNT(DISTINCT is_open_jaw) kinds, COUNT(*) members
  FROM deal_candidates WHERE cluster_id IS NOT NULL GROUP BY cluster_id HAVING kinds > 1
`).all() as any[]
console.log(`CLUSTERING: ${mixed.length} families mixing open jaws with round trips (must be 0)`)

// §12/§13 reachable in the UI at all, not merely stored.
const feed = buildFeed(db, { minScore: 0 })
console.log(`FEED: openjaw section carries ${feed.counts.openjaw} card(s) at minScore 0`)
for (const card of feed.sections.openjaw) {
  console.log(
    `   card ${card.route} score ${card.score} legs ` +
    `${card.openJaw?.outbound.origin}->${card.openJaw?.outbound.destination} / ` +
    `${card.openJaw?.inbound.origin}->${card.openJaw?.inbound.destination}`,
  )
}
const first = candidates[0]
if (first) {
  const detail = dealDetail(db, first.id)!
  console.log(`DETAIL #${first.id}: openJaw ${detail.candidate.openJaw ? "present" : "MISSING"}, ` +
    `${detail.warnings.length} warning(s)`)
  for (const w of detail.warnings) console.log(`   - ${w}`)
}

// §20 what open-jaw support has cost so far.
const cost = db.prepare(`
  SELECT COALESCE(SUM(open_jaw_leg_searches), 0) legs,
         COALESCE(SUM(open_jaw_candidates), 0) candidates,
         COALESCE(SUM(metered_calls), 0) metered, COUNT(*) runs
  FROM discovery_runs
`).get() as any
console.log(
  `\nCOST TO DATE: ${cost.legs} open-jaw leg searches across ${cost.runs} discovery run(s), ` +
  `${cost.candidates} open-jaw candidates, ${cost.metered} metered calls total`,
)
