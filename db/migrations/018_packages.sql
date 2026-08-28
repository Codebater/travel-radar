-- Phase 8g: the package tier. Tour-operator flight+hotel bundles become
-- FIRST-CLASS competing trip constructions: the radar's question is now
-- BUILD YOURSELF vs BUY PACKAGE, quantified only when comparability is
-- strong enough to make the number honest.
--
-- Same doctrine as flights and stays, one new subtlety: a package price is a
-- SEALED TOTAL for a whole product (flights + hotel + board + sometimes
-- transfer). Its inclusions are part of its identity — a package with the
-- transfer included and a self-built trip with the transfer unknown are NOT
-- the same product, and the comparison layer must say so instead of claiming
-- a saving.
--
-- Provider usage/health deliberately reuses the generic provider_usage and
-- provider_events tables (provider identity is data, never structure); this
-- migration adds only what is package-shaped.

-- One row per search we issued against a package seller. Observations
-- reference it so same-search siblings are excluded by id, never timestamp
-- (the sibling-exclusion rule, carried over verbatim). kind:
--   calendar     — Tier 0 broad seasonal sweep (one call, many check-in dates)
--   offers       — Tier 1 dated detail for one property window
--   confirmation — Tier 2 cross-seller confirmation (CHECK24-style)
CREATE TABLE package_search_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  property_id  TEXT REFERENCES stay_properties(id),   -- null for region sweeps
  origin       TEXT NOT NULL,                          -- departure airport (IATA)
  range_start  TEXT,                                   -- calendar window, or check-in
  range_end    TEXT,
  nights       INTEGER,
  adults       INTEGER NOT NULL DEFAULT 2,
  children     INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL,
  source       TEXT NOT NULL,                          -- cli | observer | test
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_pkg_sr_provider_day ON package_search_requests (provider, created_at);
CREATE INDEX idx_pkg_sr_property     ON package_search_requests (property_id, created_at);

-- Append-only. Never updated, never deleted. Re-observing the same package
-- writes a NEW row; "latest" is per-key MAX(id), never a timestamp equality.
CREATE TABLE package_offer_observations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  package_key            TEXT NOT NULL,      -- price-free identity, packages/identity.ts
  provider               TEXT NOT NULL,      -- the SELLER (tui_packages | check24_packages)
  tour_operator          TEXT,               -- the organizer behind the seller, when stated
  property_id            TEXT REFERENCES stay_properties(id),  -- null: hotel not in our universe
  provider_property_ref  TEXT NOT NULL,      -- giata id / seller-native hotel id
  giata_id               INTEGER,            -- universal hotel join key, when known
  hotel_name             TEXT,               -- seller's own words

  origin                 TEXT NOT NULL,
  destination_airport    TEXT,
  destination_region     TEXT,

  check_in               TEXT NOT NULL,      -- HOTEL nights, the comparable unit
  check_out              TEXT NOT NULL,
  nights                 INTEGER NOT NULL,
  trip_departure         TEXT,               -- when the traveller leaves home
  trip_return            TEXT,               -- when the traveller starts home
  trip_days              INTEGER,            -- door-to-door days, when derivable
  adults                 INTEGER NOT NULL,
  children               INTEGER NOT NULL,

  room_name              TEXT,
  room_class             TEXT,               -- entry | premium | suite | villa | unknown
  board                  TEXT NOT NULL,      -- stays vocabulary; AI ≠ HB, ever
  board_source           TEXT NOT NULL,
  cabin                  TEXT NOT NULL,      -- economy | premium_economy | business | first | unknown
  flight_segments        TEXT NOT NULL,      -- JSON {outbound:[…],return:[…]} — actual flights
  flight_price_pp        REAL,               -- ONLY when the seller genuinely split it
  hotel_price_pp         REAL,
  price_split_source     TEXT NOT NULL,      -- provider | absent (a split is never derived)

  baggage_status         TEXT NOT NULL,      -- included | not_included | unknown
  transfer_status        TEXT NOT NULL,      -- included | not_included | unknown
  cancellation           TEXT NOT NULL,      -- refundable | nonrefundable | unknown

  total_price            REAL NOT NULL,      -- the authoritative package price
  price_per_person       REAL,
  currency               TEXT NOT NULL,
  taxes_fees             TEXT NOT NULL,      -- included | excluded | partial | unknown
  unknown_inclusions     TEXT NOT NULL,      -- JSON [string]: named, never zeroed

  verification_level     TEXT NOT NULL,      -- discovered | confirmed | verified
  confidence             TEXT NOT NULL,
  sanity                 TEXT NOT NULL DEFAULT 'ok',
  sanity_detail          TEXT,

  fetched_at             TEXT NOT NULL,
  search_request_id      INTEGER REFERENCES package_search_requests(id)
);

CREATE INDEX idx_pkg_obs_key           ON package_offer_observations (package_key, id);
CREATE INDEX idx_pkg_obs_property_date ON package_offer_observations (property_id, check_in, board);
CREATE INDEX idx_pkg_obs_fetched       ON package_offer_observations (fetched_at);

-- Raw payload capture for parser-regression fixtures, mirroring stay_raw_responses.
CREATE TABLE package_raw_responses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,
  kind               TEXT NOT NULL,
  property_id        TEXT,
  search_request_id  INTEGER,
  payload            TEXT NOT NULL,
  fetched_at         TEXT NOT NULL
);

CREATE INDEX idx_pkg_raw_fetched ON package_raw_responses (fetched_at);

-- The BUILD-vs-BUY record. Append-only: each evaluation writes a new row, so
-- the verdict's own history is auditable as prices move. Every verdict stores
-- WHY — the comparability level's reasons and the verdict's reasons — because
-- "package cheaper" without "…for a 4-night product against your 5-night trip"
-- is exactly the dishonesty this table exists to prevent.
CREATE TABLE package_comparisons (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id                  INTEGER NOT NULL REFERENCES trip_opportunities(id),
  trip_key                 TEXT NOT NULL,
  package_observation_id   INTEGER NOT NULL REFERENCES package_offer_observations(id),
  package_key              TEXT NOT NULL,

  comparability            TEXT NOT NULL,   -- EXACT_MATCH | CLOSE_MATCH | DESTINATION_LEVEL_ONLY | NOT_COMPARABLE
  comparability_reasons    TEXT NOT NULL,   -- JSON [string]
  verdict                  TEXT NOT NULL,   -- BUILD_YOURSELF | BUY_PACKAGE | ROUGH_CONTEXT_ONLY
                                            --   | INSUFFICIENT_COMPARABILITY | UNKNOWN_COSTS_PREVENT_VERDICT
  verdict_reasons          TEXT NOT NULL,   -- JSON [string]

  synthetic_total          REAL,            -- trip's known cash total (single-currency only)
  synthetic_currency       TEXT,
  package_total            REAL NOT NULL,
  package_currency         TEXT NOT NULL,
  known_difference         REAL,            -- synthetic − package, same currency only
  known_difference_pct     REAL,
  winner                   TEXT,            -- diy | package — only on decisive verdicts

  computed_at              TEXT NOT NULL
);

CREATE INDEX idx_pkg_cmp_trip    ON package_comparisons (trip_id, id);
CREATE INDEX idx_pkg_cmp_verdict ON package_comparisons (verdict, computed_at);
