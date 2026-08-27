/**
 * §21 - what a notification actually says.
 *
 * The hard part is not formatting, it is restraint. A notification has about
 * two seconds of a person's attention and one job: convey whether this is
 * worth opening. So every line here earns its place, and anything the reader
 * cannot act on stays in the detail page behind the link.
 *
 * The other rule is that a message may never imply evidence it does not have.
 * A candidate with no history gets "LOW BASELINE CONFIDENCE" on its own line,
 * not a comfortable silence - because "↓47% below median" and "we have never
 * seen this route before" look identical once you delete the second one.
 */

import { deepLinkFor, feedLink, type NotificationConfig } from "./config.js"
import { scrub, scrubBody, type NotificationMessage } from "./providers/types.js"
import type { StoredCandidate } from "../anomaly/store.js"

const int = new Intl.NumberFormat("en-US")

function money(amount: number, currency: string | null): string {
  const symbol = currency === "EUR" ? "€" : currency === "USD" ? "$" : ""
  const rounded = Math.round(amount)
  return symbol ? `${symbol}${int.format(rounded)}` : `${int.format(rounded)} ${currency ?? ""}`.trim()
}

function cabinLabel(cabin: string): string {
  return cabin.replace(/_/g, " ").toUpperCase()
}

/** "10-12 Oct" for a family, "10 Oct" for a single date. */
function dateRange(earliest: string, latest: string): string {
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`)
    return `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`
  }
  return earliest === latest ? fmt(earliest) : `${fmt(earliest)}–${fmt(latest)}`
}

export interface RenderInput {
  candidate: StoredCandidate
  /** How many dates in the family this candidate represents. */
  dateCount: number
  earliestDeparture: string
  latestDeparture: string
  /** §4 set when the decision rests on absolute price with little or no history. */
  lowConfidenceLabel: string | null
  /** §18 true when this is going out during quiet hours on the extreme bypass. */
  bypass: boolean
  /** Set on a re-alert, describing what improved. */
  improvement: string | null
}

/**
 * One candidate, rendered for a phone screen.
 *
 * The three shapes in §21 are three genuinely different products - a cash
 * fare, a points redemption and a two-ticket trip - and flattening them into
 * one template would bury the number that matters in each.
 */
export function renderCandidate(
  input: RenderInput, config: NotificationConfig,
): NotificationMessage {
  const c = input.candidate
  const lines: string[] = []
  const tags: string[] = []
  let title: string

  const hasHistory = c.baseline.count > 0
  const dates = dateRange(input.earliestDeparture, input.latestDeparture)
  const nights = c.tripLengthNights ? ` · ${c.tripLengthNights}n` : ""

  if (c.isOpenJaw && c.openJaw) {
    const j = c.openJaw
    tags.push("compass")
    title = `${Math.round(c.score)}/100 — OPEN JAW`
    lines.push(`${j.outbound.origin} → ${j.outbound.destination}`)
    lines.push(`${j.inbound.origin} → ${j.inbound.destination}`)
    lines.push(`${money(j.totalPrice, j.currency)} total${j.transferCost > 0 ? ` + ${money(j.transferCost, j.currency)} transfers` : ""}`)
    if (j.comparator) {
      lines.push(`Comparable return ${money(j.comparator.price, j.comparator.currency)}`)
      if (j.netSaving !== null && j.netSaving > 0) lines.push(`Save ${money(j.netSaving, j.currency)}`)
    } else {
      lines.push("No comparable return observed")
    }
    lines.push(`${dates}${nights}`)
    lines.push("Two separate tickets")
  } else if (c.type === "award") {
    tags.push("gem")
    title = `${Math.round(c.score)}/100 — AWARD`
    lines.push(`${c.origin} → ${c.destination}`)
    lines.push(cabinLabel(c.cabin))
    const taxes = c.taxesAmount !== null ? ` + ${money(c.taxesAmount, c.taxesCurrency)}` : ""
    lines.push(`${int.format(c.points ?? 0)} ${c.loyaltyProgram ?? "points"}${taxes}`)
    if (input.dateCount > 1) lines.push(`${input.dateCount} dates`)
    lines.push(dates)
    if (hasHistory && c.baseline.percentBelowMedian > 0) {
      lines.push(`↓${c.baseline.percentBelowMedian}% vs ${int.format(Math.round(c.baseline.median))} usual`)
    }
    if (c.cpp?.cpp != null) lines.push(`${c.cpp.cpp} cents/pt`)
  } else {
    tags.push("fire")
    title = `${Math.round(c.score)}/100 — ${cabinLabel(c.cabin)}`
    lines.push(`${c.origin} → ${c.destination}`)
    const price = c.priceAmount !== null ? money(c.priceAmount, c.priceCurrency) : "price unknown"
    lines.push(`${price} ${c.tripType === "return" ? "return" : "one way"}`)
    if (hasHistory) {
      lines.push(`Observed median: ${money(c.baseline.median, c.priceCurrency)}`)
      if (c.baseline.percentBelowMedian > 0) lines.push(`↓${c.baseline.percentBelowMedian}%`)
    }
    lines.push(`${dates}${nights}${input.dateCount > 1 ? ` · ${input.dateCount} dates` : ""}`)
  }

  // §7 the headline fare is not what a positioning trip costs to begin, and a
  // notification that shows only the fare is the exact misreading the true
  // start cost exists to prevent.
  if (c.requiresPositioning && c.trueTripStartCost !== null) {
    lines.push(`From ${c.origin} — true start cost ${money(c.trueTripStartCost, c.priceCurrency)}`)
  }

  // Evidence, stated rather than implied.
  if (input.lowConfidenceLabel) {
    lines.push(input.lowConfidenceLabel)
    tags.push("warning")
  } else if (hasHistory) {
    lines.push(`${c.baseline.confidence} confidence · ${c.baseline.count} observations`)
  }
  if (c.verificationStatus === "verified" || c.verificationStatus === "cross-verified") {
    lines.push(c.verificationStatus === "verified" ? "Verified" : "Cross-verified")
    tags.push("white_check_mark")
  }
  if (input.improvement) lines.push(input.improvement)

  return {
    title: scrub(title, 120),
    body: scrubBody(lines.join("\n")),
    // 4 rather than 5 for an ordinary alert: 5 is ntfy's "bypass Do Not
    // Disturb", and reserving it for the extreme bypass is what keeps that
    // distinction meaning anything.
    priority: input.bypass ? 5 : 4,
    tags,
    clickUrl: deepLinkFor(c.id, config),
  }
}

/**
 * §19 - the morning digest.
 *
 * One message, not one per queued item. A phone that buzzes six times at 08:00
 * has taught its owner to swipe the whole stack away without reading it, which
 * costs more than the six alerts were worth.
 */
export function renderDigest(
  items: RenderInput[], config: NotificationConfig,
): NotificationMessage {
  const count = items.length
  const lines: string[] = []
  for (const item of items.slice(0, config.rateLimits.maxDigestItems)) {
    const c = item.candidate
    const value = c.isOpenJaw && c.openJaw
      ? `${money(c.openJaw.totalPrice, c.openJaw.currency)} open jaw`
      : c.type === "award"
        ? `${int.format(c.points ?? 0)} ${c.loyaltyProgram ?? "pts"}`
        : money(c.priceAmount ?? 0, c.priceCurrency)
    lines.push(
      `${Math.round(c.score)} · ${c.origin}→${c.destination} ${cabinLabel(c.cabin)} · ${value}` +
      (item.lowConfidenceLabel ? " · low confidence" : ""),
    )
  }
  const hidden = count - Math.min(count, config.rateLimits.maxDigestItems)
  if (hidden > 0) lines.push(`…and ${hidden} more`)

  return {
    title: scrub(`${count} ${count === 1 ? "opportunity" : "opportunities"} found overnight`, 120),
    body: scrubBody(lines.join("\n")),
    priority: 3,
    tags: ["sunrise"],
    // The digest covers several candidates, so it links to the feed rather than
    // to any one of them.
    clickUrl: feedLink(config),
  }
}

/** §11 - the test message. Deliberately unmistakable and never candidate-derived. */
export function renderTest(): NotificationMessage {
  return {
    title: "TRAVEL RADAR TEST",
    body: [
      "This is a test notification.",
      "No flight, fare or candidate is involved.",
      `Sent ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC.`,
    ].join("\n"),
    priority: 3,
    tags: ["hammer_and_wrench"],
    clickUrl: null,
  }
}
