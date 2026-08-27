-- Phase 3: award observations, balance snapshots, persisted search results.
--
-- Same discipline as 001:
--   award_prices      — append-only history ("points observed by this radar")
--   balance_snapshots — append-only loyalty balance history (local only, sensitive)
--   search_results    — the full result payload per search, so results.json is
--                       an export rather than application state.

-- Append-only award observations. One row per (itinerary × loyalty program ×
-- provider × fetch). AIRLINE and LOYALTY PROGRAM are separate columns on
-- purpose: an Austrian-operated flight may be priced by Miles & More, Aeroplan,
-- United and LifeMiles at four different rates — those are four rows sharing
-- one itinerary_hash, and that is signal, not duplication.
CREATE TABLE award_prices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  itinerary_hash      TEXT    NOT NULL,   -- physical-flight identity (program-independent)
  origin              TEXT    NOT NULL,
  destination         TEXT    NOT NULL,
  departure_date      TEXT    NOT NULL,
  return_date         TEXT,
  departure_time      TEXT,
  arrival_time        TEXT,
  airline             TEXT,               -- marketing carrier(s) where known
  operating_airlines  TEXT,               -- comma separated
  flight_numbers      TEXT,               -- comma separated
  stops               INTEGER,
  duration_minutes    INTEGER,
  cabin               TEXT    NOT NULL,
  loyalty_program     TEXT    NOT NULL,   -- e.g. FLYING_BLUE — NOT the airline
  points              INTEGER NOT NULL,
  taxes_amount        REAL,
  taxes_currency      TEXT,
  available_seats     INTEGER,
  booking_url         TEXT,
  provider            TEXT    NOT NULL,   -- roame | atf | ...
  verification_level  TEXT    NOT NULL,   -- cached | discovered | cross-verified
  provider_confidence TEXT    NOT NULL,   -- high | medium | low
  raw_ref             TEXT,               -- cache_key of the payload this came from
  fetched_at          TEXT    NOT NULL,
  search_request_id   INTEGER REFERENCES search_requests(id)
);

CREATE INDEX idx_award_prices_route
  ON award_prices (origin, destination, departure_date, cabin);
CREATE INDEX idx_award_prices_program
  ON award_prices (loyalty_program, origin, destination, cabin);
CREATE INDEX idx_award_prices_itinerary
  ON award_prices (itinerary_hash, fetched_at);
CREATE INDEX idx_award_prices_fetched
  ON award_prices (fetched_at);

-- Loyalty balance snapshots. Append-only so balance history accumulates.
-- SENSITIVE: this table lives only in the git-ignored local database; balances
-- must never be committed, logged in full, or served beyond the local API.
CREATE TABLE balance_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program     TEXT    NOT NULL,           -- display name
  program_key TEXT    NOT NULL,           -- normalized key (matches transfer graph)
  balance     INTEGER NOT NULL,
  source      TEXT    NOT NULL,           -- awardwallet | fallback
  fetched_at  TEXT    NOT NULL
);

CREATE INDEX idx_balance_snapshots_fetched ON balance_snapshots (fetched_at);
CREATE INDEX idx_balance_snapshots_program ON balance_snapshots (program_key, fetched_at);

-- Full DashboardResults payload per search. The dashboard's load-time state
-- comes from here (via /api/results/latest); results.json remains as a
-- debugging export only.
CREATE TABLE search_results (
  search_request_id INTEGER PRIMARY KEY REFERENCES search_requests(id),
  payload           TEXT    NOT NULL,     -- DashboardResults JSON
  created_at        TEXT    NOT NULL
);

CREATE INDEX idx_search_results_created ON search_results (created_at);
