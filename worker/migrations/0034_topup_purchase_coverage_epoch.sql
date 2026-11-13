-- Dormant candidacy only. Existing purchases remain unproven; deletion cascades unchanged.
ALTER TABLE topup_retention ADD COLUMN coverage_epoch TEXT CHECK(coverage_epoch IS NULL OR (length(coverage_epoch)=32 AND coverage_epoch NOT GLOB '*[^0-9a-f]*'));
