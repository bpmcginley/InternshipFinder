# Student billing recovery

October 23, 2026. W1/W2/W4/W5 fixes use durable state before contacting Stripe.
No live provider request or customer transaction was made while implementing them.

## Invariants

- One account has one pending checkout across tiers and time windows. A retry uses the stored form and attempt key.
- Only an authoritative expired session releases an open reservation. Uncertain creation older than 23 hours requires owner reconciliation, since Stripe may prune idempotency keys after 24 hours.
- Cancellation-pending grants free allowance but still blocks account deletion and another purchase.
- Competing completed subscriptions cannot overwrite the retained live plan. The extra subscription is recorded before cancellation.
- Duplicate automatic refunds require exact subscription, invoice, invoice payment, payment intent, charge, amount, currency and customer agreement. Ambiguous or split payments remain pending, with no guessed refund.
- An uncertain refund creation is not blindly retried after 23 hours. A stored refund ID is retrieved; a fully refunded charge settles recovery without another refund.
- Webhook failures remain retryable. A separate daily recovery invocation handles at most two rows and rotates failed attempts so manual cases cannot starve later cancellations.

## Before deployment

Apply the idempotent `schema.sql` before the Worker; `npm run deploy` already does that in order.
The new `student_checkouts` and `student_billing_recovery` tables contain hashed account IDs and
provider identifiers, never card details or email addresses. The stored checkout form contains
price IDs, return URLs and hashed references, with no API key.

Verify the existing restricted Stripe key permits checkout and subscription reads, subscription
cancellation, Charges/Invoices/Invoice Payments/Payment Intents reads, and refund creation/retrieval.
Do not rotate keys or broaden them without checking their current permissions. The existing signed
webhook is reused; deployment registers the new 07:27 UTC daily recovery trigger with its own request budget. No new Stripe events are required by these fixes.

Run local Worker tests and real local Workers/D1 tests, then a separate controlled Stripe test-mode
lifecycle before enabling the new behavior in production. Offline tests do not certify live key permissions.

## Owner reconciliation

Inspect pending cases privately through D1:

```sql
SELECT subscription, reason, state, invoice, refund, created, updated
FROM student_billing_recovery WHERE state != 'resolved' ORDER BY updated;
SELECT attempt, plan, state, session, created FROM student_checkouts WHERE state IN ('creating', 'open');
```

For a cancellation, confirm the exact subscription is canceled in Stripe. For a duplicate, also
confirm its exact paid invoice and the disposition of every payment/refund; do not use customer
identity alone. Retry the existing webhook or let daily reconciliation complete a known outcome.
If its conservative checks cannot establish the result, preserve the row and resolve through an
explicitly reviewed repair. Do not reset attempts, replace keys, delete recovery rows or mark them
resolved merely to unblock a customer. A partial/split refund needs owner review rather than guessed compensation.

For an uncertain checkout creation with no stored session, locate the provider session by the
hashed reference, creation time and attempt key. Expire an unpaid session or reconcile a completed
subscription before any reservation repair. A zero-row local plan does not prove nothing was charged.

## Revert

Revert Worker callers before removing any table. Keep unresolved recovery and pending checkout
records until their provider outcomes are established. Do not deploy older code that treats pending
cancellation as canceled or discards duplicate subscriptions. No automatic down-migration is provided.
