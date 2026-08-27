#!/usr/bin/env python3
"""Health probe for the fast-flights provider. Imports only — no network call,
no Google request, nothing billable. Prints one JSON object to stdout."""

import json
import sys

out = {"ok": False, "version": None, "error": None}

try:
    import fast_flights                                    # noqa: F401
    from fast_flights import FlightQuery, create_query     # noqa: F401
    from fast_flights.fetcher import URL                   # noqa: F401
    import primp                                           # noqa: F401

    try:
        from importlib.metadata import version
        out["version"] = version("fast-flights")
    except Exception:
        out["version"] = getattr(fast_flights, "__version__", "unknown")

    out["ok"] = True
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"

json.dump(out, sys.stdout)
sys.stdout.write("\n")
