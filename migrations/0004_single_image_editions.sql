-- Two pictures per place: the normal edition carries a day image and the Halloween
-- edition a night image. A published variant may now lack one lighting, so the
-- image columns of hc_variants become nullable. SQLite cannot relax NOT NULL in
-- place, so the table is rebuilt; existing rows (both images) are copied unchanged.
-- Nothing references hc_variants, so dropping the old table breaks no foreign key.

CREATE TABLE hc_variants_v2 (
  checkin_id TEXT NOT NULL REFERENCES hc_checkins(id),
  theme TEXT NOT NULL,
  revision_id TEXT NOT NULL UNIQUE REFERENCES hc_revisions(id),
  text TEXT NOT NULL,
  differences_json TEXT NOT NULL,
  day_key TEXT,
  night_key TEXT,
  day_sha256 TEXT,
  night_sha256 TEXT,
  published_at TEXT NOT NULL,
  PRIMARY KEY (checkin_id, theme),
  CHECK (day_key IS NOT NULL OR night_key IS NOT NULL),
  CHECK ((day_key IS NULL) = (day_sha256 IS NULL)),
  CHECK ((night_key IS NULL) = (night_sha256 IS NULL))
);

INSERT INTO hc_variants_v2 (checkin_id, theme, revision_id, text, differences_json, day_key, night_key, day_sha256, night_sha256, published_at)
  SELECT checkin_id, theme, revision_id, text, differences_json, day_key, night_key, day_sha256, night_sha256, published_at FROM hc_variants;

DROP TABLE hc_variants;
ALTER TABLE hc_variants_v2 RENAME TO hc_variants;
