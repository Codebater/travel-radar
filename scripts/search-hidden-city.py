#!/usr/bin/env python3
"""
Hidden City Flight Search Engine — Real SerpAPI Implementation

Finds hidden city ticketing opportunities by searching for flights through
the target city to beyond-destinations, using real Google Flights data via SerpAPI.

Usage: search-hidden-city.py LAX DEN 2026-03-15 [--max-beyond 6] [--min-savings 30] [--pretty]

Algorithm:
  1. Get direct price for origin→target via SerpAPI (1 API call)
  2. Look up hub connections for the target city
  3. Search origin→beyond_city for top N beyond cities (N API calls, max 6)
  4. For each result, check if target appears in layovers array
  5. If hidden-city price < direct price, it's an opportunity

SerpAPI budget: tracks usage in serpapi-usage.json, hard cap at 95/month.
"""

import json
import sys
import os
import argparse
import requests
from datetime import datetime
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_DIR, 'data')
HUB_CONNECTIONS_FILE = os.path.join(DATA_DIR, 'hub-connections.json')
USAGE_FILE = os.path.join(PROJECT_DIR, 'serpapi-usage.json')

MONTHLY_LIMIT = 95

def load_hub_connections():
    try:
        with open(HUB_CONNECTIONS_FILE, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: Hub connections file not found at {HUB_CONNECTIONS_FILE}", file=sys.stderr)
        return {}

def check_usage():
    """Check SerpAPI usage, return (allowed, current_count)"""
    current_month = datetime.now().strftime('%Y-%m')
    try:
        with open(USAGE_FILE, 'r') as f:
            usage = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        usage = {"month": current_month, "searches": 0, "limit": MONTHLY_LIMIT, "warn_at": 80, "last_reset": datetime.now().strftime('%Y-%m-%d')}

    if usage.get("month") != current_month:
        usage = {"month": current_month, "searches": 0, "limit": MONTHLY_LIMIT, "warn_at": 80, "last_reset": datetime.now().strftime('%Y-%m-%d')}
        with open(USAGE_FILE, 'w') as f:
            json.dump(usage, f, indent=2)

    return usage["searches"] < MONTHLY_LIMIT, usage["searches"]

def increment_usage():
    """Increment SerpAPI usage counter"""
    current_month = datetime.now().strftime('%Y-%m')
    try:
        with open(USAGE_FILE, 'r') as f:
            usage = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        usage = {"month": current_month, "searches": 0, "limit": MONTHLY_LIMIT, "warn_at": 80, "last_reset": datetime.now().strftime('%Y-%m-%d')}

    if usage.get("month") != current_month:
        usage = {"month": current_month, "searches": 0, "limit": MONTHLY_LIMIT, "warn_at": 80, "last_reset": datetime.now().strftime('%Y-%m-%d')}

    usage["searches"] += 1
    with open(USAGE_FILE, 'w') as f:
        json.dump(usage, f, indent=2)
    return usage["searches"]

def serpapi_search(origin, destination, date_str, api_key):
    """Single SerpAPI Google Flights search. Returns raw response or None."""
    allowed, used = check_usage()
    if not allowed:
        print(f"🛑 SerpAPI limit reached ({used}/{MONTHLY_LIMIT}). Skipping.", file=sys.stderr)
        return None

    try:
        params = {
            'engine': 'google_flights',
            'departure_id': origin,
            'arrival_id': destination,
            'outbound_date': date_str,
            'currency': 'USD',
            'type': 2,  # One-way
            'hl': 'en',
            'api_key': api_key
        }

        resp = requests.get("https://serpapi.com/search.json", params=params, timeout=20)
        count = increment_usage()
        print(f"  SerpAPI call #{count}: {origin}→{destination}", file=sys.stderr)

        if resp.status_code == 200:
            return resp.json()
        else:
            print(f"  SerpAPI HTTP {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"  SerpAPI error: {e}", file=sys.stderr)
        return None

def get_cheapest_price(serpapi_data):
    """Extract cheapest price from SerpAPI response."""
    if not serpapi_data:
        return None

    min_price = None
    for category in ["best_flights", "other_flights"]:
        for itinerary in serpapi_data.get(category, []):
            price = itinerary.get("price")
            if price and (min_price is None or price < min_price):
                min_price = price
    return min_price

def find_flights_with_layover(serpapi_data, target_airport):
    """Find flights that have target_airport as a layover. Returns list of matching itineraries."""
    matches = []
    if not serpapi_data:
        return matches

    for category in ["best_flights", "other_flights"]:
        for itinerary in serpapi_data.get(category, []):
            layovers = itinerary.get("layovers", [])
            layover_ids = [l.get("id", "") for l in layovers]

            if target_airport in layover_ids:
                flights = itinerary.get("flights", [])
                airlines = list(set(f.get("airline", "") for f in flights if f.get("airline")))
                flight_numbers = [f.get("flight_number", "") for f in flights if f.get("flight_number")]

                # Find arrival time at target layover
                arrival_at_target = ""
                for i, flight in enumerate(flights):
                    arr_airport = flight.get("arrival_airport", {})
                    if arr_airport.get("id") == target_airport:
                        arrival_at_target = arr_airport.get("time", "")
                        break

                departure_time = ""
                if flights:
                    dep = flights[0].get("departure_airport", {})
                    departure_time = dep.get("time", "")

                matches.append({
                    "price": itinerary.get("price"),
                    "airlines": airlines,
                    "flight_numbers": flight_numbers,
                    "departure_time": departure_time,
                    "arrival_at_target": arrival_at_target,
                    "total_duration": itinerary.get("total_duration", 0),
                    "layovers": layovers,
                    "stops": len(layovers),
                })
    return matches

def calculate_risk(target_airport, airlines, beyond_city):
    """Calculate risk score for hidden city ticketing."""
    risk_level = "medium"
    risk_factors = [
        "Must book one-way only",
        "No checked bags (will go to final destination)",
        "Cannot use frequent flyer number"
    ]

    # Large hub = lower risk (easier to blend in)
    large_hubs = ['DEN', 'ORD', 'ATL', 'LAX', 'JFK', 'DFW', 'SEA', 'SFO', 'IAH', 'MIA', 'PHX', 'MSP']
    if target_airport in large_hubs:
        risk_level = "low"
    else:
        risk_level = "high"
        risk_factors.append("Smaller airport — more visible")

    # Strict enforcement airlines
    strict = ['United', 'Delta', 'American']
    for airline in airlines:
        if airline in strict:
            if risk_level == "low":
                risk_level = "medium"
            risk_factors.append(f"{airline} actively enforces against hidden city ticketing")
            break

    risk_factors.extend([
        "If flight cancelled, rebooking goes to final destination",
        "Repeated use may result in account ban"
    ])

    return risk_level, risk_factors

def find_hidden_city_opportunities(origin, target, date_str, api_key, max_beyond=6, min_savings=30):
    """Main hidden city search algorithm using real SerpAPI data."""
    hub_data = load_hub_connections()
    results = []

    # Step 1: Get direct price
    print(f"\n📊 Step 1: Direct price {origin}→{target}...", file=sys.stderr)
    direct_data = serpapi_search(origin, target, date_str, api_key)
    direct_price = get_cheapest_price(direct_data)

    if direct_price is None:
        print(f"  ⚠️ Could not get direct price for {origin}→{target}", file=sys.stderr)
        # Use SerpAPI price_insights if available
        if direct_data and "price_insights" in direct_data:
            direct_price = direct_data["price_insights"].get("lowest_price")
        if direct_price is None:
            print(f"  ❌ No price data available, cannot compare", file=sys.stderr)
            return []

    print(f"  💰 Direct price: ${direct_price}", file=sys.stderr)

    # Step 2: Find beyond cities
    beyond_cities = []
    if target in hub_data:
        beyond_cities = hub_data[target].get('beyond_cities', [])
    else:
        # Check if target is a beyond city of any hub — those hubs route through themselves
        print(f"  ℹ️ {target} not a hub, checking reverse connections...", file=sys.stderr)
        for hub, data in hub_data.items():
            if target in data.get('beyond_cities', []):
                # Flights to cities beyond this hub might route through the hub
                # But we need cities beyond target, not beyond the hub
                pass
        # Fallback: use common large airports as beyond destinations
        beyond_cities = ['LAX', 'SFO', 'SEA', 'JFK', 'ORD', 'ATL', 'DFW', 'MIA']

    # Filter out origin and target, limit to max_beyond
    beyond_cities = [c for c in beyond_cities if c != origin and c != target][:max_beyond]

    print(f"\n📊 Step 2: Searching {len(beyond_cities)} beyond cities: {', '.join(beyond_cities)}", file=sys.stderr)

    # Step 3: Search each beyond city
    for beyond_city in beyond_cities:
        # Check budget before each call
        allowed, used = check_usage()
        if not allowed:
            print(f"  🛑 Budget exhausted after {used} calls", file=sys.stderr)
            break

        print(f"\n  🔍 {origin}→{beyond_city} (looking for {target} layover)...", file=sys.stderr)
        beyond_data = serpapi_search(origin, beyond_city, date_str, api_key)

        if not beyond_data:
            continue

        # Find flights that stop at our target
        matches = find_flights_with_layover(beyond_data, target)

        if not matches:
            print(f"    No flights via {target}", file=sys.stderr)
            continue

        for match in matches:
            hidden_price = match["price"]
            if hidden_price is None:
                continue

            savings = direct_price - hidden_price
            if savings < min_savings:
                continue

            savings_pct = round((savings / direct_price) * 100, 1)
            risk_level, risk_factors = calculate_risk(target, match["airlines"], beyond_city)

            result = {
                "type": "hidden_city",
                "origin": origin,
                "real_destination": target,
                "ticketed_destination": beyond_city,
                "layover_airport": target,
                "direct_price": direct_price,
                "hidden_city_price": hidden_price,
                "savings": round(savings, 2),
                "savings_percent": savings_pct,
                "airline": " / ".join(match["airlines"]) if match["airlines"] else "Various",
                "flight_numbers": match["flight_numbers"],
                "departure_time": match["departure_time"],
                "arrival_at_layover": match["arrival_at_target"],
                "total_duration_min": match["total_duration"],
                "stops": match["stops"],
                "risk_score": risk_level,
                "risks": risk_factors,
                "booking_url": f"https://www.google.com/travel/flights?q=flights+from+{origin}+to+{beyond_city}+on+{date_str}",
                "confidence": "high",
                "data_source": "serpapi"
            }
            results.append(result)
            print(f"    ✅ FOUND: ${hidden_price} via {target} to {beyond_city} — saves ${savings:.0f} ({savings_pct}%)", file=sys.stderr)

        time.sleep(0.3)  # Brief pause between calls

    results.sort(key=lambda x: x['savings'], reverse=True)

    allowed, used = check_usage()
    print(f"\n📊 SerpAPI usage: {used}/{MONTHLY_LIMIT} this month", file=sys.stderr)

    return results

def main():
    parser = argparse.ArgumentParser(description='Find hidden city flight opportunities (real SerpAPI data)')
    parser.add_argument('origin', help='Origin airport code (e.g., LAX)')
    parser.add_argument('destination', help='Target destination airport code (e.g., DEN)')
    parser.add_argument('date', help='Departure date (YYYY-MM-DD)')
    parser.add_argument('--max-beyond', type=int, default=6,
                       help='Max beyond cities to search (default: 6, each costs 1 SerpAPI call)')
    parser.add_argument('--min-savings', type=float, default=30,
                       help='Minimum savings in USD (default: 30)')
    parser.add_argument('--pretty', action='store_true', help='Pretty print JSON output')

    args = parser.parse_args()

    api_key = os.getenv('SERP_API_KEY')
    if not api_key:
        print("❌ SERP_API_KEY not set. Set in .env or environment.", file=sys.stderr)
        # Output empty results
        print(json.dumps([]))
        sys.exit(0)

    try:
        datetime.strptime(args.date, '%Y-%m-%d')
    except ValueError:
        print(f"Error: Invalid date format: {args.date}", file=sys.stderr)
        sys.exit(1)

    print(f"🏙️ Hidden City Search: {args.origin} → {args.destination} on {args.date}", file=sys.stderr)
    print(f"   Budget: max {args.max_beyond + 1} SerpAPI calls (1 direct + {args.max_beyond} beyond)", file=sys.stderr)

    results = find_hidden_city_opportunities(
        args.origin.upper(),
        args.destination.upper(),
        args.date,
        api_key,
        max_beyond=args.max_beyond,
        min_savings=args.min_savings
    )

    if args.pretty:
        print(json.dumps(results, indent=2))
    else:
        print(json.dumps(results))

    if results:
        print(f"\n🎉 Found {len(results)} hidden city opportunities!", file=sys.stderr)
        for r in results[:3]:
            print(f"   {r['origin']}→{r['ticketed_destination']} via {r['real_destination']}: ${r['hidden_city_price']} (save ${r['savings']:.0f}, {r['savings_percent']}%)", file=sys.stderr)
    else:
        print(f"\nNo hidden city opportunities found with ≥${args.min_savings} savings", file=sys.stderr)

if __name__ == "__main__":
    main()
