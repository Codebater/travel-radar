-- Phase 6: remember WHY a search happened.
--
-- §20 wants every candidate to record the discovery method that found it, so
-- that after a few weeks "is the wildcard scan worth its calls?" has an answer.
-- That fact is known at SEARCH time and nowhere else. Deriving it later from
-- the shape of the route -- "origin is BUD, so this must be positioning" --
-- would be a guess that silently becomes wrong the moment the config changes,
-- and it could never distinguish a flexible-date sample from a sparse one on
-- the same route.
--
-- So the search request carries it, and every observation already points at
-- its search request. One join, no inference.

ALTER TABLE search_requests ADD COLUMN discovery_method TEXT;
ALTER TABLE search_requests ADD COLUMN discovery_run_id INTEGER REFERENCES discovery_runs(id);
ALTER TABLE search_requests ADD COLUMN discovery_stage INTEGER;

CREATE INDEX idx_search_requests_discovery
  ON search_requests (discovery_run_id, discovery_method);
