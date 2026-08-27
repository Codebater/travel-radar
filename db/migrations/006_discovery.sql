-- Phase 6: discovery.
--
-- The fixed observer answers "what does this route usually cost?" for six
-- routes I already know I want. Discovery answers a different question:
-- "where should I be going that I would never have thought to search?"
--
-- It is a separate job type on purpose. The observer's value is a long,
-- consistent, comparable series per route; discovery's value is breadth, and
-- breadth means a different cost profile, a different cadence and a different
-- failure mode. Mixing them would compromise both.
--
-- Nothing here touches observation_jobs, flight_prices or award_prices.

-- ─── Discovery jobs ─────────────────────────────────────────────────────────

-- A job is a SCOPE, not a route: one origin group crossed with one destination
-- group over a date horizon. The engine decides which combinations inside that
-- scope are worth a call, and the sampling stage decides how many.
CREATE TABLE discovery_jobs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL UNIQUE,
  origin_group         TEXT    NOT NULL,        -- primary | positioning
  destination_group    TEXT    NOT NULL,        -- key into config destinationGroups
  horizon_days         INTEGER NOT NULL DEFAULT 180,
  trip_lengths         TEXT    NOT NULL,        -- JSON [7,10,14,21]
  cabins               TEXT    NOT NULL,        -- JSON ["economy","business"]
  frequency_hours      REAL    NOT NULL DEFAULT 24,
  jitter_minutes       INTEGER NOT NULL DEFAULT 30,
  priority             INTEGER NOT NULL DEFAULT 2,
  -- JSON per-run ceilings; a run reduces its scope rather than overrunning.
  budget               TEXT    NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  last_run_at          TEXT,
  next_run_at          TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  runs_completed       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_discovery_jobs_due ON discovery_jobs (enabled, next_run_at);

-- What one cycle actually did. The counters are separated by COST CLASS
-- (free / award / metered) rather than by provider, because that is the
-- distinction that decides whether a run was affordable.
CREATE TABLE discovery_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id               INTEGER NOT NULL REFERENCES discovery_jobs(id),
  started_at           TEXT    NOT NULL,
  completed_at         TEXT,
  scheduled_for        TEXT,
  status               TEXT    NOT NULL,        -- running | success | partial | failed | skipped_budget | dry-run
  trigger              TEXT    NOT NULL DEFAULT 'schedule',

  routes_sampled       INTEGER NOT NULL DEFAULT 0,
  date_pairs_sampled   INTEGER NOT NULL DEFAULT 0,
  stage1_searches      INTEGER NOT NULL DEFAULT 0,
  stage2_searches      INTEGER NOT NULL DEFAULT 0,
  award_searches       INTEGER NOT NULL DEFAULT 0,

  cache_hits           INTEGER NOT NULL DEFAULT 0,
  free_calls           INTEGER NOT NULL DEFAULT 0,
  award_calls          INTEGER NOT NULL DEFAULT 0,
  metered_calls        INTEGER NOT NULL DEFAULT 0,
  verification_calls   INTEGER NOT NULL DEFAULT 0,

  observations_added   INTEGER NOT NULL DEFAULT 0,
  candidates_produced  INTEGER NOT NULL DEFAULT 0,
  -- Set when a ceiling forced the run to drop planned work, so a small run is
  -- never mistaken for a quiet market.
  scope_reduced        TEXT,
  errors               TEXT,
  duration_ms          INTEGER
);

CREATE INDEX idx_discovery_runs_job ON discovery_runs (job_id, started_at);
CREATE INDEX idx_discovery_runs_started ON discovery_runs (started_at);

-- ─── Clusters ───────────────────────────────────────────────────────────────

-- Flexible-date discovery finds the same trip on three consecutive days at
-- almost the same price. Those are one opportunity, not three, and a feed that
-- shows them three times trains the reader to ignore it. The candidates stay
-- individually stored and individually judgeable; the cluster is how they are
-- PRESENTED and how one verdict can cover a family.
CREATE TABLE candidate_clusters (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_key         TEXT    NOT NULL UNIQUE,  -- deterministic identity
  type                TEXT    NOT NULL,         -- cash | award
  origin              TEXT    NOT NULL,
  destination         TEXT    NOT NULL,
  destination_group   TEXT,
  route               TEXT    NOT NULL,
  cabin               TEXT    NOT NULL,
  loyalty_program     TEXT,

  earliest_departure  TEXT    NOT NULL,
  latest_departure    TEXT    NOT NULL,
  member_count        INTEGER NOT NULL DEFAULT 0,

  best_candidate_id   INTEGER REFERENCES deal_candidates(id),
  best_score          REAL    NOT NULL,
  best_price          REAL,
  best_currency       TEXT,
  best_points         INTEGER,

  discovered_by       TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE INDEX idx_candidate_clusters_score ON candidate_clusters (best_score DESC);
CREATE INDEX idx_candidate_clusters_route ON candidate_clusters (route, cabin, type);

-- ─── Discovery metadata on candidates ───────────────────────────────────────

-- Which method found this. The whole point of recording it is to learn, after
-- a few weeks, which discovery methods earn their cost - a wildcard scan that
-- never produces a WOULD BOOK is a scan worth switching off.
ALTER TABLE deal_candidates ADD COLUMN discovered_by TEXT NOT NULL DEFAULT 'FIXED_OBSERVER';
ALTER TABLE deal_candidates ADD COLUMN discovery_run_id INTEGER REFERENCES discovery_runs(id);
ALTER TABLE deal_candidates ADD COLUMN cluster_id INTEGER REFERENCES candidate_clusters(id);
ALTER TABLE deal_candidates ADD COLUMN destination_group TEXT;

-- Positioning: the money and the inconvenience are separate columns because
-- they are separate things. true_trip_start_cost is what the trip actually
-- costs to begin; positioning_penalty is what the fare cannot express.
ALTER TABLE deal_candidates ADD COLUMN requires_positioning INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deal_candidates ADD COLUMN positioning TEXT;          -- JSON breakdown
ALTER TABLE deal_candidates ADD COLUMN positioning_penalty REAL;  -- 0..1
ALTER TABLE deal_candidates ADD COLUMN true_trip_start_cost REAL;

-- Open jaw: the return leg may land somewhere other than the origin.
ALTER TABLE deal_candidates ADD COLUMN is_open_jaw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deal_candidates ADD COLUMN open_jaw TEXT;             -- JSON legs + saving

-- Absolute rules and sanity are recorded even when they do not fire, so a
-- reader can see the rule that was applied rather than guess.
ALTER TABLE deal_candidates ADD COLUMN absolute_tier TEXT;        -- interesting | extreme | wtf
ALTER TABLE deal_candidates ADD COLUMN sanity TEXT;               -- ok | SUSPICIOUS_DATA
ALTER TABLE deal_candidates ADD COLUMN sanity_detail TEXT;
ALTER TABLE deal_candidates ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE deal_candidates ADD COLUMN trip_length_nights INTEGER;

CREATE INDEX idx_deal_candidates_discovered_by ON deal_candidates (discovered_by, score DESC);
CREATE INDEX idx_deal_candidates_cluster ON deal_candidates (cluster_id);

-- §33 WOULD_BOOK is the verdict that actually matters: "good deal" is an
-- opinion about the algorithm, "would book" is an opinion about the trip.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Every
-- existing row is carried across unchanged.
CREATE TABLE deal_feedback_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES deal_candidates(id) ON DELETE CASCADE,
  verdict      TEXT    NOT NULL CHECK (verdict IN ('GOOD_DEAL', 'NORMAL', 'BAD_SIGNAL', 'WOULD_BOOK')),
  note         TEXT,
  source       TEXT    NOT NULL DEFAULT 'ui',
  created_at   TEXT    NOT NULL
);

INSERT INTO deal_feedback_new (id, candidate_id, verdict, note, source, created_at)
  SELECT id, candidate_id, verdict, note, source, created_at FROM deal_feedback;

DROP TABLE deal_feedback;
ALTER TABLE deal_feedback_new RENAME TO deal_feedback;

CREATE INDEX idx_deal_feedback_candidate ON deal_feedback (candidate_id, created_at);
