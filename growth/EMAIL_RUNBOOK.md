# Weekly email operations

The weekly digest was approved and enabled October 15, 2026. Do not repeat activation or send a
catch-up broadcast as a deployment check. Forms require confirmation; subscriber addresses stay
with Buttondown. The owner/test preview drafts are not broadcasts to publish.

## First send and normal schedule

- First scheduled subscriber run: **Monday, October 19, 2026 at 12:00 UTC / 8 a.m. EDT**.
- Subsequent runs: Mondays at 12:00 UTC. This becomes **7 a.m. EST** in winter; the schedule does not
  promise 8 a.m. Eastern year-round.
- GitHub can start late. Metrics allow two hours of scheduling grace, then flag the missing or stuck
  run. They never start, retry, or catch up a digest.
- Keep schedule (growth/catchup.py) does: since 2026-10-19, if no digest run has started by its next
  check after 12:00 UTC on a Monday (until 22:00), it starts one for every subscriber. When GitHub's
  late scheduled run turns up afterwards, it finds the email already out and ends green without
  sending (`--skip-if-sent`), so the metrics row reads `success` for that Monday.
  was: "The existing Keep schedule job does not send email."
- A manual workflow run defaults to an owner-only test. It does not establish that a scheduled
  subscriber broadcast happened. Do not tick “Send to every subscriber” just to check deployment.

## What health establishes

The existing hourly metrics snapshot includes a `digest.yml` automation row. Its original
`conclusion`, `at`, `event`, and `url` fields describe the current Monday's subscriber run: GitHub's
scheduled run, or Keep schedule's catch-up of it (started by `github-actions[bot]`; counted since
2026-10-21). A run a person starts never counts, test copy or not. When a Monday has both, the newest
that succeeded is the one shown. Additional fields are:

| Field | Meaning |
|---|---|
| `health` | `not_due`, `waiting`, `in_progress`, `success`, `overdue`, `failed`, `blocked`, or `unknown` |
| `due_at` / `next_due_at` | Scheduled UTC slots, independent of how late GitHub actually starts |
| `detail` | Explanation and safe next step |
| `delivery_confirmed` | Always false: workflow status does not prove delivery to recipients |
| `last_manual_run` | Latest completed run when it was manual; its audience is deliberately not inferred |

Before the first Monday slot, health is `not_due`. Within scheduling grace a missing run is
`waiting`. A green scheduled workflow counts as `success` only if its **Send the digest** step also
succeeded. A skipped send is `blocked`, not a successful broadcast. Overdue, failed, blocked, and
unknown states are also copied into the snapshot's existing `problems` array so they remain visible
without a dashboard schema migration. A successful step means provider handoff only.

After the first send, inspect the Actions run and Buttondown's sent/scheduled state, public archive,
and aggregate delivery/bounce results. Use the confirmed-subscriber procedure in
[SIGNUP_MEASUREMENT.md](SIGNUP_MEASUREMENT.md); anonymous form events are not subscribers.

## Refusals and recovery

Real sends, including owner-only tests, refuse before any Buttondown request if the listing export's
`generated_at` is missing, malformed, lacks a timezone, is in the future, or is over 48 hours old.
Fresh timezone-aware offsets are accepted. Historical preview generation remains available without
`--send`; its reference date remains the export date.

1. For an export refusal, inspect the latest ingest and its timestamp. Refresh/repair the data and
   read the new preview before considering a send; do not bypass freshness or backdate the clock.
2. For a missing, failed, cancelled, or unknown run, **first inspect Buttondown's sent and scheduled
   emails**. A timeout can happen after a send was accepted. Do not retry or publish a leftover draft
   while delivery status is uncertain.
3. If the send step was skipped, check whether `DIGEST_ENABLED` was intentionally turned off. Do not
   re-enable it just to make a health badge green.
4. Only after establishing that no subscriber email was accepted should the owner choose a manual
   broadcast. The existing six-day duplicate guard remains active. `--allow-same-week` is an explicit
   exceptional override, not the normal recovery path.

No subscriber API access, expanded key scopes, recipient exports, or email open/click tracking are
needed for these checks. The health check reads GitHub metadata; it never reads provider credentials
or subscriber records.
