#!/usr/bin/env python3
"""
Google Flights search via fast_flights (AWeirdDev/flights).
Primary cash price source — replaces SerpAPI as first pass.

Usage:
  python3 scripts/search-google-flights.py LAX LHR 2026-03-15 [--class economy|business|first] [--return 2026-03-22]

Outputs JSON array to stdout. All logging goes to stderr.
"""

import sys
import json
import argparse
import re
from datetime import datetime

# Ensure the venv is used
import os
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
VENV_SITE = os.path.join(ROOT_DIR, ".venv", "lib")
# Find the python version dir dynamically
if os.path.exists(VENV_SITE):
    for d in os.listdir(VENV_SITE):
        sp = os.path.join(VENV_SITE, d, "site-packages")
        if os.path.exists(sp) and sp not in sys.path:
            sys.path.insert(0, sp)

from fast_flights import FlightData, Passengers, create_filter, get_flights_from_filter


def parse_price(price_str: str) -> float | None:
    """Extract numeric price from '$399' or 'US$1,234'"""
    if not price_str:
        return None
    match = re.search(r'[\d,]+', price_str.replace(',', ''))
    if match:
        try:
            return float(match.group().replace(',', ''))
        except ValueError:
            return None
    return None


def parse_duration_minutes(dur_str: str) -> int:
    """Parse '10 hr 20 min' or '2 hr' to minutes"""
    if not dur_str:
        return 0
    hours = 0
    minutes = 0
    h_match = re.search(r'(\d+)\s*hr', dur_str)
    m_match = re.search(r'(\d+)\s*min', dur_str)
    if h_match:
        hours = int(h_match.group(1))
    if m_match:
        minutes = int(m_match.group(1))
    return hours * 60 + minutes


def parse_time(time_str: str, search_date: str) -> str:
    """Parse '5:35 PM on Sun, Mar 15' into ISO-ish format"""
    if not time_str:
        return ""
    # Try to extract just the time portion
    match = re.search(r'(\d{1,2}:\d{2}\s*[AP]M)', time_str)
    if match:
        time_part = match.group(1).strip()
        # Extract date if present
        date_match = re.search(r'(\w+),\s*(\w+)\s+(\d+)', time_str)
        if date_match:
            month_str = date_match.group(2)
            day = int(date_match.group(3))
            year = int(search_date[:4])
            try:
                month_num = datetime.strptime(month_str, '%b').month
                dt = datetime.strptime(f"{year}-{month_num:02d}-{day:02d} {time_part}", "%Y-%m-%d %I:%M %p")
                return dt.strftime("%Y-%m-%dT%H:%M")
            except ValueError:
                pass
        return time_part
    return time_str


def search(origin: str, dest: str, date: str, cabin: str = "economy", return_date: str | None = None) -> list[dict]:
    """Search Google Flights and return unified results."""
    seat_map = {
        "economy": "economy",
        "business": "business",
        "first": "first",
    }
    seat = seat_map.get(cabin, "economy")
    
    flight_data = [FlightData(date=date, from_airport=origin, to_airport=dest)]
    
    trip_type = "round-trip" if return_date else "one-way"
    if return_date:
        flight_data.append(FlightData(date=return_date, from_airport=dest, to_airport=origin))
    
    filter_obj = create_filter(
        flight_data=flight_data,
        trip=trip_type,
        passengers=Passengers(adults=1),
        seat=seat,
    )
    
    print(f"Searching Google Flights: {origin}→{dest} on {date} ({cabin})", file=sys.stderr)
    result = get_flights_from_filter(filter_obj)
    
    flights = []
    for i, flight in enumerate(result.flights or []):
        price = parse_price(flight.price)
        duration = parse_duration_minutes(flight.duration)
        dep_time = parse_time(flight.departure, date)
        arr_time = parse_time(flight.arrival, date)
        
        # Extract date from departure for travelDate
        travel_date = date
        dep_date_match = re.search(r'(\w+),\s*(\w+)\s+(\d+)', flight.departure or "")
        if dep_date_match:
            try:
                month_num = datetime.strptime(dep_date_match.group(2), '%b').month
                day = int(dep_date_match.group(3))
                year = int(date[:4])
                travel_date = f"{year}-{month_num:02d}-{day:02d}"
            except ValueError:
                pass

        flights.append({
            "id": f"fast-flights-{i}",
            "source": "google",
            "type": "cash",
            "origin": origin,
            "destination": dest,
            "airline": flight.name or "Unknown",
            "stops": flight.stops if isinstance(flight.stops, int) else 0,
            "durationMinutes": duration,
            "departureTime": dep_time,
            "arrivalTime": arr_time,
            "cabinClass": cabin,
            "cashPrice": price,
            "currency": "USD",
            "isBest": flight.is_best or False,
            "delay": flight.delay,
            "travelDate": travel_date,
        })
    
    print(f"Found {len(flights)} flights via fast_flights", file=sys.stderr)
    return flights


def main():
    parser = argparse.ArgumentParser(description="Search Google Flights via fast_flights")
    parser.add_argument("origin", help="Origin airport code")
    parser.add_argument("destination", help="Destination airport code")
    parser.add_argument("date", help="Departure date (YYYY-MM-DD)")
    parser.add_argument("--class", dest="cabin", default="economy", choices=["economy", "business", "first"])
    parser.add_argument("--return", dest="return_date", default=None, help="Return date (YYYY-MM-DD)")
    
    args = parser.parse_args()
    
    try:
        results = search(args.origin, args.destination, args.date, args.cabin, args.return_date)
        print(json.dumps(results))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        print(json.dumps([]))
        sys.exit(1)


if __name__ == "__main__":
    main()
