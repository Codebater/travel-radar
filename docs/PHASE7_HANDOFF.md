# Travel Radar — Phase 7 handoff

For a fresh session building Phase 8 **locally, on Windows**. Read this, then
`DEVELOPMENT.md` for setup detail. Written 2026-08-28.

## The one rule before any other

**Vault71 (the Synology NAS) is production. Windows is development only.**
Production runs unattended, holds the only live database, and sends real
notifications to a real phone. Phase 8 work must not modify production in any
way until it is explicitly, deliberately deployed. Never run a second
scheduler against the production database; never point local code at it.

## Current state

- Git: branch `extreme-travel-radar`, commit `ec8c123` (nothing pushed to any remote).
- Tests: **480 passing** (`npm test`), 0 lint errors, typecheck clean.
- Production: deployed 2026-08-28 to Vault71, compose project at
  `/volume1/docker/travel-radar/` (a `README.md` runbook lives there). Two
  containers: `travel-radar` (dashboard + scheduler, one container, either
  process dying restarts both) and `ntfy` v2.28.0 (self-hosted, auth
  `deny-all`, write-only publisher user + read-only phone user).
- Notifications are **ENABLED** in production (threshold 90, 2 immediate/day,
  1 digest/day, 24h cluster cooldown, quiet 23:00–08:00 Europe/Prague,
  extreme bypass at 97 with corroboration). The first two real alerts were
  delivered 2026-08-28 (VIE→DXB LifeMiles awards, low-history exception,
  labelled LOW BASELINE CONFIDENCE).
- Production URLs: LAN `http://192.168.0.37:8888`, tailnet
  `https://vault71.tailec23df.ts.net:8888`; ntfy on tailnet `:2586`. LAN +
  tailnet only — no port forwarding, no public exposure, ever.
- The pre-migration Windows database survives as
  `data/travel-radar.pre-nas-migration.db` — it is the **rollback artifact**;
  do not delete it, do not run against it.

## What this system is

An "Extreme Travel Opportunity Radar": it continuously observes cash and
award flight prices on routes from PRG/VIE, discovers opportunities nobody
asked for (flexible dates, wildcard destinations, positioning airports, open
jaws), scores anomalies against its own observed history, and interrupts a
person only for the tiny fraction worth interrupting for. No build step:
TypeScript run directly via `tsx`, Node 22, SQLite via better-sqlite3.

## Major modules

| Path | Job |
|---|---|
| `serve.ts` | HTTP server (loopback by default): dashboard, `/deals.html`, `/alerts.html`, `/observer.html`, read-only APIs, one narrow write endpoint (feedback) |
| `providers/cash-flights/` | Provider contract + fast_flights (free, via Python bridge) + SerpAPI (metered). `search()` never throws |
| `providers/award-flights/` | Roame (session cookie) + ATF. PROGRAM ≠ AIRLINE: one itinerary × N programs = N rows sharing an `itineraryHash` |
| `observer/` | Scheduler (SQLite lease, single holder), fixed-route observation jobs, backoff, health, backups |
| `discovery/` | Sparse→dense→confirm sampling, positioning economics, open-jaw leg collection, verification gate, budgets |
| `anomaly/` | Baselines (no look-ahead), scoring, sanity, absolute rules, clustering, feed, open-jaw candidate assembly |
| `notifications/` | Phase 7: eligibility gates, identity keys, queue state machine, quiet hours, ntfy channel, CLI |
| `db/` | Connection + file-based migrations (`db/migrations/*.sql`, applied in filename order on connect), backup |
| `config/*.json` | ALL tuning: anomaly weights, discovery scope, notification policy. Config, never code |

## Database

Single SQLite file (WAL). `DATABASE_PATH` env selects it; tests use throwaway
paths via `tests/setup.ts` (which also blanks provider keys and redirects
`BACKUP_DIR` — never weaken that file). 11 migrations, append-only history:
`flight_prices` / `award_prices` are never deleted. Key derived tables:
`deal_candidates` (one decision per observation, upsert on
source_table+source_id), `open_jaw_pairs` (a decision about TWO observations),
`candidate_clusters` (presentation families, rebuilt wholesale),
`notifications` / `notification_queue` / `notification_events` (Phase 7).

**Identity churn is the trap of this schema** (measured, not assumed):
candidate ids, cluster ids and open-jaw pair ids are all re-minted for
identical trips; `observed_at` on an open jaw is the assembly clock, not the
age of its legs. Anything needing durable identity uses the derived keys in
`notifications/identity.ts` (`opportunityKey` / `fingerprint` /
`cooldownKey`). Phase 8 should reuse this pattern, not reinvent it.

## Engine invariants (never regress)

- **No look-ahead**: a decision about an observation at time T uses only
  observations strictly before T; same-search siblings are excluded by
  `search_request_id`, never by timestamp.
- **Hard comparability**: origin/destination/cabin/trip-type/currency/program
  are never relaxed. Below 5 comparable observations, no decision is emitted.
- **Uncomputable ≠ zero**: a score component that cannot be computed is
  dropped and weights renormalise. But "no rule exists" ≠ "the rule said
  ordinary" (discriminate on `rulePath`, not `tier`), and a no-history
  decision is capped (`noHistoryScoreCap` 85).
- **Sanity before the thin-baseline exit**, and suspicious rows are stored
  (visible) but excluded from every later baseline.
- **Open jaws are two tickets**: never presented as one provider's round
  trip; never metered-verified as a single round trip (guarded twice); the
  saving is against a comparable round trip of the SAME trip length or it is
  null — never invented.
- **Positioning**: true trip start cost (fare+transfer+hotel) and a 0–1
  penalty are kept separate; the penalty subtracts from the score and cannot
  be outvoted by a discount.

## Budget invariants (never regress)

- SerpAPI: monthly budget minus an untouchable **manual reserve** = automation
  ceiling; discovery gets a share of that; the notification path has its own
  sub-cap (`search_requests.source='notify'`) and `userInitiated: false`
  always. Scheduled/discovery cash search always passes
  `allowMeteredFallback: false`.
- Budgets reserve **before** the await (concurrency-safe), reduce scope
  rather than overrun, and record every reduction on the run.
- Award searches cost one call per provider/class — check room for the whole
  search before starting it.

## Notification architecture (Phase 7, live)

Ten ordered gates, cheap first, money last — a score alone never notifies:
hard blockers → freshness (measured from the underlying `flight_prices` rows,
MIN across open-jaw legs, never from `observed_at`) → score → evidence
(MEDIUM baseline / verified / cross-verified / low-history WTF exception with
its own bar 85, always labelled LOW BASELINE CONFIDENCE) → structure
(open-jaw net saving, positioning worthwhileness) → dedup (fingerprint) →
operator feedback (BAD_SIGNAL by opportunity key) → re-alert (material
improvement on stored NUMBERS, ≥10% etc.; open jaw only on the combined
total) → rate limits (re-read per send, in-flight counts as spent) → verify.
Queue: QUEUED→CLAIMED→SENDING→terminal; `attempts` incremented **before** the
POST; crash mid-send = UNKNOWN, never re-sent (at-most-once). Quiet hours via
`Intl` with explicit `Europe/Prague` (never TZ env, never offset arithmetic);
digests are slot-due, not fire-at-8. Every decision — including every silence
— is recorded in `notification_events` with the blocker.

ntfy channel: publishes with the **JSON form** (headers can't be injected by
provider strings), POSTs to the origin only, `redirect: "error"`, destination
validated in `readNtfyConfig` (https, or loopback, or exactly the one
env-named internal host). Every error string passes `redactSecrets`. The
security suite boots `serve.ts` with canary secrets and asserts no page or
API serves them — keep it passing.

## Security invariants (never regress)

- Secrets only in `.env` / `~/.openclaw/credentials/`. Never in config JSON,
  HTML, API responses, logs, DB payloads, or git. The ntfy topic **is** the
  password on a public server — it is never printed anywhere ("topic hidden").
- `serve.ts`: loopback bind by default; dotfile/extension allowlist; Origin
  allowlist (plus env `RADAR_TRUSTED_ORIGINS` for LAN/tailnet, empty locally);
  the feedback POST is the only write endpoint (loopback or trusted-Origin,
  JSON only, size-capped). No endpoint can start a search that spends money.
- Deep links are built from config origin + integer only, with an
  origin-survival assertion; no candidate field ever reaches a URL.
- `results-*.json` files contain real loyalty balances — never commit, never
  bake into images.

## Providers — status and limits

- **fast_flights** (free cash): works via the `SOCS` consent cookie, pinned
  3.1.0, Python bridge probes `.venv` then `python3`/`python`.
- **SerpAPI** (metered cash): key in `.env`; budget enforced in DB.
- **Roame** (award): session cookie at `~/.openclaw/credentials/roame.json`
  (production copy on the NAS). **Expires ~2026-09-10.** On expiry: award
  runs report `SKIPPED_AUTH`, cash continues, scheduler stays healthy, and
  `notify:status`/`production:health` warn in advance. Renewal is manual
  (log in at roame.travel, replace the file, restart the container). Never
  automate login.
- **ATF**: BA works; Iberia is dead upstream (recorded DEGRADED). 50
  calls/month free tier, economy only.
- **AwardWallet**: blocked on `BUSINESS_ADMINS_REQUIRE_PLUS` (paid);
  hardcoded fallback balances in use. Not required by anything.
- **Miles & More**: unavailable on Roame's free tier despite docs;
  LH-group First is invisible without it. seats.aero is the known candidate
  source (not integrated — deliberate).

## Development on Windows

```bash
npm test               # 480 tests, all offline (threads:false is required — better-sqlite3 segfaults in workers)
npm run lint           # 0 errors expected
npm run typecheck
npm run dev            # dashboard on http://localhost:8888 (loopback only)
npm run observer:...   # seed|status|dry-run|run|health — fine locally, they use the LOCAL db path
npm run discovery:...  # seed|dry-run|run|status|openjaw|positioning|clusters|pool
npm run anomaly:...    # evaluate|backfill|candidates|report|feedback
npm run notify:...     # dry-run|test|status|report (test needs NTFY_* env; leave unset locally)
npm run db:verify      # integrity + row counts for any db file
npm run production:health   # meant for the NAS container; runs locally against the local db
```

Local `data/travel-radar.db` does not exist any more (renamed to the
`.pre-nas-migration.db` rollback artifact). Local runs will create a fresh
empty one — that is correct and expected; **never** copy the production DB
back for development, and never mount/point anything at the NAS paths.

## Production, at a high level

Vault71: `/volume1/docker/travel-radar/` — `compose.yaml`, `.env` (secrets,
chmod 600), `data/` (the live DB), `backups/` (integrity-checked snapshots),
`config/` (mounted read-only into the container; edit + `docker compose
restart travel-radar` to change policy), `credentials/`, `ntfy/`, `build/ctx/`
(image build context). Image `travel-radar:phase7` built on the NAS (no
buildx — classic builder). Ops go through SSH; the one status command is
`docker exec travel-radar npm run production:health`. To stop the radar, stop
the **container** (`observer:stop` inside it just triggers a supervised
restart). Deployment gotchas (npx swallows SIGTERM, Synology mount ownership,
`:ro` mounts vs WAL, etc.) are recorded in the deploy commit message
(`ec8c123`) and the NAS README.

## Known gaps

- No WOULD_BOOK/GOOD/NORMAL/BAD feedback exists yet — every threshold is a
  judgement, not a measurement; nothing auto-tunes (by design, §34).
- Award open jaws not implemented; open-jaw metered verification unsupported
  (needs an atomic two-call budget decision); positioning and open jaw do not
  compose; open-jaw pairs persist after their legs age out (the notification
  freshness gate compensates — candidate withdrawal architecture was
  deliberately not built).
- `verifyBeforeNotify` has never spent a real call. Digest path has never
  fired in production. Mexico open-jaw legs not yet collected.
- `discovery_runs.open_jaw_candidates` counts threshold-crossing decisions
  only — do not reinterpret.

## Phase 8 direction

The next project is a **lean Stay Radar**: unusually good hotel / resort /
all-inclusive opportunities, in the same spirit — observe, baseline, judge,
interrupt rarely. **Do not design or implement it yet.** When it starts:
build and test entirely locally on Windows against local databases, reuse the
invariants above (especially no look-ahead, config-not-code, budget ceilings,
derived identity, and the notification gate discipline), and touch production
only as an explicit, reviewed deployment step.
