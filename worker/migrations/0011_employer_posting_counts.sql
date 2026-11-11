-- Aggregate organic posting activations. No migration backfill or identity columns.
CREATE TABLE IF NOT EXISTS employer_posting_counts (
  day TEXT NOT NULL CHECK (length(day) = 10 AND date(day, '+0 days') IS day),
  company TEXT NOT NULL CHECK (typeof(company) = 'text' AND length(CAST(company AS BLOB)) BETWEEN 1 AND 200),
  n INTEGER NOT NULL CHECK (typeof(n) = 'integer' AND n BETWEEN 1 AND 1000),
  PRIMARY KEY (day, company)
);

-- The active UTC-day limit survives process restarts and removal of company totals.
CREATE TABLE IF NOT EXISTS employer_posting_day_caps (
  day TEXT PRIMARY KEY NOT NULL CHECK (length(day) = 10 AND date(day, '+0 days') IS day),
  n INTEGER NOT NULL CHECK (typeof(n) = 'integer' AND n BETWEEN 0 AND 50000)
);
