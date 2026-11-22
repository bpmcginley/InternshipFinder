-- Private current coverage metadata only. No purchase enrollment or replay authority.
CREATE TABLE IF NOT EXISTS topup_history_coverage (
  mode TEXT PRIMARY KEY NOT NULL CHECK(mode IN ('test','live')),
  epoch TEXT NOT NULL CHECK(length(epoch)=32 AND epoch NOT GLOB '*[^0-9a-f]*'),
  schema_key TEXT NOT NULL CHECK(length(schema_key) BETWEEN 1 AND 64 AND schema_key NOT GLOB '*[^A-Za-z0-9_.-]*'),
  starts_at TEXT NOT NULL CHECK(length(starts_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',starts_at,'+0 days') IS starts_at),
  covered_through TEXT CHECK(covered_through IS NULL OR (length(covered_through)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',covered_through,'+0 days') IS covered_through AND covered_through>=starts_at)),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  health TEXT NOT NULL CHECK(health IN ('unproven','closed','qualified')),
  CHECK(health!='unproven' OR covered_through IS NULL),
  CHECK(health!='qualified' OR covered_through IS NOT NULL)
);
