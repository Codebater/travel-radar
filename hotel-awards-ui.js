/**
 * Hotel Award Radar — presentation-layer sorting and buy-points math.
 *
 * Loaded by hotel-awards.html as a classic script (window.HotelAwardsUI) and
 * by tests as a module — one implementation, no drift. Everything here is
 * DISPLAY logic over observations exactly as stored; nothing alters, ranks
 * into, or writes anything.
 *
 * Load-bearing honesty rules:
 *   - every cost this file can compute is an ESTIMATED COST TO BUY POINTS at
 *     a promo's source-stated purchase rate — never hotel value, cash value
 *     or savings;
 *   - a computation exists ONLY with an explicit effectiveCostPerMile from
 *     the promo feed — no rate, no number;
 *   - per-night figures stay per-night: nothing in this file multiplies by
 *     stay nights, so an average points/night can never become a stay total.
 *     A source-stated pointsTotal may be priced, but only when the caller
 *     passes that stated total explicitly.
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== "undefined" && module.exports) module.exports = api
  root.HotelAwardsUI = api
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /**
   * Estimated cost, in US cents, to BUY `points` at an explicit promo
   * purchase rate (`cpmCents` = source-stated ¢ per point). Null whenever
   * the rate is not explicitly stated — never derived, never guessed.
   */
  function buyPointsCostCents(points, cpmCents) {
    if (typeof points !== "number" || !Number.isFinite(points) || points <= 0) return null
    if (typeof cpmCents !== "number" || !Number.isFinite(cpmCents) || cpmCents <= 0) return null
    return Math.round(points * cpmCents)
  }

  /**
   * Estimated PER-NIGHT buy-points acquisition cost (cents) for one
   * observation: its source-stated points/night × the current promo's
   * explicit purchase rate. Null without both. Deliberately ignorant of
   * `nights` — a full-stay acquisition figure from an average is forbidden.
   */
  function acquisitionPerNightCents(observation, promoIndex) {
    if (!observation || observation.pointsPerNight === null || observation.pointsPerNight === undefined) return null
    const promo = promoIndex ? promoIndex[observation.program] : undefined
    if (!promo || promo.effectiveCostPerMile === null || promo.effectiveCostPerMile === undefined) return null
    return buyPointsCostCents(observation.pointsPerNight, promo.effectiveCostPerMile)
  }

  /** "$150" / "$37.50" / "$1,234" from cents — display helper for acquisition costs. */
  function centsToDollars(cents) {
    if (cents === null || cents === undefined) return null
    const whole = cents % 100 === 0
    return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })
  }

  const SORT_MODES = ["newest", "points", "cash", "buypoints"]

  /**
   * Sort a COPY of the observation rows for display. "newest" preserves the
   * API's order (newest first — the current, honest default). Rows missing
   * the sorted-on fact always go last, in their original order; ties keep
   * the newest-first order. Nothing here filters or mutates.
   *
   * "cash": cash-context amounts are compared within USD first, then other
   * currencies (grouped, never converted — cross-currency amounts are not
   * comparable), then rows with no cash context.
   *
   * "buypoints": rows participate ONLY when their program has a current
   * promo with an explicit purchase rate AND the row states points/night;
   * the key is that per-night ACQUISITION cost (buying the points), never a
   * hotel value.
   */
  function sortObservations(rows, mode, promoIndex) {
    const list = Array.isArray(rows) ? rows.slice() : []
    if (!SORT_MODES.includes(mode) || mode === "newest") return list

    const indexed = list.map((o, i) => ({ o, i }))
    const byOrder = (a, b) => a.i - b.i
    const lastNull = (key) => (a, b) => {
      const ka = key(a.o); const kb = key(b.o)
      if (ka === null && kb === null) return byOrder(a, b)
      if (ka === null) return 1
      if (kb === null) return -1
      return ka - kb || byOrder(a, b)
    }

    if (mode === "points") {
      indexed.sort(lastNull(o => (o.pointsPerNight === null || o.pointsPerNight === undefined) ? null : o.pointsPerNight))
    } else if (mode === "cash") {
      indexed.sort((a, b) => {
        const ga = cashGroup(a.o); const gb = cashGroup(b.o)
        if (ga !== gb) return ga - gb
        if (ga === 2) return byOrder(a, b)
        return (a.o.cashComparisonAmount - b.o.cashComparisonAmount) || byOrder(a, b)
      })
    } else if (mode === "buypoints") {
      indexed.sort(lastNull(o => acquisitionPerNightCents(o, promoIndex)))
    }
    return indexed.map(x => x.o)
  }

  function cashGroup(o) {
    if (o.cashComparisonAmount === null || o.cashComparisonAmount === undefined) return 2
    return o.cashComparisonCurrency === "USD" ? 0 : 1
  }

  return { buyPointsCostCents, acquisitionPerNightCents, centsToDollars, sortObservations, SORT_MODES }
})
