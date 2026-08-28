# Travel Radar — Phase 8f handoff

For a fresh session continuing after Phases 8a–8f (Stay Radar + Trip Composer v1),
all built **locally on Windows, 2026-08-28**. Read `docs/PHASE7_HANDOFF.md` first for
the flight radar's own doctrine — everything there still holds and none of it was
modified. Branch `extreme-travel-radar`, nothing pushed to any remote.

## The one rule before any other

**Vault71 (the Synology NAS) is production and runs ONLY the Phase-7 flight radar.**
Nothing from Phase 8 is deployed. The local `data/travel-radar.db` is a fresh dev
database (flight tables locally hold only a small Phase-8f test collection); the NAS
holds the only live flight data and sends real notifications. Never point local code
at the NAS, never run a second scheduler against its database.

## What was built (phases completed)

- **8a — Stay foundation**: migration 012; `stay_properties` = the **Luxury
  Universe** (50 slug-verified properties, `config/stay-properties.json`, TripAdvisor
  `g{geo}-d{prop}` keys for all 50) vs the **Active Observation Set** (`active=1`,
  currently 12) — membership metadata exists, automatic promotion deliberately does
  not. `providers/stays/` contract (mirrors cash-flights: never-throw, capabilities
  as data, registry + `setStayProviders` test seam). Xotelo provider (free keyless
  TripAdvisor rates + 90-day cheap/avg/high heatmap).
- **8b — Scheduler + Agoda**: migration 013; own lease (`stay_scheduler_state`),
  deterministic rotating sparse grid, reserve-before-await budgets, per-provider
  circuit breaker (TRANSPORT failures only — semantic HTTP-200 errors and cold-cache
  empties never trip it), confirmation trigger (median ≥20% below w/ ≥5 sibling-
  excluded priors, or calendar-cheap ≥50% of nights) → **Agoda room-grid** clean-room
  provider (`POST www.agoda.com/api/v1/property/room-grid`, static bundle key
  `ag-initiator-api-key`, `x-gate-meta = base64(epochMs|uuid|path)`, currency by
  NUMERIC id — USD=7, cookie-free; ref format `propertyId:cityId:countryId`).
- **8c — Judgement**: migration 014 `stay_candidates` (upsert on source_id;
  price-free `opportunity_key` on the shared 3-day dateFamily grid); baselines with
  hard dims + relaxation ladder; absolute bars; evidence facts; `stays.html`.
- **8d — Discovery expansion + verification**: migration 015; four-concept scoring
  (relative .40 / absoluteValue .25 / evidence .20 / actionability .15); percentile
  × baseline-maturity; targeted sampling (calendar cheap-window runs + neighbours of
  ≥15%-below lows + window-edge probes); **SerpAPI Google Hotels** provider
  `serpapi_hotels` = metered VERIFICATION ONLY behind a gate that records WHY before
  every spend (`stay_verifications`, reasons like RELATIVE_ANOMALY_NEAR_THRESHOLD).
- **8e — Hardening**: migration 016; **tax status is a hard baseline dimension**
  (included/excluded/partial/unknown never share a baseline); `before_tax_nightly`
  stored only when provider stated the tax (never estimated); category-relative
  absolute value (cross-property cheap tail, own property excluded, min 20 samples /
  2 properties — currently inert for lack of peer data, by design); shared SerpAPI
  account ceiling; trip-ready `stays/opportunities.ts` (sources separated).
- **8f — Trip Composer v1**: migration 017 `trip_opportunities`; `trips/` joins
  stay windows × stored flights (cash round trips + paired one-way awards),
  windows-first search with hard ceilings, price-free `trip_key`, cash/miles never
  blended, unknowns named, trip-level absolute bars (`config/trips.json`),
  overpriced kill, complexity penalties, `trips.html` + `/api/trips`.

## Invariants that must not regress (Phase-8 additions to Phase 7's list)

- **No look-ahead** for every baseline (`fetched_at < asOf`, sibling exclusion by
  `search_request_id` — never timestamp equality; calendar "latest" is per-date
  MAX(id), never `fetched_at =`). Cross-source evidence and ACTIONABILITY use
  current knowledge on purpose; only baselines are strictly as-of.
- **Hard comparability (stays)**: property, source_class (meta/retail), room_class
  (NULL is its own class), board, occupancy, currency, **tax status**. Only
  relaxation: nights bucket, recorded. AI ≠ FB ≠ breakfast, ever.
- **Price honesty**: `price_basis` — a lead_in teaser can never become a stay total
  (`stayTotalFor` returns null); missing tax figures stay "unknown", never
  "included"; before-tax figures derived only from provider-stated numbers.
- **Zero vs absent**: a rule that RAN and said ordinary keeps its weight at raw 0;
  "no rule exists" drops and renormalises (visible at weight 0). No-history cap 80.
  Penalties subtract, never join components.
- **Provider replaceability**: nothing outside a provider file may know a provider's
  name/shape. Every response is echo-checked (property identity, dates, currency);
  a mismatch is a failed result, never recorded data. Providers never throw.
- **Money**: cash components carry currencies and are NEVER converted or blended;
  mixed currencies stay itemised (`cashTotal` null); miles per program, never
  cash-valued; unknown costs are named strings, never zero.
- **Budgets**: reserve-before-await everywhere; ceilings reduce scope and record it;
  verification-level candidates are excluded from verification targets (else a
  self-perpetuating spend loop — test-pinned).
- **Tests**: `threads:false` (better-sqlite3 segfaults in workers); `tests/setup.ts`
  points XOTELO/AGODA/SERPAPI_HOTELS API bases at an unroutable port and blanks
  credentials empty-not-deleted — never weaken it.

## Provider funnel and budgets

| Tier | Provider | Cost | Role |
|---|---|---|---|
| discovery | `xotelo` (data.xotelo.com, keyless) | free | date-specific per-OTA nightly + heatmap; cold-cache empties = retry-later streaks; per-ref calendar-unsupported marking |
| confirmation | `agoda` (unofficial room-grid) | free, revocable | room-level tax-in prices, board, cancellation; only after a trigger; NO retries; 4/run, 12/day |
| verification | `serpapi_hotels` (SERP_API_KEY shared w/ flights) | metered | gate-only; own budget `STAYS_SERPAPI_MONTHLY_BUDGET` (15) **capped by** `SERPAPI_ACCOUNT_MONTHLY_ALLOWANCE` (default 100, never assume paid) minus the flight budget (90) → **effective 10/mo**; plus combined-usage guard. Flight budget + manual reserve structurally unreachable. 2/run, 3/day, 7-day opportunity cooldown |
| (not built) | LiteAPI | — | deliberately not implemented |

Response-shape gotchas: Xotelo `timestamp` is MILLISECONDS; SerpAPI `google_hotels`
with a specific-hotel `q` returns a DIRECT property response (top-level
name/rate_per_night/prices), not `properties[]` — both parsed; `award_prices` has
`points`, no `price_amount`.

## Components map

```
providers/stays/   types.ts (contract) index.ts (registry+wrappers) xotelo.ts agoda.ts serpapi-hotels.ts
stays/             config registry(universe) store normalize sampling targeting lease budget
                   observer(scheduler) trigger baseline scoring absolute category evidence
                   windows(actionability+families) engine(judge) candidates verification
                   opportunities identity cli
trips/             config types identity compose store cli
config/            stays.json stay-properties.json trips.json  (every number has a *Note)
db/migrations/     012..017
UI                 stays.html trips.html (+ /api/stays/deals, /api/trips in serve.ts — additive)
CLI                stays:* (seed properties status health rates triggers dry-run run start stop
                   resolve-agoda evaluate candidates windows opportunities verify verifications
                   show report observe)  trips:compose|list|show|report
scripts/collect-trip-flights.ts   one-off free flight collection aimed at stay windows
.claude/launch.json               preview server "travel-radar" (serve.ts :8888)
```

## Latest real findings (local dev DB)

- History: **477 stay rate observations, 806 calendar days**, 12 scheduler runs;
  usage lifetime: xotelo 131, agoda 13, serpapi_hotels 3 (+1 raw diagnostic).
- **Lily Beach Nov 19–21**: rel 93, 33% below a clean 34-obs baseline; verified
  live — Google cheapest **$833/nt tax-in** (Agoda channel), room-level $937 tax-in
  AI Lagoon Villa, official $1,105; usual $1,019–1,519. Score 63.4 — correctly
  sub-70 (absolute bars say ordinary: 681 > 650; window only 2 check-ins).
- **Soneva September**: 46–51% below median — but Agoda's real price is $2,896
  tax-in (+62% over the $1,782 meta quote, RETAIL_SPREAD_HIGH), non-refundable,
  isolated. Needs verification before trusting. **GV Sept 17–27**: sustained
  6-check-in window, only 19% below — low season, not a mispricing.
- **Trips (8f real run)**: 12 composed; top = VIE→MLE economy ($723/person) + Lily
  $681 AI = **$4,851 total (2 adults, 5n)**, fired the maldives|AI|economy trip bar
  ($970/nt < 1000) — the whole-vacation judgement surfacing what neither sub-70
  component could. Verified-stay variant $6,131 @ 48.2. Soneva ×4 admitted via a
  genuine flight-side judgement (the $865 Sept economy fare scored 45.3).
- **Still 0 stay candidates ≥ 70** and that is correct: every near-miss has a
  nameable missing ingredient. Do not lower thresholds to manufacture results.
- Limitations: no local award/positioning/open-jaw data (constructions supported,
  unfed); category axis waits for peer-property history; amanpuri + 4 others lack
  agoda refs (`stays:resolve-agoda`); Maldives transfers are a named unknown;
  flight-side local baselines thin (7 of 10 skipped).

## State

- **Tests 658 passing** (`npm test`, all offline), lint 0 errors (5 pre-existing
  warnings in old flight files), typecheck clean.
- Production: untouched throughout Phase 8. Local: everything above, uncommitted
  until the Phase-8f commit this handoff ships with.

## Explicitly NOT implemented (deliberate)

Notifications for stays/trips (no gates, no queue — stay/trip tables carry no
notification fields); LiteAPI; package holidays; SerpAPI as discovery; automatic
Active-Set promotion; trip-history baselines (substrate stored, never judged from);
any booking/prebooking anywhere; production deployment of Phase 8.

## Recommended next step

**Phase 8g: package-holiday RESEARCH ONLY** — evaluate whether tour-operator
package pricing (TUI/DER-style, flight+hotel bundles) can be observed cheaply and
legally enough to add a package tier to the composer; the 8a-era research found the
official APIs partner-gated and only scraping-grey routes open. Research and a
proposal first; no implementation without an explicit go.
