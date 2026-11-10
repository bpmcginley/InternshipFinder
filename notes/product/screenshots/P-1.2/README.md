# P-1.2 first screen evidence

Real headless Edge captures at 1280 × 1000 and 375 × 1000, light and dark, using isolated browser contexts. Full-page images also show the relocated plans sentence beside footer sign-in. `before` serves dashboard HTML and app.js from main `aef83ea3`; `after` serves this PR. `after-selected` shows the optional questions and immediately reranked listings after choosing Statistics and Data Science.

| Width / theme | Before | After | After choosing a major |
| --- | --- | --- | --- |
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) | [Selected](after-selected-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) | [Selected](after-selected-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) | [Selected](after-selected-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) | [Selected](after-selected-375-dark.png) |

The deterministic fixture copies the 12 public rows from `aef83ea3:docs/data/first.json`; it is not a production activity measurement. The clock is fixed at 2026-11-10 18:00 UTC. All requests are fulfilled locally. React 18.3.1 and ReactDOM 18.3.1 are local test dependencies; no site dependency changed. The synthetic config uses public test prices already present in `tests/site/core.test.mjs` to exercise the plans line. Those prices are test fixtures, not a fetched or asserted current production price. No sign-in, applications, mail, production writes, or external fetches occur.

Run from the repository root with an isolated directory containing `node_modules/playwright-core`, `react`, and `react-dom`:

```powershell
$env:CAPTURE_TOOLS = 'C:\path\to\isolated-tools'
node notes/product/screenshots/P-1.2/capture.cjs before
node notes/product/screenshots/P-1.2/capture.cjs after
```

The browser assertions check:

- At both widths and in both themes: no horizontal overflow or page errors; the same major combobox retains focus through the first keyboard selection, and Tab reaches the optional year; Statistics and Data Science immediately moves Mason above Echo; optional answers remain blank when skipped; Done focuses the listing heading; reload restores the selected major without repeating the first-visit panel.
- Existing field, explicit state, company, search, stage and status filters survive selection. A landing-page field does not autosave a profile, and choosing a different major does not clear that field filter. Optional year/state updates preserve the explicit state filter, stored statuses and saved searches.
- A delayed extension profile response cannot overwrite a newer manual major, and a checked listing remains selected through reranking. An earlier imported profile retains its minors, fields, terms, stages, graduation term, work authorization and other preferences through partial major/year edits.
- Delete resets the quick panel and removes its previous ranking announcement. Blocked local storage still allows current-page ranking; reload persistence is unavailable in that case.
- A failed major file displays a fallback message and still opens the full profile editor's field choices. Details remains available before a profile, without repeated row ranking buttons.
- Not now focuses search and persists the existing skip flag; reloading still leaves full profile setup reachable, including the landing-page major prefill without autosaving it.
- The unchanged config-derived plans sentence appears once, in the footer, outside the figures. Its original `IS.plansBanner` visibility gate remains independent of sign-in button visibility.

## Visible strings

New panel copy: `I study`; `Start typing your major`; `Choose a major to rank these listings. Your choices stay in this browser.`; `Class year (optional)`; `Skip for now`; `Preferred states or provinces (optional)`; `Anywhere`; `Open profile setup`; `Done`; `Not now`.

Loading/fallback: `Loading the list of majors…`; `The major list didn't load. Open profile setup to choose fields instead.`

Live status patterns: `Ranking for {comma-separated selected majors}. Your current search filters still apply.`; `No major selected. Your current search filters still apply.`; `Preferences updated. Your current search filters still apply.` Accessible section name: `Rank for your major`. Existing major/year/state option labels and shared combobox labels are reused unchanged.

Relocated exact existing pattern: `Plans: free with any email; {config plan label} {config price} and {config plan label} {config price} raise the allowance. Prices`. The original config-dependent joining logic and visibility gate are unchanged. Removed first-visit text: `Rank these for your major` (or `Rank these for {landing major}`), `Three short steps. Your profile stays in this browser.` Removed repeated row/Details button: `Rank for my major`.

The new aggregate event is `major_quick_set`; it sends no selected major or other typed values. Its recording depends on the separately authorized P-0.2 worker/privacy deployment. Existing browser profile storage is reused. No new storage key or third-party request is added.

The plans-sentence relocation makes the entire PR **needs-bruce**; leave it open. P-1.3 and P-1.4 wait for this shared app.js change to merge.
