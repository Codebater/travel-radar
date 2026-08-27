-- Phase 7: the radar is allowed to interrupt a person.
--
-- Everything before this phase was read-only from the operator's point of view:
-- the engine formed opinions and wrote them down, and somebody chose when to
-- look. An alert is different in kind. It spends attention, which is the one
-- budget in this project that cannot be topped up, and a system that spends it
-- badly gets muted - after which every later alert is worthless too.
--
-- So these tables are built around one question: WHY was this sent, or why was
-- it not? Three tables because there are three different lifetimes:
--
--   notifications        what was actually delivered. Permanent. The baseline a
--                        re-alert is measured against.
--   notification_queue   what is waiting, and what happened to each attempt.
--                        Transient, with a state machine.
--   notification_events  the decision trail, including every silence. This is
--                        the table that lets an operator tell "the radar
--                        decided" from "the radar is broken".
--
-- ─── The identity problem, which is the whole design ────────────────────────
--
-- The obvious keys are all unusable, and each was measured on the live database
-- rather than assumed:
--
--   cluster_id     rebuildClusters does DELETE + re-INSERT into an AUTOINCREMENT
--                  pk on every discovery run: 1,503 live rows behind sequence
--                  16,275. It is also NULL for any open jaw assembled after the
--                  rebuild in a tick.
--   candidate_id   sequence 36,190 for 4,928 rows.
--   open_jaw pair  pair_key is "<outboundPriceId>:<inboundPriceId>", so
--                  re-observing either leg mints a new pair, a new source_id and
--                  a new candidate for an IDENTICAL trip: sequence 226 for 10
--                  surviving rows.
--   any timestamp  evaluateOpenJaws has no cursor and re-derives every pair
--                  every tick, so a timestamp in the key mints a new identity
--                  once a minute, forever.
--
-- Hence three derived keys, each with one job:
--
--   opportunity_key  the trip, without its price. Survives re-pricing, so a
--                    re-alert can find what it is improving on.
--   fingerprint      the trip WITH its (bucketed) economics. Dedup: same thing,
--                    unchanged, never speaks twice.
--   cooldown_key     the route, without dates or price. Stops one volatile
--                    route owning the whole daily allowance.
--
-- Economics are stored as first-class COLUMNS rather than only inside the
-- fingerprint, because re-alert compares NUMBERS to numbers. Comparing keys
-- cannot work: the fingerprint changes by construction the moment the price
-- does, so the old one never matches and every improvement would look like a
-- brand-new opportunity.
--
-- No column in any of these tables may ever hold an ntfy server, topic, token
-- or publish URL. On public ntfy the topic IS the password.

-- ─── What was delivered ─────────────────────────────────────────────────────

CREATE TABLE notifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint         TEXT    NOT NULL,
  opportunity_key     TEXT    NOT NULL,
  cooldown_key        TEXT    NOT NULL,
  kind                TEXT    NOT NULL,   -- immediate | digest | bypass | test
  channel             TEXT    NOT NULL,

  -- SET NULL, never CASCADE: a withdrawn candidate must not erase the record of
  -- what was said about it. "Why was I told about this?" outlives the row.
  candidate_id        INTEGER REFERENCES deal_candidates(id) ON DELETE SET NULL,
  -- Forensic only. Never joined through - see the churn note above.
  cluster_id_at_send  INTEGER,

  type                TEXT    NOT NULL,
  route               TEXT    NOT NULL,
  cabin               TEXT    NOT NULL,
  loyalty_program     TEXT,
  currency            TEXT,
  price_amount        REAL,
  points              INTEGER,
  taxes_amount        REAL,
  -- What the trip really costs to begin: true_trip_start_cost for a positioning
  -- trip, the all-in total for an open jaw, the fare otherwise.
  effective_cost      REAL,
  open_jaw_total      REAL,               -- total_price + transfer_cost, COMBINED
  open_jaw_net_saving REAL,
  open_jaw_comparator REAL,

  score               REAL    NOT NULL,
  verification_status TEXT    NOT NULL,
  baseline_confidence TEXT    NOT NULL,
  sample_size         INTEGER NOT NULL DEFAULT 0,

  -- The Prague calendar date of the send. Stored rather than recomputed: a
  -- precomputed UTC window is wrong twice a year, and this process runs for
  -- weeks at a time.
  local_day           TEXT    NOT NULL,
  digest_slot         TEXT,               -- Prague date of the slot, digests only
  priority            INTEGER NOT NULL,
  -- The channel's own message id. NEVER a URL.
  delivery_reference  TEXT,
  payload_version     INTEGER NOT NULL DEFAULT 1,
  queue_id            INTEGER,
  sent_at             TEXT    NOT NULL
);

-- The dedup guarantee, enforced by storage rather than by remembering to check.
CREATE UNIQUE INDEX idx_notifications_fingerprint ON notifications (fingerprint);
CREATE INDEX idx_notifications_opportunity ON notifications (opportunity_key, sent_at DESC);
CREATE INDEX idx_notifications_cooldown    ON notifications (cooldown_key, sent_at DESC);
CREATE INDEX idx_notifications_day         ON notifications (local_day, kind);
-- One digest per morning, however many times the pass runs.
CREATE UNIQUE INDEX idx_notifications_digest_slot
  ON notifications (digest_slot) WHERE kind = 'digest';

-- ─── What is waiting ────────────────────────────────────────────────────────

CREATE TABLE notification_queue (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint      TEXT    NOT NULL,
  opportunity_key  TEXT    NOT NULL,
  cooldown_key     TEXT    NOT NULL,
  candidate_id     INTEGER REFERENCES deal_candidates(id) ON DELETE SET NULL,
  kind             TEXT    NOT NULL,   -- immediate | digest | bypass
  -- QUEUED CLAIMED SENDING SENT FAILED CANCELLED SUPPRESSED UNKNOWN
  status           TEXT    NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 3,
  scheduled_for    TEXT    NOT NULL,   -- UTC ISO
  digest_slot      TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  -- Always written through redact(). An upstream error string routinely
  -- contains the publish URL, and this column is rendered on a web page.
  last_error       TEXT,
  claimed_by       TEXT,
  claimed_at       TEXT,
  send_started_at  TEXT,
  -- INPUTS, never a rendered message. A body rendered at 23:05 and delivered at
  -- 08:00 quotes a nine-hour-old price, and a stored payload is an orphaned
  -- copy of data that may since have been withdrawn.
  eligibility_json TEXT    NOT NULL,
  evidence_json    TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

-- One economics cannot be in flight twice at once, guaranteed by the index
-- rather than by a check somebody has to remember.
CREATE UNIQUE INDEX idx_nq_live_fingerprint ON notification_queue (fingerprint)
  WHERE status IN ('QUEUED', 'CLAIMED', 'SENDING');
CREATE INDEX idx_nq_due ON notification_queue (status, scheduled_for);
-- NOT unique: a morning holds as many queued items as the night produced. The
-- "one digest per morning" guarantee belongs on the notifications table, where
-- it describes one MESSAGE - putting it here would have silently capped a whole
-- night at a single opportunity.
CREATE INDEX idx_nq_digest_slot ON notification_queue (digest_slot, status);

-- ─── Why, including every silence ───────────────────────────────────────────

CREATE TABLE notification_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_key TEXT,
  fingerprint     TEXT,
  -- Deliberately NO foreign key: the forensics have to outlive the row they
  -- describe, and that is the whole point of this table.
  candidate_id    INTEGER,
  cluster_id      INTEGER,
  queue_id        INTEGER,
  notification_id INTEGER,
  -- decision | transition | delivery | verify | pass_error |
  -- send_outcome_unknown | test
  kind            TEXT    NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  score           REAL,
  gates_evaluated TEXT,               -- JSON array, in the order they ran
  first_blocker   TEXT,
  -- EVERY blocker, not just the first: a candidate can be both STALE and
  -- SUSPICIOUS_DATA, and reporting only one hides that the data was garbage.
  all_blockers    TEXT,
  detail          TEXT,               -- the arithmetic, with real numbers
  occurrences     INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT    NOT NULL,
  last_seen_at    TEXT    NOT NULL
);

-- An unchanged decision bumps occurrences instead of appending. 4,928
-- candidates on a 60-second tick would otherwise make this the largest table in
-- the database inside a week, and none of those rows would say anything new.
CREATE UNIQUE INDEX idx_ne_decision
  ON notification_events (opportunity_key, first_blocker) WHERE kind = 'decision';
CREATE INDEX idx_ne_recent ON notification_events (last_seen_at DESC);
CREATE INDEX idx_ne_kind ON notification_events (kind, last_seen_at DESC);

-- §31 - did the alerts actually produce WOULD_BOOK? That question needs the
-- verdict to point at the notification that prompted it, not merely at the
-- candidate. Nullable: feedback given while browsing the feed has no
-- notification behind it, and that is a legitimate and common case.
ALTER TABLE deal_feedback ADD COLUMN notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL;
