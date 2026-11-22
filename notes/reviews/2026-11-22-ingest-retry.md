# Ingest retry rules

The November 22 Workday rate limit used most of the same-run retry budget without restoring useful coverage. If at least half of a provider's boards respond with HTTP 429 and that provider has at least ten boards, the ingester skips that provider's second pass and annotates the Actions run. Isolated 429 responses do not advance board retirement. An explicit `Retry-After` longer than the existing pause also skips the immediate retry. Same-run retries remain available for other providers.

The schedule guard retries one GitHub gateway error on a read. It never retries a workflow dispatch, and the existing guards still determine whether a job needs to run. Neither change extends how long unverified listings can stay public. Review source recovery separately from publication and coverage freshness.

Verification: test isolated and systemic throttling, `Retry-After` in both HTTP forms, another provider's retry budget, and idempotent gateway recovery. After merge, check the automatic ingest and Pages results before publishing the next package.
