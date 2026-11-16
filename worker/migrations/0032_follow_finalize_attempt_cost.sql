-- Preserve delivery and expiry semantics while bounding repeated pending validation.
DROP TRIGGER IF EXISTS follow_finalize_attempt;
CREATE TRIGGER follow_finalize_attempt BEFORE UPDATE OF state ON follow_digest_outbox
WHEN OLD.state='attempting' AND NEW.state IN ('accepted','uncertain')
  AND length(OLD.attempted_at)=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',OLD.attempted_at,'+0 days')=OLD.attempted_at
BEGIN
  -- Validate the pinned pending row once. Drive indexed lookups from its advances.
  UPDATE follow_scope_progress SET watermark=approved.to_watermark
  FROM (
    WITH verified AS MATERIALIZED (
      SELECT advances FROM follow_valid_pending
      WHERE job_id=OLD.id AND snapshot_at<=OLD.attempted_at
    ), approved_advances AS MATERIALIZED (
      SELECT json_extract(a.value,'$.scopeKey') AS scope,
        json_extract(a.value,'$.generation') AS generation,
        json_extract(a.value,'$.confirmedAt') AS confirmed,
        json_extract(a.value,'$.from') AS from_watermark,
        json_extract(a.value,'$.to') AS to_watermark
      FROM verified CROSS JOIN json_each(verified.advances) a
    )
    SELECT * FROM approved_advances
  ) AS approved
  CROSS JOIN follow_subscriptions s ON s.subscriber_id=OLD.subscriber_id
    AND s.scope_key=approved.scope AND s.confirmed_at=approved.confirmed
  WHERE follow_scope_progress.subscriber_id=OLD.subscriber_id
    AND follow_scope_progress.scope_key=approved.scope
    AND follow_scope_progress.scope_generation=approved.generation
    AND follow_scope_progress.watermark=approved.from_watermark;
END;
