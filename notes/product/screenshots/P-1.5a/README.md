# P-1.5a dashboard phone navigation

Frozen parent: P-1.4 `bd5d324a`; PR #210 is stacked on #204. Merge remains blocked until Bruce accepts #187, #193 and #204, followed by retargeting and fresh integration checks. This package adds no storage, counters, dependencies or cache tags. Existing pricing wording, plan values, destinations and header controls are unchanged.

The phone header now has a native **Menu** disclosure. All seven destinations remain in the Site navigation; desktop shows them inline. The logo, site links, Menu and live footer links have targets at least 44 by 44 CSS pixels. This is ordinary navigation, with no menu roles or focus trap.

## Measured layout

Headless Microsoft Edge, isolated contexts, 1280x1000 mouse / 375x1000 touch, light and dark, America/New_York. Static captures disable JavaScript. All requests are fulfilled locally with repository assets, isolated React runtime and explicitly synthetic public listing fixtures reused from P-1.3/P-1.4; no employer, account, AI or production requests are sent. Theme variants have identical dimensions.

| Width and mode | Header before | Header after | Difference |
|---|---:|---:|---:|
| 375 live | 506.78125 px | 466.28125 px | 40.5 px shorter |
| 375 static | 446.78125 px | 406.28125 px | 40.5 px shorter |
| 1280 live | 259.1875 px | 272.4375 px | 13.25 px taller |
| 1280 static | 253.6875 px | 272.4375 px | 18.75 px taller |

Phone brand height changes from 85 to 44.5 px. Desktop height increases to accommodate 44 px navigation targets. No horizontal overflow in any capture. Exact boxes are in [before measurements](before-measurements.json) and [after measurements](after-measurements.json).

## Screenshots

| Mode / width / theme | Before | After | Open phone Menu |
|---|---|---|---|
| live / 1280 / light | [Before](before-live-1280-light.png) | [After](after-live-1280-light.png) | - |
| live / 1280 / dark | [Before](before-live-1280-dark.png) | [After](after-live-1280-dark.png) | - |
| live / 375 / light | [Before](before-live-375-light.png) | [After](after-live-375-light.png) | [Open](after-live-375-light-open.png) |
| live / 375 / dark | [Before](before-live-375-dark.png) | [After](after-live-375-dark.png) | [Open](after-live-375-dark-open.png) |
| static / 1280 / light | [Before](before-static-1280-light.png) | [After](after-static-1280-light.png) | - |
| static / 1280 / dark | [Before](before-static-1280-dark.png) | [After](after-static-1280-dark.png) | - |
| static / 375 / light | [Before](before-static-375-light.png) | [After](after-static-375-light.png) | [Open](after-static-375-light-open.png) |
| static / 375 / dark | [Before](before-static-375-dark.png) | [After](after-static-375-dark.png) | [Open](after-static-375-dark-open.png) |

## Behavior and validation

- Native Space and Enter open and close Menu in both live and JavaScript-disabled pages. Closed links are hidden; opening exposes all seven links in their original order with original digest/employer markers.
- In the live app, Escape closes and focuses Menu. Tab out closes without taking focus from its next destination. Outside pointer closes without cancelling the browser's pointer action. Same-page hash activation focuses its destination, not Menu.
- Real browser resize 375 to 1280 moves focused Menu to the first visible link; returning to 375 moves a newly hidden link to Menu. The code remembers focus only across a visibility-induced blur; genuine outside focus/pointer departure clears it. Regression tests cover event ordering before the matchMedia callback; real browser checks also preserve genuine outside Tab and pointer focus through resizing.
- Ctrl+Enter opens a locally fulfilled fixture target in a new tab while keeping the original menu open and anchor focused. Modified activations and explicit new-tab links retain native behavior.
- Baseline 285 site tests passed. Final full suite: 294 passed, including nine new focused navigation tests. ESLint, pinned Prettier for the new test, startup budget report and diff whitespace check pass. The browser matrix has no page errors.
- Golden output has 695 entries. The manifest and review archive agree exactly. Only index.html, js/app.js and data/page-content-dates.json change: the latter changes only the homepage content digest because Menu is newly visible text; all lastmod dates and all other page digests remain unchanged. Both golden tests pass (2/2).

Run the browser evidence with `CAPTURE_TOOLS` pointing to isolated tooling containing playwright-core and React 18.3.1, then `node notes/product/screenshots/P-1.5a/capture.cjs before` or `after`. The script never launches the user's browser profile.

## Exact visible copy

New: **Menu**.

Retained site labels: **Browse**, **Weekly email**, **Auto-Apply (free)**, **Pricing**, **Compare**, **About**, **Hire interns**. Their hrefs and tracking-placement attributes are unchanged. No other visible wording is added or edited, including existing plan and footer text.
