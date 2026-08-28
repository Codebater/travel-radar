-- Phase 8i: bookable offers, deep links, offer verification.
--
-- The comparison layer says WHICH construction wins; this layer preserves the
-- way BACK to the actual provider offer. Doctrine:
--   - navigation quality is an explicit, honest label: an exact deep link, a
--     reconstructable provider search, a plain landing page, or UNAVAILABLE.
--     A URL is never manufactured and a landing page is never dressed up as a
--     booking link.
--   - provider-returned URLs are preserved VERBATIM (after a domain/scheme
--     safety check); capabilities stay data, never provider-specific columns.
--   - verification is a NEW observation: a price change appends, the original
--     observation and its locator are never rewritten.

-- Provider identifiers/urls retained on new package observations (old rows
-- stay NULL — their locators fall back to search replay built from the
-- observation's own fields).
ALTER TABLE package_offer_observations ADD COLUMN provider_ids TEXT;
ALTER TABLE package_offer_observations ADD COLUMN provider_urls TEXT;

-- One locator per source observation: how to get back to this offer.
CREATE TABLE offer_locators (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL,       -- package | flight | stay
  source_table         TEXT NOT NULL,       -- package_offer_observations | flight_prices | stay_rate_observations
  source_id            INTEGER NOT NULL,
  provider             TEXT NOT NULL,       -- the SELLER/system this locator navigates to
  seller               TEXT,                -- display seller (package seller, OTA channel)
  operator             TEXT,                -- tour operator where relevant

  navigation_quality   TEXT NOT NULL,       -- EXACT_DEEP_LINK | SEARCH_REPLAY_LINK | PROVIDER_LANDING_LINK | UNAVAILABLE
  landing_url          TEXT,
  deep_link_url        TEXT,                -- provider-returned, verbatim (safety-checked)
  booking_url          TEXT,                -- a provider-supplied booking URL, when one truly exists
  search_replay_url    TEXT,                -- reconstructed provider search from known parameters
  search_replay_params TEXT NOT NULL,       -- JSON: the parameters the replay encodes (auditable)
  provider_ids         TEXT NOT NULL,       -- JSON: raw provider identifiers (offer/product/hotel/room/flight ids)
  raw_response_ref     TEXT,                -- pointer into *_raw_responses / cache, when known

  -- The product this locator points at (echo material for verification).
  origin               TEXT,
  destination          TEXT,
  outbound_date        TEXT,
  return_date          TEXT,
  check_in             TEXT,
  check_out            TEXT,
  nights               INTEGER,
  adults               INTEGER,
  children             INTEGER,
  cabin                TEXT,
  board                TEXT,
  room_class           TEXT,
  room_name            TEXT,
  transfer_status      TEXT,
  native_currency      TEXT,
  native_price         REAL,
  observed_at          TEXT NOT NULL,       -- the source observation's own clock
  expires_at           TEXT,                -- only when the provider exposes one

  created_at           TEXT NOT NULL,
  UNIQUE (source_table, source_id)
);

CREATE INDEX idx_offer_locators_kind ON offer_locators (kind, provider);

-- Append-only verification observations. The latest row per locator answers
-- "is this still real, at what price" — it NEVER touches the locator or the
-- original observation.
CREATE TABLE offer_verifications (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  locator_id           INTEGER NOT NULL REFERENCES offer_locators(id),
  status               TEXT NOT NULL,       -- verified | changed | unavailable | blocked | expired | unsupported
  observed_price       REAL,                -- what the locator recorded (for the change display)
  observed_currency    TEXT,
  current_price        REAL,                -- what the provider says NOW (null when unavailable)
  current_currency     TEXT,
  changes              TEXT NOT NULL,       -- JSON [{dimension, observed, current}] — named, never silent
  new_observation_ids  TEXT NOT NULL,       -- JSON [int]: observation rows the recheck itself produced
  detail               TEXT,
  checked_at           TEXT NOT NULL
);

CREATE INDEX idx_offer_verifications_locator ON offer_verifications (locator_id, id);
