-- Phase 8f: the Trip Composer forms opinions about COMPLETE trips.
--
-- One row per composed trip opportunity, upserted on a durable price-free
-- trip_key: re-composing after prices move updates the same opportunity
-- instead of minting a new one (the flight radar's identity doctrine).
-- Provenance is stored as id lists back to the underlying flight/stay rows —
-- links, never copies: every number on a trip can be traced to the
-- observation that produced it.
--
-- Money doctrine: cash and miles NEVER blend. cash_components is a JSON list
-- of known cash costs (each with its currency); miles_components lists
-- points PER PROGRAM. unknown_costs names what the trip does NOT know
-- (hotel taxes, transfers) — an absent cost is a stated unknown, never zero.
--
-- This table is also the future TRIP BASELINE substrate: rows are dated so a
-- later phase can judge "5 nights Maldives AI + business" against its own
-- history with the same no-look-ahead discipline. v1 stores; it does not yet
-- judge from history.

CREATE TABLE trip_opportunities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_key              TEXT NOT NULL UNIQUE,    -- price-free identity, see trips/identity.ts

  -- the trip
  origin                TEXT NOT NULL,           -- home-side airport
  destination_airport   TEXT NOT NULL,
  destination_group     TEXT NOT NULL,
  property_id           TEXT NOT NULL REFERENCES stay_properties(id),
  check_in              TEXT NOT NULL,
  check_out             TEXT NOT NULL,
  nights                INTEGER NOT NULL,
  adults                INTEGER NOT NULL,
  construction          TEXT NOT NULL,           -- cash | award | positioning_cash | open_jaw
  cabin                 TEXT,                    -- flight cabin (outbound, or the pair's)
  room_class            TEXT,
  board                 TEXT NOT NULL,

  -- flight side
  outbound_departure    TEXT NOT NULL,
  return_departure      TEXT,
  flight_detail         TEXT NOT NULL,           -- JSON: legs, airlines, programs, prices
  flight_score          REAL,                    -- 0..100 quality of the flight side, NULL unknown
  flight_provenance     TEXT NOT NULL,           -- JSON: flight_prices/award_prices/candidate ids

  -- stay side
  stay_window_key       TEXT NOT NULL,
  stay_detail           TEXT NOT NULL,           -- JSON: nightly, taxStatus, sources
  stay_score            REAL,
  stay_provenance       TEXT NOT NULL,           -- JSON: stay candidate/observation ids

  -- money (never blended)
  cash_components       TEXT NOT NULL,           -- JSON [{kind, amount, currency, detail}]
  cash_total_amount     REAL,                    -- only when ALL cash shares one currency
  cash_total_currency   TEXT,
  miles_components      TEXT NOT NULL,           -- JSON [{program, miles, legs}]
  unknown_costs         TEXT NOT NULL,           -- JSON [string]

  -- judgement
  score                 REAL NOT NULL,
  score_breakdown       TEXT NOT NULL,           -- JSON incl. dropped components + penalties
  trip_absolute_tier    TEXT,                    -- wtf | extreme | interesting | NULL
  trip_absolute_path    TEXT NOT NULL,           -- rule path or "none"
  complexity            TEXT NOT NULL,           -- JSON: flags + penalty applied
  evidence              TEXT NOT NULL,           -- JSON: per-side verification levels
  reasons               TEXT NOT NULL,           -- JSON [string]
  admission_gate        TEXT NOT NULL,           -- which gate admitted this trip
  status                TEXT NOT NULL,           -- interesting | rejected
  rejection_reason      TEXT,

  created_at            TEXT NOT NULL,
  evaluated_at          TEXT NOT NULL
);

CREATE INDEX idx_trip_opps_score    ON trip_opportunities (status, score DESC);
CREATE INDEX idx_trip_opps_property ON trip_opportunities (property_id, check_in);
