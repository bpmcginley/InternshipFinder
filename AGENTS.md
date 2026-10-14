# InternScout agent handoffs

## Project map
- `docs/`: published dashboard, public pages, listing shards, and browser scripts.
- `extension/`: browser extension, profile/resume onboarding, Auto-Apply, and side panel.
- `worker/`: Cloudflare API and AI/auth/account services.
- `backend/`: listing collection, normalization, ranking, and export.
- `tests/site/`, `extension/test/`, `worker/test/`: relevant JavaScript test suites.

## Work coordination
Follow the user's current scope. Product reviews cover usability, visuals, accessibility, features, speed, data quality, and reliability; exclude outreach, SEO, pricing, and monetization when the user requests a product-only review.
Use parallel reviewers for independent evidence, then consolidate and verify their findings. Distinguish measured behavior from source-inferred concerns. Record file/line evidence, reproduction, user impact, proposed fix, and validation.
Review first; do not merge, deploy, send messages, or submit real applications as part of a review. Preserve another agent's uncommitted work. Keep implementation in separate branches/worktrees when concurrent work would conflict.

## Shared context
Read `docs/product-review/CONTEXT.md` before resuming the October 2026 product review. Keep that file updated with decisions, completed verification, and pending work rather than storing chat transcripts or private reasoning.
`AGENTS.md` transfers project instructions and documented state; it does not transfer model execution, credentials, subscriptions, or a live conversation's entire history.

## Model and credential boundaries
The user selected Gemini 4 Argon through the Gemini app using their existing Google AI Pro subscription. Do not switch Codex's active provider or use billable Gemini API calls for this work without a new user instruction.
Antigravity CLI is installed and authenticated, but Argon was absent from this account's CLI model list on 2026-10-13. Do not silently substitute another model or claim a CLI/backend switch occurred.
Never put API keys, tokens, OTPs, personal profile/resume data, or passwords in repository files or handoff documents.

## Verification
Run meaningful tests appropriate to a change, using existing project tooling. Typical commands: `node --test extension/test/*.test.mjs`, `node --test tests/site/*.test.mjs`, and `npm test` from `worker/`. Inspect the actual test filenames/scripts before execution. Do not make paid AI calls or test real employer submissions merely to verify a review finding.
