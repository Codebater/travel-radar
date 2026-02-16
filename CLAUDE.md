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

## What's Working (as of Feb 16, 2026)

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
- **Real SerpAPI data** — no mock/estimated prices, all Google Flights live data
- Algorithm: get direct price (1 SerpAPI call), search beyond-hub cities (N calls), check layovers
- Hub connections database with 30 hubs (domestic + international)
- Risk scoring (airline enforcement, airport size, route factors)
- SerpAPI budget tracking: reads/writes `serpapi-usage.json`, hard cap at 95/month
- Integrated into search.ts orchestrator as `hidden-city` source
- Output: `confidence: "high"`, `data_source: "serpapi"` for all results
- Tested: LAX→DEN, JFK→ORD with real data (20 API calls used as of Feb 16)

## Needs Work

### ✅ Google Flights (SerpAPI)
- Code is complete and integrated in search.ts
- Improved parser handles multi-leg itineraries, business class, booking tokens
- SERP_API_KEY configured in `.env` — 100 free/mo, budget tracked in `serpapi-usage.json`
- Hidden city engine also uses it for real price data
- **Tested**: 28 economy fares for LAX→JFK in single API call

### 🔴 Individual Airline Scrapers (via Arkalis)
These use Arkalis (headless Chrome CDP engine) and need the APIs to be reverse-engineered.
Roame replaces them for award search. They're only needed for cash prices and fare class detail.

- **United** (`united.ts`): BROKEN. Auth flow changed — `/api/auth/anonymous-token` returns a hash that `FetchFlights` rejects with 403 "AuthenticationSkipped". Research (Feb 16): GitHub wiki shows token is a long base64 string from cookie-based auth, not the anonymous endpoint. United blocks all non-browser requests. The correct token endpoint may be `/api/svc/token/anonymous` or require login. Needs real browser DevTools to capture current auth flow.
- **Alaska** (`alaska.ts`): BROKEN. Old `/searchbff/V3/search` returns HTML (SvelteKit app shell). Research (Feb 16): Alaska migrated to SvelteKit (search page) + Next.js (shopping page). `apis.alaskaair.com` exists but returns 404 for all guessed paths. The search is fully client-rendered. SvelteKit `__data.json` endpoint returns layout data but not search results. Needs browser Network tab to discover actual API calls.
- **Delta** (`delta.ts`): BROKEN. Uses form-fill + anti-bot detection. Gets blocked after 3rd attempt. Never had evaluate(fetch()) pattern applied.
- **Aeroplan** (`aeroplan.ts`): BROKEN. CDP capture issue. Old endpoint likely changed.
- **Air France, BA, Qatar, Emirates**: Skeleton files only, no real API research done

**Why these are hard**: Each airline's internal API requires browser DevTools (Network tab) to discover
the actual endpoints, request format, and auth requirements. Without Playwright/browser automation 
available in the agent environment, this requires manual browser inspection.
**Workaround**: Roame covers all these airlines' award programs in a single API call.

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
