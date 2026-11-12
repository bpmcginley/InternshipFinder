# P-2.1ba offline landing page evidence

Baseline is exact main `536a6731`; `/follows/action.html` is absent. The before captures serve that build's real `404.html` at the missing route with HTTP 404, not an invented earlier UI. Both purpose baselines are byte-identical for each width/theme. The after build adds only the new page; all 836 prior golden outputs remain byte-identical.

Sixteen captures form eight pairs: confirmation before explicit action, and request deletion after a mocked 204. Native Edge uses fresh isolated contexts at 1280/375 and light/dark. All bearer strings are random synthetic runtime values, stripped before capture, never logged or saved. No outside network is permitted. The prior 404's analytics request is blocked; the new page makes no asset/analytics request. API responses are local doubles, not live Follow state.

The harness checks immediate fragment removal, no request on load, normal Tab/Enter action, actual button bounds at least 44 pixels, no referrer/cookie, exact body-only POST, zero browser storage, no horizontal overflow/errors, successful confirmation, invalid on reload, explicit retry after 503, unavailable confirmation after 410, and conditional request deletion. The extended native regression also switches an active Confirm to a second deletion fragment, preserves the `#main` skip link, and reopens a valid fragment after reload in the same document. Confirmation-scenario POST count is five per context across separate explicit actions; deletion is one. No issuance, sender or provider is exercised.

Reproduce with `node capture.cjs BEFORE_STAMPED_SITE AFTER_STAMPED_SITE` using the existing external Playwright tooling. No credentials belong in artifacts. All after captures and distinct baseline captures were visually inspected.

| Purpose/view | Before | After |
|---|---|---|
| confirm, 1280 light | [Before](before-confirm-1280-light.png) | [After](after-confirm-1280-light.png) |
| confirm, 1280 dark | [Before](before-confirm-1280-dark.png) | [After](after-confirm-1280-dark.png) |
| confirm, 375 light | [Before](before-confirm-375-light.png) | [After](after-confirm-375-light.png) |
| confirm, 375 dark | [Before](before-confirm-375-dark.png) | [After](after-confirm-375-dark.png) |
| delete-request, 1280 light | [Before](before-delete-request-1280-light.png) | [After](after-delete-request-1280-light.png) |
| delete-request, 1280 dark | [Before](before-delete-request-1280-dark.png) | [After](after-delete-request-1280-dark.png) |
| delete-request, 375 light | [Before](before-delete-request-375-light.png) | [After](after-delete-request-375-light.png) |
| delete-request, 375 dark | [Before](before-delete-request-375-dark.png) | [After](after-delete-request-375-dark.png) |

After the same-document correction, all sixteen captures were regenerated and verified byte-identical to their `7b63f432` versions. No copy or styling changed.

The harness also runs two native Edge cases with **forced synthetic** lifecycle ordering: a pending hash, pagehide, obsolete fetch success/rejection and persisted pageshow. Both restore visibly inert with the bearer removed and no additional POST; only a later new link restores an explicit action. This qualifies the defensive boundary without claiming that natural BFCache scheduling has this order. All sixteen screenshots were regenerated again after this correction and remain byte-identical.
