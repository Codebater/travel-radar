# Flight Search Agent

Project memory and context for the flight-search skill.

## Architecture

```
search.ts (Orchestrator)
├── roame-scraper.ts → Roame GraphQL API (award flights, ALL programs)
├── SerpAPI → Google Flights (cash prices)
├── awardwiz-scrapers/scrapers/aa.ts → AA direct (detailed data, backup)
├── AwardWallet API → Points balances
└── results.json → dashboard.html
```

## What's Working (as of Feb 2026)

### ✅ Roame Scraper (`roame-scraper.ts`)
- GraphQL API at `roame.travel/api/graphql`
- Searches ALL mileage programs in one API call
- Two-step flow: `initiateFlightSearchMutation` → `pollResults`
- Auth: Firebase session JWT cookie from `~/.openclaw/credentials/roame.json`
- Session expires Feb 23, 2026
- Programs found: United, Alaska, American, Qantas, Flying Blue, JetBlue, Virgin Australia
- Returns: points, taxes, cabin class, seat availability, Roame score, flight numbers, equipment

### ✅ Search Orchestrator (`search.ts`)
- Runs Roame + Google Flights (SerpAPI) in parallel
- Loads real balances from AwardWallet API
- Generates recommendations (best value, best product, cheapest cash)
- Generates warnings (UR→Emirates dead, VA doesn't book EK, low Alaska balance)
- Outputs unified `results.json` for dashboard

### ✅ Dashboard (`dashboard.html`)
- Dynamic: loads from results.json, accepts any route
- Search form: origin, destination, dates, class
- Filters: All/Economy/Business/First, Cash/Award/All
- Sort: Best Value, Price, Points, CPP, Duration
- Points balances panel (from AwardWallet, 34 programs)
- Recommendations section
- Warning banners
- Source badges (LIVE for Roame data)

### ✅ AA Direct Scraper (via Arkalis)
- `evaluate(fetch())` pattern bypasses CORS
- Returns detailed fare class data, saver fare detection
- Used by gateway scanner

### ✅ AwardWallet Integration
- API pulls 34 real loyalty account balances
- Maps programs to scraper names
- Transfer partner calculations

### ✅ HTTP Server (`serve.ts`)
- Serves dashboard at port 8888
- `/api/search` endpoint triggers live search
- Static file serving for results.json

## Broken / Not Implemented

### 🔴 Individual Airline Scrapers (via Arkalis)
- **United**: Auth flow changed, 403 on API calls
- **Alaska**: BFF endpoint returns HTML not JSON
- **Delta**: Needs full rebuild
- **Aeroplan**: Timeout, endpoint changed
- **Air France, BA, Qatar, Emirates**: Skeleton only

**NOTE**: Roame effectively replaces all individual airline scrapers for award search.
Individual scrapers are only needed for: (1) cash prices, (2) detailed fare class data,
(3) backup if Roame is down.

### 🔧 Google Flights (SerpAPI)
- Implemented in search.ts but needs SERP_API_KEY env var
- 100 free searches/month

## Key Technical Decisions

- **Roame over individual scrapers**: One API call covers 19+ programs vs. maintaining 10+ scrapers
- **evaluate(fetch()) pattern**: For airline direct scrapers, this bypasses CDP interception issues
- **Unified results format**: All sources output to same `UnifiedFlightResult` interface
- **Dashboard is static HTML**: No build step, loads data from results.json

## Running

```bash
# Search (CLI)
npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --class both

# Roame only
npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 --class PREM

# Dashboard
npx tsx serve.ts --port 8888
# → http://localhost:8888

# Balances
npx tsx cli.ts balances
```

## File Layout

```
roame-scraper.ts     # Roame GraphQL client + CLI
search.ts            # Unified orchestrator
serve.ts             # HTTP server for dashboard
dashboard.html       # Dynamic flight comparison UI
cli.ts               # Legacy CLI (Arkalis-based scrapers)
results.json         # Latest search results (auto-generated)
arkalis/             # Headless Chrome engine (from AwardWiz)
awardwiz-scrapers/   # Individual airline scrapers + integrations
scripts/             # Python search scripts (Google, hidden city, etc.)
data/                # Static data (airport alternates, hub connections)
```

## Credentials

All at `~/.openclaw/credentials/`:
- `roame.json` — Roame session cookie (expires Feb 23, 2026)
- `awardwallet.json` — AwardWallet API key + user ID
- SerpAPI key in env: `SERP_API_KEY`
