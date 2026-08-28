/**
 * Miles-purchase promo enrichment — presentation-layer join ONLY.
 *
 * Joins /api/promos/miles rows onto existing award results by the
 * loyaltyProgram enum (flight.pointsProgram). The promotion is on BUYING the
 * loyalty currency, never a discount on the fare itself — wording and
 * qualification here must keep that distinction. Award results, ranking and
 * recommendations are never altered by anything in this file.
 *
 * Loaded by dashboard.html as a classic script (window.PromoEnrich) and by
 * tests as a module — one implementation, no drift.
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== "undefined" && module.exports) module.exports = api
  root.PromoEnrich = api
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /**
   * Index of ACTIVE, MAPPED promos by loyaltyProgram. Unmapped rows and
   * expired rows never enter it; a failed/absent feed yields an empty index,
   * which disables enrichment without touching the results themselves.
   */
  function activePromoIndex(feed) {
    const index = {}
    if (!feed || feed.ok !== true || !Array.isArray(feed.promos)) return index
    for (const p of feed.promos) {
      if (!p.loyaltyProgram) continue     // unmapped source program — enriches nothing
      if (p.active !== true) continue     // expired dated promos never qualify
      if (!index[p.loyaltyProgram]) index[p.loyaltyProgram] = p
    }
    return index
  }

  /** An award result qualifies only via its own loyaltyProgram enum. */
  function qualifies(flight, index) {
    return Boolean(flight && flight.type === "award" && flight.pointsProgram && index[flight.pointsProgram])
  }

  /**
   * "BUY MILES +80%" / "BUY MILES -40%" — "UP TO" added only when the source
   * said so. The percentage belongs to buying miles, never to the fare.
   */
  function promoBadgeText(p) {
    const pct = p.bonusPercent !== null && p.bonusPercent !== undefined
      ? "+" + p.bonusPercent + "%"
      : "-" + p.discountPercent + "%"
    return "BUY MILES " + (p.upTo ? "UP TO " : "") + pct
  }

  /** "Ends Sep 16" when the source stated an end date; null otherwise — never invented. */
  function promoEndsText(p) {
    if (!p.validUntil) return null
    const m = String(p.validUntil).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return null
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return "Ends " + months[Number(m[2]) - 1] + " " + Number(m[3])
  }

  return { activePromoIndex, qualifies, promoBadgeText, promoEndsText }
})
