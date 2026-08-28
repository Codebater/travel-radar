-- Phase 8k: ONE_WAY as a first-class trip shape in the fare radar.
--
-- A long-haul one-way is NOT half a return (Phase 6.5 measured why), so trip
-- type becomes a HARD dimension of every candidate: a fabricated return date
-- on a ONE_WAY row — or a ROUND_TRIP row missing its return dimensions — is
-- unrepresentable, not merely discouraged. No sentinel dates, no fake nights.
--
-- fare_radar_candidates is REBUILT because return_date/nights were NOT NULL
-- and SQLite cannot relax that in place. The table is a leaf (nothing
-- references it), so create-copy-drop-rename is safe with foreign keys ON.
-- Every pre-022 row survives with its id; all of them were round trips by
-- construction, so they are stamped trip_type='ROUND_TRIP' explicitly.
-- Append-only doctrine: this rewrites the SHAPE of the table, never the
-- observations in it.

CREATE TABLE fare_radar_candidates_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES fare_radar_runs(id),
  flight_price_id   INTEGER REFERENCES flight_prices(id),
  itinerary_hash    TEXT NOT NULL,

  trip_type         TEXT NOT NULL CHECK (trip_type IN ('ROUND_TRIP', 'ONE_WAY')),

  origin            TEXT NOT NULL,
  destination       TEXT NOT NULL,
  departure_date    TEXT NOT NULL,
  return_date       TEXT,              -- NULL exactly when trip_type='ONE_WAY'
  nights            INTEGER,           -- NULL exactly when trip_type='ONE_WAY'
  adults            INTEGER NOT NULL,

  cabin             TEXT NOT NULL,     -- what was REQUESTED and echoed
  cabin_mix         TEXT NOT NULL,     -- BUSINESS_FULL | BUSINESS_MIXED | BUSINESS_UNVERIFIED
                                       --   | PREMIUM_ECONOMY | ECONOMY
  cabin_mix_detail  TEXT NOT NULL,     -- why: per-segment evidence or its absence
  airline           TEXT,
  airlines          TEXT NOT NULL,     -- JSON [string]
  stops             INTEGER,
  duration_minutes  INTEGER,
  quality_flags     TEXT NOT NULL,     -- JSON [string]: OVERNIGHT_CONNECTION, LONG_LAYOVER, …

  price_amount      REAL NOT NULL,
  price_currency    TEXT NOT NULL,
  deal_score        REAL NOT NULL,     -- transparent, deterministic (score_breakdown says how)
  score_breakdown   TEXT NOT NULL,     -- JSON
  fare_window_key   TEXT NOT NULL,     -- strict-dimension key for future fare baselines

  provider          TEXT NOT NULL,
  locator_id        INTEGER REFERENCES offer_locators(id),
  observed_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,

  -- The biconditionals that make a mislabelled row impossible: ROUND_TRIP has
  -- both return dimensions, ONE_WAY has neither.
  CHECK ((trip_type = 'ROUND_TRIP') = (return_date IS NOT NULL)),
  CHECK ((trip_type = 'ROUND_TRIP') = (nights IS NOT NULL))
);

INSERT INTO fare_radar_candidates_new (
  id, run_id, flight_price_id, itinerary_hash, trip_type,
  origin, destination, departure_date, return_date, nights, adults,
  cabin, cabin_mix, cabin_mix_detail, airline, airlines, stops, duration_minutes,
  quality_flags, price_amount, price_currency, deal_score, score_breakdown,
  fare_window_key, provider, locator_id, observed_at, created_at
)
SELECT
  id, run_id, flight_price_id, itinerary_hash, 'ROUND_TRIP',
  origin, destination, departure_date, return_date, nights, adults,
  cabin, cabin_mix, cabin_mix_detail, airline, airlines, stops, duration_minutes,
  quality_flags, price_amount, price_currency, deal_score, score_breakdown,
  fare_window_key, provider, locator_id, observed_at, created_at
FROM fare_radar_candidates;

DROP TABLE fare_radar_candidates;
ALTER TABLE fare_radar_candidates_new RENAME TO fare_radar_candidates;

CREATE INDEX idx_frc_run   ON fare_radar_candidates (run_id, price_amount);
CREATE INDEX idx_frc_route ON fare_radar_candidates (origin, destination, departure_date);

-- Runs gain the same hard dimension without a rebuild (parent table — a
-- rebuild would need the child dropped first, for zero benefit). Existing
-- runs were all round trips. For ONE_WAY runs, min_nights/max_nights are
-- NOT_APPLICABLE request descriptors and hold 0/0 by definition — they are
-- never read as a trip length (a ONE_WAY candidate carries nights = NULL,
-- enforced above; 0/0 here describes the REQUEST row only).
ALTER TABLE fare_radar_runs ADD COLUMN trip_type TEXT NOT NULL DEFAULT 'ROUND_TRIP';
