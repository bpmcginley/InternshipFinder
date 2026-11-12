-- Unknown historical rows never acquire erasure authority from a later clean snapshot.
ALTER TABLE topup_retention ADD COLUMN history_proven INTEGER NOT NULL DEFAULT 0 CHECK(history_proven IN (0,1));
ALTER TABLE topup_retention ADD COLUMN evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'));
