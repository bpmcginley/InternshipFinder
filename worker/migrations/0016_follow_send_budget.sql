-- One global follow-send attempt count for the UTC day of the latest observed time.
CREATE TABLE IF NOT EXISTS follow_send_budget (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at,'+0 days') IS observed_at),
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer'
    AND attempts BETWEEN 0 AND 9007199254740991)
);
