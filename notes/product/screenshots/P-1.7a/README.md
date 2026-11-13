# P-1.7a visual evidence

Fresh headless Edge 157 contexts, 1280x1000 and 375x1000 viewports, device scale 1, en-US, America/New_York; full-page PNGs in light and dark preferences. Only localhost routes were fulfilled; every external request was blocked, and none was attempted. No account, production API, analytics or real employer submission was used.

Before: source main `c6ef372f`. New builder and guide URLs return a local harness 404; the screenshot explicitly identifies this as the baseline checkout, not a production response. The existing widget uses two invented roles and a fixed public-format export timestamp for deterministic evidence. After uses the same fixture. All four before/after embed PNG pairs have identical SHA-256 hashes; `docs/widget/index.html` is unchanged.

| Width / theme | Builder before / after | Guide before / after | Embed before / after |
|---|---|---|---|
| 1280 / light | [before](before-builder-1280-light.png) / [after](after-builder-1280-light.png) | [before](before-guide-1280-light.png) / [after](after-guide-1280-light.png) | [before](before-embed-1280-light.png) / [after](after-embed-1280-light.png) |
| 1280 / dark | [before](before-builder-1280-dark.png) / [after](after-builder-1280-dark.png) | [before](before-guide-1280-dark.png) / [after](after-guide-1280-dark.png) | [before](before-embed-1280-dark.png) / [after](after-embed-1280-dark.png) |
| 375 / light | [before](before-builder-375-light.png) / [after](after-builder-375-light.png) | [before](before-guide-375-light.png) / [after](after-guide-375-light.png) | [before](before-embed-375-light.png) / [after](after-embed-375-light.png) |
| 375 / dark | [before](before-builder-375-dark.png) / [after](after-builder-375-dark.png) | [before](before-guide-375-dark.png) / [after](after-guide-375-dark.png) | [before](before-embed-375-dark.png) / [after](after-embed-375-dark.png) |

Observed checks: field=civil preselection; switching to Software and four roles updates escaped snippet and preview; clipboard success and denial recovery (focus plus full-text selection); keyboard skip link; selects/button at least 44px tall; no document horizontal overflow; zero page errors. Screenshots visually inspected for phone and desktop layout. The unchanged embedded viewer remains light even when the builder follows a dark preference.

Instructions verified against [Slack RSS help](https://slack.com/help/articles/218688467-Add-RSS-feeds-to-Slack) and [MonitoRSS setup](https://monitorss.xyz/) on 2026-11-10. The guide uses the existing generated page RSS link rather than inventing field URLs. No channel setup or message sending occurred.
