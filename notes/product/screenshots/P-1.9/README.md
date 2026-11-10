# P-1.9 employer entry evidence

This package is stacked on PR #206 at `f6e599ef`. Parents #194 and #206 must publish before this child is retargeted and integrated with fresh main for final review and CI. The source change is confined to the employer-only offer helper; no CSS, JavaScript, worker, checkout, data, pricing or terms implementation changes.

Before uses the parent's synthetic golden archive; after uses the same frozen fixture with the new entry. These are invented listings, not live openings or business metrics. Fresh headless Edge contexts use 1280×1000 and 375×1000, light/dark, device scale 1, en-US and America/New_York. Browser time is fixed at November 10, 2026, 12:00 UTC. Fonts and data are local; all external requests are blocked. The existing beacon is blocked in both phases.

| View | Before | After |
|---|---|---|
| Bose entry, 1280 light | [Before](before-bose-entry-1280-light.png) | [After](after-bose-entry-1280-light.png) |
| Bose entry, 1280 dark | [Before](before-bose-entry-1280-dark.png) | [After](after-bose-entry-1280-dark.png) |
| Bose entry, 375 light | [Before](before-bose-entry-375-light.png) | [After](after-bose-entry-375-light.png) |
| Bose entry, 375 dark | [Before](before-bose-entry-375-dark.png) | [After](after-bose-entry-375-dark.png) |
| Bose full, 1280 light | [Before](before-bose-full-1280-light.png) | [After](after-bose-full-1280-light.png) |
| Bose full, 1280 dark | [Before](before-bose-full-1280-dark.png) | [After](after-bose-full-1280-dark.png) |
| Bose full, 375 light | [Before](before-bose-full-375-light.png) | [After](after-bose-full-375-light.png) |
| Bose full, 375 dark | [Before](before-bose-full-375-dark.png) | [After](after-bose-full-375-dark.png) |
| Hostile/long name, 1280 light | [Before](before-stress-full-1280-light.png) | [After](after-stress-full-1280-light.png) |
| Hostile/long name, 1280 dark | [Before](before-stress-full-1280-dark.png) | [After](after-stress-full-1280-dark.png) |
| Hostile/long name, 375 light | [Before](before-stress-full-375-light.png) | [After](after-stress-full-375-light.png) |
| Hostile/long name, 375 dark | [Before](before-stress-full-375-dark.png) | [After](after-stress-full-375-dark.png) |

The unchanged buy page after following the new entry: [1280 light](after-prefill-1280-light.png), [1280 dark](after-prefill-1280-dark.png), [375 light](after-prefill-375-light.png), [375 dark](after-prefill-375-dark.png). Its config is intercepted and fulfilled locally with the existing employer-funnel unit-test fixture; this is not a statement about production buying availability. Listing index/shards come from the synthetic golden artifact. The company is Bose, no role is selected, terms are unchecked, and no POST or checkout navigation occurs. No worker or payment provider is contacted.

Keyboard checks focus the entry with Shift+Tab/Tab, then activate it with Enter. The exact company key remains `bose`. Long company text with ampersand, angle brackets and quotes renders as text, without injected elements or horizontal overflow. Both viewports fit; no page errors occur. The Bose link is 30 px tall at 1280 and wraps on the phone; no CSS or touch-target claim is added by this copy-only package. [Before measurements](before-measurements.json), [after measurements](after-measurements.json).

Golden proof: only eight employer HTML pages and `data/page-content-dates.json` change. Replacing the new employer-offer section with the parent's section restores each HTML file byte-for-byte. Within every section, the paid disclosure/price paragraph and all three link destinations are identical; one employer entry marker remains. All other site bytes and paths, including pricing, the date fixture, feeds, listing data and assets, are unchanged. Both golden manifest and archive were refreshed. `verify_delta.py` reproduces this proof.

Reproduction uses isolated temporary artifacts and playwright-core, with no repository dependency changes:

1. Extract the parent's golden archive into a temporary baseline folder and build the current fixture into another folder using `golden_build.prepare(work)` and `golden_build.build(work)`.
2. Run `python notes/product/screenshots/P-1.9/prepare_stress.py before <baseline-site>` and the same command with `after <current-site>`. This adds an explicitly synthetic capture-only page; it is never part of the golden/publication artifact.
3. Set `NODE_PATH` to the isolated `internscout-product-capture-tools/node_modules` directory and `EDGE_BINARY` to local Edge.
4. Run `node notes/product/screenshots/P-1.9/capture.cjs <baseline-site> before` and the same command with `<current-site> after`.
5. Run `python notes/product/screenshots/P-1.9/verify_delta.py <baseline-site>`. Audit publication using the unmodified golden archive, without the capture-only stress page.

No app startup path changed. The generated page and existing buy-page JavaScript start successfully in the local browser flow above; prefill is tested without submission.
