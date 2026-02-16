# ✈️ Flight Search Agent

Multi-source flight search that always finds the best value path — whether points or cash. Searches 19+ award programs and Google Flights in parallel, then scores every result with real CPP analysis, sweet spot detection, and transfer path awareness.

## What It Does

You search a route. It tells you:
- **"This Flying Blue J is 50K pts, the cash equivalent is $4,200 (actual), that's 8.1¢/pt (exceptional)"**
- **"You can fund it by transferring 50K Chase UR → Flying Blue (instant)"**
- **"This is a known sweet spot — book it"**

## Features

### Search Sources
- **🔍 Roame** — One GraphQL API searches 19+ mileage programs (United, Alaska, AA, Delta, Flying Blue, Qantas, BA, Emirates, Qatar, Singapore, etc.)
- **💰 SerpAPI** — Google Flights cash prices (hard cap at 95/mo to stay on free tier)
- **🏙️ Hidden City Engine** — Finds cheaper fares by booking beyond your destination
- **💳 AwardWallet** — Real balances from 34 loyalty accounts

### Value Engine
- **📊 Real CPP Scoring** — Cross-references award fares against actual cash fares for the same route + cabin. No hardcoded estimates — uses Google Flights data from the same search.
- **🎯 Sweet Spot Detection** — 18 known high-value redemptions (Flying Blue J to Europe at 55K, ANA F via VS at 120K RT, Alaska→Cathay J at 50K, etc.). Flags matches AND shows route tips for what to look for.
- **🔀 Transfer Path Graph** — 40 transfer paths across Chase UR, Amex MR, Bilt, Marriott. Shows how to fund any award: direct balance → single transfer → combinations.
- **🏆 Value Score (0-100)** — Composite score weighing CPP (40%), sweet spot match (20%), affordability (15%), product quality (15%), convenience (10%).
- **💡 Insights** — Proactive intelligence: "Cash wins here at only 1.2¢/pt", "Exceptional value — book now", "Look for Aeroplan J on this route".

### Dashboard
- **Search form** — Any origin/destination/dates
- **Class tabs** — All / Economy / Business / First
- **Type filter** — All / Cash / Award
- **Sort options** — Best Value, Price ↑, Points ↑, CPP ↓, Duration ↑
- **Points balances** — Expandable panel showing all loyalty balances
- **Recommendations** — Top 3 picks with real CPP, funding paths, and sweet spot flags
- **Source badges** — LIVE (Roame), Google, Hidden City

## Quick Start

```bash
# Search LAX → London, all classes
npx tsx search.ts --from LAX --to LHR --date 2026-03-15 --class both

# Launch dashboard
npx tsx serve.ts --port 8888
# Open http://localhost:8888
```

## Architecture

```
search.ts (Orchestrator)
├── roame-scraper.ts    → Roame GraphQL API (19+ award programs)
├── SerpAPI             → Google Flights (cash prices)
├── hidden city engine  → Beyond-hub savings detection
├── AwardWallet API     → 34 loyalty account balances
└── value-engine.ts     → Real CPP + sweet spots + transfer paths
    ├── sweet-spots.ts      → 18 known elite redemptions
    └── transfer-partners.ts → 40 bank→airline transfer paths
```

### How It Works

1. **Search** — Roame + SerpAPI + hidden city run in parallel (~45-65s)
2. **Score** — Value engine cross-references every award fare against real cash prices
3. **Match** — Sweet spot database flags known high-value redemptions
4. **Fund** — Transfer partner graph shows how to get miles you need
5. **Rank** — Composite value score (0-100) sorts everything
6. **Recommend** — Top 3 picks with full context

## CLI Usage

```bash
# Full search with all sources
npx tsx search.ts --from LAX --to DXB --date 2026-04-28 --class both --sources roame,google,hidden-city

# Roame only for award availability
npx tsx roame-scraper.ts --from LAX --to DXB --date 2026-04-28 --class PREM

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

### SerpAPI (Required for cash prices)
```bash
# In .env file:
SERP_API_KEY=your-key-here
# Free tier: 100/mo, hard-capped at 95 with usage tracking
```

### AwardWallet (Optional, for real balances)
```bash
# Save to ~/.openclaw/credentials/awardwallet.json:
{
  "apiKey": "your-api-key",
  "userId": "your-user-id"
}
```

## Sweet Spots Database

Known high-value redemptions tracked:

| Program | Route | Cabin | Max Points | Expected CPP |
|---------|-------|-------|-----------|--------------|
| Flying Blue | US→Europe | Business | 55K | 7.0¢ |
| Aeroplan | US→Asia | Business | 75K | 7.5¢ |
| Virgin Atlantic | US→Japan | First (ANA) | 120K RT | 12.0¢ |
| Alaska | US→Asia | Business (CX) | 50K | 9.0¢ |
| Alaska | US→Asia | Business (JAL) | 60K | 9.0¢ |
| Alaska | US→ME | First (Emirates) | 115K | 10.0¢ |
| Turkish | US→IST | Business | 45K | 8.0¢ |
| BA Avios | US domestic | Economy | 7.5K | 2.5¢ |
| Qatar | US→DOH | Business (QSuites) | 70K | 7.0¢ |

## Output Format

`results.json` contains:

```typescript
{
  meta: { origin, destination, departureDate, searchedAt, sources, completionPct },
  balances: [{ program, balance, displayBalance }],
  flights: [{
    // Flight data
    source, type, airline, stops, cabinClass, points, cashPrice,
    // Value scoring
    realCpp, cppRating, cashComparable, cashSource,
    sweetSpotMatch, fundingPath, canAfford, affordDetails,
    valueScore
  }],
  recommendations: [{ rank, title, totalCost, cppValue, details }],
  insights: [{ type, priority, title, detail }],
  routeSweetSpots: [{ program, cabin, maxPoints, description }],
  warnings: string[]
}
```

## SerpAPI Budget

Free tier: 100 searches/month. Hard-capped at 95 with auto-tracking in `serpapi-usage.json`. Warns at 80. Auto-resets monthly.

## License

MIT
