# P-2.3u publication evidence

Local synthetic production-entry builds use the checked-in golden inputs and actual export, standalone publisher, asset graph stamping and link audit. Before is the default publisher; after adds only `--employer-postings`. No real listing scrape or production request is used. Browser capture remains off in both artifacts.

Reproduce with the pinned Python/Pillow dependencies: `python notes/product/screenshots/P-2.3u/prepare.py ABSENT_TEMP_DIRECTORY`, then `node notes/product/screenshots/P-2.3u/capture.cjs ABSENT_TEMP_DIRECTORY` using isolated Playwright/Edge tooling. The browser script intercepts every page request; outside requests, including keyboard-activated posting popups, are aborted. It uses fresh contexts with 1280/375 by 1000 viewports and both color schemes. These are browser/DOM measurements, not screen-reader execution.

All 16 captures completed: two families (software engineering and highest-paying), before/after, both widths and themes. Eight before/after PNG pairs are byte-identical. Visible text, link href/target/rel, bounds and layout are exactly equal; no horizontal overflow or page errors. The after DOM contains the expected employer keys on 29 field and 24 pay organic posting links, no paid/Auto-Apply annotations, and no capture-enabling script attribute. Enter activates the same posting destination, intercepted locally. `report.json` records the matrix.

The default artifact has 830 files and exactly matches both existing golden fixtures. Opt-in has 831 files: one keys-only catalog (eight synthetic employers), six declared shard overlays, the first preview overlay and 576 generated HTML files with only direct-link attributes added. Every other file is byte-identical, including all native Core/App graph assets, dashboard, digest, feeds, widgets, descriptions, manifest/index, page dates, sitemap and share images. Stripping only employer-key properties/attributes restores the original data objects/HTML. The actual publication allowlist passes all 831 files with zero problems. No golden fixture was refreshed.

| Family and viewport | Before | After |
| --- | --- | --- |
| field, 1280, light | [before](before-field-1280-light.png) | [after](after-field-1280-light.png) |
| field, 1280, dark | [before](before-field-1280-dark.png) | [after](after-field-1280-dark.png) |
| field, 375, light | [before](before-field-375-light.png) | [after](after-field-375-light.png) |
| field, 375, dark | [before](before-field-375-dark.png) | [after](after-field-375-dark.png) |
| pay, 1280, light | [before](before-pay-1280-light.png) | [after](after-pay-1280-light.png) |
| pay, 1280, dark | [before](before-pay-1280-dark.png) | [after](after-pay-1280-dark.png) |
| pay, 375, light | [before](before-pay-375-light.png) | [after](after-pay-375-light.png) |
| pay, 375, dark | [before](before-pay-375-dark.png) | [after](after-pay-375-dark.png) |
