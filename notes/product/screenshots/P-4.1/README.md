# P-4.1 bounded landing cohort evidence

This package proposes five fixed cohorts: Summer 2027 software engineering, data science and finance; senior standing in Chicago; sophomore standing in Denver. It adds no remote aliases and no first-year metro page. These are candidate pages, not evidence of search demand. Owner merge and publication are pending; the four-week observation period has not started.

The baseline is published main `22948471`. Its unchanged golden fixture builds 695 files. Before screenshots show the existing internships hub. After screenshots show the same synthetic fixture and the new hub links; the new pages did not exist before this change. The golden fixture supports two of the five pilot pages (23 roles each, software engineering and finance). A separate, explicitly synthetic fixture built by `prepare_standing.py` exercises all five and supplies the Denver screenshots (22 invented roles). It does not alter the golden inputs or public export. No screenshot depicts current job availability.

| View | Before | After |
|---|---|---|
| 1280 light | [Hub](before-hub-1280-light.png) | [Hub](after-hub-1280-light.png), [season](after-season-1280-light.png), [standing](after-standing-1280-light.png) |
| 1280 dark | [Hub](before-hub-1280-dark.png) | [Hub](after-hub-1280-dark.png), [season](after-season-1280-dark.png), [standing](after-standing-1280-dark.png) |
| 375 light | [Hub](before-hub-375-light.png) | [Hub](after-hub-375-light.png), [season](after-season-375-light.png), [standing](after-standing-375-light.png) |
| 375 dark | [Hub](before-hub-375-dark.png) | [Hub](after-hub-375-dark.png), [season](after-season-375-dark.png), [standing](after-standing-375-dark.png) |

Real headless Edge, fresh browser contexts, 1000-pixel viewport height, reduced motion, and touch enabled at 375 pixels. `capture.cjs` fulfills all first-party page/assets requests from local generated files and aborts every external request, including the existing Cloudflare beacon. Zero external page requests were allowed. No provider, production site, analytics query, posting or application was contacted. Keyboard Tab reached a visible link; keyboard Enter followed a pilot hub link successfully at both widths and in both themes. No horizontal overflow or page script error occurred. The new primary dashboard targets measured at least 44 pixels high on the touch viewport. This is browser/DOM evidence, not a screen-reader execution claim.

The focused tests cover the ten-role floor, the existing 20-role index threshold, live/earning exceptions, malformed standing metadata, generic undergraduate exclusion, actual metro membership, ID deduplication, employer diversity, geographic spread, fixed cap, duplicate/collision prevention, stable ordering, fallback breadcrumbs, and honest displayed counts. The full-build comparison proves every existing page keeps its index/thin decisions and ordered listing IDs, and every existing page except the intentionally linked internships hub retains identical HTML. The thin-page test checks canonical/feed retention and sitemap exclusion through the existing writer, feeds and offline link auditor.

Baseline setup: the first global-Python invocation failed seven isolated packaging checks because the editable package was not installed. A private temporary virtual environment with an editable install of this worktree resolved them: 1165 backend and 490 growth tests passed, with the existing Windows filesystem-link permission, missing ffmpeg and missing cryptography skips. No shared interpreter or checkout was modified. Implementation tests excluding the pending golden refresh passed 1672 tests with the same three skips; 19 focused tests passed. After normally integrating main `52692137` (data refresh, data-path plumbing and token tooling), the complete Python suite including both golden tests passed 1677 tests with those three skips; all 319 serial Node 22 site tests passed. Python lint reported zero findings, startup reporting succeeded, and the 699-file publication allowlist audit had zero problems. Publication checker tests passed four cases with the existing Windows link-permission skip. All 699 archive hashes exactly match the manifest. Final CI and independent review remain required.

Golden diagnosis before integration: 699 output files; two added HTML/feed pairs, and changes only to `internships/index.html`, `sitemap.xml` and `data/page-content-dates.json`. Existing listing data, assets, existing role pages, feeds and remote canonicals remain byte-identical. No golden input has changed. Both artifacts were refreshed after integration validation. Every integrated output byte equals the output used for the captures. The content-date change is only the hub digest (its lastmod stays November 10) and the two new page records; other records remain identical.

New visible strings (substitutions are public selected-cohort counts/names):

- `Selected terms and class years`
- `Summer 2027 software engineering internships`; `Summer 2027 data science internships`; `Summer 2027 finance internships`
- `Internships for seniors in Chicago`; `Internships for sophomores in Denver`
- `{count} open student roles in this list.`
- `These roles are tagged Summer 2027 in the current export. Check each posting for its dates and requirements.`
- `These postings mention {senior|sophomore} standing in the title or extracted requirements. Roles that only say undergraduate are not included. Check each posting for its full requirements.`
- `Browse {software engineering|data science|finance} roles`
- `The dashboard includes other terms.`
- `Browse roles across {Illinois|Colorado}`
- `The dashboard covers the wider state and also includes roles without stated class-year requirements.`
- `Showing {shown} of {count} roles.`
- `More roles: {existing parent label}`
- Metadata description: `{count} open student roles. {cohort explanation above}`.

Existing navigation, breadcrumbs, listing actions, RSS label and Auto-Apply explanation are reused unchanged. Dashboard links deliberately describe the broader field or state view: no exact term or explicit-standing dashboard filter is invented. No new counter, storage, external asset, CSS, taxonomy, geography, export or configuration change is included.

Current public-export requalification on integrated main: snapshot `2026-11-11T04:42:46.457323+00:00`, 19,920 eligible IDs. The five pilot counts are software engineering 1,949, data science 666, finance 541, senior Chicago 73 and sophomore Denver 22, all indexed under the normal rules. A full in-memory build with and without the pilot preserved every one of 2,109 existing paths, index/thin flags and ordered role IDs; existing HTML was byte-identical except the intended hub links. The five existing indexable remote-field paths remain unchanged. Explicit first-year metro maximum is still three. This uses checked-in public data and no live sitemap or private earning evidence; it is a data/selection check, not a search-performance measurement.
