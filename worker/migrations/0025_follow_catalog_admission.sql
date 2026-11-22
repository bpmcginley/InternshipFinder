-- Dormant trusted catalog precondition. This empty view retains no request or release data.
CREATE VIEW IF NOT EXISTS follow_catalog_admissions AS SELECT NULL AS expires_at_ms WHERE 0;
CREATE TRIGGER IF NOT EXISTS follow_catalog_admit
INSTEAD OF INSERT ON follow_catalog_admissions
BEGIN
  SELECT CASE WHEN typeof(NEW.expires_at_ms) IN ('integer','real')
    AND NEW.expires_at_ms>0 AND NEW.expires_at_ms<=9007199254740991
    AND NEW.expires_at_ms=CAST(NEW.expires_at_ms AS INTEGER)
    AND NEW.expires_at_ms>CAST(round((julianday('now')-2440587.5)*86400000) AS INTEGER)
    THEN 1 ELSE RAISE(ABORT,'Follow catalog unavailable') END;
END;
