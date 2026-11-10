# P-1.7e generated distribution evidence

This package is stacked on reviewed PR #194 at `9dad8284`. The parent must merge first; then this child must integrate fresh main, retain #200's published install/count files, refresh both golden artifacts and pass review/CI again. No worker deployment or external publication was performed.

All screenshots use the synthetic golden fixture, not live listings or business metrics. Before is the parent golden archive. After is the same frozen-clock build with this package. Fresh headless Edge contexts use 1280×1000 or 375×1000, light/dark, device scale 1, en-US and America/New_York. Only local artifacts are served. Existing Cloudflare beacon attempts are blocked; no external request is allowed. Fonts are local.

| View | Before | After |
|---|---|---|
| Field full, 1280 light | [Before](before-field-full-1280-light.png) | [After](after-field-full-1280-light.png) |
| Field full, 1280 dark | [Before](before-field-full-1280-dark.png) | [After](after-field-full-1280-dark.png) |
| Field full, 375 light | [Before](before-field-full-375-light.png) | [After](after-field-full-375-light.png) |
| Field full, 375 dark | [Before](before-field-full-375-dark.png) | [After](after-field-full-375-dark.png) |
| Field footer, 1280 light | [Before](before-field-footer-1280-light.png) | [After](after-field-footer-1280-light.png) |
| Field footer, 1280 dark | [Before](before-field-footer-1280-dark.png) | [After](after-field-footer-1280-dark.png) |
| Field footer, 375 light | [Before](before-field-footer-375-light.png) | [After](after-field-footer-375-light.png) |
| Field footer, 375 dark | [Before](before-field-footer-375-dark.png) | [After](after-field-footer-375-dark.png) |
| Compare footer, 1280 light | [Before](before-compare-footer-1280-light.png) | [After](after-compare-footer-1280-light.png) |
| Compare footer, 1280 dark | [Before](before-compare-footer-1280-dark.png) | [After](after-compare-footer-1280-dark.png) |
| Compare footer, 375 light | [Before](before-compare-footer-375-light.png) | [After](after-compare-footer-375-light.png) |
| Compare footer, 375 dark | [Before](before-compare-footer-375-dark.png) | [After](after-compare-footer-375-dark.png) |

The unchanged builder after following the new field link: [1280 light](after-builder-1280-light.png), [1280 dark](after-builder-1280-dark.png), [375 light](after-builder-375-light.png), [375 dark](after-builder-375-dark.png). These four flow captures show Mechanical preselected and its iframe code. The test clipboard is memory-only within the fresh browser context, leaving the user's clipboard untouched.

Measured checks: every added link is keyboard reachable via Shift+Tab/Tab and at least 44 px tall. Links fit within both viewport widths, and both pages have no document overflow. Enter on the field link opens `/widget/builder.html?field=mechanical`; the selection, preview URL and copied iframe code retain that canonical tag. No page errors occurred. [Before measurements](before-measurements.json), [after measurements](after-measurements.json).

The child golden delta is exactly 555 generated HTML files plus `data/page-content-dates.json`: shared footer/CSS on all generated families, and ten field-specific lines. `verify_delta.py` removes only the reviewed additions and proves every changed HTML file then equals the parent's bytes. All other output bytes, paths, feeds, listing/widget data and static assets are identical. Both golden artifacts were refreshed.

One approved fixture input changes: `/pricing/`'s prior digest is recalculated with the production `page_dates.fingerprint('/pricing/', html, datetime(2026, 11, 10, 12, tzinfo=timezone.utc))` over the newly generated synthetic pricing HTML. The digest is `e3516f9b4e4fec0d5480624298ad124734966ec874d4e7cc5c1098757bd57cb6`. Its November 1 date, the deliberately changed `/about/` fixture, production date code and golden date assertions remain unchanged. This keeps both unchanged-date and changed-date coverage after the intentional shared footer change. The verification script checks this derivation too.

Reproduce with the existing golden build tooling and isolated temporary playwright-core installation:

1. Extract the parent's golden archive into a temporary `p17e-before` directory; do not use live data.
2. Build the current golden fixture into a separate temporary workspace with `golden_build.prepare(work)` and `golden_build.build(work)`.
3. Set `NODE_PATH` to the isolated `internscout-product-capture-tools/node_modules` directory and `EDGE_BINARY` to the local Edge executable.
4. Run `node notes/product/screenshots/P-1.7e/capture.cjs <baseline-site> before` and `node notes/product/screenshots/P-1.7e/capture.cjs <current-workspace/site> after`.
5. Run `python notes/product/screenshots/P-1.7e/verify_delta.py <baseline-site>`.

The existing founder-name test uses HTMLParser to exclude only an actual anchor's `href` value equal to the requested public repository URL. Regression cases reject the literal attribute string in visible text, `data-href`, other elements/attributes, comments, script text, case variants and escaped names. Final SEO/distribution validation passes all 158 tests; Ruff and diff checks pass. Production source, public assets, golden files and screenshots remain byte-identical to the reviewed implementation. No public text naming the founder was added.
