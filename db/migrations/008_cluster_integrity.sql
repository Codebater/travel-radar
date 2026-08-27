-- Phase 6 correction: cluster references and the sanity default.
--
-- Two defects found by an adversarial review, both of which only appear on a
-- populated database and so were invisible in a fresh one.
--
-- 1. candidate_clusters.best_candidate_id referenced deal_candidates with no
--    ON DELETE action. Phase 5 added a withdrawal path (a re-evaluation that
--    can no longer make a decision deletes it), so withdrawing a candidate that
--    happened to represent a family now fails with a foreign-key error and
--    aborts the evaluation.
--
--    ON DELETE SET NULL is right rather than CASCADE: the family still exists
--    and its other members are still real, so deleting them all because the
--    representative went would destroy far more than it fixed. The next
--    rebuild picks a new representative.
--
-- 2. `sanity` was added without a default, so every candidate decided before
--    Phase 6 carries NULL - and every query that filters `sanity = 'ok'`
--    (clustering, the feed) silently excluded the entire pre-Phase-6 history.

UPDATE deal_candidates SET sanity = 'ok' WHERE sanity IS NULL;

-- Every membership pointer is cleared before the old table is dropped.
-- deal_candidates.cluster_id references candidate_clusters(id), so with
-- foreign keys enforced the DROP below fails outright while any row still
-- points at it - which is the same class of defect this migration exists to
-- fix, met while fixing it. The next rebuild repopulates the memberships.
UPDATE deal_candidates SET cluster_id = NULL;

CREATE TABLE candidate_clusters_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_key         TEXT    NOT NULL UNIQUE,
  type                TEXT    NOT NULL,
  origin              TEXT    NOT NULL,
  destination         TEXT    NOT NULL,
  destination_group   TEXT,
  route               TEXT    NOT NULL,
  cabin               TEXT    NOT NULL,
  loyalty_program     TEXT,

  earliest_departure  TEXT    NOT NULL,
  latest_departure    TEXT    NOT NULL,
  member_count        INTEGER NOT NULL DEFAULT 0,

  best_candidate_id   INTEGER REFERENCES deal_candidates(id) ON DELETE SET NULL,
  best_score          REAL    NOT NULL,
  best_price          REAL,
  best_currency       TEXT,
  best_points         INTEGER,

  discovered_by       TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

INSERT INTO candidate_clusters_new
  SELECT id, cluster_key, type, origin, destination, destination_group, route, cabin,
         loyalty_program, earliest_departure, latest_departure, member_count,
         best_candidate_id, best_score, best_price, best_currency, best_points,
         discovered_by, created_at, updated_at
  FROM candidate_clusters;

DROP TABLE candidate_clusters;
ALTER TABLE candidate_clusters_new RENAME TO candidate_clusters;

CREATE INDEX idx_candidate_clusters_score ON candidate_clusters (best_score DESC);
CREATE INDEX idx_candidate_clusters_route ON candidate_clusters (route, cabin, type);
