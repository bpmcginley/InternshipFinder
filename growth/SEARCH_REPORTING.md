# Reading search and visit reports

The October 28, 2026 reporting change separates a Google visibility loss from a change in total site traffic. The collector is `growth/metrics.py`, run by the existing hourly Dashboard metrics workflow. Its private output remains in the existing `metrics_daily` and `metrics_snapshot` D1 tables. No new analytics provider or credential is needed.

Google documents Pacific dates, final data, optional incomplete-date metadata and API row limits in its [Search Analytics query reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query). The crawl check uses Google's [read-only URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).

## Labels for the private dashboard

| Existing or new field | Display label and interpretation |
|---|---|
| `metrics_daily.visits` | Cloudflare estimated visits, all sources, UTC. Today's row is partial. |
| `metrics_daily.search` | Cloudflare estimated visits from all search engines and supported AI referrers, UTC. This is not a Google-only figure. |
| `snapshot.week.coverage` | Show the UTC request bounds, partial dates and omitted sample dates beside that chart. An omitted successful sample is a zero estimate, not proof of zero visitors. |
| `snapshot.week.search_engines.days` | Cloudflare estimated Google, Bing and other-search arrivals by UTC day. Google mail, maps and sign-in hosts are excluded. Referring hosts do not prove a visit was an organic search click. |
| `snapshot.search_console.totals_7d` and `totals_28d` | Google finalized search clicks, impressions, CTR and weighted position. Use the explicit Pacific date range in `search_console.reporting`, not "through today". |
| `snapshot.search_console.reporting` | Show timezone, start/end, seven-day start, final data state and completeness boundary. If Google's optional metadata is absent, the stated conservative three-day lag applies. |
| `snapshot.search_console.comparison.weeks` | Two complete Monday-Sunday Pacific weeks, oldest first. These contain final site totals and private, bounded page and query breakdowns. |
| `snapshot.search_console.fixed_page_cohort` | A page-by-date query for those same two weeks keeps the same eight employer URLs: treatments Under Armour, Medtronic, Lyft and Bose; unchanged comparators Shure, Sun Life, UL Solutions and Capital One. Check status before comparing the groups. |
| `snapshot.week.search_engines.comparison.weeks` | Cloudflare estimated Google/Bing/other-search arrivals for the exact same Pacific weeks. UTC bounds account for daylight-saving changes. Check `status` before rendering. |
| `snapshot.search_console.url_inspection` | Google's last observed crawl/indexing status for Under Armour, Medtronic, Lyft and Bose treatment pages. A later `lastCrawlTime` is evidence of recrawling, not a ranking or indexing guarantee. |

Existing dashboard keys and the `metrics_daily` schema remain compatible. The Google headline range intentionally ends on a finalized date rather than the current partial day. A private dashboard hosted outside this repository must use the date and measurement labels above when it adopts the new fields.

## Compare like with like

Compare Google's complete week with the previous complete week. Compare its clicks with the Google-only Cloudflare estimate, then check Bing, social and direct traffic separately. A rise in total or combined-search visits can coexist with a real Google loss.

Use `comparison.weeks[].pages[].url` for canonical URL identity. The old `path` remains for existing consumers, but path alone can combine different hosts or schemes. Both weekly page lists and query lists have explicit limits, returned counts, cap flags and `exhaustive: false`. Google can omit rows for privacy/internal limits even below our cap. Absence from a returned cohort does not mean zero impressions or deindexing. Site totals come from a separate date-only query, never from summing the bounded page/query lists. Average positions must be compared for the same query/page cohort before attributing every movement to ranking.

The October 28 content cohort uses comparators with returned October 12-18 impressions: Shure 76,
Sun Life 54, UL Solutions 52 and Capital One 46. These replace the initially proposed low-traffic
Sonos/Stryker/Pinterest/URBN set. They are observational comparisons across different employers,
not randomized controls. The exposure rules, initial factual coverage and revert are documented
in `reviews/2026-10-28-search-content-cohort/README.md`.

If Google supplies `metadata.first_incomplete_date`, every headline date ends before that boundary. The collector still requests `dataState: final` explicitly. When metadata is absent, it reports the three-day fallback instead of assuming the last nonzero row marks finalization. A zero-impression final day never slides the reporting window backward.

Cloudflare uses adaptive samples. Total, landing-page and referrer estimates are separate queries and can disagree at low traffic. Do not turn those estimates into exact conversion rates or call a zero sample "zero users". Failed/malformed requests preserve existing daily rows and put the error in the snapshot. A successful omitted date overwrites its stale daily estimate; `week.coverage.omitted_days` records why.

## Bounds and privacy

Google collection uses nine Search Analytics requests: one completeness probe, one final date series, the two legacy top lists, four requests for the two matched-week page/query lists, and one exact-URL-filtered page-by-date request for the fixed eight-page experiment. Each weekly list is capped at 500 pages or 250 queries. The fixed cohort has at most 112 possible page-days and a 1,000-row cap, so a top-page list limit cannot hide a treatment or control. Its omissions still do not prove deindexing. Cloudflare adds two matched-week referrer requests, each capped at 5,000 hosts. A failed optional cohort remains `status: unavailable` without erasing successful site totals.

The four URL Inspection requests use the same existing read-only Google token, have a ten-second timeout each and stop at the first 403. They only read Google's last crawl state; they do not request indexing, change permissions or create persistent access. A missing permission is an optional unavailable result.

Queries, full URL cohorts and detailed inspection results remain in the private D1 snapshot. Public workflow logs show counts for query lists, canonical URL cohorts and inspections instead of those details. Existing retention applies: every snapshot for two days, then the last snapshot per day, then deletion after 120 days. Nothing is written into the public `docs/` tree.

Revert: restore the earlier `growth/metrics.py` collector and its tests. There is no database migration to reverse; old dashboard keys remain readable.
