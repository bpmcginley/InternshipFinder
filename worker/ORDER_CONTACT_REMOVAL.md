# Employer order contact removal

For the owner handling a request by email under `privacy.html#employer-orders`. There is no public
contact-removal endpoint. Do not treat a request from an unrelated address as authority over an order.
Use the original order email thread to identify the order and verify the request. Keep the request
in private business records, not this repository.

This removes contact details from InternScout's order records while keeping the company, roles,
amounts, dates, accepted terms and payment/refund references. Stripe's own records and emails already
delivered to mailboxes are separate; changing D1 does not delete or recall them.

## Before changing anything

1. Read the order and its placements through the existing private owner access. Verify the exact
   `o-` order ID. Do not paste the employer's contact details into a public issue, log or handoff.
2. Complete any cancellation, refund, unused-days offer or financial reconciliation first. Do not
   erase contacts while the order is `unverified`, `verified` or `paid`, any placement is still
   `draft`, `checked`, `on` or `paused`, a credit is `offered`, or a decision/credit job is `running`
   or `unknown`. An approved order whose placements have ended can have its contact removed.
3. Check both `employer_order_mail` and `employer_campaign_reports` for that order. If `sending_until` is later than the current UTC time,
   wait for the attempt to finish or its five-minute lease to expire. A send already in flight cannot
   be recalled by deleting the queue. Coordinate with the owner so no financial action is being run
   for the same order during removal.

The following are read-only checks. Bind the verified ID as `?` using the existing private D1 tooling:

```sql
SELECT id, status FROM employer_orders WHERE id = ?;
SELECT p.id, p.status, p.end_day FROM employer_order_roles r
JOIN placements p ON p.id = r.placement_id WHERE r.order_id = ?;
SELECT id, status FROM employer_credits WHERE order_id = ?;
SELECT action, state FROM employer_decisions WHERE order_id = ?;
SELECT choice, state FROM employer_credit_jobs WHERE order_id = ?;
SELECT kind, sent_at, sending_until FROM employer_order_mail WHERE order_id = ?;
SELECT placement_id, state, sent_at, sending_until FROM employer_campaign_reports WHERE order_id = ?;
```

## Remove the contact details

After those checks, run these statements through private D1 maintenance access with the same verified
ID bound to each `?`. Use one D1 batch if the owner tooling supports it. Otherwise apply them in order
and verify every statement; they are idempotent, so a partial failure can be completed safely. These are
maintenance instructions, not a new application route or a request to erase any current order.

```sql
DELETE FROM employer_order_mail WHERE order_id = ?;
-- 2026-10-23: was: only receipt/decision queues existed. Keep campaign tombstones to avoid resending.
UPDATE employer_campaign_reports SET state = CASE WHEN state = 'sent' THEN 'sent' ELSE 'skipped' END,
  skipped_reason = CASE WHEN state = 'sent' THEN skipped_reason ELSE 'contact_removed' END,
  terminal_at = COALESCE(terminal_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  to_address = NULL, subject = NULL, body = NULL, reply_to = NULL,
  sending_until = NULL, lease_token = NULL, next_attempt_at = NULL
WHERE order_id = ?;
UPDATE employer_credits SET token_hash = '' WHERE order_id = ?;
UPDATE employer_orders
SET name = '', email = '', email_domain = '', token_hash = NULL, token_expires = NULL
WHERE id = ? AND status IN ('approved', 'refused');
```

Deleting both pending messages and sent tombstones removes any stored email body/address and prevents
the cron from delivering an old queued message after the contact was erased. Clearing the confirmation
and credit-token hashes invalidates old contact links. Keep settled credits and their financial
references; do not delete or reset a financial-operation claim to make this request succeed.

Review free-text refusal reasons and privately entered pilot notes for contact details added manually;
remove those contact details if present. Preserve the business outcome, company, amounts and dates.
Public listing titles/company names and anonymous placement totals are not buyer contact details.

## Verify and record completion

Read back the order's `name`, `email`, `email_domain`, `token_hash` and `token_expires`; the contact
fields must be empty and both link fields null. The order must have no `employer_order_mail` rows,
and any related `employer_credits.token_hash` must be empty. Campaign report rows must contain no
address, subject, body or reply address, no lease or next attempt, and none may remain queued.
Check the company, amounts, dates and
payment/refund references remain. Record only the order ID and completion time in the owner's private
maintenance record, then reply through the original request thread. Do not add the removed address
back to D1 or to the weekly email list. The existing seven-year retention cleanup still removes the
remaining order record when its retention period ends.
