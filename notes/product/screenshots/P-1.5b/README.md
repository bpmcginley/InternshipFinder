# P-1.5b generated phone layout

All captures use the offline golden build's synthetic listings, fixed at 2026-11-10. Baseline screenshots were captured from `f4504cb1`; all 695 golden manifest entries were verified identical to starting main `182c02ce` before reuse. The later install-footer integration does not change these generated pages or fonts. No production listing counts or usage measurements are shown.

Fresh headless Edge contexts: 1280 x 1000 and 375 x 1000, device scale 1, light/dark, en-US and America/New_York. Local fonts/assets only; every external request was blocked (the existing Cloudflare analytics script). No script errors. `capture.cjs` reproduces after captures against an extracted synthetic golden archive; configure an isolated playwright-core through NODE_PATH and Edge through EDGE_BINARY. It never accesses production.

At 375 pixels, tracker/pay navigation drops from three rows and a 142.5px header to one row and a 111px header; all three primary links measure at least 44px high. About, Pricing, Compare and employers remain in the footer; the enabled internship email link is also reachable there. Comparison navigation also fits one row. Desktop header dimensions remain unchanged.

Every phone table is 335px wide with no internal horizontal overflow. The original comparison table required 620px. The explicit long-name stress fixture substitutes `SyntheticInternationalLaboratory` and `By Sep 17, 2026` into the first tracker row: before, the table was 425px and the third column started beyond the viewport; after, all values fit. Stress screenshots are labelled and are not production evidence. The after stress capture also shows the retained keyboard focus outline.

Chrome's accessibility tree retains every table and column header in both layouts, plus one row header per data row: tracker 8/3, pay 18/8 and comparison 5/4 row/column headers. Redundant visible labels are aria-hidden. All named table wrappers can still receive keyboard focus. These browser checks do not claim a manual screen-reader test or Safari coverage.

| Page and width | Before light | After light | Before dark | After dark |
|---|---|---|---|---|
| Tracker 1280 | [Before](before-tracker-1280-light.png) | [After](after-tracker-1280-light.png) | [Before](before-tracker-1280-dark.png) | [After](after-tracker-1280-dark.png) |
| Tracker 375 | [Before](before-tracker-375-light.png) | [After](after-tracker-375-light.png) | [Before](before-tracker-375-dark.png) | [After](after-tracker-375-dark.png) |
| Pay 1280 | [Before](before-pay-1280-light.png) | [After](after-pay-1280-light.png) | [Before](before-pay-1280-dark.png) | [After](after-pay-1280-dark.png) |
| Pay 375 | [Before](before-pay-375-light.png) | [After](after-pay-375-light.png) | [Before](before-pay-375-dark.png) | [After](after-pay-375-dark.png) |
| Compare 1280 | [Before](before-compare-1280-light.png) | [After](after-compare-1280-light.png) | [Before](before-compare-1280-dark.png) | [After](after-compare-1280-dark.png) |
| Compare 375 | [Before](before-compare-375-light.png) | [After](after-compare-375-light.png) | [Before](before-compare-375-dark.png) | [After](after-compare-375-dark.png) |

Stress fixture: [before 1280](before-tracker-long-name-stress-1280-light.png), [after 1280](after-tracker-long-name-stress-1280-light.png), [before 375](before-tracker-long-name-stress-375-light.png), [after 375](after-tracker-long-name-stress-375-light.png). Numeric results are in [after-measurements.json](after-measurements.json).
