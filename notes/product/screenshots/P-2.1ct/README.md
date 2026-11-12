# Company Details Follow evidence

`capture.cjs BEFORE_SITE AFTER_SITE` runs local Edge through the existing isolated Playwright tool directory. All resources and API calls are intercepted. Before is the 846-file golden archive at `8bd7a5b2`; after is this package's refreshed archive. The fixture replaces public synthetic listing company facts and adds the reviewed dedicated annotation. The release attribute and optional synthetic native session exist only in intercepted test HTML/browser memory.

Twenty fresh-context scenarios cover both widths (1280 and 375), light/dark, default-off, anonymous and explicit linking, plus missing/malformed/closed/root-index fallback. Each width/theme has one before and two enabled PNGs; all four default-off recaptures equal the before PNG bytes. All 12 final PNGs also equal the initial layout captures after the nonvisual source-fence refinement. `report.json` records scenario outcomes; `artifacts.json` records the exact golden delta and archive hash. No credential values are saved.

Keyboard Enter opens Details and the company form, email receives focus, controls are at least 44px high and no horizontal overflow occurs. Idle Escape closes only the form; busy Escape leaves the form and Details open, while explicit Details close aborts the request. The suite verifies exact company-only body, unchecked linking, no referrer, empty 202, malformed 200, stale result suppression, reopen reset and sign-out. A test-only intercepted Core return exposes its actual store for changed-key and synchronous init/reset cases; no hook is added to shipped source.

Reproduce from the repository root with Node 22 and the existing offline capture tools:

```powershell
npm exec --offline --package=node@22.23.4 -- node notes/product/screenshots/P-2.1ct/capture.cjs BEFORE_SITE AFTER_SITE
npm exec --offline --package=node@22.23.4 -- node --test --test-concurrency=1 tests/site/*.test.mjs
python -m pytest backend/tests/test_golden_build.py backend/tests/test_site_links.py -q
```

The fixture uses local React/fonts and intercepts analytics rather than contacting them. `externalRequests: 0` means no request escaped interception. These are offline behavior/layout tests, not production signup or delivery evidence.
