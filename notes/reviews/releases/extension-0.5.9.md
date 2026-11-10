# Extension 0.5.9 audit fixes

Prepared October 23, 2026. This is a source candidate, not a store submission or public release.
Version 0.5.8 was already submitted separately; do not replace its ZIP or source record.

## Behavior

- EXT-1: after filling, unfamiliar actions and consent require the student, even without a recognized review heading. Known navigation remains available and trusted human clicks pass through.
- EXT-2: consent changes invalidate pending sync replies, and deletion waits for earlier uploads. Failed deletion stays visible as a failure. Account deletion and sign-out share the same synchronization barrier.
- EXT-3: delayed restores cannot overwrite newer manual edits or acknowledge them as already synced.
- EXT-4: Take over cancels asynchronous dropdown work before another DOM mutation.
- EXT-5: a restored interview stays complete, but Auto-Apply requires a local resume file on the new device.

Permissions, host permissions and identity configuration are unchanged.

## Validation and release gates

Run the complete extension suite and packaging tests on the clean final commit. The packaging helper
records that commit and both ZIP hashes. Offline regressions use fictional profiles and fixture
pages, including actual snapshot/action code, delayed cloud replies and cancellation callbacks.
They submit no employer applications and make no paid AI calls.

Before store publication, verify the exact package's real Google/personal Microsoft sign-in,
ordinary update preservation, restored profile with missing resume, popup/setup/side-panel layout,
and human final-action handoff in a controlled fixture. These manual checks are not claimed complete.

## Revert

Revert the corresponding runtime rule and its regression together. Do not reuse 0.5.8 for a different
binary. Do not restore old cloud data or consent settings during a rollback. Reverting a safety rule
reintroduces its documented audit failure.
