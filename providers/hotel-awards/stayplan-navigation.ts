/**
 * Stay-plan booking navigation — a READ-ONLY join from ranked plan segments
 * to the locator each source observation already has.
 *
 * This runs AFTER buildStayPlan has ranked its plans, so nothing here can
 * move a plan, change a signature or reorder a segment: navigation is
 * attached as a fact for the reader, never as an input to ranking. It is the
 * same honesty ladder /api/hotel-awards exposes per observation — quality is
 * the locator's stored label, url is the best stored URL in ladder order
 * (deep link → search replay → landing), observedAt is when the locator's
 * source observation was fetched.
 *
 * Load-bearing constraints the code cannot show:
 *   - plain SELECTs only (getLocator / locatorForSource). This module never
 *     writes or rebuilds a locator, never imports the locator writer or any
 *     provider, and never constructs, repairs or re-validates a URL. A
 *     missing or degraded locator surfaces exactly as stored — UNAVAILABLE
 *     when no row exists at all;
 *   - EXACT_DEEP_LINK cannot appear for hotel awards today because the
 *     hotel-award locator builder records no deep link (no rate token
 *     exists). Nothing here upgrades that label;
 *   - no provider is called, ever — navigation is whatever was recorded at
 *     insert time, dated by observedAt so the reader can judge its age.
 */

import type { DB } from "../../db/index.js"
import { getLocator, locatorForSource } from "../../offers/locators.js"
import type { StoredHotelAward } from "./store.js"
import type { SegmentNavigation, StayPlanResult } from "./stayplan.js"

/**
 * Attach `navigation` to every segment of every plan in `result`, resolving
 * each segment's observation to its stored locator. The observation's own
 * locatorId is preferred (one SELECT by primary key); an observation absent
 * from `observations` or without a locatorId falls back to the source lookup
 * by table + observation id. Mutates `result` in place and returns the SAME
 * object — plans, signatures and segment order are untouched.
 */
export function attachSegmentNavigation(db: DB, result: StayPlanResult, observations: StoredHotelAward[]): StayPlanResult {
  const byId = new Map(observations.map(o => [o.id, o]))
  for (const plan of result.plans) {
    for (const seg of plan.segments) {
      const o = byId.get(seg.observationId)
      const locator = o && o.locatorId !== null
        ? getLocator(db, o.locatorId)
        : locatorForSource(db, "hotel_award_observations", seg.observationId)
      const navigation: SegmentNavigation = locator
        ? {
            quality: locator.navigationQuality,
            url: locator.deepLinkUrl ?? locator.searchReplayUrl ?? locator.landingUrl,
            observedAt: locator.observedAt ?? null,
          }
        : { quality: "UNAVAILABLE", url: null, observedAt: null }
      seg.navigation = navigation
    }
  }
  return result
}
