# Employer browser capture: local proof

The fixture uses the existing P-2.3n synthetic stage/render preparation: 30 fake roles in real generated field and highest-paying pages. Run its `prepare.py ABSENT_TEMP_DIRECTORY`, then this folder's `capture.cjs TEMP_DIRECTORY`. The before script is the exact counter at integration baseline `aea5f010`; the after script is this package. The counter source at `aea5f010` and newly integrated main `61def2fd` is identical. The renderer and styles used by these captured pages are unchanged by that integration.

All page requests are intercepted. HTML, scripts and fonts come from local files; the fixture origin is simulated as an allowed site hostname. Native sendBeacon requests are fulfilled locally and their JSON is inspected. Other destinations, including synthetic posting popups and third-party beacons, are aborted. No network request reaches the production site, Worker or employer. Positive cases override navigator.webdriver only in the fixture context to simulate an ordinary eligible browser; the separate unmodified headless case proves automation exclusion. This is not deployed telemetry or a provider test.

Sixteen captures cover before/after field and highest-paying pages at 1280/375, light/dark. All eight pairs are PNG byte-identical. Visible text, link geometry, href/rel/target, keyboard navigation and no-overflow checks pass. No employer event occurs on load; Enter on the first posting produces exactly one only with the explicit fixture activation attribute. The attribute is not written into any production HTML.

Real browser cases also verify missing activation, webdriver, nocount, standalone widget path and iframe exclusion. Nested click targets and HTML-escaped employer keys preserve the canonical payload. Dynamically inserted fixture links prove paid/placement/sponsored, Auto-Apply, unmarked saved-only, explicit exclusion, programmatic click and malformed-key rejection; two links for one employer deduplicate, different employers count separately, and middle/modified activation retains native behavior. Every employer body has exactly e and c. Unit tests cover UTF-8 limits, prerender state, beacon refusal/throw, page-reset and 10,000-key memory bounds. No screen-reader execution is claimed.

The authorized golden refresh preserves all 808 baseline paths from `61def2fd`: 644 HTML files change only the count.js version stamp, and count.js itself changes. All other bytes and all archive/manifest hashes match; see golden-report.json. No public copy or styles change.

| Page, width, theme | Before | After |
|---|---|---|
| field, 1280, light | [Before](before-field-1280-light.png) | [After](after-field-1280-light.png) |
| field, 1280, dark | [Before](before-field-1280-dark.png) | [After](after-field-1280-dark.png) |
| field, 375, light | [Before](before-field-375-light.png) | [After](after-field-375-light.png) |
| field, 375, dark | [Before](before-field-375-dark.png) | [After](after-field-375-dark.png) |
| pay, 1280, light | [Before](before-pay-1280-light.png) | [After](after-pay-1280-light.png) |
| pay, 1280, dark | [Before](before-pay-1280-dark.png) | [After](after-pay-1280-dark.png) |
| pay, 375, light | [Before](before-pay-375-light.png) | [After](after-pay-375-light.png) |
| pay, 375, dark | [Before](before-pay-375-dark.png) | [After](after-pay-375-dark.png) |
