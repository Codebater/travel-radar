# ✈️ Flight Search Agent

Multi-source flight search with award optimization, real-time availability, and a dynamic comparison dashboard.

## Features

- **🔍 Award Search via Roame** — One API call searches 19+ mileage programs: United, Alaska, American, Delta, Flying Blue, Qantas, BA, Emirates, Qatar, Singapore, and more
- **💰 Cash Price Search** — Google Flights via SerpAPI
- **💳 Real Balances** — AwardWallet API integration (34 loyalty accounts)
- **📊 Dynamic Dashboard** — Filter by cabin class, type (cash/award), sort by CPP/price/duration
- **🏆 Smart Recommendations** — Best value, best product, cheapest cash options
- **⚠️ Intelligent Warnings** — Dead transfer routes, low balance alerts

## Quick Start

```bash
# Install dependencies
npm install

# Search all programs for LAX → DXB
npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --class both

# Launch dashboard
npx tsx serve.ts --port 8888
# Open http://localhost:8888
```

## Architecture

```
search.ts (Orchestrator)
├── roame-scraper.ts → Roame GraphQL API (19+ award programs)
├── SerpAPI → Google Flights (cash prices)  
├── AwardWallet API → 34 loyalty account balances
└── results.json → dashboard.html (dynamic UI)
```

### How Roame Works

Roame.travel provides a unified GraphQL API that searches award availability across all major airline programs simultaneously:

1. `initiateFlightSearchMutation` → starts search job
2. `pingSearchResultsQuery` → polls until complete
3. Returns: points, taxes, cabin class, seat availability, operating airlines, equipment types

This replaces the need to maintain individual airline scrapers.

## Dashboard

The dashboard (`dashboard.html`) is a zero-dependency HTML file that loads `results.json`:

- **Search form** — Enter any origin/destination/dates
- **Class tabs** — All / Economy / Business / First
- **Type filter** — All / Cash / Award
- **Sort options** — Best Value, Price ↑, Points ↑, CPP ↓, Duration ↑
- **Points balances** — Expandable panel showing all loyalty balances
- **Recommendations** — Top 3 picks with booking links
- **Source badges** — LIVE (Roame), Google, Estimated

## CLI Usage

```bash
# Full search (Roame + Google)
npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --class both --sources roame,google

# Roame only with specific class
npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 --class PREM

# Show loyalty balances
npx tsx cli.ts balances

# Serve dashboard with live search API
npx tsx serve.ts --port 8888
```

## Credentials Setup

### Roame (Required for award search)
```bash
# Login to roame.travel in browser, extract session cookie
# Save to ~/.openclaw/credentials/roame.json:
{
  "session": "eyJ...",
  "csrfSecret": "...",
  "sessionExpiresAt": 1771829264892
}
```

### AwardWallet (Optional, for real balances)
```bash
# Save to ~/.openclaw/credentials/awardwallet.json:
{
  "apiKey": "your-api-key",
  "userId": "your-user-id"
}
```

### SerpAPI (Optional, for Google Flights cash prices)
```bash
export SERP_API_KEY=your-key-here
```

## Security

- All credentials stored locally in `~/.openclaw/credentials/` (gitignored)
- No sensitive data in the repository
- Roame session cookies expire and need periodic refresh
- AwardWallet API is read-only (balance queries only)

## Output Format

`results.json` contains:

```typescript
{
  meta: { origin, destination, departureDate, returnDate, searchedAt, sources, completionPct },
  balances: [{ program, balance, displayBalance }],
  flights: [{
    source: "roame" | "google" | "aa-direct",
    type: "award" | "cash",
    airline, flightNumbers, stops, durationMinutes,
    points, pointsProgram, cashPrice, taxes,
    cppValue, roameScore, availableSeats,
    cabinClass, bookingUrl
  }],
  recommendations: [{ rank, title, totalCost, cppValue, bookingUrl }],
  warnings: string[]
}
```

## License

MIT
