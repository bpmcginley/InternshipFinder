# Auto-Apply status reliability

## Candidate scope

- A confirmation check that started before a manual takeover can no longer mark the newer job step as submitted.
- Delayed submission checks cannot inspect a newer run. A delayed resume after a sleeping tab runs only while the same paused step is still current and the tab is in front.
- The submission check requires an application receipt rather than generic welcome text, instructions, or an upload's success message. The user can still record a submission manually.

The change uses local queue state and browser observations. It adds no telemetry or permission, changes no user-visible strings, and leaves the submission guard unchanged. Checked with synthetic browser events and receipt text; no application was submitted.

## Waiting for Bruce

The source PR is for review and hosted checks. The Chrome Web Store and GitHub manual installs currently use the previously verified `ext-v0.6.0` release. These fixes need a separately versioned and verified package before either distribution channel can receive them. Do not replace the published 0.6.0 assets.
