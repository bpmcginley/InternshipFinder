# P-2.2ap browser evidence

All data and Worker responses are synthetic. Edge runs in a fresh headless context at 1280 or 375 by 1100 pixels, light/dark, reduced motion and America/New_York. Every request is intercepted. Existing React libraries are served from isolated local tooling; no external page request, provider request, payment or real session is made. The existing optional Cloudflare beacon attempt is aborted. A valid Stripe navigation is fulfilled with a local synthetic HTML response.

Before uses exact published `82c3c429` native allowance, dashboard and Core account modules. After uses this package. The same public row fixture and fake profile/session are used in both. The fixture profile uses the supported senior standing. Screens cover Account, allowance and pending-checkout deletion at both widths/themes. All 24 images are paired. No horizontal overflow or page errors were observed.

The actual native UI and Core are executed. One test-only intercepted dashboard binding allows an A-B-A auth generation change to exercise a held recovery response; it is not shipped. `results.json` records no passive recovery requests, keyboard pending/retry, terminal fresh /me exactly once, focus after the disappearing panel action, ordinary Account entry with sales off, absent capability, a held response ignored after A-B-A, and preservation of all browser values after deletion409. Account activation returns focus to Account. The panel status is a persistent polite live region; actual screen-reader software was not exercised.

Reproduce with isolated playwright-core, React/ReactDOM and Edge: export the three baseline modules from `82c3c429` into a temporary directory named by their basenames, then run `node notes/product/screenshots/P-2.2ap/capture.cjs <baseline-directory>`. The script serves local files through route interception and makes no production request. The browser proof uses local responses. The production Worker route is deployed with recovery disabled.

## Allowance

| Width/theme | Before | After |
|---|---|---|
| 1280 light | [Before](before-allowance-1280-light.png) | [After](after-allowance-1280-light.png) |
| 1280 dark | [Before](before-allowance-1280-dark.png) | [After](after-allowance-1280-dark.png) |
| 375 light | [Before](before-allowance-375-light.png) | [After](after-allowance-375-light.png) |
| 375 dark | [Before](before-allowance-375-dark.png) | [After](after-allowance-375-dark.png) |

## Account

| Width/theme | Before | After |
|---|---|---|
| 1280 light | [Before](before-account-1280-light.png) | [After](after-account-1280-light.png) |
| 1280 dark | [Before](before-account-1280-dark.png) | [After](after-account-1280-dark.png) |
| 375 light | [Before](before-account-375-light.png) | [After](after-account-375-light.png) |
| 375 dark | [Before](before-account-375-dark.png) | [After](after-account-375-dark.png) |

## Deletion

| Width/theme | Before | After |
|---|---|---|
| 1280 light | [Before](before-deletion-1280-light.png) | [After](after-deletion-1280-light.png) |
| 1280 dark | [Before](before-deletion-1280-dark.png) | [After](after-deletion-1280-dark.png) |
| 375 light | [Before](before-deletion-375-light.png) | [After](after-deletion-375-light.png) |
| 375 dark | [Before](before-deletion-375-dark.png) | [After](after-deletion-375-dark.png) |
