# Query and adapter expansion checkpoint — October 16, 2026

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

Remaining: decide whether Workday `co-op` should run on every board or only on boards with Canadian or co-op-heavy postings; check why Oshkosh's `intern` search missed `Quality Intern (Summer 2027)`, which only `student` surfaced; repeat the measurement out of season and on more boards before tuning caps. French `stage` without `stagiaire` and additional accented student wording still need classifier-aware evaluation. No claim of exhaustive coverage is made.
