/**
 * Life-Perk Stay Planner — presentation-layer models for the stay-plan UI.
 *
 * Loaded by hotel-awards.html as a classic script (window.StayPlanUI) and by
 * tests as a module — one implementation, no drift. Everything here is a pure
 * projection of a stay-plan API response into render models; nothing fetches,
 * ranks, or writes.
 *
 * Load-bearing honesty rules:
 *   - the calendar is VISUALIZATION ONLY: blocks come from plan segments'
 *     exact observed dates, gaps come from the plan's exact uncovered dates,
 *     and nothing here manufactures availability between observed windows;
 *   - per-night figures stay per-night — no function in this file multiplies
 *     a nightly figure by a night count, so an average can never become a
 *     stay total;
 *   - program totals are formatted per program and NEVER combined: a program
 *     with any per-night-only segment reads "Stay total unavailable";
 *   - explanations state only what the plan data supports — no savings
 *     claims, no invented perk values.
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== "undefined" && module.exports) module.exports = api
  root.StayPlanUI = api
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const DAY_MS = 86400000
  const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"]

  function parseDay(d) {
    if (typeof d !== "string" || !DATE_RE.test(d)) return null
    const t = Date.parse(d + "T00:00:00Z")
    return Number.isNaN(t) ? null : t
  }

  /** checkIn + n days → YYYY-MM-DD (UTC math, same as the planner). */
  function addDays(date, n) {
    const t = parseDay(date)
    if (t === null || !Number.isInteger(n)) return null
    return new Date(t + n * DAY_MS).toISOString().slice(0, 10)
  }

  const TRIP_PRESETS = [7, 14, 30]

  /** The check-out a quick trip-length preset produces. Dates stay editable —
   *  this only computes, it never forces. */
  function presetCheckout(checkIn, days) {
    if (!TRIP_PRESETS.includes(days)) return null
    return addDays(checkIn, days)
  }

  /** Nights between two dates, or null when either is malformed/inverted. */
  function nightsBetween(checkIn, checkOut) {
    const a = parseDay(checkIn); const b = parseDay(checkOut)
    if (a === null || b === null) return null
    const n = Math.round((b - a) / DAY_MS)
    return n >= 1 ? n : null
  }

  /** Which preset the current dates correspond to, or null (custom dates). */
  function activePreset(checkIn, checkOut) {
    const n = nightsBetween(checkIn, checkOut)
    return TRIP_PRESETS.includes(n) ? n : null
  }

  /**
   * Calendar render model for one plan over the requested range.
   * Columns are 1-based grid columns, one per night. Blocks are the plan's
   * stay segments at their EXACT observed dates plus explicit gap runs from
   * the plan's uncovered dates — visualization only, nothing invented.
   */
  function calendarModel(plan, rangeStart, requestedNights) {
    const startT = parseDay(rangeStart)
    if (startT === null || !Number.isInteger(requestedNights) || requestedNights < 1) {
      return { days: [], blocks: [] }
    }
    const days = []
    for (let i = 0; i < requestedNights; i++) {
      const d = new Date(startT + i * DAY_MS)
      const dow = d.getUTCDay()
      days.push({
        date: d.toISOString().slice(0, 10),
        col: i + 1,
        dayOfMonth: d.getUTCDate(),
        weekday: WEEKDAYS[dow],
        isWeekend: dow === 0 || dow === 6,
        monthLabel: (i === 0 || d.getUTCDate() === 1) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : null,
      })
    }

    const blocks = []
    for (let i = 0; i < (plan.segments || []).length; i++) {
      const s = plan.segments[i]
      const segT = parseDay(s.checkIn)
      if (segT === null) continue
      const startCol = Math.round((segT - startT) / DAY_MS) + 1
      blocks.push({
        kind: "stay", segmentIndex: i, startCol, span: s.nights,
        checkIn: s.checkIn, checkOut: s.checkOut, nights: s.nights,
        propertyName: s.propertyName, program: s.program,
      })
    }
    // Gap runs: consecutive uncovered dates merged into visible blocks.
    const uncovered = plan.uncoveredDates || []
    let run = null
    for (const date of uncovered) {
      const t = parseDay(date)
      if (t === null) continue
      const col = Math.round((t - startT) / DAY_MS) + 1
      if (run && col === run.startCol + run.span) { run.span++; run.dates.push(date) }
      else {
        if (run) blocks.push(run)
        run = { kind: "gap", startCol: col, span: 1, dates: [date] }
      }
    }
    if (run) blocks.push(run)
    blocks.sort((a, b) => a.startCol - b.startCol)
    return { days, blocks }
  }

  /** Program-branded segment classes — same identity palette as the tiles
   *  (never fake hotel photos, never arbitrary colors). */
  const PROGRAM_CLASSES = {
    HILTON_HONORS: "p-hilton", MARRIOTT_BONVOY: "p-marriott", WORLD_OF_HYATT: "p-hyatt",
    IHG_ONE_REWARDS: "p-ihg", WYNDHAM_REWARDS: "p-wyndham", ACCOR_ALL: "p-accor",
    CHOICE_PRIVILEGES: "p-choice",
  }
  function programClass(program) { return PROGRAM_CLASSES[program] || "p-other" }

  const PERK_STATE_LABELS = {
    applied: "APPLIED",
    qualifies_but_unpriced: "QUALIFIES — PRICE EFFECT UNKNOWN",
    not_eligible: "NOT ELIGIBLE",
  }
  function perkStateLabel(state) { return PERK_STATE_LABELS[state] || String(state).toUpperCase() }

  const nfmt = n => Number(n).toLocaleString("en-US")

  /**
   * The price a segment card may show: the source-stated stay total when one
   * exists, otherwise the source-stated points/night flagged per-night-only.
   * Never a synthesized figure.
   */
  function segmentPriceText(seg) {
    if (seg.pointsTotal !== null && seg.pointsTotal !== undefined) {
      return { main: `${nfmt(seg.pointsTotal)} pts total`, sub: "source-stated stay total" }
    }
    if (seg.pointsPerNight !== null && seg.pointsPerNight !== undefined) {
      return { main: `${nfmt(seg.pointsPerNight)} pts/night`, sub: "per-night only — no stay total stated" }
    }
    return { main: "points not stated", sub: "" }
  }

  /** One program's summary line — totals stay per-program; a program with
   *  any per-night-only segment shows "Stay total unavailable". */
  function programTotalText(t) {
    if (t.statedTotal !== null && t.statedTotal !== undefined) {
      return `${nfmt(t.statedTotal)} pts (${t.statedSegments} source-stated stay total${t.statedSegments === 1 ? "" : "s"})`
    }
    return `Stay total unavailable — ${t.perNightOnlySegments} per-night-only segment${t.perNightOnlySegments === 1 ? "" : "s"}`
  }

  /** Right-rail summary model — counts and per-program lines, nothing else.
   *  There is deliberately NO combined points number to derive here. */
  function summaryModel(plan) {
    const summary = plan.perkSummary || null
    return {
      coveredNights: plan.coveredNights,
      requestedNights: plan.requestedNights,
      complete: plan.coveredNights === plan.requestedNights,
      segments: plan.segments.length,
      switches: plan.switches,
      appliedFreeNights: summary ? summary.appliedFreeNights : 0,
      appliedPerks: summary ? summary.applied : [],
      annotations: summary ? summary.annotations : [],
      qualifiesUnpriced: summary ? summary.qualifiesUnpriced : [],
      certificatesConsumed: summary ? summary.certificatesConsumed : [],
      programLines: plan.programTotals.map(t => ({ program: t.program, text: programTotalText(t) })),
      uncoveredDates: plan.uncoveredDates,
    }
  }

  const GOAL_LABELS = {
    life_perks: "best life-perk coverage",
    points_cost: "lowest comparable points cost",
    fewest_switches: "fewest hotel switches",
  }

  /**
   * "How this plan works" — sentences a reader can check against the plan.
   * States coverage, switches and applied perk counts; never claims savings
   * and never values a perk.
   */
  function planExplanation(plan, goal, nowIso) {
    const hotels = new Set(plan.segments.map(s => s.provider + "|" + s.providerPropertyRef)).size
    const out = []
    if (plan.segments.length === 0) {
      out.push("No stored observation covers any night of this range — nothing was invented to fill it.")
      return out
    }
    out.push(plan.coveredNights === plan.requestedNights
      ? `Covers all ${plan.requestedNights} nights using ${hotels} hotel${hotels === 1 ? "" : "s"} (${plan.switches} switch${plan.switches === 1 ? "" : "es"}).`
      : `Covers ${plan.coveredNights} of ${plan.requestedNights} nights using ${hotels} hotel${hotels === 1 ? "" : "s"} — full coverage is impossible with stored observations; the ${plan.uncoveredDates.length} uncovered night${plan.uncoveredDates.length === 1 ? "" : "s"} are listed, never papered over.`)
    out.push(`Every segment sits on a real observed award window at its exact dates — availability between observed windows is never assumed.`)
    const applied = plan.perkSummary ? plan.perkSummary.applied : []
    const freeNights = plan.perkSummary ? plan.perkSummary.appliedFreeNights : 0
    if (applied.length > 0) {
      out.push(`${applied.length} verified free-night benefit${applied.length === 1 ? "" : "s"} appl${applied.length === 1 ? "ies" : "y"} (${freeNights} free night${freeNights === 1 ? "" : "s"} by rule) — counted as nights, never priced: the free night's points value is not stated by any source and is not invented.`)
    } else {
      out.push("No verified perk currently applies — entitlements are declared, never assumed; declare yours under Status & entitlements.")
    }
    out.push("No synthetic stay totals were used: source-stated totals are authoritative and per-night averages remain per-night.")
    out.push(`Ranked for ${GOAL_LABELS[goal] || goal}; complete night coverage always wins first.`)
    if (plan.evidence && plan.evidence.oldestFetchedAt && nowIso) {
      const oldest = evidenceAgeDays(plan.evidence.oldestFetchedAt, nowIso)
      const newest = evidenceAgeDays(plan.evidence.newestFetchedAt, nowIso)
      const ageText = oldest === null || newest === null ? "of unknown age"
        : oldest === newest ? `${oldest} day${oldest === 1 ? "" : "s"} old` : `${newest} to ${oldest} days old`
      out.push(`Evidence is ${ageText}; availability is unknown on ${plan.evidence.availabilityUnknownSegments} of ${plan.segments.length} segments — nothing here is a live hold.`)
    }
    return out
  }

  /** "HILTON_DIAMOND" → "Hilton Diamond" — display labels for declared keys. */
  function humanizeKey(key) {
    return String(key).toLowerCase().split("_")
      .map(w => w === "ihg" ? "IHG" : w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  }

  // ── Evidence (provenance) — facts echoed, never scored ─────────────────────

  /** Whole days between an observation timestamp and "now" (both ISO); null
   *  when either is unparsable. A fact for the reader, not a freshness score. */
  function evidenceAgeDays(fetchedAt, nowIso) {
    const a = Date.parse(fetchedAt || ""); const b = Date.parse(nowIso || "")
    if (Number.isNaN(a) || Number.isNaN(b)) return null
    return Math.max(0, Math.floor((b - a) / DAY_MS))
  }

  /** One provenance line for a segment, verbatim facts from its stored row. */
  function evidenceText(seg, nowIso) {
    const e = seg.evidence
    if (!e) return { ageDays: null, line: "provenance not available" }
    const ageDays = evidenceAgeDays(e.fetchedAt, nowIso)
    const taxes = e.taxesFeesState === "stated" && e.taxesFeesAmount !== null && e.taxesFeesAmount !== undefined
      ? `taxes/fees stated ${nfmt(e.taxesFeesAmount)} ${e.taxesFeesCurrency || ""}`.trim()
      : `taxes/fees ${e.taxesFeesState || "unknown"}`
    const room = e.roomName ? `${e.roomName}${e.roomClass ? " · " + e.roomClass : ""}` : (e.roomClass || "room not stated")
    const parts = [
      `observed ${String(e.fetchedAt).slice(0, 10)}` + (ageDays === null ? "" : ` · ${ageDays} day${ageDays === 1 ? "" : "s"} ago`),
      `availability ${e.availabilityState}`,
      e.verificationLevel,
      taxes,
      room,
    ]
    return { ageDays, line: parts.join(" · ") }
  }

  // ── Perk truth on cards ────────────────────────────────────────────────────

  /** "Stay for 5, pay for 4" — a NIGHT-COUNT subtraction from an applied
   *  arithmetic rule's free-night count. Never points, never a total. */
  function payForText(seg, res) {
    if (!res || res.state !== "applied" || !res.affectsArithmetic) return null
    if (!(res.freeNights > 0) || !(seg.nights > res.freeNights)) return null
    return `Stay for ${seg.nights}, pay for ${seg.nights - res.freeNights}`
  }

  /** Which DECLARED key kind satisfied a rule — "Card benefit", "<Status>
   *  benefit" or "Member benefit"; null when nothing declared satisfies it. */
  function perkAttribution(res) {
    const keys = (res && res.satisfiedBy) || []
    if (keys.length === 0) return null
    if (keys.every(k => k.startsWith("card:"))) return "Card benefit"
    const status = keys.find(k => k.startsWith("status:"))
    if (status) return `${humanizeKey(status.slice(7))} benefit`
    return "Member benefit"
  }

  /** Declared-key prefixes per program — closed vocabulary matching the perk
   *  rules' eligibility keys; never inferred from names or bookings. */
  const PROGRAM_KEY_PREFIXES = {
    HILTON_HONORS: ["HILTON"], MARRIOTT_BONVOY: ["MARRIOTT"],
    IHG_ONE_REWARDS: ["IHG"], WORLD_OF_HYATT: ["HYATT", "WORLD_OF_HYATT"],
  }
  function keyMatches(program, key) {
    return (PROGRAM_KEY_PREFIXES[program] || []).some(p => key.startsWith(p))
  }

  /** "Hilton Diamond · Card: IHG Premier Card" / "Member" / "no entitlement
   *  declared" for one program, from the DECLARED held.* lists only. */
  function heldSummary(held, program) {
    if (!held) return "no entitlement declared"
    const statuses = (held.statuses || []).filter(k => keyMatches(program, k)).map(humanizeKey)
    const cards = (held.cards || []).filter(k => keyMatches(program, k)).map(k => `Card: ${humanizeKey(k)}`)
    const member = (held.memberships || []).some(k => keyMatches(program, k))
    const parts = [...statuses, ...cards]
    if (parts.length === 0 && member) return "Member"
    if (parts.length === 0) return "no entitlement declared"
    return parts.join(" · ")
  }

  /** True when the declaration is empty — every perk then resolves
   *  not_eligible and the life-perk ranking equals the fewest-switches one. */
  function nothingDeclared(heldEntitlements) {
    if (!heldEntitlements || !heldEntitlements.held) return true
    const h = heldEntitlements.held
    const anyHeld = (h.memberships || []).length + (h.statuses || []).length + (h.cards || []).length > 0
    const anyCert = (heldEntitlements.certificates || []).some(c => c.quantity > 0)
    return !anyHeld && !anyCert
  }

  // ── Explicit re-check inputs — the plan's OWN exact windows, nothing more ──

  /** Distinct {checkIn, nights} pairs of the plan's segments. */
  function segmentWindows(plan) {
    const seen = new Set(); const out = []
    for (const s of plan.segments || []) {
      const k = `${s.checkIn}|${s.nights}`
      if (seen.has(k)) continue
      seen.add(k); out.push({ checkIn: s.checkIn, nights: s.nights })
    }
    return out
  }

  /** One {checkIn, nights} per coalesced uncovered run — exactly the gap. */
  function gapWindows(plan, rangeStart, requestedNights) {
    return calendarModel(plan, rangeStart, requestedNights).blocks
      .filter(b => b.kind === "gap")
      .map(b => ({ checkIn: b.dates[0], nights: b.span }))
  }

  // ── "Book this plan" checklist — one reservation per segment ───────────────

  /** Copyable booking checklist. Per-night lines stay per-night, program lines
   *  come from programTotalText (null once any per-night segment), no cash,
   *  no cross-program figure, availability never claimed. */
  function bookingChecklist(plan) {
    const lines = []
    let linked = 0
    let prev = null
    for (let i = 0; i < (plan.segments || []).length; i++) {
      const s = plan.segments[i]
      const price = segmentPriceText(s)
      const conditions = []
      for (const r of s.perks || []) {
        if (r.state !== "applied" && r.state !== "qualifies_but_unpriced") continue
        for (const c of r.bookingConditions || []) if (!conditions.includes(c)) conditions.push(c)
      }
      const nav = s.navigation || { quality: "UNAVAILABLE", url: null, observedAt: null }
      const noLink = !nav.url || nav.quality === "UNAVAILABLE"
      if (!noLink) linked++
      const key = `${s.provider}|${s.providerPropertyRef}`
      const e = s.evidence || null
      lines.push({
        index: i + 1,
        dates: `${s.checkIn} → ${s.checkOut}`,
        nights: s.nights,
        propertyName: s.propertyName,
        program: s.program,
        priceMain: price.main,
        priceSub: price.sub,
        conditions,
        availabilityText: e && e.availabilityState === "available"
          ? "availability stated available at observation time — still not a live hold"
          : "availability unknown — historical observation, not a live hold",
        observedAt: (nav.observedAt || (e && e.fetchedAt) || "").slice(0, 10) || null,
        navigation: nav,
        sameHotelAsPrevious: prev === key,
        noLink,
      })
      prev = key
    }
    const textBlocks = lines.map(l => [
      `${l.index}. ${l.dates} · ${l.nights} night${l.nights === 1 ? "" : "s"} · ${l.propertyName} · ${l.program}`,
      `   ${l.priceMain}${l.priceSub ? ` (${l.priceSub})` : ""}`,
      l.conditions.length ? `   Book: ${l.conditions.join("; ")}` : null,
      `   ${l.availabilityText}${l.observedAt ? ` · observed ${l.observedAt}` : ""}`,
      l.noLink ? `   no trustworthy provider link — search manually for exactly these dates` : `   ${l.navigation.url}`,
      l.sameHotelAsPrevious ? "   same hotel as the previous segment — separate observed windows; book as separate reservations unless the hotel confirms one" : null,
    ].filter(Boolean).join("\n"))
    const programLines = (plan.programTotals || []).map(t => `   ${t.program}: ${programTotalText(t)}`)
    const text = [
      `Stay plan — ${lines.length} separate reservation${lines.length === 1 ? "" : "s"}`,
      ...textBlocks,
      "Points by program:",
      ...programLines,
      "Per-night figures are per-night only; no stay total was computed. Each segment is one reservation at its exact observed dates; availability is not confirmed.",
    ].join("\n")
    return { lines, linked, text }
  }

  // ── Points held (local AwardWallet snapshot) vs a SOURCE-STATED total ──────

  /** Declared bridge from hotel-program keys to balance programKeys. The
   *  programKey itself comes from the balances module's display-name mapping,
   *  so this alone is NOT enough to call an account "this program's points". */
  const BALANCE_KEYS_FOR_PROGRAM = {
    MARRIOTT_BONVOY: ["marriott"], HILTON_HONORS: ["hilton"],
    WORLD_OF_HYATT: ["hyatt"], IHG_ONE_REWARDS: ["IHG"],
  }
  /** Canonical AwardWallet account names (lower-cased, exact) that ARE the
   *  program's own points currency. Only these accounts may back a
   *  covers/shortfall verdict; a "Hilton Grand Vacations Club" or "Marriott
   *  Vacation Club" account is a different currency and never does. */
  const BALANCE_ACCOUNT_NAMES = {
    MARRIOTT_BONVOY: ["marriott bonvoy", "marriott rewards", "marriott"],
    HILTON_HONORS: ["hilton honors", "hilton hhonors", "hilton (honors)", "hilton"],
    WORLD_OF_HYATT: ["world of hyatt", "hyatt (world of hyatt)", "hyatt gold passport", "hyatt"],
    IHG_ONE_REWARDS: ["ihg one rewards", "ihg rewards club", "ihg hotels & resorts (one rewards)", "ihg"],
  }

  /**
   * Compare the LARGEST SINGLE canonical account of a program against that
   * program's source-stated total. Accounts are never summed, programs never
   * crossed, per-night figures never touched, transfers never assumed. An
   * account matched only by programKey (a name-derived key) is shown but
   * never produces an affordability verdict.
   */
  function heldForProgramTotal(accounts, programTotal) {
    const keys = BALANCE_KEYS_FOR_PROGRAM[programTotal.program] || []
    const names = BALANCE_ACCOUNT_NAMES[programTotal.program] || []
    const mine = (accounts || []).filter(a => keys.includes(a.programKey))
      .map(a => ({ program: a.program, balance: a.balance, displayBalance: a.displayBalance || nfmt(a.balance),
        canonical: names.includes(String(a.program || "").trim().toLowerCase()) }))
    if (mine.length === 0) return { accounts: [], largest: null, verdict: "no-balance", shortfall: null, text: "held: not available" }
    const canonical = mine.filter(a => a.canonical)
    if (canonical.length === 0) {
      const top = mine.reduce((m, a) => a.balance > m.balance ? a : m, mine[0])
      return { accounts: mine, largest: top.balance, verdict: "name-matched", shortfall: null,
        text: `held: ${nfmt(top.balance)} ("${top.program}" — name-matched account, not an affordability statement)` }
    }
    const largest = Math.max(...canonical.map(a => a.balance))
    const heldText = `held: ${nfmt(largest)}${canonical.length > 1 ? ` (largest of ${canonical.length} accounts — not summed)` : ""}`
    if (programTotal.statedTotal === null || programTotal.statedTotal === undefined) {
      return { accounts: mine, largest, verdict: "no-stated-total", shortfall: null, text: `${heldText} · stay total unavailable — no affordability statement` }
    }
    if (largest >= programTotal.statedTotal) {
      return { accounts: mine, largest, verdict: "covers", shortfall: null, text: `${heldText} · largest single account covers the source-stated total` }
    }
    const shortfall = programTotal.statedTotal - largest
    return { accounts: mine, largest, verdict: "shortfall", shortfall, text: `${heldText} · short by ${nfmt(shortfall)} vs the largest single account — transfers not assumed` }
  }

  return {
    TRIP_PRESETS, addDays, presetCheckout, nightsBetween, activePreset,
    calendarModel, programClass, perkStateLabel, segmentPriceText,
    programTotalText, summaryModel, planExplanation, humanizeKey, GOAL_LABELS,
    evidenceAgeDays, evidenceText, payForText, perkAttribution, heldSummary, nothingDeclared,
    segmentWindows, gapWindows, bookingChecklist, BALANCE_KEYS_FOR_PROGRAM, heldForProgramTotal,
    PROGRAM_KEY_PREFIXES,
  }
})
