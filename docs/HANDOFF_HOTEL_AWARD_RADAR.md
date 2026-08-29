# Handoff — Hotel Award Radar (and next direction: consecutive-night stay optimizer)

Written 2026-08-28 at the end of the Hotel Award Radar session. Audience: the next Claude Code conversation, starting fresh in `flight-search-agent/`.

## Current checkpoint

- Branch: `extreme-travel-radar`, no upstream — **nothing pushed**.
- HEAD: `755a61e` ("feat: add consecutive hotel award stay planner"), on top of `072449c` (design spine), `8e82642` (buy-points tools), `bc413a1` (discovery interface), `e199ce0` (sparse discovery), `9d52f2f` (perk semantics), `3e46452` (verified perks), `7441c71` (radar readout).
- Tests: **1076/1076 passing** (46 files, `npx vitest run`, verified at this HEAD).
- Typecheck (`npx tsc --noEmit`): **clean**.
- Lint (`npm run lint`): **0 errors, 5 pre-existing unused-var warnings** (searchClass, ROOT, balances, config, job) — not from this session's work, leave them unless asked.
- Nothing deployed. **Vault71 (NAS) still runs the pre-Phase-8 flight radar only** — everything from Phase 8a onward (stays, packages, market, fare radar, deal radar, promos, hotel awards) is local-only on this Windows machine.

## Product architecture (very short map)

All domains share one SQLite DB (`data/travel-radar.db`, better-sqlite3, migrations in `db/`) and one HTTP server (`serve.ts`) serving static HTML dashboards + `/api/*` routes.

- **Cash/award flight dashboard** — `dashboard.html` + `search.ts` orchestrator (Roame GraphQL awards, SerpAPI Google Flights cash, hidden-city). The original product.
- **Observer** — `observer/` + `observer.html`. Project-wide background engine + status umbrella (`observer/overview.ts` reports every domain).
- **Business Fare Radar** — `fareradar/` + `fares.html`. Cash business/first fares, ROUND_TRIP and ONE_WAY as first-class trip shapes (never compared to each other), maturity-gated "typical fare" baselines.
- **Stays (cash hotels)** — `stays/` + `stays.html`. Cash hotel rate observations (Xotelo/Agoda/SerpAPI providers in `providers/stays/`), own scheduler, verification pipeline.
- **Packages / market verdicts** — `packages/` (Check24/TUI providers) + `market/` (FX ledger, verdicts) + `trips/` (Trip Composer). Budget-capped, manual-run.
- **Deal Radar** — `dealradar/feed.ts` + `dealradar.html`. **READ-ONLY projection** over decisions already stored — never searches, never re-scores, never invents a number; only writes are deterministic locator upserts.
- **Miles Promo Feed** — `providers/promos/awardwallet-blog.ts` + `/api/promos/miles`. Buy-points promo enrichment (airline + hotel tables).
- **Hotel Award Radar** — `providers/hotel-awards/` + `hotel-awards.html` + `/api/hotel-awards`. This session's product; details below.

## Hotel Award Radar — current state

Phase HA-1: observation and read-out only. No valuation, no ranking, no buy-points math, no optimizer.

- **Providers** (contract in [providers/hotel-awards/types.ts](../providers/hotel-awards/types.ts), provider-neutral like cash-flights):
  - **Gondola** ([gondola.ts](../providers/hotel-awards/gondola.ts)) — free anonymous MCP server at `mcp.gondola.ai/mcp` (JSON-RPC over Streamable HTTP, markdown results, parsers pinned to measured dialect with fixtures). Tools: `search_hotels`, `get_multi_night_rates`, `get_booking_link`. 403/429/503 = BLOCKED, stop, no retry.
  - **Roame Encore** ([roame.ts](../providers/hotel-awards/roame.ts)) — authenticated `HotelAvailablePeriods` query on `roame.travel/encore/graphql`, same session cookie file as the flight scraper (`~/.openclaw/credentials/roame.json`). Locations are **explicit configured bboxes only** (currently just `bangkok` in `config/hotel-awards.json`) — the provider never geocodes.
- **Store** ([store.ts](../providers/hotel-awards/store.ts)) — normalized, **append-only** `hotel_award_observations` table, dedupe-keyed, with offer-locator links.
- **Current programs observed**: HILTON_HONORS, IHG_ONE_REWARDS, MARRIOTT_BONVOY, WORLD_OF_HYATT, WYNDHAM_REWARDS.
- **Current local data**: 79 observations (40 gondola_hotels, 39 roame_hotels), all Bangkok-area probes.
- **UI/API**: [hotel-awards.html](../hotel-awards.html) reads `/api/hotel-awards` (serve.ts ~line 478) — read-only list with program/provider filters, per-observation navigation links, and a mandatory disclaimer string.
- **CLI**: `npm run hotel-awards:probe` / `hotel-awards:list` ([providers/hotel-awards/cli.ts](../providers/hotel-awards/cli.ts)). Request plan is printed before execution and hard-capped per `config/hotel-awards.json`.

### Semantics that must not be broken

- **Gondola quotes full stays** (`quoteBasis: "full_stay"` when it prints "(N pts total)"); **Roame's `avgAwardPoints` is per-night** (`quoteBasis: "per_night"`). The two are stored as stated and never converted into each other.
- **No synthesized totals**: a per-night figure is NEVER multiplied into a stay total; `pointsTotal` exists only when the source printed one.
- Unknown taxes are state `"unknown"`, never 0. Gondola never states taxes.
- `availabilityState: "unknown"` means a historical/period observation, not a live hold. Gondola multi-night confirmation counts only when the response **echoes the exact requested window**.
- Provenance preserved: provider, sourceProgramName, sourceFreshness, raw ref, verificationLevel (`cached`/`discovered`/`verified`).
- Search never throws — blocked/empty/night_clamped/incomplete are structured `searchState`s.

## Verified hotel-perk + entitlement layer (built + provenance-hardened 2026-08-28/29)

The perk foundation from this handoff's original NEXT STEP items 1–2 now EXISTS (display-only; no optimizer, no arithmetic, no ranking change):

- **`config/hotel-perk-rules.json`** — 7 program-neutral rules. **6 are `verification: "source_page"`**: the encoded conditions were read on the official source on 2026-08-28 and exact quotes are stored per-rule in `verificationEvidence`. **Hyatt Globalist remains `knowledge_encoded` (unverified)** — world.hyatt.com bot-walls automated browsing; re-verify manually before optimizer use. Notable source-verified corrections: Hilton 5th-night needs Silver+ incl. the new Diamond Reserve tier and 100%-Points standard-room bookings; Marriott S5P4 is ONE reservation, lowest-point night, one free night per redemption stay (certs excluded); the IHG Ambassador weekend benefit is an annual CERTIFICATE tied to a dedicated named rate (not a standing perk), and Ambassador costs **USD 225 or 45,000 points** (not $200); Hilton Gold's benefit is now a daily F&B credit, not breakfast; Marriott Platinum "breakfast" is really a brand×region Elite Welcome Gift choice matrix.
- **`config/entitlements.json`** — declared-only entitlements: `held.*` (empty by default — NEVER inferred), `purchasable[]` with declared acquisition costs, `certificates[]` (declared quantity only; consumption state is deliberately NOT config).
- **`providers/hotel-awards/perks.ts`** — typed loaders + validation (refuse-loudly) + pure `applicablePerks()` matcher → `PerkBadge[]` with eligibility states `eligible` / `purchasable` / `requires`. Badges carry no numbers.
- **`/api/hotel-awards`** enriches each observation with `perks[]` (fail-soft: config error → `perksError`, never a broken read-out); **`hotel-awards.html`** renders the badges — and only `source_page` rules may present as verified; `knowledge_encoded` rules render "· unverified" with downgraded styling.
- Tests: `tests/hotel-award-perks.test.ts` + extended `tests/hotel-awards-api.test.ts` pin all of the above, including that observations are exposed unchanged and no total is ever synthesized.

### Machine-readable optimizer semantics (added `9d52f2f`, 2026-08-29 — the five former blocking limitations are RESOLVED)

Optimizer-critical conditions are now typed fields on every rule (validated refuse-loudly in `perks.ts`, passed through onto `PerkBadge`), never prose-only:

- `repetition: once_per_stay | per_block | once_per_certificate | null` — required on arithmetic rules, null on benefit-only; `per_block` means "repeats every `stayPattern.minNights` nights".
- `requiresCertificate: {type, quantity} | null` — type matches `entitlements certificates[].key`; must travel with (and only with) `once_per_certificate`. The matcher downgrades "eligible" to "requires" (naming `certificate:TYPE`) when declared certificate stock is insufficient.
- `requiredRateName` — exact named rate the booking must use (Ambassador's "Ambassador Complimentary Weekend Night").
- `constraints` (closed vocab: `single_reservation`, `standard_room_only`, `full_points_only`, `weekend_stay`) and `exclusions` (`free_night_certificate`, `award_redemption`, `other_free_night_offers`) — presence = source-stated; absence = unstated, never permission; unknown values are validation errors.
- Entitlements: `acquisitionAlternatives` (points-priced, kept separate from cash) — Ambassador: USD 225 OR 45,000 IHG points.

Current assignments: Marriott S5P4 = once_per_stay + single_reservation/standard_room_only + excludes free_night_certificate; Hilton 5th = once_per_stay + standard_room_only/full_points_only; IHG card 4th = once_per_stay + single_reservation; Ambassador = once_per_certificate + cert{IHG_AMBASSADOR_WEEKEND_NIGHT,1} + named rate + weekend_stay + excludes award_redemption/other_free_night_offers; the three benefit-only rules carry all-null/empty semantics (enforced).

### Remaining schema gaps (non-blocking, do not paper over)

1. **Repetition floors**: Hilton 5th-night and IHG-card 4th-night are encoded `once_per_stay` as a conservative floor — their verified sources state the benefit singularly. Upgrading to `per_block` requires reading each program's full T&C recurrence language first.
2. **Brand × region × choice matrices** (Marriott Elite Welcome Gift, per-property Hilton F&B amounts) remain unencoded — benefit-only rules, never enter arithmetic.
3. **"Weekend night" calendar definition** (which days count) is program-specific and not encoded — the `weekend_stay` constraint flags the requirement; its semantics belong to the optimizer design.

## Hotel points promos

`providers/promos/awardwallet-blog.ts` parses AwardWallet's public buy-points promotions page — **airline and hotel tables, categorized, never mixed**.

- Hotel promos join stay cards only via a property's **explicit `loyaltyProgram` affiliation** (config-mapped enum via `hotelProgramMap` in `config/miles-promos.json`) — never by name matching.
- **Purchase-rate handling**: `effectiveCostPerMile` is echoed only when the source prints one; `upTo: true` marks tiered maxima. A promo whose end date passed is `active: false`.
- **No fake award valuation**: promos are enrichment badges (`promo-enrich.js`, used by stays.html/deals.html/fares.html); award results remain the source of truth for required points, taxes, availability. Nothing computes "this stay costs $X via bought points."

## Observer relationship

Observer (`observer/`) is the project-wide status/background umbrella. Per `observer/overview.ts`, current scheduling per domain:

- **scheduled** (Observer's own tick): flights, notifications (runs as the tick's last step).
- **own-scheduler**: stays (its own lease-based scheduler, `stays:start`).
- **manual-only**: fare-radar, packages-market, fx, **hotel-awards** ("probe/manual only — hotel-awards:probe CLI; Phase 1, no background job").

Deal Radar is not a scheduled domain at all — it remains a read-only projection computed on request.

## IMPORTANT NEXT PRODUCT DIRECTION

Extend the **EXISTING Hotel Award Radar** — do NOT create another product/page.

Target capability: the user enters e.g. **Bangkok, Nov 1 → Dec 1, 30 nights** and eventually receives an optimized combination of REAL hotel stays using:

- real cash rates (stays domain),
- real hotel award availability/points (hotel award observations),
- hotel points-purchase promos (Miles Promo Feed hotel table),
- verified loyalty/status/card perks.

Example perk types: nth-night-free award benefits; Marriott "Stay for 5, Pay for 4"; Hilton 5th-night-free on qualifying award stays; InterContinental Ambassador weekend-night benefit; breakfast/lounge/status benefits; free-night certificates. The optimizer may recommend switching hotels/programs mid-window to cover the period cheaply.

**Hard doctrine for the optimizer:**

- Every night of the requested window covered exactly once.
- NEVER extrapolate nightly award availability into a multi-night booking.
- NEVER synthesize points totals unless the source/rule explicitly supports the construction (e.g. a program's published 5th-night-free rule applied to a source-stated per-night figure is a *rule-supported construction* and must cite the rule; a bare avg × nights is forbidden).
- Cash and points remain separate; no blended currency.
- Perks require explicit, verified eligibility (status level, card held, rate type) — never assumed.
- Paid membership/status acquisition cost (e.g. Ambassador fee) is included in the math when its perk is used.
- Annual certificates cannot be reused across the same plan.
- Breakfast/lounge/upgrades are listed as benefits, never silently monetized into the price comparison.
- Direct-booking perks apply only to compatible (direct/qualifying) rates.
- Provider/source provenance preserved on every leg of the plan.

## Since the perk layer: discovery, interface, buy-points tools, design spine (all DONE, 2026-08-29)

- **Sparse long-window discovery** (`e199ce0`): LIVE-VERIFIED — Roame's HotelAvailablePeriods is an EXACT-WINDOW quote engine (always echoes the requested check-in + night count; `minNights` only filters; adjacent windows price differently, so cross-window extrapolation is invalid). Long ranges are covered by the deterministic sparse planner (`providers/hotel-awards/planner.ts`: 2/4/5/7-night windows anchored start/middle/end, explicit pre-stated budget, deterministic reduction with dropped windows reported) executed via the shared `executeWindowPlan` (`discover.ts` — one loop for CLI `discover` and `POST /api/hotel-awards/discover`; `GET /api/hotel-awards/plan` previews with zero provider calls). Blocked stops the run, no retries; Gondola keeps its exact-window verifier role and budget.
- **Discovery is visible and testable** (`bc413a1`): hotel-awards.html carries the search band (destination/dates/guests → Search stays) with the planner demoted to a collapsed "Advanced search details" disclosure; nothing runs without an explicit click. The **flight → stay hand-off exists**: the dashboard's journey CTA ("Continue → Find your stay in BKK") and the RT-summary "Find stay" pass destination/dates/adults via URL; one-way passes NO check-out (the hotel page clears the field and refuses until the user picks one — never invented).
- **Buy-points tools** (`8e82642`): sort toolbar (newest default, lowest points/night, lowest cash context, best buy-points opportunity), shared hotel promo-feed enrichment on award cards (promo-enrich.js over `/api/promos/miles`, expired/unmapped never shown), and the **points purchase calculator** ("30,000 points × 0.5¢ = about $150 — Estimated cost to BUY these points", never hotel value/savings). All math in `hotel-awards-ui.js` — explicit promo rates only, structurally incapable of touching `nights` (test-enforced), source-stated full-stay totals usable only on explicit choice.
- **Shared design spine exists** (`072449c`): `radar.css` tokens + `radar-nav.js` navbar (Flights · Stays · Deals · Trips + Radar menu: Observer · Fare Radar · Market) applied to the dashboard and hotel-awards — hero search bands, split hotel cards with program-branded tiles (no fake photos), larger price anchors, provenance in Details disclosures. Presentation only; every honesty string survives verbatim. Remaining pages adopt the spine in later slices.

## Consecutive-night stay optimizer V1 (DONE, `755a61e`)

`providers/hotel-awards/stayplan.ts` + `GET /api/hotel-awards/stayplan?checkIn&checkOut` + the "Find best stay plan" button on hotel-awards.html — a READ-ONLY projection over stored observations (no searches, no writes, no observations created; explicit click only).

- **Algorithm**: append-only history collapses to one edge per property/program/EXACT observed range (newest wins, deterministic); a forward DP over calendar dates with state (dateIndex, lastProperty) walks stay edges plus 1-night gap edges, so best-partial coverage falls out of the same search. Up to 3 alternative plans come free from the final DP states. Range cap 370 nights.
- **Ranking doctrine (lexicographic, conservative)**: 1. fewer uncovered nights — complete coverage always wins; 2. fewer hotel switches (gaps never count as switches); 3. lower source-stated points ONLY when the comparison is valid (identical program sets, every segment of every program carries a stated full-stay total, per-program dominance ≤/<) — any per-night-only segment makes plans incomparable and the rule skips; 4. stable lexicographic signature tie-break.
- **Complete vs partial**: a complete plan beats any partial regardless of switches; when full coverage is impossible the best partial is labelled as such with the EXACT uncovered dates listed.
- **Points doctrine, enforced and test-asserted**: mixed loyalty programs are NEVER summed into one number (no cross-program total exists anywhere in the output); Roame per-night averages are never synthesized into stay totals — a per-night-only segment nulls its program's total and is flagged ("a per-night average is never multiplied into a stay total"); source-stated full-stay totals are authoritative and sum within one program only.
- **Live examples (current stored data)**: Bangkok Nov 1 → Dec 1 = complete 30/30 single segment (voco Bangkok Surawong, 30n per-night-only, 0 switches) + 3 alternatives; Nov 1 → 21 over 322 edges = 20/20 via four chained REAL 5-night windows, all Aloft Bangkok Sukhumvit 11, 0 switches, each window at its own observed rate (9,700/9,500/9,200/9,200 pts/night — no rate leaks across windows).

## NEXT STEP

**Perk-aware optimization**: apply the verified perk layer to V1 plans — machine semantics only (repetition, requiresCertificate, requiredRateName, constraints, exclusions from `config/hotel-perk-rules.json` + declared entitlements), each construction citing its rule id; Hyatt's unverified rule stays excluded from optimizer-grade use. Rule-supported constructions only (e.g. Marriott S5P4 on a 5-night single-reservation award segment with actual per-night values), never from averages. Enablers still pending: explicit Gondola/Roame → `stay_properties` ref mappings (observations still have `propertyId: null`; name-matching forbidden) before any cash mixing, and a Gondola exact-window confirmation pass for a winning plan only. **Do not implement until the perk-aware design is reviewed.** Hard doctrine in "IMPORTANT NEXT PRODUCT DIRECTION" above is unchanged and binding.

## Key files

- `providers/hotel-awards/{types,gondola,roame,store,cli,perks}.ts` — the whole Hotel Award Radar provider layer (perks.ts = perk/entitlement loaders + badge matcher).
- `config/hotel-perk-rules.json`, `config/entitlements.json` — the verified perk layer's data (rules with per-rule verification evidence; declared entitlements).
- `config/hotel-awards.json` — Gondola/Roame policy, Roame captured-search reference, location bboxes, budget caps.
- `hotel-awards.html`, `serve.ts` (routes `/api/hotel-awards` ~478, `/api/promos/miles` ~462).
- `providers/promos/awardwallet-blog.ts`, `config/miles-promos.json`, `promo-enrich.js` — promo feed + UI enrichment.
- `stays/` (esp. `store.ts`, `registry.ts`, `config/stay-properties.json`) — cash-hotel side the optimizer must join against; property identity lives here.
- `observer/overview.ts` — domain status map; extend it if hotel-awards ever gets a scheduler.
- `dealradar/feed.ts` — the read-only-projection precedent to imitate for any new read-out.
- `config/travel-profile.json` — likely home for entitlements; inspect before designing.
- Tests: `tests/hotel-awards.test.ts`, `tests/hotel-awards-roame.test.ts`, `tests/hotel-awards-api.test.ts`, `tests/hotel-award-perks.test.ts`, `tests/miles-promos.test.ts`, `tests/award-promo-ui.test.ts`, `tests/stay-promo-ui.test.ts` (fixtures in `tests/fixtures/`).
- Prior handoffs (context only, mostly superseded): `docs/HANDOFF_PHASE_8J.md`, `docs/PHASE8F_HANDOFF.md`, `docs/PHASE7_HANDOFF.md`.

## Recent commits (most relevant, newest first)

- `755a61e` feat: add consecutive hotel award stay planner (stayplan.ts, API route, plan UI, tests)
- `072449c` feat: add travel radar design spine (radar.css, radar-nav.js, dashboard + hotel-awards restructure)
- `8e82642` feat: add hotel award buy-points tools (sorting, promo enrichment, points purchase calculator, hotel-awards-ui.js)
- `bc413a1` feat: add hotel award discovery interface (search band, plan preview, flight→stay hand-off)
- `e199ce0` feat: add sparse hotel award discovery (exact-window semantics, planner, executor, CLI/API, config)
- `9d52f2f` feat: add optimizer-ready hotel perk semantics (repetition, certificates, named rates, constraints/exclusions, acquisition alternatives)
- `3e46452` feat: add verified hotel award perks (perk rules + entitlements configs, perks.ts, API/UI badges, tests)
- `7441c71` feat: add hotel award radar readout (`hotel-awards.html`, `/api/hotel-awards`, observer overview row)
- `180cc75` feat: add roame hotel award provider (Encore GraphQL, per-night semantics)
- `e64e572` test: stabilize timestamp-sensitive market tests
- `452a539` feat: expand observer status across travel domains (the scheduled/own-scheduler/manual-only map)
- `d4119d0` feat: add hotel award observations (Gondola provider, store, CLI, doctrine)
- `0da10ad` feat: add hotel points purchase promo enrichment (hotel table + loyaltyProgram joins)
- `ed7782c` feat: highlight miles purchase promotions
- `afd8831` feat: add miles purchase promo feed (AwardWallet page provider)
- `17a8535` feat: add one-way cash and award comparison (dashboard)
- `32b2ba4` feat: add deal radar discovery view (read-only projection)
- `9ac8a07` feat: one-way as a first-class trip shape in the fare radar (phase 8k)
- `1c5f3fb` feat: complete travel market comparison and business fare radar phases 8g-8j
- `744acde` feat: Stay Radar + Trip Composer v1 (Phases 8a-8f, local only)
- `ec8c123` deploy: the radar moves to the NAS, and Windows becomes the rollback (last commit that touched Vault71)

---

Read this handoff and inspect the referenced code before proposing changes. Existing code is authoritative when this document is stale.
