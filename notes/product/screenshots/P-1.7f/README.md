# P-1.7f dashboard footer links

The dashboard footer adds the same two links as the published install page. They follow Install extension and precede Also check Handshake.

| Link text | Destination | Existing marker |
| --- | --- | --- |
| Internships for every major on GitHub | [Public GitHub list](https://github.com/bpmcginley/internships-every-major) | `data-distribution="list"` |
| Put live internships on your club or department site | [Widget builder](https://internscout.org/widget/builder.html) | `data-distribution="widget"` |

| Width and theme | Before | After |
| --- | --- | --- |
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

The capture script uses isolated Edge contexts with synthetic listings and locally fulfilled assets. It blocks remote requests and checks both exact destinations, link labels, tab order and overflow. The screenshots show the full viewport scrolled to the footer, with PNG widths checked at 1280 and 375 px. The two phone links each fit on a single line in the 375 px captures.

The stacked branch predates the published distribution counter delegate. The separate integration simulation loads published `count.js` from `700d1ddc` against the dashboard DOM and intercepts every request and beacon. It activates each link twice by keyboard and checks one existing named event per link for the page. Fresh main integration still needs to verify the actual combined assets.

Run `node notes/product/screenshots/P-1.7f/capture.cjs before` and `node notes/product/screenshots/P-1.7f/capture.cjs after` with `CAPTURE_TOOLS` set to isolated tooling containing Playwright Core and React 18.3.1. The `delegate` argument runs only the integration simulation.

PR #217 is stacked on #211 at `0dd68bbe`. Retargeting and fresh checks follow approval and integration of #187, #193, #204, #210 and #211.

Both golden tests pass. All 695 archive entries match the manifest, and the only public output difference from the parent is `js/app.js`.

The final serial site rerun on Node 22.23.4 passed all 312 tests. The first integrated run passed 311 of 312 after one row moved in the existing incremental ranking comparison, which recalculates scores against the live clock. The isolated test and the full rerun passed on the same source. Targeted ESLint, the startup budget report and the whitespace check also passed.
