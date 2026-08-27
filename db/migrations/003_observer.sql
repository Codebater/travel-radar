-- Phase 4: the observer — scheduled baseline observation collection.
--
-- observation_jobs   what to watch (route, cabins, providers, cadence)
-- observation_runs   what actually happened each time (auditable history)
-- scheduler_state    single-row lease so two schedulers never run jobs twice

CREATE TABLE observation_jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL UNIQUE,   -- e.g. "PRG-BKK"
  origin                TEXT    NOT NULL,
  destination           TEXT    NOT NULL,
  cabins                TEXT    NOT NULL,          -- JSON: ["economy","business"]
  cash_providers        TEXT    NOT NULL,          -- JSON: ["fast_flights"]
  award_providers       TEXT    NOT NULL,          -- JSON: ["roame"] — ATF excluded from schedules by default (5 calls/search of 150/mo)
  priority              INTEGER NOT NULL DEFAULT 2,       -- 1 = highest
  frequency_hours       REAL    NOT NULL DEFAULT 84,      -- ~twice weekly
  jitter_minutes        INTEGER NOT NULL DEFAULT 45,
  -- JSON: { horizonDays, firstDepartureOffsetDays, stepDays, tripLengths[],
  --         datesPerRun, awardEveryNRuns }
  date_strategy         TEXT    NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  last_run_at           TEXT,
  next_run_at           TEXT,
  -- Backoff bookkeeping: 3+ consecutive failures stretch the cadence;
  -- persistent auth failures skip the provider rather than hammering it.
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  runs_completed        INTEGER NOT NULL DEFAULT 0        -- drives date-grid rotation
);

CREATE INDEX idx_observation_jobs_due ON observation_jobs (enabled, next_run_at);

CREATE TABLE observation_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES observation_jobs(id),
  started_at         TEXT    NOT NULL,
  completed_at       TEXT,
  -- running | success | partial | failed | skipped_auth | skipped_budget | dry-run
  status             TEXT    NOT NULL,
  trigger            TEXT    NOT NULL DEFAULT 'schedule', -- schedule | manual | dry-run
  searches_run       INTEGER NOT NULL DEFAULT 0,
  provider_calls     INTEGER NOT NULL DEFAULT 0,          -- live external fetches/quota calls
  cache_hits         INTEGER NOT NULL DEFAULT 0,
  observations_added INTEGER NOT NULL DEFAULT 0,
  errors             TEXT,                                 -- JSON array of strings
  duration_ms        INTEGER
);

CREATE INDEX idx_observation_runs_job ON observation_runs (job_id, started_at);
CREATE INDEX idx_observation_runs_started ON observation_runs (started_at);

-- Single-row lease. A scheduler owns observation scheduling only while its
-- heartbeat is fresh; a crashed holder's stale lease is taken over. No Redis —
-- SQLite transactions are plenty for one machine, and Docker later guarantees
-- a single scheduler container.
CREATE TABLE scheduler_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  holder         TEXT    NOT NULL,           -- pid@host:token (no secrets)
  acquired_at    TEXT    NOT NULL,
  heartbeat_at   TEXT    NOT NULL,
  stop_requested INTEGER NOT NULL DEFAULT 0  -- observer:stop sets this; the loop obeys
);
