-- Phase 2 initial schema.
--
-- Three concepts are deliberately kept apart:
--   search_cache  — "what did we recently fetch?"  (expires, overwritten)
--   flight_prices — "what have we observed over time?" (append-only, never updated)
--   provider_usage — "what have we spent?" (atomic counters)

CREATE TABLE search_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  origin           TEXT    NOT NULL,
  destination      TEXT    NOT NULL,
  departure_date   TEXT    NOT NULL,
  return_date      TEXT,
  cabin            TEXT    NOT NULL,
  adults           INTEGER NOT NULL DEFAULT 1,
  source           TEXT    NOT NULL DEFAULT 'api',   -- api | cli | test
  created_at       TEXT    NOT NULL
);

CREATE INDEX idx_search_requests_route
  ON search_requests (origin, destination, departure_date);
CREATE INDEX idx_search_requests_created
  ON search_requests (created_at);

-- Append-only price history. One row per observation, per provider, per fetch.
-- Rows are NEVER updated or deleted by the application: two providers reporting
-- different prices for the same itinerary is signal, not a conflict.
CREATE TABLE flight_prices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  itinerary_hash     TEXT    NOT NULL,
  origin             TEXT    NOT NULL,
  destination        TEXT    NOT NULL,
  departure_date     TEXT    NOT NULL,
  return_date        TEXT,
  cabin              TEXT    NOT NULL,
  adults             INTEGER NOT NULL DEFAULT 1,
  airline            TEXT,
  flight_numbers     TEXT,                            -- comma separated
  stops              INTEGER,
  duration_minutes   INTEGER,
  departure_time     TEXT,
  arrival_time       TEXT,
  price_amount       REAL    NOT NULL,
  price_currency     TEXT    NOT NULL,                -- ISO 4217
  taxes_amount       REAL,
  taxes_currency     TEXT,
  baggage            TEXT,
  booking_url        TEXT,
  provider           TEXT    NOT NULL,
  verification_level TEXT    NOT NULL,                -- cached | discovered | verified
  provider_confidence TEXT   NOT NULL,                -- high | medium | low
  price_level        TEXT,                            -- low | typical | high (provider hint)
  raw_ref            TEXT,                            -- cache_key of the payload this came from
  fetched_at         TEXT    NOT NULL,
  search_request_id  INTEGER REFERENCES search_requests(id)
);

CREATE INDEX idx_flight_prices_route_date
  ON flight_prices (origin, destination, departure_date, cabin);
CREATE INDEX idx_flight_prices_itinerary
  ON flight_prices (itinerary_hash, fetched_at);
CREATE INDEX idx_flight_prices_fetched
  ON flight_prices (fetched_at);
CREATE INDEX idx_flight_prices_provider
  ON flight_prices (provider, fetched_at);

-- Recent provider payloads, keyed by the deterministic cache key.
CREATE TABLE search_cache (
  cache_key    TEXT    PRIMARY KEY,
  provider     TEXT    NOT NULL,
  origin       TEXT    NOT NULL,
  destination  TEXT    NOT NULL,
  departure_date TEXT  NOT NULL,
  return_date  TEXT,
  cabin        TEXT    NOT NULL,
  adults       INTEGER NOT NULL DEFAULT 1,
  payload      TEXT    NOT NULL,                      -- JSON: NormalizedCashFlight[]
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  hit_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_search_cache_expires ON search_cache (expires_at);
CREATE INDEX idx_search_cache_provider ON search_cache (provider);

-- Atomic per-provider, per-month accounting. Attempted / succeeded / failed are
-- tracked separately because Phase 1's counter incremented before the request
-- and could not tell a 401 apart from a real search.
CREATE TABLE provider_usage (
  provider          TEXT NOT NULL,
  period            TEXT NOT NULL,                    -- YYYY-MM
  attempted         INTEGER NOT NULL DEFAULT 0,
  succeeded         INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  last_call_at      TEXT,
  last_success_at   TEXT,
  last_error        TEXT,
  -- Reported by the provider itself where it exposes one. Kept apart from our
  -- local estimate on purpose: the local count is an estimate, not authority.
  reported_remaining INTEGER,
  reported_limit     INTEGER,
  reported_at        TEXT,
  PRIMARY KEY (provider, period)
);

CREATE TABLE provider_health (
  provider     TEXT PRIMARY KEY,
  status       TEXT NOT NULL,                         -- ok | degraded | unconfigured | error
  detail       TEXT,
  checked_at   TEXT NOT NULL,
  latency_ms   INTEGER
);
