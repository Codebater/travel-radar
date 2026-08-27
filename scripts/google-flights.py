#!/usr/bin/env python3
"""
Google Flights cash prices via fast-flights 3.x.

Replaces the fast-flights 2.2 path, which returned nothing. Two problems were
found in Phase 2 diagnostics:

  1. Google answers an un-consented request with a language-selection
     interstitial, HTTP 200, containing no flights. fast-flights sends no
     consent cookie, so every request hit that page. Sending the standard SOCS
     consent cookie makes Google return real results.

  2. fast-flights 2.2's HTML scraping left name/times/duration empty on many
     responses and reported stops as "Unknown". 3.x parses a structured payload
     instead: integer prices, per-leg airports, datetimes, durations and
     aircraft types.

Usage:
  python scripts/google-flights.py PRG BKK 2026-11-10 \
      [--class economy|premium-economy|business|first] \
      [--return 2026-11-20] [--currency EUR] [--adults 1]

Writes a single JSON object to stdout. All logging goes to stderr.
"""

import sys
import os
import json
import argparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)

# Google's consent cookie. Without it Google serves a language-selection page
# with HTTP 200 and zero flights. This is the same cookie a browser gets after
# the consent dialog; it carries no account or personal identifier.
SOCS_COOKIE = (
    "CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMzE5"
    "LjA4X3AwGgJlbiADGgYIgKbVsAY"
)

CABINS = {"economy", "premium-economy", "business", "first"}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fail(reason, detail=""):
    json.dump({"ok": False, "reason": reason, "error": detail, "flights": []}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(0)


def iso(dt):
    """SimpleDatetime -> 'YYYY-MM-DDTHH:MM' (Google reports local time, no zone)."""
    if not dt:
        return None
    try:
        y, m, d = dt.date
        hh, mm = dt.time
        return f"{y:04d}-{m:02d}-{d:02d}T{hh:02d}:{mm:02d}"
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("origin")
    ap.add_argument("destination")
    ap.add_argument("date")
    ap.add_argument("--class", dest="cabin", default="economy")
    ap.add_argument("--return", dest="return_date", default=None)
    ap.add_argument("--currency", default="EUR")
    ap.add_argument("--adults", type=int, default=1)
    args = ap.parse_args()

    if args.cabin not in CABINS:
        fail("bad-request", f"unknown cabin {args.cabin!r}")

    try:
        from fast_flights import FlightQuery, Passengers, create_query, parser
        from fast_flights.fetcher import URL
        from primp import Client
    except ImportError as e:
        fail("unconfigured", f"{e}. Install with: pip install -r requirements.txt")

    flights = [FlightQuery(date=args.date, from_airport=args.origin, to_airport=args.destination)]
    trip = "one-way"
    if args.return_date:
        flights.append(
            FlightQuery(date=args.return_date, from_airport=args.destination, to_airport=args.origin)
        )
        trip = "round-trip"

    try:
        query = create_query(
            flights=flights,
            trip=trip,
            seat=args.cabin,
            passengers=Passengers(adults=max(1, args.adults)),
            language="en-US",
            currency=args.currency,
        )
    except Exception as e:
        fail("bad-request", f"{type(e).__name__}: {e}")

    log(f"Google Flights: {args.origin}->{args.destination} {args.date} "
        f"{'RT ' + args.return_date + ' ' if args.return_date else ''}{args.cabin} {args.currency}")

    try:
        client = Client(
            impersonate="chrome_145", impersonate_os="macos",
            referer=True, cookie_store=True,
        )
        resp = client.get(URL, params=query.params(), cookies={"SOCS": SOCS_COOKIE})
    except Exception as e:
        fail("provider-error", f"fetch failed: {type(e).__name__}: {e}")

    if resp.status_code != 200:
        fail("provider-error", f"HTTP {resp.status_code}")

    body = resp.text or ""
    try:
        results = parser.parse(body)
    except Exception as e:
        # Distinguish "Google blocked us" from "the parser broke" — they need
        # completely different fixes and must not be reported as the same thing.
        if "All languages" in body or "Choose your language" in body:
            fail("provider-error", "google returned the language/consent interstitial (consent cookie rejected)")
        fail("provider-error", f"parse failed: {type(e).__name__}: {str(e)[:200]}")

    out = []
    for item in (results or []):
        legs = []
        for leg in (getattr(item, "flights", None) or []):
            legs.append({
                "origin": getattr(leg.from_airport, "code", None),
                "destination": getattr(leg.to_airport, "code", None),
                "departureTime": iso(getattr(leg, "departure", None)),
                "arrivalTime": iso(getattr(leg, "arrival", None)),
                "durationMinutes": getattr(leg, "duration", None),
                "aircraft": getattr(leg, "plane_type", None),
            })

        airlines = list(getattr(item, "airlines", None) or [])
        total_duration = None
        durations = [l["durationMinutes"] for l in legs if l["durationMinutes"]]
        if durations:
            total_duration = sum(durations)

        out.append({
            "price": getattr(item, "price", None),
            "currency": args.currency,
            "airlines": airlines,
            # `type` is the marketing carrier code, or "multi" for mixed carriers.
            "carrierCode": getattr(item, "type", None),
            "segments": legs,
            "stops": max(0, len(legs) - 1) if legs else None,
            "durationMinutes": total_duration,
            "departureTime": legs[0]["departureTime"] if legs else None,
            "arrivalTime": legs[-1]["arrivalTime"] if legs else None,
        })

    # fast-flights does not expose baggage or a tax breakdown; those stay absent
    # rather than being guessed at.
    payload = {
        "ok": True,
        "flights": out,
        "count": len(out),
        "currency": args.currency,
        "cabin": args.cabin,
    }
    log(f"  {len(out)} itineraries")
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
