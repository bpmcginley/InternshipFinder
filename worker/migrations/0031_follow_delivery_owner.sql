-- One private current owner. No automatic reset, lease expiry or takeover.
CREATE TABLE IF NOT EXISTS follow_delivery_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL CHECK(version=1),
  generation TEXT NOT NULL CHECK(length(generation)=32 AND generation NOT GLOB '*[^0-9a-f]*'),
  phase TEXT NOT NULL CHECK(phase IN ('ready','running','held')),
  next_kind TEXT NOT NULL CHECK(next_kind IN ('confirmation','management')),
  confirmation_id TEXT,
  confirmation_expires_at TEXT,
  management_id TEXT,
  management_expires_at TEXT,
  CHECK((confirmation_id IS NULL)=(confirmation_expires_at IS NULL)),
  CHECK((management_id IS NULL)=(management_expires_at IS NULL)),
  CHECK(confirmation_id IS NULL OR length(confirmation_id)=36),
  CHECK(management_id IS NULL OR length(management_id)=36),
  CHECK(confirmation_expires_at IS NULL OR (length(confirmation_expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at,'+0 days') IS confirmation_expires_at)),
  CHECK(management_expires_at IS NULL OR (length(management_expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',management_expires_at,'+0 days') IS management_expires_at))
);
-- Adoption is operator-gated. Runtime never inserts or recreates this row.
INSERT INTO follow_delivery_owner(singleton,version,generation,phase,next_kind)
VALUES(1,1,lower(hex(randomblob(16))),'ready','confirmation')
ON CONFLICT(singleton) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS follow_owner_confirmation_delete AFTER DELETE ON follow_confirmation_outbox
BEGIN
  UPDATE follow_delivery_owner SET confirmation_id=NULL,confirmation_expires_at=NULL
  WHERE confirmation_id=OLD.id AND confirmation_expires_at=OLD.expires_at;
END;
CREATE TRIGGER IF NOT EXISTS follow_owner_confirmation_replace AFTER UPDATE OF id,expires_at ON follow_confirmation_outbox
WHEN OLD.id IS NOT NEW.id OR OLD.expires_at IS NOT NEW.expires_at
BEGIN
  UPDATE follow_delivery_owner SET confirmation_id=NULL,confirmation_expires_at=NULL
  WHERE confirmation_id=OLD.id AND confirmation_expires_at=OLD.expires_at;
END;
CREATE TRIGGER IF NOT EXISTS follow_owner_management_delete AFTER DELETE ON follow_management_outbox
BEGIN
  UPDATE follow_delivery_owner SET management_id=NULL,management_expires_at=NULL
  WHERE management_id=OLD.id AND management_expires_at=OLD.expires_at;
END;
CREATE TRIGGER IF NOT EXISTS follow_owner_management_replace AFTER UPDATE OF id,expires_at ON follow_management_outbox
WHEN OLD.id IS NOT NEW.id OR OLD.expires_at IS NOT NEW.expires_at
BEGIN
  UPDATE follow_delivery_owner SET management_id=NULL,management_expires_at=NULL
  WHERE management_id=OLD.id AND management_expires_at=OLD.expires_at;
END;
