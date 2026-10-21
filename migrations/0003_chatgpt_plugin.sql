-- ChatGPT plugin support.
-- 1. Key/value storage for the OAuth provider (clients, grants, tokens), kept in this
--    project's own D1 database instead of a separate KV namespace.
-- 2. A Halloween revision may name the normal revision it belongs to, so both editions
--    of one place can be reviewed together before either is published.

CREATE TABLE IF NOT EXISTS hc_oauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  metadata TEXT,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS hc_oauth_kv_expires_idx ON hc_oauth_kv (expires_at);

ALTER TABLE hc_revisions ADD COLUMN link_revision_id TEXT;
