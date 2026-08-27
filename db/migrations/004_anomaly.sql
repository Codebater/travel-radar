-- Phase 5: shadow anomaly engine + operational instrumentation.
--
-- Nothing here deletes or rewrites Phase 2–4 history. Three new concepts:
--   deal_candidates  — what the engine THINKS is exceptional (shadow only)
--   deal_feedback    — what a human thought of that decision
--   provider_events  — time-bucketed failures, so "last 24h" is answerable
--
-- plus small instrumentation columns on the existing observer tables.

-- ─── Instrumentation ────────────────────────────────────────────────────────

-- What next_run_at said when a scheduled run started. Without it "delayed run"
-- is unanswerable: started_at alone cannot say whether it was on time.
ALTER TABLE observation_runs ADD COLUMN scheduled_for TEXT;

-- Live resource picture of whichever process holds the lease. Written by the
-- heartbeat, so it is fresh exactly as long as the scheduler is alive. Cheap
-- to write, and it is the number that decides whether a DS723+ can host this.
ALTER TABLE scheduler_state ADD COLUMN rss_bytes INTEGER;
ALTER TABLE scheduler_state ADD COLUMN cpu_seconds REAL;
ALTER TABLE scheduler_state ADD COLUMN ticks INTEGER NOT NULL DEFAULT 0;

-- Failures and auth problems as EVENTS rather than monthly counters, because
-- provider_usage can say "4 failures this month" but never "in the last 24h".
-- Only failures are recorded, so this table stays small on a healthy system.
CREATE TABLE provider_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- error | auth | quota | skipped
  detail      TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_provider_events_time ON provider_events (occurred_at);
CREATE INDEX idx_provider_events_provider ON provider_events (provider, occurred_at);

-- Small key/value store for cursors and operational timestamps (anomaly
-- evaluation high-water mark, last backup). Not a config store.
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Shadow anomaly engine ──────────────────────────────────────────────────

-- One row per observation the engine judged interesting enough to record.
--
-- SHADOW MODE: `notified` exists so the schema can prove nothing was ever sent.
-- Phase 5 writes 0 to it, always. The engine has no notification code path.
--
-- Every number here is relative to OBSERVATIONS BY THIS RADAR, never to a
-- market price. `as_of` is the cut-off the baseline used — for historical
-- recomputation it is the observation's own timestamp, so a past observation
-- is never judged against prices that did not exist yet.
CREATE TABLE deal_candidates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Which observation this decision is about.
  source_table        TEXT    NOT NULL,   -- flight_prices | award_prices
  source_id           INTEGER NOT NULL,
  observed_at         TEXT    NOT NULL,   -- the observation's fetched_at
  as_of               TEXT    NOT NULL,   -- baseline cut-off (= observed_at)
  evaluated_at        TEXT    NOT NULL,   -- when the decision was computed

  type                TEXT    NOT NULL,   -- cash | award
  origin              TEXT    NOT NULL,
  destination         TEXT    NOT NULL,
  route               TEXT    NOT NULL,   -- "VIE-CUN", for grouping/reporting
  departure_date      TEXT    NOT NULL,
  return_date         TEXT,
  trip_type           TEXT    NOT NULL,   -- oneway | return
  cabin               TEXT    NOT NULL,
  airline             TEXT,
  stops               INTEGER,
  itinerary_hash      TEXT,

  loyalty_program     TEXT,               -- awards only — PROGRAM, not airline
  price_amount        REAL,
  price_currency      TEXT,
  points              INTEGER,
  taxes_amount        REAL,
  taxes_currency      TEXT,

  -- Baseline it was judged against (§L/§M comparability).
  baseline_key        TEXT    NOT NULL,
  baseline_scope      TEXT    NOT NULL,   -- strict | relaxed:<dropped dimension>
  observed_median     REAL,
  observed_minimum    REAL,
  observed_maximum    REAL,
  percent_below_median REAL,
  percentile          REAL,
  sample_size         INTEGER NOT NULL,
  baseline_confidence TEXT    NOT NULL,   -- INSUFFICIENT | VERY_LOW | LOW | MEDIUM | HIGHER
  baseline_first_at   TEXT,
  baseline_last_at    TEXT,
  baseline_age_days   REAL,

  -- §O taxes are never collapsed into points; §P CPP carries its own basis.
  cpp                 REAL,
  cpp_basis           TEXT,               -- verified | discovered | none
  cpp_confidence      TEXT,
  cash_provenance     TEXT,               -- JSON
  award_provenance    TEXT,               -- JSON
  program_comparison  TEXT,               -- JSON (§Q winners per dimension)

  provider            TEXT    NOT NULL,
  provider_confidence TEXT    NOT NULL,
  verification_level  TEXT    NOT NULL,

  score               REAL    NOT NULL,   -- EXPERIMENTAL 0-100, not truth
  score_breakdown     TEXT    NOT NULL,   -- JSON: component → {raw, weight, points}
  weights_version     TEXT    NOT NULL,
  engine_version      TEXT    NOT NULL,
  reasons             TEXT    NOT NULL,   -- JSON [{code, detail}]
  features            TEXT    NOT NULL,   -- JSON: month, weekday, tripLength, daysOut
  presets_matched     TEXT,               -- JSON ["EXTREME"] — config only, no alerts
  threshold           REAL    NOT NULL,

  mode                TEXT    NOT NULL DEFAULT 'shadow',
  status              TEXT    NOT NULL DEFAULT 'new',
  notified            INTEGER NOT NULL DEFAULT 0,   -- always 0 in Phase 5
  created_at          TEXT    NOT NULL,

  -- Re-evaluating an observation UPDATES its decision rather than adding a
  -- second one, so backfills stay idempotent and feedback stays attached.
  UNIQUE (source_table, source_id)
);

CREATE INDEX idx_deal_candidates_score   ON deal_candidates (score DESC, observed_at DESC);
CREATE INDEX idx_deal_candidates_route   ON deal_candidates (route, cabin, type);
CREATE INDEX idx_deal_candidates_created ON deal_candidates (created_at);
CREATE INDEX idx_deal_candidates_observed ON deal_candidates (observed_at);

-- Human judgment of a candidate. Append-only: changing your mind is data too,
-- and the report reads the latest verdict per candidate.
CREATE TABLE deal_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES deal_candidates(id) ON DELETE CASCADE,
  verdict      TEXT    NOT NULL CHECK (verdict IN ('GOOD_DEAL', 'NORMAL', 'BAD_SIGNAL')),
  note         TEXT,
  source       TEXT    NOT NULL DEFAULT 'ui',   -- ui | cli
  created_at   TEXT    NOT NULL
);

CREATE INDEX idx_deal_feedback_candidate ON deal_feedback (candidate_id, created_at);
