-- Phase HA-1: HOTEL AWARD observations — append-only, provider-neutral, and
-- completely separate from cash stay observations (different product, never
-- blended; valuation against cash is a LATER phase and no column here invites
-- it early).
--
-- The load-bearing honesty rules are schema-enforced:
--   - quote_basis says what the SOURCE quoted. 'full_stay' requires a
--     source-stated points_total; 'per_night' FORBIDS one — so a nightly
--     price can never be multiplied into a stay total, by construction.
--   - taxes unknown is a STATE, never a zero.
--   - search_state records blocked/empty/incomplete outcomes honestly
--     (vocabulary informed by the getaway walker's measured states).

CREATE TABLE hotel_award_observations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key             TEXT NOT NULL,     -- provider|ref|program|check_in|nights|room|basis (hashed)

  provider               TEXT NOT NULL,     -- e.g. gondola_hotels
  provider_property_ref  TEXT NOT NULL,     -- the provider's own hotel id
  property_id            TEXT,              -- our stay_properties id ONLY via explicit refs (never name-matched)
  property_name          TEXT NOT NULL,
  chain                  TEXT,

  program                TEXT NOT NULL,     -- explicit loyalty program (config-mapped enum, else the source's own name normalized)
  source_program_name    TEXT NOT NULL,     -- exactly as the source stated it

  check_in               TEXT NOT NULL,
  check_out              TEXT NOT NULL,
  nights                 INTEGER NOT NULL,

  quote_basis            TEXT NOT NULL CHECK (quote_basis IN ('full_stay', 'per_night')),
  room_class             TEXT,              -- standard | suite | null = property-level quote (unstated)
  room_name              TEXT,

  points_total           INTEGER,           -- ONLY when the source states a stay total
  points_per_night       INTEGER,           -- ONLY when the source states it

  taxes_fees_amount      REAL,
  taxes_fees_currency    TEXT,
  taxes_fees_state       TEXT NOT NULL CHECK (taxes_fees_state IN ('stated', 'included', 'unknown')),

  award_type             TEXT NOT NULL CHECK (award_type IN ('points', 'points_plus_cash', 'unknown')),

  -- Labelled cash context from the SAME source response — context, never a
  -- valuation input (that phase does not exist yet).
  cash_comparison_amount   REAL,
  cash_comparison_currency TEXT,

  availability_state     TEXT NOT NULL CHECK (availability_state IN ('available', 'unavailable', 'unknown')),
  search_state           TEXT NOT NULL CHECK (search_state IN ('complete', 'empty', 'night_clamped', 'blocked', 'incomplete')),
  verification_level     TEXT NOT NULL,     -- cached | discovered | verified
  source_freshness       TEXT,              -- the source's own staleness statement, when it makes one

  locator_id             INTEGER REFERENCES offer_locators(id),
  raw_ref                TEXT,

  fetched_at             TEXT NOT NULL,
  created_at             TEXT NOT NULL,

  -- A stay-total exists exactly when the source quoted the stay; a per-night
  -- quote can never carry one (and must actually state the nightly price).
  CHECK ((quote_basis = 'full_stay') = (points_total IS NOT NULL)),
  CHECK (quote_basis != 'per_night' OR points_per_night IS NOT NULL)
);

CREATE INDEX idx_hao_dedupe  ON hotel_award_observations (dedupe_key, fetched_at);
CREATE INDEX idx_hao_program ON hotel_award_observations (program, check_in);
CREATE INDEX idx_hao_ref     ON hotel_award_observations (provider, provider_property_ref, check_in);
