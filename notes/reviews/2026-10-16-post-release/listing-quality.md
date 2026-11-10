# Listing quality follow-up — October 16, 2026

Source: `origin/main` at `cbfef6171f08ebc4f9c06a41523519b630a120aa`.
Data: committed export generated `2026-10-16T15:33:45.498163+00:00`.
Scope: a census of carried records and URL collisions, followed by a bounded ten-role review.
No ingestion, paid search, application, publication or deletion was performed.

## Verified defect and fix

The export contains **19,272 distinct (stable ID, apply URL) records**, of which **15,143 are open**.
The open records represent only **14,926 distinct stable IDs**. All **217 excess records** are
carried copies of IDs also fetched fresh in the same export. Of the reported 474 carried records,
only **257** are additional opportunities not already represented by a fresh ID.

`backend/internscout/export_static.py:409` (`carry_open_boards`) and
`:472` (`carry_search_finds`) used URL-only membership checks. An employer can publish the same
stable role through different boards or change its URL. A failed older board then reinstates the
old URL beside a fresh record with the same ID. Example ID `f9dcdc9b578fe742`, Ryan's
Summer 2027 Tax Consulting Intern - Canada, appears under both `/Students-Graduates/…R0020613`
and `/RyanCareers/…R0020613-1`.

Impact: published totals overcount actual opportunities, and consumers keyed on stable IDs can
select the older record depending on load/order. Six pairs have different region arrays; those
differences are order/format variants, so this audit does **not** establish an incorrect state.
None of these 217 pairs differs in exported class-year restrictions or insights. The regression
also exercises a changed restriction to ensure a future stale copy cannot override it.

Fix: both carry paths now reject an ID already present, including a freshly closed ID, and reserve
each carried ID as it is appended. Existing URL checks, board identity, two-day age window and
stage rules remain. Fresh record, URL and stable ID win. This is separate from the already-fixed
multi-board identity issue in PR #118.

An offline replay using all distinct `(ID, URL)` export records as the previous corpus, and the
unmarked records as this run's fetched input, retains **220 board + 37 search carried records**:
**19,055 total records, 14,926 open records, 14,926 distinct open IDs, zero duplicate IDs**.
This isolates carry behavior; it is not a prediction of the next live ingest's counts. Generated
JSON is deliberately unchanged: the next normal ingest/export will use the corrected code.

## Remaining duplicate and eligibility evidence

Among freshly fetched open records, the existing `_canon_job` comparator finds **106 URL groups**
with multiple stable IDs (**109 extra rows**). Eleven groups have differing exported `years`.
This is a separate issue from the stable-ID carry fix. Examples:

| Employer | Stable IDs | Exported evidence |
|---|---|---|
| Hitachi | `0c36a30caa6bb382`, `bd377841c63e6e84` | Same Workday requisition `R0148396`; first copy says PhD-only in insights, other copy has no degree restriction. |
| Modal | `2471a9ca03d41236`, `7430d74243c243de` | Same Ashby UUID `38888294-6bc7-4dab-b072-6d0f0c2ed79a`; same title, first copy PhD-only, second unrestricted. |
| Roblox | `7956cae5c1e3a793`, `31c06a2d719218d4` | Same canonical destination; title/insights in one copy identify PhD, other copy does not. |

Recommendation: trace raw per-source provenance and conflicting term/year evidence before a
separate dedupe change, then keep the employer's eligibility for verified identical requisitions.
Do not indiscriminately collapse all canonical groups: generic careers URLs, separate terms and
ambiguous source data need explicit handling. No broad ranking/dedupe change is included here.

## Bounded carried-role sample

Method: remove the 217 records shadowed by fresh IDs; rank remaining employers by carried count
(tie order from alphabetical shard traversal); select the lexicographically smallest stable ID
from each of the ten largest groups. Review title, regions, years, insights and available sidecar
description. This is a coverage sample, not a random estimate of all postings' correctness.

| Employer; sample ID | Observed stored evidence and follow-up |
|---|---|
| Gilead; `03c0bf4c2ba86698` | Global Medical Affairs internship, Foster City CA. No description/eligibility in sidecar; detail hydration needed before inferring eligibility. |
| Penn State; `07b9e592b86d099d` | Part-Time Research Assistant – Buanafina Lab, University Park PA. No stored description; student restriction and current opening unknown. |
| Kite; `042d618d71d979ac` | Global Patient Safety internship, Parsippany NJ. Available description identifies a summer internship; no inferred degree claim made. |
| MFS; `16a206273ac2a7a5` | Legal Intern (JD), Boston MA; `years: []`. JD is explicit in title but the current year vocabulary has no professional-degree category. An undergraduate should not read an empty filter restriction as proof of eligibility. Needs a separately designed professional-degree filter. |
| Johnson Controls; `14ed3a1bfac13fe8` | Plumbing Apprentice 2nd, Nisku AB. Description explicitly requires registered Alberta apprenticeship/trade-school enrollment. Retain as a legitimate apprenticeship, with that restriction visible in detail. |
| Wells Fargo; `21cec08fa7d83d7b` | Military Apprentice, Wilmington NC. Military audience explicit in title; no description available. Do not present as general undergraduate eligibility or assume it is closed. |
| CampusReel; `403bd1b36f33fff6` | Social Media Intern – Paier College, Hamden CT. Description specifically addresses that school's students. Site-specific eligibility isn't a current structured field. |
| Gas South; `0df3c693f775b856` | Marketing Strategic Projects Intern, Atlanta GA. No sidecar description; current eligibility/open status unknown. |
| EMC; `3c222554c9cb226a` | Claims (Data) internship, Iowa. No sidecar description; current eligibility/open status unknown. |
| Montserrat; `12fb0fe54681e4b1` | Aggregated videographer internship, Hamilton MA. Stored description names filming an event on **July 18, 2026**, already past on review date. Treat as a stale-content candidate for official-employer verification; do not infer a live closure from aggregator text alone. |

The web reader could not access the nine direct employer/official application URLs attempted in
this sample (Workday, Greenhouse and CampusReel); their current open/closed status is **unknown**.
The Montserrat destination is an aggregator and was not treated as an authoritative live source.
No record was removed based on tool inaccessibility. Across all 257 unshadowed carried records,
**93 lack sidecar descriptions**, none triggers current `never_student` title rules, and none has
a `years_of(title, insights)` mismatch. Reapplying those existing rules alone will not address
the missing professional-degree, military or school-specific restrictions.

## Validation

- Two new carryover regression tests failed before the fix, then passed: alternate-board URL
  with the same stable ID, and search carryover with a fresh/open or closed ID at a changed URL.
- Added an export-level regression asserting total/open counts match unique emitted IDs and the
  newly fetched URL survives. Existing tests still ensure genuinely distinct boards remain held.
- Focused backend suites: **149 passed** before the final export regression was added.
- Final full backend suite: **780 passed, 2 optional environment/media checks skipped**;
  updated `test_shards.py`: **28 passed**, including the export regression.
- No paid model/search requests, live submissions, ingestion, generated data rewrites or browser
  session interactions were used.

## Reproduce the census

Read every `docs/data/listings/*.json` except `index.json` and `*.desc.json`. Deduplicate shard
appearances by `(row['id'], row['apply_url'])`, not ID alone (which hides this defect) and not
canonical URL alone (which hides the separate duplicate-copy issue). Restrict to `status == 'open'`.
Compare record count with unique ID count; count carried records whose ID occurs in an unmarked
record. For the separate URL census, group unmarked open records by
`internscout.dedupe._canon_job(apply_url)` and compare their `years` values. Source/date above fixes
the corpus so future ingest changes are not mistaken for irreproducibility.
