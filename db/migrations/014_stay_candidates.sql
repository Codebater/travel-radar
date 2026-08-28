-- Phase 8c: the Stay Radar forms opinions.
--
-- One decision per rate observation, exactly the flight engine's shape:
-- UNIQUE(source_id) so re-evaluation UPSERTS and backfills stay idempotent.
-- The source row (stay_rate_observations) is append-only and never re-minted,
-- so — unlike the flight side's churning cluster/pair ids — source_id here IS
-- durable. opportunity_key is still derived and stored, because the thing a
-- future notification layer must recognise is the OPPORTUNITY (property ×
-- date-family × product), which many observations will share over time.
--
-- No notification fields. This table states opinions; interrupting a person
-- is a different phase with its own gates.

CREATE TABLE stay_candidates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- identity
  source_id             INTEGER NOT NULL UNIQUE REFERENCES stay_rate_observations(id),
  opportunity_key       TEXT NOT NULL,      -- derived, price-free: see stays/identity.ts
  property_id           TEXT NOT NULL REFERENCES stay_properties(id),
  observed_at           TEXT NOT NULL,      -- the observation's fetched_at
  as_of                 TEXT NOT NULL,      -- baseline cutoff actually used
  evaluated_at          TEXT NOT NULL,

  -- the stay and the product
  check_in              TEXT NOT NULL,
  check_out             TEXT NOT NULL,
  nights                INTEGER NOT NULL,
  adults                INTEGER NOT NULL,
  children              INTEGER NOT NULL,
  room_name             TEXT,
  room_class            TEXT,
  board                 TEXT NOT NULL,
  board_source          TEXT NOT NULL,
  source_class          TEXT NOT NULL,
  rate_source           TEXT,
  provider              TEXT NOT NULL,
  verification_level    TEXT NOT NULL,      -- discovered | confirmed | verified

  -- economics (nightly is the comparison unit; the stay total is derived and
  -- stored so a reader never multiplies a teaser by nights themselves)
  nightly_amount        REAL NOT NULL,
  stay_total            REAL,
  price_currency        TEXT NOT NULL,
  taxes_fees            TEXT NOT NULL,

  -- baseline block (NULLs mean "no baseline could be built", never zero)
  baseline_key          TEXT,
  baseline_scope        TEXT,               -- strict | any-length | no-history
  sample_size           INTEGER NOT NULL DEFAULT 0,
  observed_median       REAL,
  observed_minimum      REAL,
  percentile            REAL,
  percent_below_median  REAL,
  baseline_first_at     TEXT,
  baseline_last_at      TEXT,
  baseline_age_days     REAL,
  baseline_confidence   TEXT NOT NULL,      -- INSUFFICIENT | VERY_LOW | LOW | MEDIUM | HIGHER

  -- absolute rules
  absolute_tier         TEXT,               -- wtf | extreme | interesting | NULL
  absolute_rule_path    TEXT NOT NULL,      -- e.g. "maldives.all_inclusive.luxury" or "none"

  -- evidence (cross-source facts as data, never blended into one number)
  confirmation_state    TEXT NOT NULL,      -- meta_only | retail_confirmed | retail
  evidence              TEXT NOT NULL,      -- JSON: the facts, with real numbers

  -- decision
  score                 REAL NOT NULL,
  score_breakdown       TEXT NOT NULL,      -- JSON: every component incl. dropped ones
  reasons               TEXT NOT NULL,      -- JSON array of human-readable codes
  threshold             REAL NOT NULL,
  status                TEXT NOT NULL,      -- candidate | below_threshold | suspicious
  sanity                TEXT NOT NULL,
  engine_version        TEXT NOT NULL,
  weights_version       TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_stay_cand_score    ON stay_candidates (status, score DESC);
CREATE INDEX idx_stay_cand_property ON stay_candidates (property_id, check_in);
CREATE INDEX idx_stay_cand_opportunity ON stay_candidates (opportunity_key);
