-- Phase 8j: the flexible BUSINESS-CLASS fare radar.
--
-- "Cheapest bookable business fares from my home airports in the next N
-- days" is a PLANNED sweep over date combinations, not an exact-date search.
-- Doctrine carried over verbatim:
--   - observations stay in flight_prices (append-only; the radar never mints
--     a second price-history table) — radar candidates LINK to them;
--   - the search plan is explicit and stored: every run says what it intended
--     to spend, what it actually spent, and what it cut when the cap bit;
--   - cabin is a hard dimension. A mixed-cabin or unverifiable itinerary is
--     LABELLED, never silently ranked as full business.

CREATE TABLE fare_radar_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  origins        TEXT NOT NULL,        -- JSON [IATA] — config, never hard-coded
  destinations   TEXT NOT NULL,        -- JSON [IATA] (resolved watchlist/mode)
  destination_mode TEXT NOT NULL,      -- specific | watchlist:<name> | anywhere
  window_start   TEXT NOT NULL,        -- earliest departure (YYYY-MM-DD)
  window_end     TEXT NOT NULL,        -- latest departure
  min_nights     INTEGER NOT NULL,
  max_nights     INTEGER NOT NULL,
  cabin          TEXT NOT NULL,
  adults         INTEGER NOT NULL,
  currency       TEXT NOT NULL,

  plan           TEXT NOT NULL,        -- JSON: the visible search plan incl. reductions
  calls_planned  INTEGER NOT NULL,
  calls_spent    INTEGER NOT NULL DEFAULT 0,
  searches_issued INTEGER NOT NULL DEFAULT 0,
  candidates_found INTEGER NOT NULL DEFAULT 0,

  source         TEXT NOT NULL,        -- cli | api | test
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);

-- One row per surviving candidate of a run. Append-only per run; the current
-- view is simply the newest finished run's rows. flight_price_id is the
-- provenance link into the append-only price history (nullable only for
-- cache-served itineraries whose original row is linked by hash instead).
CREATE TABLE fare_radar_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES fare_radar_runs(id),
  flight_price_id   INTEGER REFERENCES flight_prices(id),
  itinerary_hash    TEXT NOT NULL,

  origin            TEXT NOT NULL,
  destination       TEXT NOT NULL,
  departure_date    TEXT NOT NULL,
  return_date       TEXT NOT NULL,
  nights            INTEGER NOT NULL,
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
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_frc_run   ON fare_radar_candidates (run_id, price_amount);
CREATE INDEX idx_frc_route ON fare_radar_candidates (origin, destination, departure_date);
