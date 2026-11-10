# P-1.7b install footer evidence

Baseline: `aef83ea3`. Captured locally on 2026-11-10 with fresh headless Edge contexts at 1280 x 1000 and 375 x 1000, device scale 1, light and dark color schemes, en-US locale and America/New_York timezone. Local repository fonts and assets only; every external request was blocked. The install page's existing Cloudflare analytics script request was blocked in all eight page loads; no new external request was added. No production counting or navigation to GitHub occurred.

Each case has a full-page screenshot and a viewport scrolled to the footer. The before capture predates the two links. After captures verify no horizontal overflow, both link destinations, 44-pixel minimum link height, keyboard focus from the list link to the widget link, and Enter opening the existing local builder successfully. No page-script errors occurred. The first after harness run expected the builder heading without its existing final period; the harness assertion was corrected and all cases rerun. Product code did not change for that correction.

| View | Before footer | After footer | Before full page | After full page |
|---|---|---|---|---|
| 1280 light | [Before](before-footer-1280-light.png) | [After](after-footer-1280-light.png) | [Before](before-install-1280-light.png) | [After](after-install-1280-light.png) |
| 1280 dark | [Before](before-footer-1280-dark.png) | [After](after-footer-1280-dark.png) | [Before](before-install-1280-dark.png) | [After](after-install-1280-dark.png) |
| 375 light | [Before](before-footer-375-light.png) | [After](after-footer-375-light.png) | [Before](before-install-375-light.png) | [After](after-install-375-light.png) |
| 375 dark | [Before](before-footer-375-dark.png) | [After](after-footer-375-dark.png) | [Before](before-install-375-dark.png) | [After](after-install-375-dark.png) |

Visual review: the desktop links fit together; at 375 pixels they stack with spacing above the existing legal/navigation links. Light and dark colors retain the install page's existing palette. The page above the footer keeps its existing content and layout.
