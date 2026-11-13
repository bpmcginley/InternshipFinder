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
Use `notes/README.md` to find runbooks by topic. For the active refactor, read `notes/refactor/HANDOFF.md`, `ANALYSIS.md`, and `STATUS.md`. For concurrent product work, read `notes/product/HANDOFF.md` and `STATUS.md`; follow its section 3 ownership rules before each wave. Record decisions, verification, package ownership, PRs, merge results, and pending questions in the corresponding status file.
Read `notes/product-review/CONTEXT.md` before resuming the October 2026 product review. Keep that file updated with decisions, completed verification, and pending work rather than storing chat transcripts or private reasoning.
`AGENTS.md` transfers project instructions and documented state; it does not transfer model execution, credentials, subscriptions, or a live conversation's entire history.

## Refactor implementation
- Follow current user authorization and the hand-off decisions. Use one owned worktree, branch and PR per work package. Check open PRs and file claims before starting a wave. Update the tracker in every PR.
- Never force-push or rewrite history. Integrate main with normal merges. Preserve other checkouts and uncommitted work. Do not edit, move or delete `MuseWork.md`.
- Workers never merge. The lead may merge within the user's authorized scope after all CI checks pass and a second agent reviews for hidden behavior changes. Preserve golden output or explain every approved output change. Check Pages after each publishing merge before the next merge; a failed publication requires a new revert PR.
- Do not deploy production workers, run remote database commands, release the extension, or manually run workflows that publish, send email or post to social accounts. No account creation, payments, paid provider calls, outreach, or real application submissions for verification.
- Keep secrets, private service identifiers and personal data out of code, logs, PRs and notes. Preserve user-visible text, privacy policy, pricing and data collection. Keep `extension/agent/guard.js` and its protected tests unchanged.
- Preserve old import paths until the compatibility-removal package. Pause only an affected package when behavior changes, golden differences or hand-off stop conditions need a decision; record the question and continue independent work.

## Model and credential boundaries
The user selected Gemini 4 Argon through the Gemini app using their existing Google AI Pro subscription. Do not switch Codex's active provider or use billable Gemini API calls for this work without a new user instruction.
Antigravity CLI is installed and authenticated, but Argon was absent from this account's CLI model list on 2026-10-13. Do not silently substitute another model or claim a CLI/backend switch occurred.
Never put API keys, tokens, OTPs, personal profile/resume data, or passwords in repository files or handoff documents.

## Verification
Use Python 3.12 and Node 22, matching CI. Check the hand-off and workflow commands for the current backend, worker runtime, golden-build and reproducible-packaging suites. Run the root lint and type-report scripts when the package applies; existing type debt is report-only until its documented gate changes.
Run meaningful tests appropriate to a change, using existing project tooling. Typical commands: `node --test extension/test/*.test.mjs`, `node --test tests/site/*.test.mjs`, and `npm test` from `worker/`. Inspect the actual test filenames/scripts before execution. Do not make paid AI calls or test real employer submissions merely to verify a review finding.
