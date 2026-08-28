-- Phase 8d: discovery expansion + metered verification.
--
-- Three additions:
--   1. stay_candidates learns the FOUR-CONCEPT decomposition (relative
--      anomaly / absolute value / evidence / actionability) as first-class
--      columns, plus a verification state.
--   2. stay_verifications — one row per PAID verification decision, including
--      refusals. Every metered call must be able to answer "why did we spend
--      money on this?", so the gate reason is recorded before the request.
--   3. stay_opportunity_windows — presentation families: neighboring cheap
--      check-ins for the same product are ONE opportunity, not eight noisy
--      candidates. Rebuilt wholesale (flight-cluster style); the underlying
--      candidates and observations are never touched.

ALTER TABLE stay_candidates ADD COLUMN relative_score REAL;         -- 0..100, NULL = no baseline
ALTER TABLE stay_candidates ADD COLUMN absolute_value_score REAL;   -- 0..100, NULL = no rule
ALTER TABLE stay_candidates ADD COLUMN evidence_score REAL;         -- 0..100
ALTER TABLE stay_candidates ADD COLUMN actionability_score REAL;    -- 0..100
ALTER TABLE stay_candidates ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
  -- unverified | requested | verified | verification_failed
ALTER TABLE stay_candidates ADD COLUMN verification_gate_reason TEXT;

-- Every verification DECISION, spent or refused. Append-only.
CREATE TABLE stay_verifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id       INTEGER REFERENCES stay_candidates(id) ON DELETE SET NULL,
  opportunity_key    TEXT NOT NULL,
  property_id        TEXT NOT NULL REFERENCES stay_properties(id),
  check_in           TEXT NOT NULL,
  check_out          TEXT NOT NULL,
  gate_reason        TEXT NOT NULL,     -- RELATIVE_ANOMALY_NEAR_THRESHOLD | ABSOLUTE_VALUE_NEAR_THRESHOLD
                                        --   | ANOMALY_AND_ABSOLUTE_VALUE | SUSTAINED_CHEAP_WINDOW
                                        --   | META_AGODA_CORROBORATED
  gate_detail        TEXT NOT NULL,     -- the arithmetic behind the reason
  status             TEXT NOT NULL,     -- spent | refused_budget | refused_cooldown | failed | no_match
  search_request_id  INTEGER REFERENCES stay_search_requests(id),
  result_summary     TEXT,              -- JSON: what came back, in brief
  requested_at       TEXT NOT NULL,
  resolved_at        TEXT
);

CREATE INDEX idx_stay_verif_opportunity ON stay_verifications (opportunity_key, requested_at);
CREATE INDEX idx_stay_verif_property    ON stay_verifications (property_id);

-- Presentation only: every member candidate stays individually stored and
-- individually judgeable. Rebuilt wholesale after each evaluation.
CREATE TABLE stay_opportunity_windows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key          TEXT NOT NULL UNIQUE,   -- property|sourceClass|board|currency|firstCheckIn
  property_id         TEXT NOT NULL REFERENCES stay_properties(id),
  source_class        TEXT NOT NULL,
  board               TEXT NOT NULL,
  currency            TEXT NOT NULL,
  first_check_in      TEXT NOT NULL,
  last_check_in       TEXT NOT NULL,
  distinct_check_ins  INTEGER NOT NULL,
  span_days           INTEGER NOT NULL,
  nights_min          INTEGER NOT NULL,
  nights_max          INTEGER NOT NULL,
  persistence         TEXT NOT NULL,          -- isolated | short | sustained
  member_count        INTEGER NOT NULL,
  best_candidate_id   INTEGER REFERENCES stay_candidates(id) ON DELETE SET NULL,
  best_score          REAL NOT NULL,
  best_nightly        REAL NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_stay_windows_score ON stay_opportunity_windows (best_score DESC);
