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

Remaining: measure per-keyword incremental accepted IDs, latency and failure rate on a small representative board sample; use those results to tune vocabulary and caps. French `stage` without `stagiaire` and additional accented student wording still need classifier-aware evaluation. No claim of exhaustive coverage is made.
