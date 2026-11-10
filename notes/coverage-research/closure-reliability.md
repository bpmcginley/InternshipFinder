# Closure reliability, October 16 and 18, 2026

Implemented locally. No production database, paid searches, applications or deployments were used.

## Reproduced problem

`pipeline.run` inferred the sources scanned from the **accepted listings** in the
current batch. If employer A's Greenhouse scan succeeded and employer B's failed,
both employers appeared to be covered by the source name `greenhouse`. An unseen
listing from B could be closed. Conversely, a successful board returning zero
listings could not close its old entries because its source name never entered
that set. Search-only and community-list-only runs could also close postings
merely absent from that day's limited results.

## Resulting behavior

Absence only closes a listing when explicit successful, complete evidence exists
for its exact `(ATS, employer token)` board. The CLI carries that evidence from
`scan_boards(..., completed_boards=...)` to `run(..., completed_boards=...)`.
The default is an empty evidence set, making standalone/fixture callers safe.

Greenhouse, Lever, Ashby and Recruitee expose exhaustive list endpoints. Their
fetchers validate the expected list payload and explicitly signal completion.
Valid empty lists authorize closure for that employer. Malformed HTTP 200 payloads
raise an error instead of masquerading as empty boards. Detail enrichment limits
do not truncate those endpoints' posting inventory.

As of October 16, other adapters did not prove pagination exhaustion (the
October 18 update below changes this). Their successful returns,
including empty returns, remain insufficient evidence for absence closure. Failed,
blocked and capped board scans never authorize it. Google Jobs, community lists
and public feed refreshes likewise do not authorize absence closure: their
current interfaces do not prove exhaustive coverage.

Existing `SourceLink.source_url` and `Listing.apply_url` recover employer
provenance without a schema migration. All recoverable employer boards for a row
must have completed; unresolved ATS provenance retains it. Employer evidence can
close a posting originally discovered through Google or a community list.
Source URLs/timestamps refresh on observation. A posting URL seen in the raw
batch remains protected even when missing enrichment or changed metadata causes
it to be rejected by current filters.

Explicit `active=False` continues to close a fetched posting; it does not depend
on absence inference.

## Validation

Offline SQLite regression coverage includes a failed board beside a successful
board on the same ATS, successful empty boards, incomplete/capped evidence,
unresolved provenance, raw presence with rejected metadata, validated empty versus
malformed responses, and separate `--ats`, `--lists`, and `--google` CLI modes.
The initial targeted run passed 39 tests across closure, board scanning and
pipeline suites. The backend suite at this workstream's completion passed 633
tests, with two optional/environment checks skipped; other workstreams are still
being integrated.

## Update, October 18, 2026: every adapter that can prove a full scan now does

The October 16 change let only Greenhouse, Lever, Ashby and Recruitee close a
listing by absence. Every other board adapter, Workday included, could never do
it, so a closed role on those boards stayed open. This update adds completion
evidence to each adapter whose API makes a full read provable, and makes the
static export obey the same evidence.

### How an adapter proves a full scan

An adapter calls `mark_complete` (in `sources/common.py`) only at the very end
of a fetch, and only when the rows it read add up to the total the API reported
on the first page. Any of the following leaves the board without evidence:

- a page cap was reached (Workday 400 results per keyword, Oracle 600, Taleo
  200, Eightfold 120, iCIMS career sites 300, SmartRecruiters 500, ADP 1,000);
- the Workday read stopped early because the tail held no internships;
- a page came back empty or short before the total was reached;
- the total or the rows list was missing or not a number;
- any keyword search, or any page, failed. The error propagates, so
  `scan_boards` records the board as failed and adds no evidence.

A response that is not a JSON object at all raises an error.

### Adapter by adapter

Authoritative over the whole board (`FULL_LIST`), so a missing posting is closed
however it was first found:

| Adapter | Evidence |
| --- | --- |
| Greenhouse, Lever, Ashby, Recruitee | unchanged: one exhaustive list call |
| Workable | the widget call is unpaged; a well formed `jobs` list counts |
| BambooHR | `/careers/list` is unpaged; `result` must be a list, and must match `meta.totalCount` when one is given |
| Rippling | the v1 board call is unpaged; only a bare array counts, since an object wrapper could be one page of a paged answer |
| ADP | every requisition read up to `meta.totalNumber` |

Authoritative only for what their keyword searches return (`SEARCH_SCOPED`):

| Adapter | Evidence |
| --- | --- |
| Workday | every search the run made read to its `total`: intern, student on health boards, and any words in `WORKDAY_EXTRA_KEYWORDS` (co-op is opt-in since October 19) |
| Oracle | every keyword read to its `TotalJobsCount` |
| SmartRecruiters | the intern search read to its `totalFound` |
| Taleo | every keyword read to its `pagingData.totalCount` |
| Eightfold | every keyword read to its `count` |
| iCIMS career sites | the one query read to its `totalCount` |

A keyword scan proves that every search result was read, not that every job on
the board was. So its evidence only closes a posting that the adapter itself
found on an earlier run. A posting known only from Google Jobs or a community
list may have a title the keywords never match (a "Summer Analyst" never answers
a search for "intern"), and is kept.

Not authoritative, and why:

| Adapter | Reason |
| --- | --- |
| iCIMS portal | HTML search pages with no result total, a 5 page cap, and a read that stops on the first page with no internships |
| SuccessFactors | HTML search pages with no result total and a 5 page cap per keyword |
| Jobvite | one HTML page with no total; nothing shows whether large boards paginate |
| JazzHR | one HTML page with no total; an empty board and a changed template parse the same |

`tests/test_scan_completeness.py` fails if a new adapter is added to
`BOARD_FETCHERS` without being placed in one of these groups.

### Matching a posting to the board that proved it

`scan_evidence.py` is shared by the pipeline and the exporter. Registry tokens
carry extras that posting URLs do not, so the evidence key drops them: Taleo's
portal id and Eightfold's employer domain. Without that, those boards' evidence
could never match a posting. iCIMS career sites are matched by host, since
their posting URLs carry no iCIMS marker. Matching is case insensitive.

### The published site

CI rebuilds its database every run, so the database closure alone never removed
anything from the site. What the site shows is decided by `export_static`, whose
`carry_open_boards` puts back the previous export's rows for any board whose
count fell to half or less, on the guess that its fetch failed.

`run_ingest` now passes the completed boards to `export()`. A board with
evidence this run has its missing rows dropped, not carried, however far its
count fell. `carry_search_finds` also drops a search find whose board is a
`FULL_LIST` board read whole this run; keyword scoped evidence leaves search
finds alone, for the reason above. A failed, capped or non-authoritative board
keeps the old carry behavior. The export log prints how many rows complete
scans closed, and the ingest report counts complete boards per ATS.

Answer to the question that started this: yes. A role that disappears from a
Workday board whose searches were all read to their totals
leaves the published site on the next refresh, even when the board lost enough
roles to look like a failed fetch. Before, a role gone from a board that kept
more than half its rows already left; a role gone from a board of three or more that
fell to half or less was carried for up to two days. That second case now leaves at
once. `test_a_role_gone_from_a_fully_scanned_workday_board_leaves_the_site` in
`tests/test_export_closure.py` proves it by running `run_ingest.main` twice
against a fake Workday API with a new database each time, as CI does.
`test_the_same_board_failing_keeps_its_roles_carried` and
`test_a_capped_scan_is_not_evidence_and_keeps_the_carry` prove the fallback.

### Validation

All tests are offline fixtures. Per adapter: a complete scan closes the missing
posting, a complete empty board is evidence, a capped scan is not, a failed
keyword or page raises without evidence, a malformed payload gives none. The
backend suite passed 946 tests with 2 optional checks skipped (872 before this
update; 74 new).

### Remaining limits

- Large Workday boards rarely prove anything. A fuzzy "intern" search often
  returns more than 400 results, or stops early on noise, so those boards stay
  non-authoritative and keep the carry rule.
- Workable posting URLs often have the form `apply.workable.com/j/<id>`, which
  does not name the account. Those postings cannot be matched to their board,
  so Workable evidence leaves them open.
- SuccessFactors, iCIMS portal, Jobvite and JazzHR still cannot close by
  absence. Each would need a result total or an end of list marker verified
  against live pages first.
- The Workday health boards' extra "student" search depends on the board's
  sector label. If the label is removed, postings only that search found are
  no longer searched for, and a complete scan would close them.
- On the export side the rows carry no source list, so a keyword scoped board
  with evidence also stops carrying rows that came only from a community list.
  Those lists are fetched on every full run, so a row still listed comes back.
- The Workable, BambooHR and Rippling "unpaged" readings come from the shape of
  their public responses and our own calls, not from published API guarantees.
- This does not reopen listings closed incorrectly by older runs.
