-- Phase 6.5: open jaw becomes a real discovery method.
--
-- Until now `deal_candidates.is_open_jaw` was a write-only zero. Both
-- evaluation sites hard-coded it false, `findOpenJaws` had exactly one caller
-- (a manual CLI command), and the reason code, the clustering split and the
-- detail panel it fed were all unreachable. The schema claimed a capability
-- the engine did not have.
--
-- The missing piece was identity. An ordinary candidate is a decision ABOUT
-- ONE OBSERVATION - deal_candidates is unique on (source_table, source_id) and
-- every row points at one flight_prices or award_prices id. An open jaw is a
-- decision about TWO observations, and there was nothing for it to point at.
--
-- So a pair gets a row of its own. It is not a fare and does not pretend to
-- be: it is the STATEMENT that two specific one-way observations can be flown
-- as one trip, with both leg ids kept as foreign keys so provenance is a join
-- rather than a copy. A candidate then points at the pair the same way every
-- other candidate points at its observation, which means the upsert, the
-- withdrawal path, feedback and clustering all work unchanged.

CREATE TABLE open_jaw_pairs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Deterministic identity: the two leg ids. Re-deriving the same combination
  -- tomorrow updates this row rather than adding a second one.
  pair_key              TEXT    NOT NULL UNIQUE,

  -- The legs themselves. NEVER denormalised away: the price a candidate quotes
  -- must be traceable to the exact observation that produced it, and a copied
  -- number cannot be.
  outbound_price_id     INTEGER NOT NULL REFERENCES flight_prices(id) ON DELETE CASCADE,
  inbound_price_id      INTEGER NOT NULL REFERENCES flight_prices(id) ON DELETE CASCADE,

  -- Denormalised for querying and for the feed. Every one of these is derived
  -- from the two rows above and is refreshed whenever the pair is re-derived.
  outbound_origin       TEXT    NOT NULL,
  outbound_destination  TEXT    NOT NULL,
  outbound_departure    TEXT    NOT NULL,
  outbound_price        REAL    NOT NULL,
  inbound_origin        TEXT    NOT NULL,
  inbound_destination   TEXT    NOT NULL,
  inbound_departure     TEXT    NOT NULL,
  inbound_price         REAL    NOT NULL,

  cabin                 TEXT    NOT NULL,
  currency              TEXT    NOT NULL,
  total_price           REAL    NOT NULL,
  destination_group     TEXT,
  trip_length_nights    INTEGER NOT NULL,

  -- §6 the comparison, with the row it came from. NULL comparator is a real
  -- and reportable state, not a zero.
  comparable_round_trip REAL,
  comparator_price_id   INTEGER REFERENCES flight_prices(id) ON DELETE SET NULL,
  comparator_route      TEXT,
  saving                REAL,
  saving_percent        REAL,

  -- §7 the part a fare cannot express: getting between two destination cities,
  -- and home from the wrong home airport.
  transfer_cost         REAL    NOT NULL DEFAULT 0,
  net_saving            REAL,
  friction              REAL    NOT NULL DEFAULT 0,
  usefulness            REAL    NOT NULL DEFAULT 0,

  discovery_run_id      INTEGER REFERENCES discovery_runs(id),
  first_seen_at         TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX idx_open_jaw_pairs_legs ON open_jaw_pairs (outbound_price_id, inbound_price_id);
CREATE INDEX idx_open_jaw_pairs_route ON open_jaw_pairs (outbound_origin, outbound_destination, cabin);

-- §20 what open-jaw support actually costs, per run, in the same row as every
-- other cost class. A capability whose price is not recorded cannot be judged.
ALTER TABLE discovery_runs ADD COLUMN open_jaw_leg_searches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_runs ADD COLUMN open_jaw_candidates   INTEGER NOT NULL DEFAULT 0;

-- The feed and the clustering split both filter on this.
CREATE INDEX idx_deal_candidates_open_jaw ON deal_candidates (is_open_jaw, score DESC);
