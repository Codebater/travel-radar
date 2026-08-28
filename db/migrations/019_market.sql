-- Phase 8h: Trip Market Comparison + Cost Normalization.
--
-- The market layer makes synthetic trips and package trips HONESTLY
-- comparable: every construction gets a cost-inclusion ledger, cross-currency
-- arithmetic happens only through stored FX observations (native amounts are
-- never overwritten, conversions are reproducible by referencing the exact
-- observation used), and a monetary winner exists only at sufficient
-- confidence. UNKNOWN is never zero.

-- ─── FX observations ────────────────────────────────────────────────────────

-- Append-only. One row per fetched reference rate. provider_date is the
-- rate's ECONOMIC date (ECB reference day); fetched_at is our clock. A
-- conversion stores the id of the observation it used, so re-running the
-- arithmetic years later reproduces the same number from the same row.
CREATE TABLE fx_rate_observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency  TEXT NOT NULL,           -- ISO 4217, e.g. USD
  quote_currency TEXT NOT NULL,           -- e.g. EUR
  rate           REAL NOT NULL,           -- 1 base = rate quote
  provider       TEXT NOT NULL,           -- e.g. frankfurter_ecb
  provider_date  TEXT NOT NULL,           -- the rate's own reference date
  fetched_at     TEXT NOT NULL
);

CREATE INDEX idx_fx_pair ON fx_rate_observations (base_currency, quote_currency, id);

-- ─── Market verdicts ────────────────────────────────────────────────────────

-- Append-only, batch-scoped: every market run stamps compute_batch, current
-- views read only the newest batch per trip so superseded rows can never
-- pollute a ranking (they remain as history).
CREATE TABLE market_verdicts (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  compute_batch            TEXT NOT NULL,
  slot_key                 TEXT NOT NULL,   -- origin|property|dateFamily|nights|board|cabin|adults|comparisonCcy
  trip_id                  INTEGER NOT NULL REFERENCES trip_opportunities(id),
  trip_key                 TEXT NOT NULL,
  package_observation_id   INTEGER NOT NULL REFERENCES package_offer_observations(id),
  package_key              TEXT NOT NULL,

  comparability            TEXT NOT NULL,   -- EXACT_MATCH | CLOSE_MATCH | DESTINATION_LEVEL_ONLY | NOT_COMPARABLE
  confidence               TEXT NOT NULL,   -- HIGH | MEDIUM | LOW | INSUFFICIENT
  verdict                  TEXT NOT NULL,   -- BUILD_YOURSELF | BUY_PACKAGE | TOO_CLOSE_TO_CALL | INSUFFICIENT_COMPARABILITY
  winner                   TEXT,            -- diy | package — only at sufficient confidence
  reasons                  TEXT NOT NULL,   -- JSON [string], incl. bounded statements

  comparison_currency      TEXT NOT NULL,
  diy_known_total          REAL,            -- in comparison currency, null when not computable
  package_total            REAL,            -- in comparison currency
  absolute_difference      REAL,            -- diy − package, null unless both computable
  percent_difference       REAL,
  diy_ledger               TEXT NOT NULL,   -- JSON ledger snapshot (native amounts preserved inside)
  package_ledger           TEXT NOT NULL,
  fx_observation_ids       TEXT NOT NULL,   -- JSON [int] — exact FX rows used; [] when same-currency

  computed_at              TEXT NOT NULL
);

CREATE INDEX idx_market_verdicts_trip  ON market_verdicts (trip_id, compute_batch);
CREATE INDEX idx_market_verdicts_batch ON market_verdicts (compute_batch);

-- ─── Trip-market baseline substrate ─────────────────────────────────────────

-- Historical total-trip market prices per construction, strict dimensions in
-- the slot key. SUBSTRATE ONLY: nothing judges from this yet — maturity for a
-- "this whole vacation is 35% below normal" claim is a later phase's burden.
CREATE TABLE trip_market_observations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key             TEXT NOT NULL,
  construction         TEXT NOT NULL,      -- diy_cash | diy_award | diy_positioning | diy_open_jaw
                                           --   | package:<seller>:<operator>
  source_table         TEXT NOT NULL,      -- trip_opportunities | package_offer_observations
  source_id            INTEGER NOT NULL,
  known_total_native   REAL,               -- null when the construction has no single-currency known total
  native_currency      TEXT,
  comparison_total     REAL,               -- null when FX unavailable/stale
  comparison_currency  TEXT NOT NULL,
  fx_observation_ids   TEXT NOT NULL,      -- JSON [int]
  unknown_categories   TEXT NOT NULL,      -- JSON [string] — named, never zeroed
  observed_at          TEXT NOT NULL
);

CREATE INDEX idx_tmo_slot ON trip_market_observations (slot_key, construction, observed_at);

-- ─── Batch-scoping for the 8g comparability audit ───────────────────────────

-- package_comparisons predates batch discipline; ~2.1k verbose rows from the
-- first pre-filter run must never pollute current views. Old rows keep
-- compute_batch NULL (= superseded as soon as any stamped batch exists);
-- deletes never happen.
ALTER TABLE package_comparisons ADD COLUMN compute_batch TEXT;

CREATE INDEX idx_pkg_cmp_batch ON package_comparisons (trip_id, compute_batch);
