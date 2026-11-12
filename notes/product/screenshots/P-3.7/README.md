# P-3.7 Cloud Sync restore ordering

The screenshots show Voice when a synthetic restore arrives during startup. Baseline `f3cf022a` shows the old local sample beneath the restore notice. The candidate shows the sample from the restored profile beneath the same notice. A later edit through the refreshed field saves normally.

| Width | Light | Dark |
| --- | --- | --- |
| 1280 | [Before](before-1280-light.png) / [After](after-1280-light.png) | [Before](before-1280-dark.png) / [After](after-1280-dark.png) |
| 375 | [Before](before-375-light.png) / [After](after-375-light.png) | [Before](before-375-dark.png) / [After](after-375-dark.png) |

Chrome ran the actual onboarding and store modules with synthetic storage and the browser's Web Locks. The harness queued one combined profile and marker write as the page first read the marker. All requests stayed in the local fixture. The browser check covers the profile and notice read ordering. The candidate also aborts a pending interview request immediately when a newer restore arrives while the store lock is held. It keeps the unanswered turn available for Retry after the refreshed profile is loaded. The extension test separately uses real Cloud Sync and store code to test GET, PUT conflict, write rejection, opt-out and once-only notice claims with synthetic storage and intercepted responses.

Set `CAPTURE_TOOLS` to a local directory with `node_modules/playwright-core`. Run `node notes/product/screenshots/P-3.7/capture.cjs before` and then the same command with `after`. Set `VERIFY_ONLY=1` to run without writing screenshots. Set `RESTORE_BROWSER` to override the Chrome executable.
