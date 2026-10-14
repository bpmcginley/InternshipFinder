# Claude PR #93 review

Reviewed merged commit `9190a37d` from https://github.com/bpmcginley/InternshipFinder/pull/93.
All five GitHub checks passed. The unmodified extension suite was reproduced locally: **179 passed**. Additional tests ran entirely offline with synthetic data; no employer application was submitted.

## P1 — Take over does not prevent rules-based prefill after an asynchronous page wait
`extension/background/agent.js:650` calls `ISDom.fastFill` after waiting for the tab, sleeping, injecting scripts, and loading the profile. Ownership is checked at the top of the loop, but is not rechecked before this mutating operation (or the second prefill after loading-page waits).

Reproduction: invoke the actual `runJob`, have a mocked `chrome.tabs.get` complete `takeBack` during the page wait, and record the subsequent `fastFill`. Result: `prefill while needs_you`, after the takeover status was persisted. The delayed-AI regression passes because it exercises a later boundary.

Fix: check run identity/status/abort after asynchronous waits and immediately before every mutating page operation, including prefill, upload preparation, and the first tab action. Invalidate the active run before waiting for storage in the control router.

## P1 — Unfamiliar submit labels remain allowed on text-only review pages
`extension/agent/guard.js:161` rejects an unfamiliar labeled submit button only when that button's own form contains filled inputs. At a text-only review step, `formFilled` is zero, so `classify` returns `ok`. The `runFilled` and `reviewStep` checks in `allowClick` only apply when classification is `ambiguous`.

Reproduction with the actual guard: `allowClick({text:"Go", type:"submit", formFilled:0, automationId:"final-action"}, {filledFields:0, runFilled:true, reviewStep:true})` returns `{allowed:true}`. “Let’s make it official” has the same result.

Fix: classify unfamiliar submit-type labels as ambiguous even when their form has no inputs; allow only explicit navigation/account exceptions. Retain job-page Apply before any answers and human-triggered final submission.

## Assessment
The wider decorated-label rules, cross-page context, generation checks, focus retention, and temporary click interception are valuable improvements. Keep them. The two gaps above prevent treating the human-only-submit and takeover guarantees as fully verified. The separate Codex product branch needs to incorporate this PR rather than replace its stronger guard and focus behavior with older code.

## Follow-up status

Both reproduced gaps are fixed on `codex/product-quality`, based on this merged commit. Regression tests now cover takeover during a page wait, cancellation during the last storage read before prefill, and unfamiliar submit labels on text-only review pages. Claude's improvements remain in place. The integrated extension suite passes 218 tests. These changes are awaiting PR review and are not deployed or released.

Review evidence is preserved outside the repository in `C:/Users/bruce/Documents/InternScout-ProductReview/claude-pr93/`, including an actual-loop prefill reproduction and test output. This review did not post comments or messages to Claude or GitHub.
