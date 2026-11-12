-- Irreversible management send-attempt claim; no raw credential or address copy.
ALTER TABLE follow_management_outbox ADD COLUMN claim_id TEXT;
