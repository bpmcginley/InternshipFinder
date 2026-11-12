# P-3.1 local limit-card evidence

Synthetic Edge preview, not a released extension or live account. `capture.cjs` uses fresh contexts and intercepted local source files; every external request is blocked. Before reads immutable main `8c352e25`; after uses this PR. No real employer tab, AI, invite request, payment, permission prompt, account sign-in or submission occurs. The mock tab API records URLs only.

Twenty-four images cover offered upgrade, no higher plan (also no eligible offer), and per-run cap at 1280/375 pixels, light/dark, before/after. Raw Worker errors go through actual `workerError`; actual sidepanel/card code renders the synthetic public queue. Automated assertions check no horizontal overflow, no page errors, zero external requests, keyboard Enter on Invite, exact generic/legacy upgrade destinations, Invite focus retained after redraw and next Tab reaching Resume. Independently inspect source/unit tests for real guarded-loop propagation; this preview does not run the background agent.

Run with isolated playwright-core via `CAPTURE_TOOLS`, then `node notes/product/screenshots/P-3.1/capture.cjs before` and `after`. The script uses the installed Edge executable and requires no running local server. Source CSS/button sizes/permissions are unchanged.

| Width/theme | Before offered | After offered | Before no higher plan | After no higher plan | Before per-run | After per-run |
|---|---|---|---|---|---|---|
| 1280 light | [before](before-1280-light-offered.png) | [after](after-1280-light-offered.png) | [before](before-1280-light-top-plan.png) | [after](after-1280-light-top-plan.png) | [before](before-1280-light-per-run.png) | [after](after-1280-light-per-run.png) |
| 1280 dark | [before](before-1280-dark-offered.png) | [after](after-1280-dark-offered.png) | [before](before-1280-dark-top-plan.png) | [after](after-1280-dark-top-plan.png) | [before](before-1280-dark-per-run.png) | [after](after-1280-dark-per-run.png) |
| 375 light | [before](before-375-light-offered.png) | [after](after-375-light-offered.png) | [before](before-375-light-top-plan.png) | [after](after-375-light-top-plan.png) | [before](before-375-light-per-run.png) | [after](after-375-light-per-run.png) |
| 375 dark | [before](before-375-dark-offered.png) | [after](after-375-dark-offered.png) | [before](before-375-dark-top-plan.png) | [after](after-375-dark-top-plan.png) | [before](before-375-dark-per-run.png) | [after](after-375-dark-per-run.png) |
