-- Phase 8e: tax-basis comparability + richer opportunity windows.
--
-- The 8d finding this fixes: SerpAPI's tax-INCLUSIVE rows joined Xotelo's
-- tax-UNKNOWN rows in one meta baseline and lifted Lily Beach's median from
-- ~953 to ~1079 — a silent upward bias on every pre-tax meta quote's
-- relative score. Tax status becomes a HARD baseline dimension, and an
-- explicit before-tax nightly is stored where a provider genuinely states
-- one (tax-inclusive price minus its stated tax) — derived, never estimated.

-- Stored ONLY when the provider stated both the inclusive price and the tax:
-- before_tax_nightly = nightly − stated per-night taxes. NULL everywhere else.
ALTER TABLE stay_rate_observations ADD COLUMN before_tax_nightly REAL;

-- Windows learn what a Trip Composer will actually need: the cheapest member
-- (not just the best-scoring one) and the persistence evidence behind the
-- classification.
ALTER TABLE stay_opportunity_windows ADD COLUMN cheapest_nightly REAL;
ALTER TABLE stay_opportunity_windows ADD COLUMN cheapest_candidate_id INTEGER REFERENCES stay_candidates(id) ON DELETE SET NULL;
ALTER TABLE stay_opportunity_windows ADD COLUMN evidence TEXT;   -- JSON: member check-ins, price range, tax status mix
