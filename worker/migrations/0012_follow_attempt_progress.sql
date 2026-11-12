-- A bounded validation view, not new retained data. Invalid pending data is never guessed.
CREATE VIEW IF NOT EXISTS follow_valid_pending AS
SELECT p.job_id,p.snapshot_at,p.advances
FROM follow_pending_progress p JOIN follow_digest_outbox o ON o.id=p.job_id
WHERE length(p.snapshot_digest)=64 AND p.snapshot_digest NOT GLOB '*[^0-9a-f]*'
  AND length(p.snapshot_at)=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',p.snapshot_at,'+0 days')=p.snapshot_at
  AND length(o.created)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',o.created,'+0 days')=o.created
  AND p.snapshot_at<=o.created AND length(CAST(p.advances AS BLOB))<=32768
  AND json_type(p.advances)='array' AND json_array_length(p.advances)>0
  AND NOT EXISTS (
    SELECT 1 FROM json_each(p.advances) a
    WHERE CASE WHEN a.type!='object' THEN 1 ELSE NOT COALESCE(
      (SELECT COUNT(*) FROM json_each(a.value))=5
      AND NOT EXISTS (SELECT 1 FROM json_each(a.value) k
        WHERE k.key NOT IN ('scopeKey','generation','confirmedAt','from','to'))
      AND json_type(a.value,'$.scopeKey')='text' AND length(json_extract(a.value,'$.scopeKey'))>0
      AND json_type(a.value,'$.generation')='text'
      AND length(json_extract(a.value,'$.generation'))=36
      AND substr(json_extract(a.value,'$.generation'),9,1)='-'
      AND substr(json_extract(a.value,'$.generation'),14,1)='-'
      AND substr(json_extract(a.value,'$.generation'),19,1)='-'
      AND substr(json_extract(a.value,'$.generation'),24,1)='-'
      AND length(replace(json_extract(a.value,'$.generation'),'-',''))=32
      AND replace(json_extract(a.value,'$.generation'),'-','') NOT GLOB '*[^0-9a-f]*'
      AND json_type(a.value,'$.confirmedAt')='text' AND length(json_extract(a.value,'$.confirmedAt'))=24
      AND strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(a.value,'$.confirmedAt'),'+0 days')=json_extract(a.value,'$.confirmedAt')
      AND json_type(a.value,'$.from')='text' AND length(json_extract(a.value,'$.from'))=24
      AND strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(a.value,'$.from'),'+0 days')=json_extract(a.value,'$.from')
      AND json_type(a.value,'$.to')='text' AND json_extract(a.value,'$.to')=p.snapshot_at
      AND json_extract(a.value,'$.confirmedAt')<=json_extract(a.value,'$.from')
      AND json_extract(a.value,'$.from')<=json_extract(a.value,'$.to'),0) END
  )
  AND (SELECT COUNT(DISTINCT json_extract(CASE WHEN a.type='object' THEN a.value ELSE '{}' END,'$.scopeKey'))
    FROM json_each(p.advances) a)=json_array_length(p.advances);

-- Runs before the existing AFTER-state trigger erases pending data. Only durable attempts
-- can consume a window. Removed/recreated or independently changed lifetimes are untouched.
CREATE TRIGGER IF NOT EXISTS follow_finalize_attempt BEFORE UPDATE OF state ON follow_digest_outbox
WHEN OLD.state='attempting' AND NEW.state IN ('accepted','uncertain')
  AND length(OLD.attempted_at)=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',OLD.attempted_at,'+0 days')=OLD.attempted_at
BEGIN
  UPDATE follow_scope_progress SET watermark=(
    SELECT json_extract(a.value,'$.to') FROM follow_valid_pending v,json_each(v.advances) a
    WHERE v.job_id=OLD.id AND json_extract(a.value,'$.scopeKey')=follow_scope_progress.scope_key
  ) WHERE (subscriber_id,scope_key) IN (
    SELECT OLD.subscriber_id,json_extract(a.value,'$.scopeKey')
    FROM follow_valid_pending v,json_each(v.advances) a WHERE v.job_id=OLD.id
  ) AND EXISTS (
    SELECT 1 FROM follow_valid_pending v,json_each(v.advances) a
    JOIN follow_subscriptions s ON s.subscriber_id=OLD.subscriber_id
      AND s.scope_key=json_extract(a.value,'$.scopeKey')
    WHERE v.job_id=OLD.id AND v.snapshot_at<=OLD.attempted_at
      AND s.scope_key=follow_scope_progress.scope_key
      AND s.confirmed_at=json_extract(a.value,'$.confirmedAt')
      AND follow_scope_progress.scope_generation=json_extract(a.value,'$.generation')
      AND follow_scope_progress.watermark=json_extract(a.value,'$.from')
  );
END;

-- No advancement before an attempt. Once claimed, cancellation is uncertain for survivors:
-- a late provider response cannot be recalled and must not make their window eligible again.
DROP TRIGGER IF EXISTS follow_scope_cancel_digest;
CREATE TRIGGER IF NOT EXISTS follow_scope_cancel_digest AFTER DELETE ON follow_subscriptions
WHEN OLD.confirmed_at IS NOT NULL
BEGIN
  UPDATE follow_digest_outbox SET state=CASE WHEN state='attempting' AND EXISTS (SELECT 1 FROM follow_pending_progress WHERE job_id=follow_digest_outbox.id) THEN 'uncertain' ELSE 'cancelled' END,
    payload=NULL,lease_token=NULL,lease_until=NULL
    WHERE subscriber_id=OLD.subscriber_id AND state IN ('queued','leased','attempting');
END;
