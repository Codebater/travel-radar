# Development Guide

> ## ⚠️ UNRESOLVED SECURITY ISSUE — real loyalty balances are in public git history
>
> `results-dxb-outbound.json` and `results-dxb-return.json` were committed
> before the `results*.json` ignore rule existed. They contain **34 real
> loyalty-account balances** (Marriott 984,722; Chase UR 387,429; Aeroplan
> 475,663; and 31 more) and are reachable in the public GitHub history of
> `wiziswiz/flight-search-agent`.
>
> **This is still unfixed.** Deleting the files from the working tree would not
> remove them from history. Fixing it requires a history rewrite plus a force
> push to the public repository, which destroys the existing commit hashes for
> anyone who has cloned it.
>
> **Nothing has been done about this without your explicit approval.** No
> history has been rewritten, nothing has been force-pushed, no remote history
> has been deleted, and no credentials have been rotated. When you want it
> resolved, the options are:
>
> 1. `git filter-repo --path results-dxb-outbound.json --path results-dxb-return.json --invert-paths`, then force-push, then ask GitHub Support to purge cached views.
> 2. Delete and recreate the repository from a clean tree.
> 3. Accept the exposure — the data is account balances, not credentials; no API
>    key, session cookie or password was ever committed (verified by scanning
>    the full history).
>
> Balances alone cannot be used to log in or book anything, so this is a privacy
> exposure rather than an account-takeover risk. It is still worth resolving.

Local setup for the flight search agent. Written against a Windows 11 machine
(PowerShell + Git Bash); the macOS/Linux differences are called out inline.

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | **22.x LTS** (verified on 22.15.0) | `package.json` declares `engines.node >= 22`. Node 22 is the current LTS and has the global `fetch` this project relies on. |
| npm | 10.x (ships with Node 22) | The lockfile is committed; use npm, not yarn/pnpm. |
| Python | **3.11+** (verified on 3.13.3) | Optional. Only needed for the two Python search sources. |
| git | any recent | |

There is **no build step**. TypeScript runs directly through `tsx`.

---

## 2. Install

```bash
npm install
```

`.npmrc` sets `legacy-peer-deps=true`. Without it npm aborts with `ERESOLVE`:
`vite-plugin-watch-and-run@1.8.x` wants `vite >= 5` while the project pins
`vite ^4.3.9` for the inherited AwardWiz scraper tooling. Nothing else in the
tree is affected.

Optional — the Python search sources:

```bash
python -m venv .venv
```
```bash
.venv/Scripts/pip install -r requirements.txt
```

On macOS/Linux the last line is `.venv/bin/pip install -r requirements.txt`.
`search.ts` auto-detects both venv layouts and otherwise falls back to whichever
of `python` / `python3` is on `PATH`.

---

## 3. Environment configuration

```bash
cp .env.example .env
```

PowerShell: `Copy-Item .env.example .env`

**Every credential is optional.** The app starts, the dashboard loads and a
search completes with none of them configured — each missing credential
disables exactly one source and is reported in the server console. You will get
zero results, which is the honest outcome, not a crash.

Since Phase 2 the **free cash provider needs no credentials at all**, so a clean
checkout returns real cash prices with an empty `.env`.

**Credentials**

| Variable | Where | Required for | If missing |
|----------|-------|--------------|------------|
| `SERP_API_KEY` | `.env` | Metered cash-price *verification*, hidden-city engine | Cash prices still work via the free provider, labelled `discovery` instead of `verified`; hidden-city returns 0 |
| `ATF_API_KEY` | `.env` *or* `~/.openclaw/credentials/awardtravelfinder.json` | Award Travel Finder cross-reference | `atf` source errors and is skipped |
| Roame session | `~/.openclaw/credentials/roame.json` only | All award availability | `roame` source errors and is skipped |
| AwardWallet key | `~/.openclaw/credentials/awardwallet.json` only | Real loyalty balances | Falls back to a hardcoded balance list in `search.ts` |

**Configuration** (all optional, defaults shown)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_PATH` | `./data/travel-radar.db` | SQLite file. Relative paths resolve against the project root; mount this as a Docker volume later |
| `CASH_CACHE_TTL_HOURS` | `8` | How long a cash-fare result stays servable without refetching |
| `AWARD_CACHE_TTL_HOURS` | `2` | Shorter, because award availability is more volatile |
| `SERPAPI_MONTHLY_BUDGET` | `90` | Total metered calls allowed per calendar month |
| `SERPAPI_RESERVE_CALLS` | `10` | Held back for manual verification; automation refuses to touch these |
| `CASH_CURRENCY` | `USD` | Currency asked of cash providers. The value engine does no FX conversion, so changing it makes CPP meaningless until a conversion layer exists |

`.env` is git-ignored and is **not** served over HTTP (the static server refuses
dotfiles). Never commit real keys.

### Credential file formats

`~/.openclaw/credentials/roame.json` — log in at roame.travel and copy the cookies:
```json
{ "session": "<firebase session jwt>", "csrfSecret": "<csrf secret>", "sessionExpiresAt": 1771829264892 }
```
Sessions expire. The scraper fails fast with the expiry date when they do.

`~/.openclaw/credentials/awardwallet.json`:
```json
{ "apiKey": "your-api-key", "userId": "your-user-id" }
```

On Windows `~` resolves to `%USERPROFILE%` (e.g. `C:\Users\you\.openclaw\credentials\`).

---

## 4. Running

### Dashboard

```bash
npm start
```

Then open **http://localhost:8888**.

`npm run dev` is the same command. Change the port with `npx tsx serve.ts --port 9000`.

The server binds to `127.0.0.1` only. To expose it on the LAN (deliberately —
it holds live loyalty sessions and paid API budget) pass `--host 0.0.0.0`.

### Search from the CLI

```bash
npm run search -- --from LAX --to LHR --date 2026-03-15 --class both
```

Note the `--` before the flags. Useful options:

```
--from <IATA>            Origin (default LAX)
--to <IATA>              Destination (default DXB)
--date <YYYY-MM-DD>      Departure (default 2026-04-28)
--return <YYYY-MM-DD>    Return date; omit for one-way
--class <ECON|PREM|both> Cabin group (default both)
--sources <list>         roame,atf,google,hidden-city (default: all four)
--flex <0|1|2>           Roame ±N days
--refresh                Bypass the cash cache and refetch (may spend metered calls)
--verify                 Ask the metered provider to confirm cash prices
--output <file>          Output file (default results.json)
--verbose                Per-source progress
```

`--refresh` and `--verify` both count as *user-initiated*, so they are the only
CLI paths permitted to spend the reserved SerpAPI calls.

Skip sources you don't have credentials for — and skip `atf` unless you need it,
since a full ATF search costs 5 of its 150 monthly calls:

```bash
npm run search -- --from LAX --to DXB --date 2026-04-28 --sources roame,google
```

Individual providers:

```bash
npm run roame -- --from LAX --to DXB --date 2026-04-28 --class PREM
```
```bash
npm run atf -- --from LAX --to LHR --date 2026-03-15 --unified
```

### Checks

```bash
npm run typecheck
```
```bash
npm run lint
```
```bash
npm test
```

**`npm test` never spends API credit.** `tests/setup.ts` deletes `SERP_API_KEY`
and `ATF_API_KEY` from the test environment and redirects `DATABASE_PATH` to a
temporary file, and every provider in the suite is a mock from `tests/mocks.ts`.
A test that accidentally reached a real provider would fail with `unconfigured`
rather than quietly billing a call. The security suite boots a real `serve.ts`
on an ephemeral port but only makes requests that are rejected before any search
starts.

The suite covers cache keys and itinerary identity, cache hit/expiry/corruption,
database insertion and append-only history, deduplication, provider fallback,
concurrent quota updates, the SerpAPI budget guard, and the Phase 1 security
fixes.

`npm run test:scrapers` runs the inherited AwardWiz suite. It drives real
airline sites through headless Chrome and every scraper in it is commented out
upstream, so it currently collects zero tests. Don't expect it to pass.

### Stopping / restarting

`Ctrl+C` in the server terminal. If a port is stuck:

```bash
netstat -ano | findstr :8888
```
```bash
taskkill /PID <pid> /F
```

macOS/Linux: `lsof -ti:8888 | xargs kill`.

---

## 5. Cash providers, cache and database

### Provider ordering

Cash prices come through `providers/cash-flights/`. Nothing else in the
application names a vendor — adding a provider means implementing
`CashFlightProvider` and adding it to the registry in `providers/cash-flights/index.ts`.

Every search walks three tiers:

| Tier | Source | Label | Cost |
|------|--------|-------|------|
| 0 | Local cache | `cached` | free |
| 1 | `fast_flights` (Google Flights, free) | `discovered` | free |
| 2 | `serpapi` (metered) | `verified` | 1 call per cabin |

Tier 2 runs **only** when one of these is true:

- the search asked for it (`--verify`, or `verify=1` on the API),
- the user hit **Refresh live price** (`--refresh` / `refresh=1`),
- tier 1 produced nothing at all.

A plain search therefore costs nothing. Check what the tiers did in the log:

```
CACHE MISS PRG-BKK business
FAST_FLIGHTS discovery €3276 (6 itineraries, 1702ms)
CACHE HIT PRG-BKK business (fast_flights, 12m old)
SERPAPI verification €3310 (9 itineraries, 890ms)
SERPAPI SKIPPED budget reserve — SerpAPI automation budget exhausted (80/80, 10 calls reserved for manual verification)
```

### Award providers (Phase 3)

Award search runs behind `providers/award-flights/` — the same contract idea as
cash, with three award-specific rules:

- **Not a fallback chain.** Roame and ATF see different inventory, so both run
  by default. Disable one independently with `ENABLE_ROAME=false` /
  `ENABLE_ATF=false`.
- **Per-provider cache** (`AWARD_CACHE_TTL_HOURS`, default 2h). A fresh Roame
  payload is served from cache even while ATF's expired entry is re-fetched.
  Within TTL a repeated identical award search queries neither provider and
  spends no quota. Award cache keys look like
  `PRG:BKK:2026-11-10:oneway:PREM:1:f0:roame`.
- **PROGRAM ≠ AIRLINE.** One Austrian-operated flight priced by Aeroplan,
  LifeMiles and Miles & More is three redemption options sharing one
  `itineraryHash` — never collapsed. Only identical (itinerary × program)
  entries dedupe, keeping the cheapest.

Verification levels: `cached` (replayed), `discovered` (one provider),
`cross-verified` (two independent providers reported the same program + cabin +
date — one provider repeating itself never counts).

`ATF` costs **5 quota calls per search** (one per airline) from ~150/month;
every attempt lands in `provider_usage`, and the quota ATF itself reports is
stored separately from the local estimate.

Which loyalty programs each provider can search is recorded — with evidence and
audit dates, never alliance-membership guesses — in
`providers/award-flights/coverage.json`, also served by `/api/providers`.

### Loyalty balances

Balances come from AwardWallet through `providers/balances/`, cached as
append-only `balance_snapshots` batches for `LOYALTY_BALANCE_TTL_HOURS`
(default 12h). A search never refetches balances while a snapshot is fresh; a
manual refresh (`--refresh` / "Refresh live price") does. Balances are
sensitive: they live only in the git-ignored database, are never logged
individually (counts and ages only), and tests use synthetic values.

### Hidden city (Phase 3 fix)

The engine now lives in `providers/cash-flights/hidden-city.ts` and prices
everything through `searchCashFlights` — cash cache, SerpAPI budget guard,
reserve and accounting all apply, and a repeated sweep inside the TTL costs
zero calls. The old `scripts/search-hidden-city.py` called SerpAPI directly
with its own counter; it is deprecated, no longer wired into the application,
and prints a warning if run by hand. Hidden-city results carry
`hiddenCity: true`, a risk level and explicit warnings (baggage, cancellation
rebooking, contract-of-carriage) — they are informational comparisons, not
ordinary tickets.

### Observer — scheduled baseline collection (Phase 4)

The observer accumulates price history for the personal route profile. It is
NOT a deal hunter: no scoring, no alerts — statistics only, labelled "observed
by this radar".

```bash
npm run observer:seed
```
```bash
npm run observer:dry-run
```
```bash
npm run observer:run -- PRG-BKK
```
```bash
npm run observer:start
```
```bash
npm run observer:stop
```
```bash
npm run observer:status
```

- **Profile**: routes/cabins/cadence live in `config/travel-profile.json`, not
  in code. `observer:seed` upserts jobs from it (idempotent; run bookkeeping is
  preserved). Wildcard destinations are configuration only.
- **Cost discipline**: cash goes cache → fast_flights with the metered fallback
  FORBIDDEN (`allowMeteredFallback: false`) — a scheduled run can never spend
  SerpAPI. Awards use the per-provider award cache; ATF is excluded from
  schedules by default (5 calls/search of ~150/month) and now refuses any
  search that would exceed its allowance.
- **Sampling**: departures every `stepDays` (14) across a 180-day horizon
  starting 21 days out, trip lengths 7/10/14/21 rotated across the grid; each
  run searches only `datesPerRun` (4) pairs and successive runs rotate through
  the grid. Awards run every `awardEveryNRuns` (2nd) run.
- **Dry-run** prints the exact dates, expected cold-cache call ceilings and the
  monthly budget projection — zero external calls. The scheduler REFUSES to
  start when the projection exceeds any provider budget.
- **Locking**: a single-row `scheduler_state` lease (holder = pid@host:token,
  30-60s heartbeats, stale takeover after `OBSERVER_LEASE_TTL_SECONDS`). Two
  schedulers cannot run jobs twice; `observer:stop` asks the holder to exit via
  the database. Headless by design — plain Node process, no browser, no OS task
  scheduler; Docker-ready for the NAS later.
- **Backoff**: 3+ consecutive failures stretch a job's interval (×2, ×4, up to
  ×8). Expired/missing award credentials are detected BEFORE searching and
  recorded as `SKIPPED_AUTH`, which does not count as failure — a dead session
  is never hammered.
- **Disable things**: one provider — `ENABLE_ROAME=false` / `ENABLE_ATF=false`,
  or remove it from the job's `award_providers`; one route —
  `npx tsx observer/cli.ts disable PRG-MEX`.
- **Inspect**: the Observer page at http://localhost:8888/observer.html (jobs,
  runs, provider status, budget projection; click a route for its statistics),
  `npm run observer:status`, `npm run history -- PRG BKK`, or the read-only
  APIs `/api/observer/status` and `/api/route-stats?from=PRG&to=BKK`.
  Scheduler CONTROL is CLI-only on purpose — nothing on the network can start,
  stop or reconfigure it.

### Credentials for live award validation

- **Roame program keys**: Roame's identifier for Miles & More is `LUFTHANSA`
  (`MILES_AND_MORE` is rejected as an invalid MileageProgram). GraphQL
  introspection is disabled, so the enum can only be probed one value at a
  time. As of 2026-08-27 the key is accepted but returns no fares — see
  `providers/award-flights/coverage.json`.
- **Roame**: log in at roame.travel → DevTools → Application → Cookies → copy
  the `session` and `csrfSecret` values into
  `%USERPROFILE%\.openclaw\credentials
oame.json`:
  `{ "session": "…", "csrfSecret": "…", "sessionExpiresAt": <cookie expiry, ms epoch> }`.
  Refreshing an expired session is the same procedure. Verify with
  `npm run providers` (shows the expiry date, no network call).
- **ATF**: `ATF_API_KEY` in `.env` (or the credentials file). ATF also
  documents agent self-registration (`POST /api/v1/agent/register`) — run that
  yourself if you want a fresh key; the app never creates accounts.
- **AwardWallet** (optional): `awardwallet.json` with `apiKey` + `userId`.
- **Validate without spending**: `npm run providers` then
  `npm run observer:dry-run`. A minimal live check is one manual
  `npm run observer:run -- PRG-BKK` — on an award run this issues 4 award
  searches x 2 classes = 8 Roame search jobs plus 8 free cash fetches; ATF
  stays untouched.

### Testing a provider

```bash
npm run providers
```

Reports each provider's status, its local usage estimate and — where the vendor
reports one — its own remaining quota. **This never performs a billable call.**
The same data is served at `http://localhost:8888/api/providers`.

To exercise the free provider directly, without the rest of the pipeline:

```bash
.venv/Scripts/python scripts/google-flights.py PRG BKK 2026-11-10 --class economy --currency EUR
```

### Cache behaviour

The cache key is deterministic and includes everything that changes a result:

```
PRG:BKK:2026-11-10:2026-11-20:business:1:fast_flights
origin:destination:departure:return:cabin:adults:provider
```

One-way searches use the literal `oneway` in the return slot. TTLs come from
`CASH_CACHE_TTL_HOURS` (8h) and `AWARD_CACHE_TTL_HOURS` (2h).

**Cache and history are different things.** The cache answers "what did we
recently fetch?" and expires. History answers "what prices have we observed over
time?" and is append-only — clearing the cache never deletes an observation, and
a cached replay is never recorded as a new observation.

Clearing the development cache:

```bash
npm run cache:clear
```
```bash
npm run cache:clear -- fast_flights
```
```bash
npm run cache:prune
```

`cache:clear` drops every cached payload (or one provider's); `cache:prune`
drops only expired rows. Neither touches `flight_prices`.

### Database

SQLite via `better-sqlite3`, at `data/travel-radar.db` (override with
`DATABASE_PATH`). WAL mode is on, so a reader never blocks the writer, and
`busy_timeout` is 5s so two concurrent searches queue instead of failing.

Migrations live in `db/migrations/` and are applied automatically on first
connection. To run them explicitly:

```bash
npm run db:migrate
```
```bash
npm run db:status
```

| Table | Holds | Lifetime |
|-------|-------|----------|
| `search_requests` | every search asked for: route, dates, cabin, adults, source | permanent |
| `flight_prices` | one row per observed price, per provider, per fetch | **append-only, never updated** |
| `search_cache` | recent provider payloads keyed by cache key | expires |
| `provider_usage` | attempted / succeeded / failed calls per provider per month | permanent |
| `provider_health` | last status check per provider | overwritten |
| `award_prices` | one row per (itinerary × program × provider × fetch) — "points observed by this radar" | **append-only** |
| `balance_snapshots` | loyalty balance batches (sensitive, local only) | append-only |
| `search_results` | full result payload per search — the dashboard's state | one per search |
| `observation_jobs` | what the observer watches: route, cabins, providers, cadence, backoff state | permanent |
| `observation_runs` | per-run audit: status, searches, live calls, cache hits, observations, errors, duration | permanent |
| `scheduler_state` | the single scheduler lease (holder, heartbeat, stop flag) | one row |
| `schema_migrations` | which migrations have run | permanent |

Back it up by copying `travel-radar.db` **together with** its `-wal` and `-shm`
files, or by stopping the server first.

### Inspecting usage and history

```bash
npm run providers
```
```bash
npm run history -- PRG BKK
```

`history` reports cash stats (count/min/median/average/max/latest per currency)
and, since Phase 3, award stats per loyalty program and cabin — observation
count, min/median/average/max/latest points and lowest observed taxes. These
are **points observed by this radar**, not market-wide history. Currencies are
never blended, and neither are programs.

Raw SQL works too:

```bash
node -e "const D=require('better-sqlite3');console.table(new D('data/travel-radar.db',{readonly:true}).prepare('SELECT provider,COUNT(*) n,MIN(price_amount) min,MAX(price_amount) max FROM flight_prices GROUP BY provider').all())"
```

### Provider usage accounting

`provider_usage` counts **attempts**, successes and failures separately, in
single atomic SQL statements inside transactions. The budget guard reads
*attempts*, which is the conservative choice: a call that failed with HTTP 401
may still have consumed a request slot, so it is not silently reclaimed.

Where a vendor reports its own remaining quota, that value is stored in separate
columns (`reported_remaining`, `reported_limit`, `reported_at`) and never mixed
with the local estimate. The local number is an estimate; only the vendor's is
authoritative.

This replaces Phase 1's `serpapi-usage.json`, which lost increments when two
processes searched at once. That file is now ignored and unused — delete any
copy you still have.

### Files that can eventually be retired

| File | Status |
|------|--------|
| `serpapi-usage.json` | **superseded** by `provider_usage`; nothing reads it any more |
| `results.json` | **retired as state** in Phase 3 — debug export only; dashboard loads from `/api/results/latest` |
| `results-return.json` | intermediate for round-trip searches |
| `scripts/search-google-flights.py` | **superseded** by `scripts/google-flights.py` (fast-flights 3.x) |
| `scripts/search-hidden-city.py` | **superseded** in Phase 3 by `providers/cash-flights/hidden-city.ts`; deprecated, warns when run |
| `load-real-data.js` | dead since Phase 1 — nothing imports it |
| `cli.ts` | cannot start; imports a git-ignored directory |

Since Phase 3 the dashboard loads its state from **`/api/results/latest`**,
backed by the `search_results` table — the app runs with no `results.json` on
disk at all. The file is still written after each search as a debugging export,
and remains the fallback for the server-down / file:// case.

---

## 5a. Where data lives

| Path | Written by | Contents | Git |
|------|-----------|----------|-----|
| `data/travel-radar.db` | every search | Cache, price history, usage, health | ignored |
| `results.json` | every search | Full `DashboardResults` — the dashboard reads this on load | ignored |
| `results-return.json` | round-trip searches | Return leg before merging | ignored |
| `roame-results.json` | `roame-scraper.ts` CLI | Raw Roame payload | ignored |
| `.venv/` | you | Python deps | ignored |

`results-dxb-outbound.json` / `results-dxb-return.json` are committed sample
captures from Feb 2026, useful for working on the dashboard without spending API
budget (see the warning at the top of this file about their contents):

```bash
cp results-dxb-outbound.json results.json
```

Reload the dashboard and you get 131 real flights to click through. **This is
sample data, not a live search** — the header timestamp shows the capture date.

---

## 6. Common errors

**`Roame credentials not found at .../roame.json`**
Expected without a Roame session. Search continues; award results will be empty.

**`Roame session expired on <date>`**
Log in at roame.travel again and refresh the cookie values in the credentials file.

**`SerpAPI 401: Invalid API key`**
`SERP_API_KEY` is set but wrong. The failure is recorded in `provider_usage` as
an attempt *and* a failure, and attempts count against the budget — a bad key
therefore burns local budget without spending anything at SerpAPI. Check with
`npm run providers`; reset by clearing the row:
`node -e "const D=require('better-sqlite3');new D('data/travel-radar.db').prepare('DELETE FROM provider_usage WHERE provider=?').run('serpapi')"`

**`SerpAPI automation budget exhausted (80/80, 10 calls reserved…)`**
Automation has spent its share for the month. Cached and free-provider results
are still returned. A manual **Refresh live price** (or `--refresh` / `--verify`
on the CLI) may still use the 10 reserved calls. Raise `SERPAPI_MONTHLY_BUDGET`
or lower `SERPAPI_RESERVE_CALLS` if that split is wrong for you.

**`SerpAPI monthly budget exhausted (90/90)`**
Nothing may spend, including manual refresh. Resets on the 1st of the month.

**`ModuleNotFoundError: No module named 'fast_flights'`**
The venv isn't set up — see §2. Cash prices fall back to SerpAPI, which costs
metered calls, so it's worth fixing.

**`ImportError: cannot import name 'FlightQuery' from 'fast_flights'`**
Wrong fast-flights version. `requirements.txt` pins `3.1.0`; 2.x used a
different API and its HTML parser frequently returned empty fields.

**`google returned the language/consent interstitial`**
Google answered with its language-selection page instead of results. The helper
sends the standard `SOCS` consent cookie to avoid exactly this; seeing it means
Google has changed the requirement. The search degrades to SerpAPI rather than
failing, but the free tier is effectively down until the cookie is updated in
`scripts/google-flights.py`.

**Dashboard shows `Cached · 3h old` and you want a live number**
Click **Refresh live price**. It confirms first, because it bypasses the cache
and may spend a metered call per cabin.

**`SQLITE_BUSY` or a locked database**
Two processes writing at once beyond the 5s `busy_timeout`. Stop any stray
`npm start` / `npm run search` and retry. WAL mode means readers never cause it.

**`npm error code ERESOLVE`**
`.npmrc` is missing or you ran npm from outside the project root — see §2.

**Dashboard shows "Search failed: …"**
The server answered and the search errored. The dashboard deliberately does
**not** fall back to the previous `results.json` here, because that would show
stale results for a different route as if they were fresh. Check the server
console for the underlying provider error.

**Dashboard shows `0 results` with an "⚠️ Estimated data" badge**
The search ran and every source returned nothing — usually no credentials.
Check the server console to see which source failed and why.

---

## 7. Known limitations (as of this baseline)

- **`fast_flights` is a scraper, not a contract.** Phase 2 repaired it (the
  blocker was Google's consent interstitial; the fix is the `SOCS` cookie) and it
  is now the default cash source at ~0.5s per search. But it has no SLA, can
  break whenever Google changes its page, exposes no tax breakdown, no baggage
  allowance and no flight numbers, and returns Google's curated top itineraries
  (4–10) rather than every fare. Its results are labelled `discovered`, not
  `verified`, for that reason. Google's Terms of Service discourage automated
  access; this is low-volume personal use, and SerpAPI remains the licensed path
  for anything that needs to be dependable.
- **No FX conversion.** Prices are stored with their ISO currency and never
  compared across currencies. `CASH_CURRENCY` defaults to USD because the value
  engine compares cash against award taxes without conversion.
- **Stale-while-revalidate is not implemented.** A cache hit returns immediately
  and does not kick off a background refresh. Adding one meant either a job
  runner or fire-and-forget promises that outlive the request; Phase 2 chose
  reliability over cleverness, and a cache miss is only ~1.3s anyway.
- **`npm run legacy:cli`** (`cli.ts`) does not run: it imports
  `awardwiz-scrapers/integrations/`, which is git-ignored and absent from the
  repo. `npm run search` (`search.ts`) is the working orchestrator.
- **`gateway-scanner.ts`** is documented in `CLAUDE.md` but does not exist in
  the repo.
- **Individual airline scrapers** under `awardwiz-scrapers/scrapers/` are either
  broken (United, Alaska, Delta, Aeroplan) or unimplemented skeletons
  (Air France, BA, Qatar, Emirates). Roame covers those programs instead. See
  `SCRAPER_RESEARCH_NEEDED.md`.
- **The dashboard requires internet even for cached data** — Tailwind and Inter
  load from CDNs.
- **`results-dxb-*.json` in git contain 34 real loyalty balances.** They predate
  the `results*.json` ignore rule. Removing them from the working tree does not
  remove them from history.
