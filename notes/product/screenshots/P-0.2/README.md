# P-0.2 counter disclosure evidence

Bruce approved the counter disclosure on November 10, 2026. This PR publishes the approved substance with two narrow accuracy adjustments: future steps are conditional on the feature and counter being enabled, and the no-identifiers statement describes **stored totals**, because the browser sends a pathname before the server reduces it to a page kind. No worker deployment or additional collection is performed.

## Exact visible changes

The date becomes **Last updated November 10, 2026**. The following paragraph is inserted in Searching listings, after the existing sentence ending “as totals that say nothing about who.” Existing wording is otherwise byte-identical:

> When these features and their counters are enabled, we also count expanding a company's results, choosing a major, saving a role, opening My list, pressing a share link, opening our GitHub list or widget page, seeing the out-of-runs panel, and pressing its invite, top-up or plan controls. This includes opening or sending a company or search email-follow form, reaching its confirmation page, playing the demo, and pressing Print on a flyer. Each of these browser steps is counted at most once per page load, as a daily total by step and kind of page. These stored totals contain no account ID, email address, company, role, chosen major or search terms. They do not prove that an email subscription was confirmed, a purchase completed, or a flyer printed. These aggregate totals have no automatic expiry and cannot identify a person's activity for individual deletion.

## Source verification

- `docs/js/count.js:29-42,75-92`: opt-out, local/automated-browser exclusions, event deduplication and beacon payload. Each event is attempted at most once per page load. The request carries an event name and pathname; stored totals do not retain the pathname.
- `worker/src/visits.js:200-206,243-273`: accepted fixed event names increment only UTC day/event/bounded page kind/count; new P-0.2 names are absent from attributed-event selection. Unknown names do not write rows. Origin, bot and rate checks remain.
- `worker/schema.sql:124-130` defines the aggregate row. `worker/src/limits.js:554-580` cleanup removes campaign attribution after 400 days, but contains no automatic event-count deletion. These new step totals are not linked to accounts and cannot support individual deletion.
- `notes/product/P-0.2-counter-review.md` supplies the approved substance. Its historical proposal label is retained; the current approval and still-pending owner deployment are recorded in STATUS.

## Browser evidence

16 captures use the isolated stamped golden artifacts at baseline `686a590d` and the same build with this disclosure. Fresh headless Edge contexts, local fonts, 1280×1000 and 375×1000 viewports, both supported themes, en-US and America/New_York. External requests are blocked. No real provider call, submission, deployment or production visit occurs. All four cases have no document overflow or page errors. Counts-section crops are supplied beside full-page captures so the long policy is readable.

| Width/theme | Count section before | Count section after | Full before | Full after |
|---|---|---|---|---|
| 1280 light | [Before](before-1280-light-counts.png) | [After](after-1280-light-counts.png) | [Before full](before-1280-light-full.png) | [After full](after-1280-light-full.png) |
| 1280 dark | [Before](before-1280-dark-counts.png) | [After](after-1280-dark-counts.png) | [Before full](before-1280-dark-full.png) | [After full](after-1280-dark-full.png) |
| 375 light | [Before](before-375-light-counts.png) | [After](after-375-light-counts.png) | [Before full](before-375-light-full.png) | [After full](after-375-light-full.png) |
| 375 dark | [Before](before-375-dark-counts.png) | [After](after-375-dark-counts.png) | [Before full](before-375-dark-full.png) | [After full](after-375-dark-full.png) |

[Before measurements](before-measurements.json) and [after measurements](after-measurements.json) record dimensions and blocked origins. Reproduce with the isolated temporary playwright-core installation: set NODE_PATH and EDGE_BINARY, then run `node notes/product/screenshots/P-0.2/capture.cjs <extracted-site> before` or `after`. The script serves only local artifact bytes through intercepted requests.

## Golden boundary

Both stamped artifacts are regenerated. Exactly `privacy.html` changes; all other 694 files and all page-content-date records remain byte-identical. No input fixture, source generator, JavaScript, schema, worker or paid-policy wording changes. Removing the inserted paragraph and reverting only the visible date restores the previous privacy source exactly. Archive SHA-256: `4c7a031a2f6760285cd63896241c30f00a4a9f5c382ab78303c3711a3f831655`.

Baseline counter tests: 46 passed. Full Node 22 site suite, serial: 267 passed. Golden tests: two passed. Publication checker: 695 files, zero problems. Startup-budget estimate, capture-script syntax and diff checks pass. No application startup code changed; the local policy loads successfully in every capture.
