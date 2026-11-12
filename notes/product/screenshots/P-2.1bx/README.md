# P-2.1bx offline UI evidence

These are synthetic component fixtures, not a live dashboard or a sent email. The `before-disabled` images render the actual default-off component and show no Follow UI. The `after-enabled` images explicitly enable and open the component for invented company/search selections. Existing dashboard CSS and local fonts are read unchanged. All previous public artifacts are byte-identical in the actual golden build.

Each row pairs 1280 and 375 pixel widths, a 1000 pixel viewport height, and both themes. Keyboard focus is on the email input in every enabled capture.

| Mode | Width | Theme | Before (disabled) | After (synthetic enabled) |
|---|---|---|---|---|
| company | 1280 | light | [Before](before-disabled-company-1280-light.png) | [After](after-enabled-company-1280-light.png) |
| company | 1280 | dark | [Before](before-disabled-company-1280-dark.png) | [After](after-enabled-company-1280-dark.png) |
| company | 375 | light | [Before](before-disabled-company-375-light.png) | [After](after-enabled-company-375-light.png) |
| company | 375 | dark | [Before](before-disabled-company-375-dark.png) | [After](after-enabled-company-375-dark.png) |
| search | 1280 | light | [Before](before-disabled-search-1280-light.png) | [After](after-enabled-search-1280-light.png) |
| search | 1280 | dark | [Before](before-disabled-search-1280-dark.png) | [After](after-enabled-search-1280-dark.png) |
| search | 375 | light | [Before](before-disabled-search-375-light.png) | [After](after-enabled-search-375-light.png) |
| search | 375 | dark | [Before](before-disabled-search-375-dark.png) | [After](after-enabled-search-375-dark.png) |

`capture.cjs` uses Playwright Core and locally installed React/ReactDOM 18.3.1 with a fresh isolated Edge context per case. Set `CAPTURE_TOOLS` to the isolated tool folder containing those packages and Playwright. Optional `EDGE_PATH` selects the local Edge executable. Run `node notes/product/screenshots/P-2.1bx/capture.cjs` from this checkout.

Every browser request is intercepted and fulfilled from the fixture or local files. Unexpected requests fail. Storage methods throw. Eight width/theme/mode cases passed: no horizontal overflow or page errors, no external requests, no storage calls, Enter opens and focuses email, Escape closes and returns focus, invalid input stays focused, Tab/Space selects explicit consent, Tab/Enter submits once, generic accepted feedback receives focus, an account generation change aborts pending work and ignores its late result, signed-out mode has no linkage checkbox, and state-only summary uses the approved All fields value. No provider or real recipient is contacted.

The fixture heading, labels identifying synthetic preview, invented employer and role are test scaffolding. Product-visible words are enumerated in [the package note](../../P-2.1bx-signup-form.md). Existing production dashboard mounting, request deadlines, current authorization, provider retention and actual sending remain outside this evidence.
