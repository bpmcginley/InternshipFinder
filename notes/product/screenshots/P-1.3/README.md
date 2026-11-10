# P-1.3 row presentation evidence

This PR is stacked on P-1.2 #187. It cannot merge until Bruce merges that parent, the PR is retargeted to main, and the integrated result is reviewed and validated. No plan text, profile storage, ranking, application action, or listing data is changed by this package.

Real headless Edge captures use isolated contexts, 1280 × 1000 and 375 × 1000 viewports, both color schemes, locale en-US, America/New_York, and a fixed clock of 2026-11-10 18:00 UTC. Before serves dashboard HTML/app.js from parent `98f22627`; after serves this PR. The existing setup-skip and intro-hide preferences are set equally for both, so the captures emphasize rows.

| Width/theme | Before | After |
| --- | --- | --- |
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

Additional evidence: [phone Details light](after-details-375-light.png), [phone Details dark](after-details-375-dark.png), [mock installed-extension controls and selection](after-installed-375-dark.png).

## Fixture and reproduction

All seven listings are explicitly synthetic, with `Fixture` employer names and application links on `jobs.example.com`. They cover a duplicate US location suffix, a second location, a Canadian province with diacritics, remote work restricted to Texas, Ashby/Lever/Other, numeric pay, a stipend, unpaid work, rejected zero pay, no posting date and a future date. These are illustrative amounts and listings, not production opportunities or business metrics. No application link is opened.

Every browser request is fulfilled locally. React and ReactDOM 18.3.1 are isolated local test dependencies; no dependency is added to the site. The final installed-extension case responds to the existing postMessage bridge locally; no real extension, account, application, mail, or provider is used. No new third-party request or image asset is introduced by the UI.

```powershell
$env:CAPTURE_TOOLS = 'C:\path\to\isolated-tools'
node notes/product/screenshots/P-1.3/capture.cjs before
node notes/product/screenshots/P-1.3/capture.cjs after
```

The isolated tools directory contains `node_modules/playwright-core`, `react`, and `react-dom`. The script launches the installed Edge executable with fresh browser contexts.

## Measured behavior

- All four width/theme combinations have no horizontal overflow or page errors.
- The chosen region and additional-location count stay intact; the full raw locations remain in the tooltip. Canada and Texas-only remote qualifiers remain visible. No row object is normalized or changed.
- Date-only postings retain their calendar date in the New York browser timezone. Today, yesterday and two days ago render as expected; the future posting shows its full date. The `time` element preserves the source date, the title has the full date, and screen readers receive the full date instead of duplicated visible text.
- Salary, stipend and unpaid badges are visible; unknown and rejected zero pay remain `Pay not listed`. No currency or payment status is inferred.
- Ashby appears in Details, not the collapsed row. Other has no job-board field. Escape closes Details and returns focus to its opener.
- Auto-Apply keeps its existing button, tooltip, disclosure state and label. The installed fixture retains selection and the custom-site access note without requesting a run or submission. Unit tests also retain the action callback and busy disabled state.
- All 360 possible company-tile hues were measured through actual computed CSS. Minimum text contrast is **6.50:1 light** and **7.78:1 dark**. Initials are decorative, deterministic and use Unicode graphemes when available, with a code-point fallback; empty names use `?`.

Baseline: 263 site tests passed before edits. Seven focused row-presentation tests pass. Full-suite, golden and final CI results are recorded on the PR.

## Visible strings and patterns

- Compact location: `{city}, {state or province}`; Canadian places retain `, Canada`; remote qualifiers remain. Additional locations now read ` +{N} more`. Raw tooltip strings and `Location not listed` are preserved.
- Visible posted date: `Posted today`, `Posted yesterday`, `Posted {N} days ago`, or `Posted {localized full date}` for a future date. Title: `{localized full date}`. Screen-reader text: `Posted {localized full date}`. Missing/invalid dates keep the existing Details fallback `Posting date not listed`.
- Details: `Job board: {existing board label}`. `Other` is omitted. The board name is removed from the collapsed row's date line.
- Tile: the uppercase first grapheme of the company name, or `?` for an empty name, hidden from assistive technology. The full company name remains beside it.
- Auto-Apply tooltip: `Fills from your resume. You review and submit.` The visible `Auto-Apply` text and all existing action/disclosure labels stay unchanged.
- Listing salary text, `Stipend`, `Unpaid`, and `Pay not listed` are reused unchanged; only listed pay receives a badge. These are listing facts, not plan prices.
