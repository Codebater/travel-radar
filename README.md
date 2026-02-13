# ✈️ Flight Search Agent

> Find the cheapest flights using 8 parallel search strategies — including award flights with miles/points, hidden city ticketing, and geo-pricing arbitrage.

**🆕 Now integrated with AwardWiz 2.0** — Advanced anti-detection airline scrapers with Arkalis engine for real-time award flight search.

[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-Skill-purple.svg)](https://openclaw.ai)

---

## Features

- 🔍 **8 search strategies** running in parallel via `ThreadPoolExecutor`
- 🏆 **Award flight search** with 4-tier real data architecture (SerpAPI → airline scraping → points.me → sweet spots DB)
- 🏙️ **Hidden city engine** with 30+ hub database and 3-tier search modes
- 📊 **Interactive dashboard** — dark-themed HTML dashboard with Economy/Business toggle, filters, sorts, and color-coded availability
- 💳 **Transfer partner intelligence** — full maps for Chase UR, Amex MR, Capital One, Citi TYP, and Bilt with ratios
- 🗣️ **Natural language parsing** — `"LAX to Dubai April 27 business class using points"`
- ✈️ **Alternative airports** with transport cost modeling and net savings calculation
- 💰 **Budget carrier deep search** — Southwest, Spirit, Frontier, Ryanair, EasyJet
- 📅 **Flexible date matrix** — ±N days with cheapest combination highlighted

---

## Quick Start

### Prerequisites

- Python 3.9+
- (Optional) [SerpAPI key](https://serpapi.com/) for real-time Google Flights data (free tier: 100 searches/month)

### Run a Search

```bash
# Natural language
scripts/flight-search.py --natural "LAX to JFK March 15 flexible +/-3 days"

# Structured
scripts/flight-search.py LAX JFK 2026-03-15 --return 2026-03-22 --flex 3

# With award flights
scripts/flight-search.py LAX NRT 2026-03-15 --include-awards --programs chase-ur,united --balances 80000,45000

# Individual strategies
scripts/search-google-flights.py LAX JFK 2026-03-15 --flex 3 --pretty
scripts/search-hidden-city.py LAX DEN 2026-03-15 --pretty
scripts/search-awards.py LAX NRT 2026-03-15 --programs chase-ur,united --balances 80000,45000 --pretty
scripts/search-budget.py LAX JFK 2026-03-15 --pretty
scripts/search-alt-airports.py LAX JFK 2026-03-15 --matrix --pretty
```

### Environment Variables

```bash
export SERP_API_KEY="your_serpapi_key_here"   # Enables real-time Google Flights data
```

Without `SERP_API_KEY`, the scripts gracefully degrade to estimated pricing modes.

## AwardWiz 2.0 Integration

This project now includes **AwardWiz 2.0**, an advanced airline scraper system with anti-detection capabilities for real-time award flight searches.

### AwardWiz CLI Usage

```bash
# Search award flights with AwardWiz scrapers
npx tsx cli.ts search -f LAX -t DXB -d 2026-04-28

# Search specific airline programs
npx tsx cli.ts search -f JFK -t LHR -d 2026-06-15 -p united,britishairways

# Include balance information with transfer calculations
npx tsx cli.ts search -f SFO -t NRT -d 2026-08-20 --balances

# List available scrapers
npx tsx cli.ts list
```

### AwardWiz Features

- **🤖 Arkalis Anti-Detection Engine**: Advanced browser automation that evades bot detection
- **⚡ Parallel Scraping**: Search multiple airlines simultaneously  
- **💳 AwardWallet Integration**: Automatic balance fetching and transfer calculations
- **🔄 Transfer Partner Logic**: Calculate accessible miles through credit card transfers
- **🛡️ Error Resilient**: Robust retry logic and graceful failure handling

### Available Airline Scrapers

**✅ Working**: United Airlines (MileagePlus)  
**🔴 Needs Fix**: Alaska Airlines, Air Canada Aeroplan  
**🚧 Research Needed**: Air France, British Airways, Qatar Airways, Emirates  

See `SCRAPER_RESEARCH_NEEDED.md` for detailed implementation tasks.

### Dashboard Integration

The HTML dashboard now loads real scraper results when available:
- Real data marked with 🔴 REAL indicators
- Estimated data clearly labeled as "estimated"
- Data source shown per result

---

## Dashboard

The interactive flight comparison dashboard (`dashboard.html`) gives you a visual overview of all search results.

### Features

| Feature | Description |
|---------|-------------|
| **Dark theme** | Slate/navy card-based layout with smooth animations |
| **Economy / Business toggle** | Tab-based switching between cabin classes |
| **Filter** | Cash / Award / All flights |
| **Sort** | By Price, Value (cpp), or Duration |
| **Color-coded availability** | 🟢 Green (available), 🟡 Yellow (limited), 🔴 Red (unavailable) |
| **Airline logos** | Auto-fetched from logo APIs |
| **Booking URLs** | Direct links to airline award/cash booking pages |
| **Top recommendations** | Highlight cards with best value picks |
| **Warning banners** | Alerts for expired transfer partnerships, balance limits |
| **Responsive** | Works on desktop and mobile |

Open `dashboard.html` directly in a browser after running a search. The dashboard reads flight data embedded in the HTML.

---

## Search Strategies

The master orchestrator (`scripts/flight-search.py`) runs multiple strategies concurrently and deduplicates, ranks, and merges results.

### 1. Google Flights (SerpAPI)

Real-time flight data via the SerpAPI Google Flights engine. Supports flexible date windows (±N days) and returns a **date matrix** highlighting the cheapest departure/return combination.

```
         | Return Mar 22 | Return Mar 23 | Return Mar 24
---------|---------------|---------------|---------------
Dep 3/15 |     $342      |     $358      |     $401
Dep 3/16 |     $289 ★    |     $312      |     $378
Dep 3/17 |     $315      |     $298      |     $356

★ Best price: Depart Mar 16, Return Mar 22 = $289
```

### 2. Hidden City Engine

Custom engine that finds flights where your destination is a **layover** on a route to a city beyond — often 20-50% cheaper. Uses a comprehensive hub database covering 30+ major airports.

**Three search modes:**
1. **SerpAPI mode** — real-time Google Flights data (if `SERP_API_KEY` set)
2. **URL scraping mode** — parse Google Flights URLs directly
3. **Estimated mode** — realistic distance-based price modeling using haversine formula

```
JFK → DEN direct:      $450
JFK → DEN → SLC:       $285 (deplaning at DEN saves 37%)
```

> ⚠️ **Restrictions:** One-way tickets only, no checked bags, may violate airline ToS.

### 3. Award Flight Search

See [Award Flight Search](#award-flight-search) below for the full 4-tier architecture.

### 4. Budget Carrier Deep Search

Directly searches budget airlines not always indexed by major aggregators:
- **US:** Southwest, Spirit, Frontier, Allegiant, Sun Country
- **Europe:** Ryanair, EasyJet, Wizz Air, Norwegian
- **Asia:** AirAsia, Scoot, Cebu Pacific

### 5. Alternative Airport Scan

Searches airports within ~100 miles of your origin and destination. Includes **transport cost modeling** (estimated taxi/Uber costs and travel time) to show **net savings**:

| Route | Airport | Transport | Flight | Net Savings |
|-------|---------|-----------|--------|-------------|
| LAX area | SNA (Orange County) | $45, 60 min | $198 | $67 saved |
| JFK area | LGA (LaGuardia) | $50, 60 min | $215 | $35 saved |

### 6. Flexible Date Matrix

Scans ±1 to ±7 days around your target dates. Returns every departure/return combination with the cheapest pair highlighted. Mid-week flights are often significantly cheaper.

### 7. Geo-Pricing Bypass

Checks prices from different regional airline sites (`.co.uk`, `.de`, `.jp`, etc.) to exploit currency and regional pricing differences. Can save 10-30%.

### 8. Error Fare Monitor

Scans deal sites and forums for airline pricing mistakes. Error fares can offer 50-90% savings but may be cancelled.

---

## Award Flight Search

The award search (`scripts/search-awards.py`) uses a **4-tier real data architecture** — no mock or random data.

### Tier 1: SerpAPI Google Flights

Fetches **real cash prices** for both economy and business class, then cross-references with the sweet spots database to calculate actual **value per point (cpp)**.

### Tier 2: Airline Website Scraping

Framework for Playwright-based scraping of `united.com`, `aa.com`, `delta.com` award search pages. Invoked via the orchestrator when Playwright MCP is available.

### Tier 3: points.me Free Tier

Scrapes `points.me` search results via Playwright for availability that SerpAPI might miss.

### Tier 4: Sweet Spots DB Estimates

Falls back to 25+ known excellent-value award redemptions, clearly labeled as **"estimated"** when no real data is available. Includes:

- ANA First Class via Virgin Atlantic (55K miles)
- Cathay Pacific First via Alaska (70K miles)
- Turkish Business via United (45K miles)
- And 20+ more routes

### User Points Profile

Pass `--programs` and `--balances` to get **personalized results**:

```bash
scripts/search-awards.py LAX NRT 2026-03-15 \
  --programs chase-ur,united,amex-mr \
  --balances 80000,45000,120000 \
  --pretty
```

Each result is annotated with:
- ✅ Whether you can **afford** it with your current balances
- 🔄 **Transfer paths** showing exactly how to book (e.g., "Transfer 60,000 Chase UR → United at 1:1")
- 💡 **Recommendation** — use points or pay cash, based on real or estimated cpp

### Transfer Partner Intelligence

Full mapping of all major flexible currency programs:

| Program | Partners |
|---------|----------|
| **Chase Ultimate Rewards** | United, British Airways, Virgin Atlantic, Aeroplan, Singapore, Southwest, Air France/KLM, Iberia, Emirates |
| **Amex Membership Rewards** | Delta, British Airways, Virgin Atlantic, Aeroplan, Singapore, Air France/KLM, Emirates, ANA |
| **Capital One Miles** | British Airways, Virgin Atlantic, Air France/KLM, Turkish, Emirates, Singapore |
| **Citi ThankYou Points** | Virgin Atlantic, Singapore, Air France/KLM, Turkish, Emirates |
| **Bilt Rewards** | American, United, Alaska, Aeroplan, British Airways, Virgin Atlantic, Air France/KLM, Turkish, Emirates |

All transfers mapped at their current ratios (most are 1:1).

### Award Search Output

Each result includes:

| Field | Description |
|-------|-------------|
| `program` | Loyalty program name |
| `miles_required` | Points/miles needed |
| `taxes_fees` | Estimated taxes and fees |
| `cash_equivalent` | What the flight costs in cash |
| `value_per_point` | Cents per point (cpp) |
| `source` | `serpapi-validated`, `serpapi-estimated`, `airline-direct`, `points-me`, or `estimated` |
| `transfer_partners` | Which flexible currencies transfer to this program |
| `booking_paths` | Exactly how to book with your points |
| `booking_url` | Direct link to the airline's award booking page |
| `confidence` | `high` / `medium` / `low` |
| `recommendation` | 🔥 Outstanding / ✅ Excellent / 👍 Good / ⚖️ Fair / 💵 Below average |

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERP_API_KEY` | No | SerpAPI key for real-time Google Flights data. Free tier: 100 searches/month. Without it, estimated pricing is used. |

### Data Files

| File | Description |
|------|-------------|
| `data/hub-connections.json` | 30+ major hub airports with "beyond" cities for hidden city routing |
| `data/airport-alternates.json` | 30+ airports with nearby alternatives, distances, and transport costs |
| `data/award-sweet-spots.json` | 25+ known excellent-value award redemptions with miles, classes, and routes |

---

## OpenClaw Skill Installation

This project is installable as an [OpenClaw](https://openclaw.ai) skill for use with AI assistants.

### Install

Copy the files to your OpenClaw skills directory:

```bash
cp -r . ~/.openclaw/skills/flight-search/
```

### Usage via OpenClaw

Once installed, use the `/flight-search` command:

```
/flight-search SFO to Tokyo on March 20 using points
/flight-search LAX to London on April 10-17 flexible
/flight-search JFK to LAX hidden city
```

The skill is defined in `SKILL.md` with:
- **Allowed tools:** `mcp__plugin_playwright_playwright__*`, `Bash`
- **Natural language** flight queries parsed automatically
- All 8 strategies available

---

## File Structure

```
flight-search-agent/
├── README.md                  # This file
├── SKILL.md                   # OpenClaw skill definition & documentation
├── CLAUDE.md                  # Project memory and architecture notes
├── dashboard.html             # Interactive flight comparison dashboard
├── scripts/
│   ├── flight-search.py       # Master orchestrator (parallel execution)
│   ├── search-google-flights.py   # Google Flights via SerpAPI
│   ├── search-hidden-city.py  # Hidden city engine (3-tier)
│   ├── search-awards.py       # Award flight search (4-tier)
│   ├── search-budget.py       # Budget carrier search
│   ├── search-alt-airports.py # Alternative airport search
│   └── search-skiplagged.py   # Skiplagged-style route finder
├── data/
│   ├── hub-connections.json   # Hub airport database
│   ├── airport-alternates.json    # Alternative airports database
│   └── award-sweet-spots.json # Award sweet spots database
└── strategies/                # Strategy documentation (markdown)
    ├── hidden-route.md
    ├── geo-pricing.md
    ├── fare-rules.md
    ├── timing-finder.md
    ├── price-detector.md
    ├── price-watch.md
    ├── airline-vs-ota.md
    └── award-flights.md
```

---

## Technical Details

### Architecture

- **Pure Python 3** with minimal dependencies (`urllib`, `json`, `concurrent.futures`)
- **No API keys required** for basic functionality — graceful degradation everywhere
- **Standardized JSON output** from all scripts for easy piping and integration
- **ThreadPoolExecutor** for parallel strategy execution
- **Haversine distance calculation** for hidden city price estimation

### Output Format

All scripts output standardized JSON:

```json
{
  "price": 299,
  "currency": "USD",
  "airline": "United",
  "flight_number": "UA1234",
  "origin": "LAX",
  "destination": "JFK",
  "departure_date": "2026-03-15",
  "departure_time": "14:30",
  "arrival_time": "22:45",
  "duration": "5h 15m",
  "stops": 0,
  "strategy": "google-flights",
  "booking_url": "https://...",
  "confidence": "high"
}
```

### Ranking Algorithm

Flights are scored on:
1. **Price** (primary factor)
2. **Stops** ($50 penalty per stop)
3. **Duration** ($0.50 penalty per minute)
4. **Confidence** level of the data source
5. **Strategy reliability** bonus

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-strategy`)
3. Implement your strategy following the pattern in `scripts/search-*.py`
4. Ensure JSON output matches the standardized format
5. Submit a pull request

### Adding a New Strategy

Each strategy script should:
- Accept `origin`, `destination`, `depart_date` as positional args
- Support `--return`, `--pretty` flags
- Output standardized JSON to stdout
- Log progress to stderr
- Handle timeouts gracefully (30s max)
- Degrade gracefully if APIs are unavailable

---

## License

MIT

## Security & Credentials

This tool reads API keys (e.g., `SERP_API_KEY`) from environment variables to query flight data from SerpAPI and airline websites. **No credentials are stored, logged, or transmitted to any third party** — they are only used for direct API calls to the services you configure.

Network calls go to:
- `serpapi.com` — Google Flights data (requires free API key)
- Airline websites (united.com, alaskaair.com, etc.) — public search pages, no login required
- `business.awardwallet.com` — your loyalty balances (requires your AwardWallet API key)

## License

MIT — see [LICENSE](LICENSE)
