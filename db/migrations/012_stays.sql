-- Phase 8a: the Stay Radar foundation.
--
-- Same discipline as flights, different unit of observation. A flight
-- observation is (route x date x cabin); a stay observation is
-- (property x check-in x nights x occupancy x board). Everything else carries
-- over: history is append-only, decisions come later and reference
-- observations, and no provider name is load-bearing anywhere in the schema —
-- every external source is replaceable (Xotelo may vanish, Agoda may block,
-- LiteAPI may revoke, SerpAPI costs money), so provider identity is DATA on a
-- row, never structure.
--
-- ─── Luxury Universe vs Active Observation Set ──────────────────────────────
--
-- stay_properties is the UNIVERSE: every property interesting enough to have a
-- row, eventually hundreds. Observation is budget-limited, so only the subset
-- with active = 1 (the Active Observation Set) is ever scheduled. The metadata
-- columns (priority, luxury_tier, all_inclusive, typical_stay_nights,
-- destination_group, nearest_airports) exist so a LATER phase can promote and
-- demote membership on evidence; no automatic promotion logic exists yet, and
-- in Phase 8a the config file is the only thing that flips `active`.
--
-- ─── Price semantics ────────────────────────────────────────────────────────
--
-- The single most dangerous number in hotel data is a teaser. price_basis
-- records what a number actually IS (lead_in | nightly_room | stay_room |
-- stay_total) and taxes_fees records what it contains. A lead-in is stored —
-- it is still an observation — but nothing downstream may treat it as a
-- bookable total, and baselines exclude it. Suspicious rows are flagged via
-- `sanity`, kept visible, and excluded from every later baseline — discarding
-- would hide a provider that has begun producing garbage.

-- ─── The universe ───────────────────────────────────────────────────────────

CREATE TABLE stay_properties (
  id                   TEXT PRIMARY KEY,           -- canonical slug, e.g. "soneva-fushi"
  name                 TEXT NOT NULL,
  destination_group    TEXT NOT NULL,              -- e.g. maldives | thailand-beach | riviera-maya
  country              TEXT NOT NULL,
  region               TEXT,
  nearest_airports     TEXT NOT NULL,              -- JSON array of IATA codes (Trip Composer hook)
  luxury_tier          TEXT NOT NULL,              -- ultra | luxury | upper
  -- Whether the property can be bought all-inclusive, and what a bare price
  -- most plausibly means there:  only | available | none | unknown
  all_inclusive        TEXT NOT NULL,
  default_board        TEXT NOT NULL,              -- board a bare rate most likely includes
  typical_stay_nights  TEXT NOT NULL,              -- JSON array, e.g. [5,7]
  priority             INTEGER NOT NULL DEFAULT 5, -- 1 = most interesting
  active               INTEGER NOT NULL DEFAULT 0, -- Active Observation Set membership
  notes                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_stay_properties_active ON stay_properties (active, priority);
CREATE INDEX idx_stay_properties_group  ON stay_properties (destination_group);

-- One property has one identity PER PROVIDER. Providers come and go; the
-- canonical id does not. verified_at records the last time this ref actually
-- returned data, so a rotted ref is detectable without a join through history.
CREATE TABLE stay_property_refs (
  property_id  TEXT NOT NULL REFERENCES stay_properties(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  ref          TEXT NOT NULL,
  verified_at  TEXT,
  PRIMARY KEY (property_id, provider)
);

-- ─── Observations ───────────────────────────────────────────────────────────

-- One row per search we issued. Observations reference it so that same-search
-- siblings can be excluded from baselines by id, never by timestamp — the
-- flight engine's sibling-exclusion rule, carried over verbatim.
CREATE TABLE stay_search_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id  TEXT NOT NULL REFERENCES stay_properties(id),
  kind         TEXT NOT NULL,                     -- rates | calendar
  check_in     TEXT,                              -- null for calendar requests
  check_out    TEXT,
  adults       INTEGER NOT NULL DEFAULT 2,
  children     INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL,
  source       TEXT NOT NULL,                     -- cli | observer | test
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_stay_sr_property ON stay_search_requests (property_id, created_at);

-- Append-only. Never updated, never deleted — this is the history the anomaly
-- engine will baseline against. Re-observing the same stay writes a NEW row.
CREATE TABLE stay_rate_observations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id            TEXT NOT NULL REFERENCES stay_properties(id),
  provider               TEXT NOT NULL,
  provider_property_ref  TEXT NOT NULL,

  check_in               TEXT NOT NULL,           -- YYYY-MM-DD
  check_out              TEXT NOT NULL,
  nights                 INTEGER NOT NULL,
  adults                 INTEGER NOT NULL,
  children               INTEGER NOT NULL,

  room_name              TEXT,                    -- provider's own words, unmodified
  room_class             TEXT,                    -- entry | premium | suite | villa | unknown
  board                  TEXT NOT NULL,           -- room_only | breakfast | half_board | full_board | all_inclusive | unknown
  board_source           TEXT NOT NULL,           -- structured | property_default | unknown
  refundable             INTEGER,                 -- tri-state: 1 | 0 | NULL unknown
  cancellation_deadline  TEXT,

  rate_source            TEXT,                    -- the OTA/channel quoted, e.g. "Booking.com"
  source_class           TEXT NOT NULL,           -- meta | retail | bedbank | official | unknown
  price_amount           REAL NOT NULL,
  price_currency         TEXT NOT NULL,
  price_basis            TEXT NOT NULL,           -- lead_in | nightly_room | stay_room | stay_total
  taxes_fees             TEXT NOT NULL,           -- included | excluded | partial | unknown
  taxes_fees_amount      REAL,

  verification_level     TEXT NOT NULL,           -- discovered | confirmed | verified
  confidence             TEXT NOT NULL,           -- high | medium | low
  provider_as_of         TEXT,                    -- provider's own data timestamp, when it reports one
  sanity                 TEXT NOT NULL DEFAULT 'ok',  -- ok | SUSPICIOUS_DATA
  sanity_detail          TEXT,

  fetched_at             TEXT NOT NULL,
  search_request_id      INTEGER REFERENCES stay_search_requests(id)
);

CREATE INDEX idx_stay_rates_property_date ON stay_rate_observations (property_id, check_in, board);
CREATE INDEX idx_stay_rates_fetched       ON stay_rate_observations (fetched_at);
CREATE INDEX idx_stay_rates_provider      ON stay_rate_observations (provider, fetched_at);

-- Day-class calendar observations (e.g. a heatmap endpoint classifying each
-- forward date as cheap/average/high for one property). Not a price — a
-- provider's own opinion of one. Append-only for the same reason as rates:
-- a class FLIP over time is exactly the discovery trigger.
CREATE TABLE stay_calendar_observations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id            TEXT NOT NULL REFERENCES stay_properties(id),
  provider               TEXT NOT NULL,
  provider_property_ref  TEXT NOT NULL,
  stay_date              TEXT NOT NULL,            -- the classified date
  day_class              TEXT NOT NULL,            -- cheap | average | high
  fetched_at             TEXT NOT NULL,
  search_request_id      INTEGER REFERENCES stay_search_requests(id)
);

CREATE INDEX idx_stay_cal_property_date ON stay_calendar_observations (property_id, stay_date, fetched_at);
