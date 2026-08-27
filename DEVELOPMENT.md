# Development Guide

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

| Variable | Where | Required for | If missing |
|----------|-------|--------------|------------|
| `SERP_API_KEY` | `.env` | Google Flights cash prices (fallback), hidden-city engine | Both sources return 0 results with a console warning |
| `ATF_API_KEY` | `.env` *or* `~/.openclaw/credentials/awardtravelfinder.json` | Award Travel Finder cross-reference | `atf` source errors and is skipped |
| Roame session | `~/.openclaw/credentials/roame.json` only | All award availability | `roame` source errors and is skipped |
| AwardWallet key | `~/.openclaw/credentials/awardwallet.json` only | Real loyalty balances | Falls back to a hardcoded balance list in `search.ts` |

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
--output <file>          Output file (default results.json)
--verbose                Per-source progress
```

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

`npm test` runs `tests/` — credential-free unit tests over the value engine,
sweet spots and transfer graph. They make no network calls and cost nothing.

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

## 5. Where data lives

Nothing is stored in a database. All state is files in the project root:

| Path | Written by | Contents | Git |
|------|-----------|----------|-----|
| `results.json` | every search | Full `DashboardResults` — the dashboard reads this on load | ignored |
| `results-return.json` | round-trip searches | Return leg before merging | ignored |
| `serpapi-usage.json` | `search.ts` + `scripts/search-hidden-city.py` | Monthly SerpAPI counter, auto-resets on month change | ignored |
| `roame-results.json` | `roame-scraper.ts` CLI | Raw Roame payload | ignored |
| `.venv/` | you | Python deps | ignored |

Every search **overwrites** `results.json`. There is no history, no cache and no
per-user settings — a repeat search costs the same API budget as the first.

`results-dxb-outbound.json` / `results-dxb-return.json` are committed sample
captures from Feb 2026, useful for working on the dashboard without spending API
budget:

```bash
cp results-dxb-outbound.json results.json
```

Reload the dashboard and you get 131 real flights to click through. **This is
sample data, not a live search** — the header timestamp will show the original
capture date.

---

## 6. Common errors

**`Roame credentials not found at .../roame.json`**
Expected without a Roame session. Search continues; award results will be empty.

**`Roame session expired on <date>`**
Log in at roame.travel again and refresh the cookie values in the credentials file.

**`SerpAPI 401: Invalid API key`**
`SERP_API_KEY` is set but wrong. Note the counter in `serpapi-usage.json` still
increments on failed calls, so a bad key burns the local budget without spending
anything at SerpAPI — delete the file to reset.

**`🛑 SerpAPI monthly limit reached (95/95)`**
Self-imposed cap, 5 under the 100/month free tier. It resets on the 1st.
Delete `serpapi-usage.json` to reset it manually.

**`ModuleNotFoundError: No module named 'fast_flights'`**
The venv isn't set up — see §2. Harmless; the search falls back to SerpAPI.

**`ImportError: cannot import name 'FlightData' from 'fast_flights'`**
Wrong fast-flights version. `requirements.txt` pins `2.2`; 3.x renamed the API.

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

- **`fast_flights` returns no data.** The free no-API-key Google Flights source
  runs but Google serves it a language-selection page instead of results. Cash
  prices therefore come only from SerpAPI (quota-limited). Verified against both
  fast-flights 2.2 and 3.1.0.
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
