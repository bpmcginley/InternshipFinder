# Query and adapter expansion checkpoint, October 16, 2026

Implemented locally; no production ingestion, deployment, paid search, or employer submissions.

## Changes

- Oracle searches `intern`, `co-op`, `student`, and `stagiaire` on every tenant. Previously it searched only `intern`, with an extra `student` search for health sectors. This reaches non-health student roles and avoids making co-ops compete exclusively with noisy `intern` matches.
- Taleo adds `stagiaire` to its existing four searches.
- Eightfold adds `stagiaire` and retains explicitly Canadian standardized locations. Previously its location parser discarded every country other than US/USA. Province codes must be recognized; country labels remain explicit so Ontario, California stays in the US.
- Existing student-opportunity classification still decides admission. Relevance-search noise such as `Manager, Internal Controls` is rejected. No broad new acceptance rules were added.

## Public evidence and observed measurement

The existing registered [Stantec Oracle board](https://hdhl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs) was sampled through its public `recruitingCEJobRequisitions` API after checking robots.txt. Four list-only requests used one 100-row page for each keyword:

| Keyword | API-reported total | Rows returned on sampled page |
|---|---:|---:|
| intern | 802 | 100 |
| co-op | 104 | 100 |
| student | 112 | 100 |
| stagiaire | 0 | 0 |

These totals include non-internship relevance matches and overlapping jobs. They are **not counts of incremental internships**. The `intern` total exceeds the existing 600-result scan ceiling, which demonstrates why separate narrower searches can expose opportunities behind that ceiling. One sampled public co-op row is requisition `1008127`, `Architectural Technologist Co-op Student - Winter 2027`, Regina, SK, Canada. It appears in the co-op response; its absence from every baseline intern page has not been established.

[Tetra Tech's official French Taleo search page](https://tetratech.taleo.net/careersection/2/jobsearch.ftl?lang=fr) showed `Stagiaire estimateur(trice) en électricité`, requisition `71500003729`, in Quebec. This provides a concrete French-only title motivating `stagiaire` searches. [Ericsson's official Eightfold posting](https://ericsson.eightfold.ai/careers/job/563121772960424) was indexed as `Data Analyst Intern` and explicitly mentioned Ericsson Canada. The Canadian Eightfold response shapes in tests are synthetic parser fixtures, not a captured live API response.

A further multi-page Stantec measurement was launched, but its output was not retained. Do not claim any incremental live yield from it. Resume with a saved measurement receipt comparing accepted requisition IDs across the six-page intern baseline and expanded queries before quoting growth.

## Bounds and validation

Oracle retains six 100-row pages per keyword, at most 24 list requests per board (previously 6, or 12 for health), plus the unchanged maximum of 25 detail requests after cross-query deduplication. Taleo retains eight pages per keyword and Eightfold twelve; each adds one bounded keyword. They continue to enforce robots rules and existing error behavior.

`python -m pytest tests/test_query_expansion.py tests/test_canadian_adapters.py tests/test_fetchers.py -q` from `backend/`: **81 passed**. The 12 new cases exercise actual fetch functions with offline HTTP responses: recovery by alternative queries, cross-query deduplication, bounded independent Oracle pagination, relevance-noise rejection, French title retention, and Canada/California location separation. Full-suite integration validation belongs to the parent workstream.

Measured October 18, 2026 on six live boards, with saved receipts in `measurements/`; see [live verification](live-verification-2026-10-18.md#4-query-expansion-measured-cost-and-yield). Against an `intern`-only baseline, the production keyword sets added 39 accepted listings on Eightfold John Deere (all from `student`), 28 on Taleo Textron (18 from `internship`, 6 `co-op`, 3 `stagiaire`, 1 `student`), 6 on Oracle Stantec (5 `co-op`, 1 `student`), and none on three Workday boards, where `co-op` cost 3 to 20 extra requests per board. Estimated fleet cost: about 14,400 extra requests and about 10 minutes of wall time per run at 16 workers, 94% of it from Workday `co-op`.

Remaining: check why Oshkosh's `intern` search missed `Quality Intern (Summer 2027)`, which only `student` surfaced; repeat the measurement out of season and on more boards before tuning caps. French `stage` without `stagiaire` and additional accented student wording still need classifier-aware evaluation. No claim of exhaustive coverage is made.

## Workday extra searches are opt-in (October 19, 2026)

The measurement above settled the Workday question. Workday's `intern` search is fuzzy and already returns most co-ops, so `co-op` added no accepted listing on the three boards measured while costing 3 to 20 extra requests per board, about 13,500 requests and 9 minutes of wall time per full run across 1,230 Workday boards.

Default now: every Workday board is searched for `intern` only. Health and behavioral health boards keep their `student` search, which predates the October 16 expansion (commit `d46e713`, from a live check that hospital student roles never answer `intern`). Oracle, Taleo and Eightfold keep their expanded keyword sets, which did add listings.

Switch: set `WORKDAY_EXTRA_KEYWORDS` to a comma-separated list of extra words, searched on every Workday board after `intern` and before the sector's own word. `WORKDAY_EXTRA_KEYWORDS="co-op"` restores the October 16 behavior; `"co-op,student"` also searches `student` everywhere. Words are lowercased and each is searched once. Unset or empty means `intern` only. The variable is read at fetch time, so it applies to whichever process runs the ingest (set it in the workflow's environment to change CI).

Not enabled: a `student` search on every board. On Oshkosh it found one listing the `intern` search missed, `Quality Intern (Summer 2027)`, for about 4 more requests per board (about 4,900 per run, 3.4 more minutes). One listing on one board does not justify that cost yet, and the miss is more likely the `intern` read stopping early on Oshkosh's offset or dry-page rule than a wording gap, since the title contains "Intern". That cause is still unconfirmed. Turn it on with the switch above if a wider sample shows more such finds.

Closure stays correct with either setting. A Workday board is complete only when every word actually searched in that run was read to its reported total: `intern` alone by default, plus `student` on health boards, plus any configured extras. A switched-on `co-op` search that hits the page cap still leaves the board without evidence. One consequence to know: keyword-scoped evidence closes postings the adapter found on an earlier run, so the first complete run after a word is switched off closes postings that only that word had found. With `co-op` that was none of the measured listings, but the same caution applies whenever the switch is changed. Tests: `test_workday_default_evidence_covers_only_the_intern_search`, `test_workday_every_keyword_searched_must_complete`, `test_workday_switched_on_co_op_read_whole_is_evidence` and `test_workday_health_student_search_must_complete_too` in `tests/test_scan_completeness.py`, and the search-order tests in `tests/test_fetchers.py`.
