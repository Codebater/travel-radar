# Travel Radar — Phase 8j handoff

For a fresh session with no access to prior conversations, continuing after
Phases 8g–8j (package tier → market comparison → bookable offers → business
fare radar), all built **locally on Windows, 2026-08-28**, branch
`extreme-travel-radar`, checkpoint commit `1c5f3fb` (`feat: complete travel
market comparison and business fare radar phases 8g-8j`). Nothing pushed to
any remote. Read `docs/PHASE7_HANDOFF.md` and `docs/PHASE8F_HANDOFF.md` first
— everything there still holds and none of it was modified.

## The one rule before any other

**Vault71 (the Synology NAS) is production and runs ONLY the Phase-7 flight
radar.** Nothing from Phase 8 is deployed. The local `data/travel-radar.db`
is the dev database. Never point local code at the NAS, never run a second
scheduler against its database, never deploy without an explicit go.

## Project purpose

An Extreme Travel Opportunity Radar. It observes, over time and append-only:
**cash flights** (fast_flights free tier + SerpAPI metered), **award
flights** (Roame/ATF), **stays** (Xotelo → Agoda → SerpAPI Hotels funnel),
and **tour-operator packages** (TUI, CHECK24). On top of the observations it
builds: **package-vs-DIY market comparison** with **FX normalization** (ECB),
a **cost-inclusion ledger** per construction, **bounded verdicts** (a winner
only when the evidence supports a number), **actionable provider links**
(OfferLocator) with **offer rechecks**, and a **flexible business-class fare
radar** over the user's home airports.

The intended human workflow:

```
SEARCH → COMPARE → INSPECT → RECHECK → FOLLOW PROVIDER → BOOK
```

The system only looks and links. It NEVER books, holds, pays or notifies
(notifications exist only in the production flight radar).

## Phase 8g — package tier (migration `db/migrations/018_packages.sql`)

- **Providers** (`providers/packages/`): `tui.ts` (Tier 0 seasonal calendar +
  Tier 1 dated offers, keyless CloudFront + api.cloud.tui.com endpoints;
  hosts live in `config/packages.json` because they may rotate — rotation is
  a health event, never a silent fallback) and `check24.ts` (Tier 2
  cross-seller confirmation via the form-POST job/poll endpoint; `Empty` is a
  valid zero-offer answer). Contract in `providers/packages/types.ts`,
  registry + never-throw wrappers in `providers/packages/index.ts`.
- **Contract rules**: providers never throw; capabilities are DATA
  (`PackageProviderCapabilities`), never name checks; every response is
  echo-checked (hotel identity, dates, currency, occupancy, board) — a
  mismatch is a failed result, never recorded data. HTTP 403/429/503, a
  `cf-mitigated` header or HTML instead of JSON = **blocked**: stop
  immediately, record the event, NO retries ever.
- **Observations** (`package_offer_observations`, append-only): seller
  (provider) and tour operator preserved separately and never collapsed —
  TUI/L'TUR and CHECK24/L'TUR are different booking paths even at the same
  price. Transfer status is evidenced (`included`/`not_included`/`unknown`),
  baggage likewise; the package TOTAL is the authoritative price and a
  flight/hotel split is stored only when the seller genuinely supplied one.
- **Variants**: the current view (`latestPackageObservations` in
  `packages/store.ts`) keeps one cheapest row per (transfer status × room
  class) variant of the newest batch, so a cheaper transfer-unknown row can
  never shadow a transfer-included exact match.
- **Budgets** (`packages/budget.ts`): reserve-before-await, TUI 6/run 24/day,
  CHECK24 4/run 12/day (a poll loop is ONE search); refusals are recorded
  `skipped` events. Provider usage/health rides the generic `provider_usage`
  / `provider_events` tables.
- Measured trap: CHECK24 `roomAllocation` "A" = ONE adult ("A-A" = two);
  `price.person` vs `price.total`; hotel nights = `overnightStays` with
  check-in derived from the outbound flight's actual arrival datetime. TUI
  offers `startDate/endDate` bound the WHOLE TRIP envelope, not check-in.

## Phase 8h — market comparison (migration `db/migrations/019_market.sql`)

- **FX observations** (`market/fx.ts`, `fx_rate_observations`): Frankfurter
  serving the **ECB euro reference rates** — keyless, canonical host
  `api.frankfurter.dev/v1` (config `config/market.json`; the old .app host
  301-redirects and the provider refuses redirects). Comparison currency:
  **EUR**. Native amounts are NEVER overwritten; every conversion references
  the exact FX row id (historically reproducible from the DB alone); a rate
  older than 7 days (by its own reference date) REFUSES a numeric verdict;
  only configured pairs convert — **no chaining** through a third currency.
- **Cost ledger** (`market/ledger.ts`): one line per category (airfare,
  award_taxes, accommodation, hotel_taxes_fees, transfers, baggage,
  positioning, package_total, other), each **KNOWN / INCLUDED / UNKNOWN /
  NOT_APPLICABLE**. UNKNOWN is never zero; INCLUDED lines carry NO amount so
  a package total can never be double-counted; miles ride beside the ledger,
  never inside cash.
- **Verdicts** (`market/verdict.ts`, `market_verdicts`): market constructions
  (diy_cash / diy_award / diy_positioning / diy_open_jaw /
  package:<seller>:<operator>) compete per slot. Confidence HIGH / MEDIUM /
  LOW / INSUFFICIENT; a numeric winner requires compatible currency (native
  or fresh stored FX), EXACT/CLOSE comparability with equal nights, and **no
  material unresolved unknown on the LEADING side** (transfers,
  hotel_taxes_fees) — otherwise the output is a bounded statement: *"DIY is
  currently EUR X lower BEFORE the unknown transfers — NOT a saving"*, which
  recomputes automatically once the unknown becomes a KNOWN line. Trailing-
  side unknowns only widen the leader's margin (floor). <5% gap =
  TOO_CLOSE_TO_CALL.
- **Compute batches**: every run stamps `compute_batch`; current views read
  only the newest batch per trip, so superseded rows (including ~2.1k
  pre-batch NULL rows from an early 8g run) can never pollute a ranking —
  and they are never deleted.
- **Re-quote**: stay collection flipped to native EUR
  (`config/stays.json` observation.currency; EUR baselines start fresh —
  currency is a hard dimension; USD history remains valid through FX). Cash
  flight collection stays USD (production radar); the market layer converts
  per-component.

**Lily Beach reference example** (real data, 2026-08-28, fx#1 USD→EUR
0.85874): DIY verified variant EUR 5,264.94 vs best EXACT package EUR 6,908
(TUI/L'TUR, transfer included; CHECK24/L'TUR quotes the identical 6,908 —
cross-seller consistency; best CLOSE = CHECK24/AurumTours 6,094, transfer
unknown). Verdict: INSUFFICIENT_COMPARABILITY at LOW confidence — *DIY is
currently EUR 1,643.06 lower BEFORE the unknown transfers*. The single
missing datum is the Lily speedboat transfer price for 2 (it must exceed
€1,643 to flip). No estimate was inserted, by design.

## Phase 8i — bookable offers (migration `db/migrations/020_offers.sql`)

- **OfferLocator** (`offers/locators.ts`, `offer_locators`): one locator per
  source observation (package / flight / stay) with explicit **navigation
  quality**: `EXACT_DEEP_LINK` (provider returned a URL for THIS offer),
  `SEARCH_REPLAY_LINK` (provider search reconstructed from the offer's own
  parameters), `PROVIDER_LANDING_LINK` (plain hotel/provider page),
  `UNAVAILABLE`. EXACT is never fabricated.
- **Per provider**: CHECK24 = EXACT via its per-offer `detailsUrl` (preserved
  verbatim, resolved against the provider origin, live-validated to open the
  offer detail view incl. `accommodationCode`); TUI = SEARCH_REPLAY via the
  parameterized
  `tui.com/pauschalreisen/suchen/angebote/<slug>/<giataId>/offer/?…` page (no
  per-offer URL exists in any TUI response — honest); flights = the stored
  Google Flights query URL verbatim (never EXACT — no itinerary token
  exists); stays = TripAdvisor landing (xotelo) / dated Agoda search replay /
  Google Travel search replay (serpapi).
- **URL safety** (`offers/urls.ts`, allowlist in `config/offers.json`):
  parse-then-assert — https only, exact-host allowlist per provider, no
  credentials; relative provider paths resolve against the provider origin
  and the host must SURVIVE. A failing URL degrades the locator, it is never
  repaired.
- **Verification** (`offers/recheck.ts`, `offer_verifications`,
  append-only): recheck re-resolves the locator through the provider
  (budget-reserved) and echo-diffs price/currency/dates/nights/adults/board/
  transfer/operator/room. Any change is RECORDED (`changed` + per-dimension
  list) — never silently the same offer; a price change renders as
  PRICE CHANGED (observed / current / difference / checked) while the
  historical observation, price and links survive untouched. Statuses:
  verified / changed / unavailable / blocked / expired / unsupported.
  Recheck results are themselves NEW observations.
- **DIY navigation**: a DIY trip is components, not one booking — Flight
  [open search] + Hotel [open page/search] + Transfer UNKNOWN row, assembled
  in `offers/assemble.ts` and rendered in `trips.html`.

## Phase 8j — business fare radar (migration `db/migrations/021_fare_radar.sql`)

Purpose: *"find the cheapest bookable business-class fares from my home
airports in the next N days"* — a planned sweep over date combinations, not
an exact-date search.

- **Origins are config** (`config/fare-radar.json`): `homeAirports.primary`
  = VIE, PRG; `extended` = BUD, BTS, MUC with `extendedEnabled: false`
  (toggle per run with `--extended` or UI checkboxes). Nothing hard-codes an
  airport.
- **Destinations**: specific mode (`--destination BKK`), watchlists
  (`asia` — BKK HKT SIN KUL HKG NRT HND ICN TPE DPS SGN HAN MNL —
  `americas`, `middle-east-africa`), and `--anywhere` = **the union of every
  watchlist, honestly labelled**: no cash provider we use supports true
  destination-less discovery, so "anywhere" means "everywhere we chose to
  look".
- **Planner** (`fareradar/planner.ts`): provider capabilities are data
  (`PROVIDER_PROFILES`: both cash providers are fixed-date only, no calendar,
  no grid), so flexibility is SYNTHESIZED: **Tier 0** sparse evenly-spaced
  departure probes per route at a representative preferred trip length
  (preferred lengths 4/5/6/7/8/10/12/14 — never an assumed 7); **Tier 1**
  refines the cheapest cells with trip-length variants + a neighbour date;
  **Tier 2** re-confirms finalists fresh. The full plan (calls per tier,
  cap, and every reduction) is computed BEFORE the first request, printed,
  and stored on the run.
- **Request budgeting**: hard cap 60 searches/run (config), deterministic
  reduction order probes → refinement cells → destinations, each cut named
  (`REDUCED: destination MNL dropped… rotate it into the next run`). The
  radar uses the FREE provider only: `allowMeteredFallback: false` on every
  search in `fareradar/engine.ts` — **SerpAPI is structurally unreachable**
  and the run summary proves `0 billable calls`.
- **Cabin truth** (`fareradar/score.ts`): cabin is echo-checked;
  `NormalizedSegment.cabin` (added in `providers/cash-flights/types.ts`)
  carries per-segment evidence — SerpAPI states `travel_class` per leg →
  `BUSINESS_FULL` / `BUSINESS_MIXED`; fast_flights states nothing →
  `BUSINESS_UNVERIFIED` (labelled with the reason, penalized, never promoted
  to FULL); an economy/premium echo is `ECONOMY` / `PREMIUM_ECONOMY` and is
  removed from value ranking while staying visible.
- **Quality flags**: LONG_LAYOVER, OVERNIGHT_CONNECTION, AIRPORT_CHANGE,
  computed only from stated segment times; drops (max 2 stops, max 30h) are
  counted. SELF_TRANSFER/SEPARATE_TICKET exist in the vocabulary but cannot
  fire from today's single-ticket providers.
- **Ranking**: raw **CHEAPEST** always beside **BEST VALUE** (deterministic
  `dealScore` = 100 × cheapest/price minus named config penalties — no
  opaque model). Home airports compete naturally and the report exposes the
  fare DIFFERENCE (never an invented positioning cost).
- **History**: candidates (`fare_radar_candidates`) link into append-only
  `flight_prices` and carry a strict `fare_window_key`
  (origin|destination|date family|nights bucket|cabin|adults|currency);
  `typicalFareFor` in `fareradar/store.ts` refuses below maturity (3 distinct
  fetch days / 5 observations).
- **Recheck**: `recheckTopFares` re-searches finalists (forceRefresh, capped
  at 5) and writes Phase-8i `offer_verifications`; candidates are never
  mutated.
- **Surfaces**: `fares.html` (form from config, plan display, cheapest /
  best-value / destination dashboard, RECHECK TOP 5 with PRICE CHANGED
  display); routes in `serve.ts`: `GET /api/fares/config`,
  `GET /api/fares/radar`, `POST /api/fares/run`, `POST /api/fares/recheck-top`
  (plus 8g–8i routes `GET /api/packages`, `GET /api/market`,
  `GET /api/offers`, `POST /api/offers/recheck`); CLI:
  `npm run flights:radar` / `flights:radar-report` / `flights:radar-recheck`
  (and `--dry-run` prints the plan with ZERO requests).

## Current live reference state (historical evidence, NOT a current fare)

Phase 8j validation run #1 (2026-08-28, VIE+PRG → BKK, 30-day window,
business, 4–14 nights): plan 33/cap 60 → **28 searches, 0 billable calls,
130 candidates**. Historical cheapest observed: **PRG → BKK EUR 2,120,
Austrian, Sep 23 → Oct 1, 8 nights, 2 stops, 13h25, BUSINESS_UNVERIFIED,
flags LONG_LAYOVER + OVERNIGHT_CONNECTION**. Historical VIE comparison:
EUR 2,593, Qatar Airways, 1 stop → difference EUR 473 exposed. Top 3
finalists rechecked successfully at their observed prices at that time.
These are dated observations in the dev DB — treat as evidence, re-run for
current fares.

## NON-NEGOTIABLE INVARIANTS

- Observations are **append-only**; history is NEVER mutated, rewritten or
  deleted (superseded rows are batch-scoped out of current views, kept).
- Native prices are never overwritten; conversions are views referencing the
  exact stored FX observation; FX provenance is always retained.
- Stale or missing FX **refuses** a numeric verdict — a rate is never
  invented, never an LLM, never a constant, never chained through a third
  currency.
- **UNKNOWN is never zero.** An absent cost is a named unknown.
- **INCLUDED never adds an amount** — no double counting of package totals.
- No hidden component price by subtraction (a flight/hotel split exists only
  when the seller supplied it).
- Provider identity is DATA (rows/capabilities), never schema or name checks.
- Sellers and operators remain distinct — **no seller collapse**, ever.
- **No fabricated URLs, no fabricated prices.** EXACT_DEEP_LINK only when the
  provider returned that URL for that offer; URL safety = https + exact-host
  allowlist, parse-then-assert.
- A blocked provider ends the operation — **no retry storms**, no CAPTCHA or
  bot-wall circumvention, ever.
- Every provider response is **echo-checked** (identity, dates, currency,
  occupancy, cabin, board); a mismatch never enters history.
- A **material unknown on the LEADING side cannot create a savings claim** —
  bounded statement instead.
- **Exact comparability outranks a misleadingly cheaper close variant** (both
  are preserved).
- **BUSINESS_UNVERIFIED is not BUSINESS_FULL**; missing cabin evidence is
  never upgraded by assumption.
- Metered provider use must be explicit; the fare radar sets
  `allowMeteredFallback: false` everywhere.
- Radar caps are computed BEFORE requests and are never silently exceeded —
  reductions are named in the stored plan.
- Rechecks create NEW observations; old offer prices and links survive every
  verification outcome.

## Current config (verified from disk, `config/fare-radar.json`)

primary VIE, PRG · extended BUD, BTS, MUC (off by default) · comparison/
request currency EUR · cap 60 searches/run · default window next 30 days ·
4–14 nights (preferred 4/5/6/7/8/10/12/14) · sparse 5 probes/route · refine
6 cells × 3 variants · confirm 5 finalists · quality max 2 stops / 30h /
6h layover · baselines mature at 3 distinct days + 5 observations.

## Quality state (verified 2026-08-28)

**812/812 tests passing** (`npm test`, fully offline — `tests/setup.ts`
points every keyless host at an unroutable port), **lint 0 errors** (5
pre-existing warnings in old flight files), **typecheck clean** (`npx tsc
--noEmit`).

## Git checkpoint

Commit `1c5f3fb` — `feat: complete travel market comparison and business
fare radar phases 8g-8j` (65 files, all four migrations, the packages/
market/offers/fareradar modules, both new pages, configs and tests). Local
only; the branch has never been pushed.

## Next phase candidate — ONE_WAY (NOT implemented)

The next desired capability: **ONE_WAY flexible business-fare discovery.**

Already verified design facts:
- `CashFlightQuery.returnDate` is nullable; `flight_prices.return_date` is
  nullable; `itineraryHash` supports a null return; the flight replay
  locator renders without a return date; the Phase-6.5 open-jaw discovery
  has already exercised one-way search paths through the same orchestrator.

Fare-radar-specific blockers:
- `fare_radar_candidates.return_date` and `.nights` are currently NOT NULL →
  one-way needs **migration 022** (SQLite cannot relax NOT NULL in place —
  table rebuild or an explicit `trip_type` column with defined semantics;
  append-only doctrine applies).
- **ONE_WAY must be a hard observation/ranking dimension** — one-way and
  round-trip candidates/baselines must NEVER mix (Phase 6.5 measured why:
  long-haul one-ways are not half a return).
- `typicalFareFor` filters `return_date IS NOT NULL` — needs an explicit
  one-way branch, never silent mixing.
- The one-way planner should spend its per-cell refinement budget on denser
  DATE discovery instead of meaningless trip-length variants.

Intended architecture: implement **ROUND_TRIP and ONE_WAY first**. Only
later construct **SPLIT_ROUND_TRIP** from independently observed outbound
and inbound ONE_WAY markets — never as a giant direct combinatorial provider
search. Potential later: OPEN_JAW (the discovery engine's open-jaw machinery
already assembles stored one-way legs).

## Read order for the next session

1. `docs/HANDOFF_PHASE_8J.md` (this file)
2. `db/migrations/018_packages.sql`, `db/migrations/019_market.sql`,
   `db/migrations/020_offers.sql`, `db/migrations/021_fare_radar.sql`
3. `providers/cash-flights/types.ts` (flight provider contract incl.
   per-segment cabin)
4. `offers/locators.ts` (OfferLocator + navigation quality)
5. `config/fare-radar.json`
6. `fareradar/score.ts` (cabin mix + deal score types) and
   `fareradar/store.ts` (candidate/run types + typicalFareFor)
7. `fareradar/planner.ts`
8. `fareradar/engine.ts`
9. `market/fx.ts` and `packages/baseline.ts` (history/baseline doctrine)
10. `fareradar/cli.ts` (and `offers/cli.ts`, `market/cli.ts`,
    `packages/cli.ts`)
11. `serve.ts` (API routes, search for `/api/fares`)
12. `fares.html`
13. `tests/fare-radar.test.ts`, `tests/market-verdict.test.ts`,
    `tests/offers-locators.test.ts`
