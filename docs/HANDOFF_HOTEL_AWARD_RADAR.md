# Handoff — Hotel Award Radar (and next direction: consecutive-night stay optimizer)

Written 2026-08-28 at the end of the Hotel Award Radar session. Audience: the next Claude Code conversation, starting fresh in `flight-search-agent/`.

## Current checkpoint

- Branch: `extreme-travel-radar`, no upstream — **nothing pushed**.
- HEAD: `3e46452` ("feat: add verified hotel award perks"), on top of `7441c71` (hotel award radar readout).
- Tests: **994/994 passing** (41 files, `npx vitest run`, verified at this HEAD).
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

### Five optimizer-blocking schema limitations (found during verification — resolve before optimizer work, do not paper over)

1. **No certificate linkage**: a rule cannot require "one unused annual certificate" (Ambassador weekend night; Marriott's cert-exclusion from S5P4 is an inexpressible interaction).
2. **Brand × region × choice matrices** are not encodable (Marriott Elite Welcome Gift, per-property Hilton F&B amounts) — affected rules deliberately claim only the umbrella benefit.
3. **`acquisitionCost` cannot express alternatives** ("USD 225 *or* 45,000 points") — the points alternative lives only in the note.
4. **No machine-checkable rate-code requirement** (Ambassador's mandatory named rate lives in free-text `bookingChannel`).
5. **No repetition semantics** for nth-night rules (once per stay vs per N-night block — Marriott is once per stay per T&C; IHG's recurrence needs the card's full benefit terms). Both carry explicit `arithmeticNote` warnings.

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

## NEXT STEP

Original inspection items 1–2 (perk-rule data, entitlements) are DONE — see the verified perk layer section above. What remains, in order, all still gated on review before implementation:

1. **Resolve the five schema limitations above** (certificate linkage first — the Ambassador rule and free-night certificates both need it) so perk rules can become optimizer-grade.
2. **Long-date-window searching**: decouple Roame's `minNights` from the window length (currently hardcoded to the full window at `providers/hotel-awards/roame.ts` search(); config-capped), producing the segment inventory a 30-night window needs; Gondola stays the exact-window verifier under its budget caps, emitting `night_clamped` where measured.
3. **Explicit Gondola/Roame → `stay_properties` ref mappings** for the target city (all observations still have `propertyId: null`; name-matching stays forbidden) so cash and award sides can join.
4. **Consecutive-night optimizer** as a READ-ONLY projection (Deal Radar precedent): cover-every-night-exactly-once DAG over verified segments; cash and points totals reported separately; rule-supported constructions only, each citing its rule id; a Gondola confirmation pass for the winning plan only.

**Do not implement any step until its design is reviewed.** Hard doctrine in "IMPORTANT NEXT PRODUCT DIRECTION" above is unchanged and binding.

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
