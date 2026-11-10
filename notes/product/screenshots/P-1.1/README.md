# P-1.1 company-run evidence

Before is main `3eb55beb`. After is this package. Captures use headless Microsoft Edge in a new browser context at widths 1280 and 375, height 1000, device scale 1, both light and dark. PNGs capture the full page, preserving the specified width. The clock starts at 2026-11-10 18:00 UTC with en-US and America/New_York settings.

`public-listings.json` is the twelve public rows copied verbatim from that revision's `docs/data/first.json`. It contains the nine consecutive REGENT listings behind the original report. These are fixture listing counts, not private business measurements. Index and statistics responses reflect this small fixture. All service requests receive local stub responses; existing React CDN requests receive local React 18.3.1 files. No posting, email or account action occurs.

| Width/theme | Before | After |
|---|---|---|
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

Observed in each browser context: twelve rows before, five displayed rows after, no JavaScript page errors and no document overflow. The button measures 36 px high with the desktop pointer used by these captures. An extra long-company-label probe wraps without table overflow. Enter expands seven rows, focuses the first revealed listing, and announces twelve of twelve shown. The footer and list-end count agree. Expansion leaves local storage unchanged and calls only `group_expand`. Company sort and REGENT search show all matching rows without grouping.

The existing 150-result pagination remains separate from displayed counts. A collapsed button counts only the remainder of its current-page run. Loading another page grows that run; an already expanded run stays expanded. Header selection includes only displayed listings and revealing rows does not select them.

Validation: 244 baseline site tests, then 251 passing updated tests under Node 22 with no skips. The startup payload report exits 0: app gzip grows by 802 bytes, dashboard HTML by 36 bytes. This is a payload measurement, not browser timing. After merging main's golden harness, the comparison detected only `index.html` and `js/app.js`; the intentional refresh updates only those hashes and corresponding archive bytes. Both golden tests pass, including deliberate template-mutation rejection. Generated page families are unchanged.

Reproduce with Node and an isolated tooling directory, outside the repository:

```powershell
npm install --prefix $env:CAPTURE_TOOLS --no-audit --no-fund playwright-core react@18.3.1 react-dom@18.3.1
node notes/product/screenshots/P-1.1/capture.cjs before
node notes/product/screenshots/P-1.1/capture.cjs after
```

Set `CAPTURE_TOOLS` first to that directory. The script launches the normal Edge executable with a fresh headless context; it does not use a signed-in browser. Runtime source, the public fixture and capture code are reviewable in this PR. New aggregate event recording remains pending P-0.2 privacy approval and Bruce's worker deployment.
