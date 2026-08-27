-- Phase 6.5 correction: a cluster has to say whether it IS an open jaw.
--
-- The feed's open-jaw section was fetched with `discovered_by = 'OPEN_JAW'`,
-- which looked equivalent and is not. `discovered_by` records WHICH METHOD
-- SPENT THE CALL, and the open-jaw stage spends calls on ordinary one-way
-- observations - the legs. Those legs are correctly labelled OPEN_JAW (that is
-- how §20 answers "was collecting them worth it?") but a single one-way fare
-- is not an open jaw, and on the first live run they outnumbered and outscored
-- the real pairs, filling the fetch and emptying the section that exists to
-- show them.
--
-- The clustering pass already refuses to put an open jaw and a round trip in
-- one family, so every family is homogeneous and the flag is well-defined.
-- Recording it makes the fact queryable instead of inferred from a label that
-- means something else.

ALTER TABLE candidate_clusters ADD COLUMN is_open_jaw INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_candidate_clusters_open_jaw ON candidate_clusters (is_open_jaw, best_score DESC);

-- Existing rows are corrected from their own members rather than left at the
-- default: the next rebuild would fix them, but a wrong answer between now and
-- then is exactly the kind of thing nobody notices.
UPDATE candidate_clusters SET is_open_jaw = 1
WHERE id IN (
  SELECT DISTINCT cluster_id FROM deal_candidates
  WHERE cluster_id IS NOT NULL AND is_open_jaw = 1
);
