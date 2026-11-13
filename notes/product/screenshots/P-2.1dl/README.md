# P-2.1dl visual evidence

Synthetic employer data, real default publisher versus the explicit private adapter. Viewports are 1280x1100 and 375x1100. The new wrapper is content-addressed and imports the exact matching App generation. No production page, account or provider was contacted.

| View | Before | After | Open form |
| --- | --- | --- | --- |
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) | [Open](after-open-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) | [Open](after-open-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) | [Open](after-open-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) | [Open](after-open-375-dark.png) |

`build.py` takes an absent private directory and uses existing synthetic fixtures to produce both artifacts. Run with repository and backend test helpers on `PYTHONPATH`. `capture.cjs` takes that directory, with `PLAYWRIGHT_CORE` and `EDGE_PATH` pointing to isolated local tooling. It serves only loopback bytes and aborts all external requests. `browser-results.json` records the measured request and overflow checks. It also asserts Enter opens with Email focused and idle Escape restores the button. The form was never submitted.

The fixture has one canonical employer model and eight open roles. Before has no Follow marker. After has the existing optional company form. All twelve images were generated from the same frozen fixture. The 375-pixel open form extends below the viewport and remains normally scrollable.
