-- Halloween Check-in schema (independent from the legacy `checkins` table in 0001).
-- Revisions are immutable; media keys are content-bound; a revision can be
-- published at most once.

CREATE TABLE IF NOT EXISTS hc_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project TEXT NOT NULL,
  state TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hc_revisions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES hc_drafts(id),
  seq INTEGER NOT NULL,
  theme TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  link_checkin_id TEXT,
  day_uploaded INTEGER NOT NULL DEFAULT 0,
  night_uploaded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, seq)
);

CREATE TABLE IF NOT EXISTS hc_approvals (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES hc_revisions(id),
  payload_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS hc_operations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES hc_revisions(id),
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
  checkin_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);

-- One publication per revision, whatever idempotency key is used.
CREATE UNIQUE INDEX IF NOT EXISTS hc_operations_one_per_revision
  ON hc_operations (revision_id);

CREATE TABLE IF NOT EXISTS hc_checkins (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  text TEXT NOT NULL,
  place_json TEXT NOT NULL,
  captured_at TEXT,
  captured_at_source TEXT,
  companions_json TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hc_variants (
  checkin_id TEXT NOT NULL REFERENCES hc_checkins(id),
  theme TEXT NOT NULL,
  revision_id TEXT NOT NULL UNIQUE REFERENCES hc_revisions(id),
  text TEXT NOT NULL,
  differences_json TEXT NOT NULL,
  day_key TEXT NOT NULL,
  night_key TEXT NOT NULL,
  day_sha256 TEXT NOT NULL,
  night_sha256 TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (checkin_id, theme)
);

CREATE INDEX IF NOT EXISTS hc_checkins_published_idx ON hc_checkins (published_at, id);
