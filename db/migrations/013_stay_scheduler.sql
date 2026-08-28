-- Phase 8b: the Stay Radar learns to run itself, and to ask a second source.
--
-- New machinery, same doctrine as the flight scheduler: one lease, one holder,
-- runs that always close, ceilings that reduce scope and say so. The new idea
-- of this phase is the CONFIRMATION TRIGGER: a cheap broad observation
-- (Xotelo) decides whether a richer room-level source (Agoda) is worth one
-- request. A trigger is NOT an alert score — it answers "should we spend a
-- confirmation call?", nothing more. The anomaly scorer is Phase 8c.

-- ─── Scheduler lease (independent from the flight scheduler's) ──────────────

CREATE TABLE stay_scheduler_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  holder         TEXT,
  acquired_at    TEXT,
  heartbeat_at   TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0
);

-- ─── Run bookkeeping ────────────────────────────────────────────────────────

-- Counters are split three ways on purpose: transport failures (the network
-- said no), SEMANTIC errors (HTTP 200 but the API said no — a different fact
-- about a different layer), and EMPTY results (200, no error, nothing priced —
-- for a cold-cache source this means "retry later", never "dead property").
CREATE TABLE stay_observation_runs (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_index               INTEGER NOT NULL,
  started_at              TEXT NOT NULL,
  completed_at            TEXT,
  status                  TEXT NOT NULL,      -- running | success | partial | failed
  trigger                 TEXT NOT NULL,      -- cli | schedule
  properties_planned      INTEGER NOT NULL DEFAULT 0,
  rates_calls             INTEGER NOT NULL DEFAULT 0,
  calendar_calls          INTEGER NOT NULL DEFAULT 0,
  confirmation_calls      INTEGER NOT NULL DEFAULT 0,
  transport_failures      INTEGER NOT NULL DEFAULT 0,
  semantic_errors         INTEGER NOT NULL DEFAULT 0,
  empty_results           INTEGER NOT NULL DEFAULT 0,
  observations_added      INTEGER NOT NULL DEFAULT 0,
  calendar_days_added     INTEGER NOT NULL DEFAULT 0,
  triggers_fired          INTEGER NOT NULL DEFAULT 0,
  confirmations_recorded  INTEGER NOT NULL DEFAULT 0,
  scope_reduced           TEXT,               -- JSON array; every ceiling that bit
  errors                  TEXT,               -- JSON array
  duration_ms             INTEGER
);

CREATE INDEX idx_stay_runs_started ON stay_observation_runs (started_at);

-- ─── Confirmation triggers ──────────────────────────────────────────────────

-- One row per "the cheap tier saw something worth one confirmation request".
-- Append-only decision trail: skips are recorded with WHY (budget, breaker,
-- missing ref), because a silent skip is indistinguishable from a quiet market.
CREATE TABLE stay_confirmation_triggers (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id                   TEXT NOT NULL REFERENCES stay_properties(id),
  run_id                        INTEGER REFERENCES stay_observation_runs(id),
  check_in                      TEXT NOT NULL,
  check_out                     TEXT NOT NULL,
  reason                        TEXT NOT NULL,   -- CALENDAR_CHEAP | PRICE_BELOW_MEDIAN
  evidence                      TEXT NOT NULL,   -- JSON: the arithmetic, with real numbers
  status                        TEXT NOT NULL,   -- pending | confirmed | no_rates | failed
                                                 --   | skipped_budget | skipped_breaker
                                                 --   | skipped_no_ref | skipped_unconfigured
  confirming_search_request_id  INTEGER REFERENCES stay_search_requests(id),
  created_at                    TEXT NOT NULL,
  resolved_at                   TEXT
);

CREATE INDEX idx_stay_triggers_property ON stay_confirmation_triggers (property_id, check_in);
CREATE INDEX idx_stay_triggers_created  ON stay_confirmation_triggers (created_at);

-- ─── Raw response retention ─────────────────────────────────────────────────

-- Every scheduler fetch keeps its raw payload for parser-regression debugging.
-- Bounded: the store prunes to the newest N rows (config) — raw payloads are
-- diagnostics, not history; the normalized observations are the history.
CREATE TABLE stay_raw_responses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,
  kind               TEXT NOT NULL,             -- rates | calendar
  property_id        TEXT NOT NULL,
  search_request_id  INTEGER,
  payload            TEXT NOT NULL,
  fetched_at         TEXT NOT NULL
);

CREATE INDEX idx_stay_raw_fetched ON stay_raw_responses (fetched_at);

-- ─── Per-ref health memory ──────────────────────────────────────────────────

-- empty_streak: consecutive rates fetches that returned nothing priced. A
--   cold-cache source (Xotelo crawls on first request) makes a single empty
--   MEANINGLESS — only a long streak marks a ref suspect, and one success
--   resets it.
-- calendar_failures / calendar_status: some properties' calendar endpoint
--   consistently 400s while rates work. After enough consecutive semantic
--   failures the ref is marked calendar-unsupported and the scheduler stops
--   asking; a CLI reset exists for when the provider fixes it.
ALTER TABLE stay_property_refs ADD COLUMN empty_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stay_property_refs ADD COLUMN calendar_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stay_property_refs ADD COLUMN calendar_status TEXT;
