# Flight Search Agent

Project memory and context for the flight-search skill.

## Architecture

```
search.ts (Orchestrator)
├── roame-scraper.ts → Roame GraphQL API (award flights, ALL programs)
├── SerpAPI → Google Flights (cash prices, needs SERP_API_KEY)
├── hidden city engine → Python script (savings opportunities)
├── awardwiz-scrapers/scrapers/aa.ts → AA direct (detailed data, backup)
├── AwardWallet API → Points balances
└── results.json → dashboard.html
```

## What's Working (as of Feb 15, 2026)

### ✅ Roame Scraper (`roame-scraper.ts`)
- GraphQL API at `roame.travel/api/graphql`
- Searches ALL mileage programs in one API call
- Two-step flow: `initiateFlightSearchMutation` → `pollResults`
- Auth: Firebase session JWT cookie from `~/.openclaw/credentials/roame.json`
- Session expires Feb 23, 2026
- Programs found: United, Alaska, American, Qantas, Flying Blue, JetBlue, Virgin Australia
- Returns: points, taxes, cabin class, seat availability, Roame score, flight numbers, equipment
- **Tested**: 87-103 flights in ~28-60s depending on economy/both

### ✅ Search Orchestrator (`search.ts`)
- Loads .env file for credentials
- Runs Roame + Google Flights + Hidden City in parallel
- Loads real balances from AwardWallet API (34 programs, live)
- Generates recommendations (best value, best product, cheapest cash)
- Generates warnings (UR→Emirates dead, VA doesn't book EK, low Alaska balance)
- Outputs unified `results.json` for dashboard
- Sources: `roame`, `google`, `hidden-city` (configurable via --sources)

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
- 37 real flights in 3 seconds
- Used by gateway scanner

### ✅ AwardWallet Integration
- API pulls 34 real loyalty account balances
- Maps programs to scraper names
- Transfer partner calculations

### ✅ HTTP Server (`serve.ts`)
- Serves dashboard at port 8888
- `/api/search` endpoint triggers live search with configurable sources
- Static file serving for results.json

### ✅ Gateway Scanner (`gateway-scanner.ts`)
- Scans 15 US airports through AA scraper
- Finds positioning flight + cheaper business class combos
- ~40 seconds for all gateways

### ✅ Hidden City Engine (`scripts/search-hidden-city.py`)
- Searches for hidden city ticketing opportunities
- Hub connections database with 20+ hubs
- Risk scoring (airline enforcement, airport size, route factors)
- 3-tier data: SerpAPI → scraping → distance estimates
- Integrated into orchestrator as a source

## Needs Work

### 🔧 Google Flights (SerpAPI)
- Code is complete and integrated in search.ts
- Improved parser handles multi-leg itineraries, business class, booking tokens
- **Needs SERP_API_KEY** — get one at https://serpapi.com/manage-api-key (100 free/mo)
- Set in `.env` file or environment variable
- Hidden city engine also uses it for real price data

### 🔴 Individual Airline Scrapers (via Arkalis)
These use Arkalis (headless Chrome CDP engine) and need the APIs to be reverse-engineered.
Roame replaces them for award search. They're only needed for cash prices and fare class detail.

- **United** (`united.ts`): Rewritten with evaluate(fetch()) pattern. Auth flow changed — they now require an anonymous token via `/api/svc/token/anonymous`. The page no longer auto-triggers search from URL params. Needs browser DevTools research to discover current auth flow.
- **Alaska** (`alaska.ts`): Migrated to SvelteKit frontend. Old `/searchbff/V3/search` returns HTML. New API appears to be at `apis.alaskaair.com` but exact endpoint unknown. Needs browser DevTools research.
- **Delta** (`delta.ts`): Uses form-fill + anti-bot detection. Commented out pre-fill interceptor. Heavy anti-scraping measures. Needs significant rework.
- **Aeroplan** (`aeroplan.ts`): CDP capture issue. Old endpoint at `aircanada.com/loyalty/dapidynamic/*/v2/search/air-bounds`. Could apply evaluate(fetch()) fix but endpoint may have changed.
- **Air France, BA, Qatar, Emirates**: Skeleton files only, no real API research done

**Why these are hard**: Each airline's internal API requires browser DevTools (Network tab) to discover
the actual endpoints, request format, and auth requirements. This cannot be done via web scraping or 
web search — it requires interactive browser inspection of the live site during a search.

## Key Technical Decisions

- **Roame over individual scrapers**: One API call covers 19+ programs vs. maintaining 10+ scrapers
- **evaluate(fetch()) pattern**: For airline direct scrapers, this bypasses CDP interception issues
- **Unified results format**: All sources output to same `UnifiedFlightResult` interface
- **Dashboard is static HTML**: No build step, loads data from results.json
- **.env file**: For local credential storage (SerpAPI key, etc.)

## Running

```bash
# Search (CLI) — all sources
npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --class both

# Roame only
npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --sources roame

# With Google Flights (needs SERP_API_KEY in .env)
SERP_API_KEY=xxx npx tsx search.ts --from LAX --to DXB --date 2026-04-28

# Roame standalone
npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 --class PREM

# Dashboard
npx tsx serve.ts --port 8888
# → http://localhost:8888

# Balances
npx tsx cli.ts balances

# Gateway scanner
npx tsx gateway-scanner.ts --from LAX --to DXB --date 2026-04-28
```

## File Layout

```
roame-scraper.ts     # Roame GraphQL client + CLI
search.ts            # Unified orchestrator (Roame + Google + Hidden City)
serve.ts             # HTTP server for dashboard
dashboard.html       # Dynamic flight comparison UI
cli.ts               # Legacy CLI (Arkalis-based scrapers)
gateway-scanner.ts   # Gateway positioning flight scanner
results.json         # Latest search results (auto-generated)
.env                 # Environment variables (SERP_API_KEY, etc.)
arkalis/             # Headless Chrome engine (from AwardWiz)
awardwiz-scrapers/   # Individual airline scrapers + integrations
scripts/             # Python search scripts (Google, hidden city, etc.)
data/                # Static data (airport alternates, hub connections)
```

## Credentials

- `~/.openclaw/credentials/roame.json` — Roame session cookie (expires Feb 23, 2026)
- `~/.openclaw/credentials/awardwallet.json` — AwardWallet API key + user ID
- `.env` file — `SERP_API_KEY` for Google Flights via SerpAPI
