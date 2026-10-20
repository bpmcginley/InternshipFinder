# Listing quality execution — October 19–20, 2026

Snapshot: export `2026-10-20T02:44:58.802800+00:00`, main at audit start.
Scope: offline census plus **40 distinct roles**, four per each of five substantial fields
(software, finance, mechanical, marketing, civil) and five thin fields (biomedical, publishing,
music, theater, clinical research). The deterministic SHA-256 ranking uses field and stable ID;
multi-field roles appear once. This coverage sample does not estimate corpus-wide accuracy.
Full sample metadata, URLs, and canonical conflict candidates are in `census.json`.

## Completed correction

**UT Austin campus labels were read as Utah.** Sample role `4c3eb30dab00ff92` (CRC Community
Outreach Intern) has the official `utaustin` Workday tenant and location `UT MAIN CAMPUS`, but
the published region is `UT`. A census finds **22 open role IDs** with this label under that
tenant. The [university's own overview](https://www.utexas.edu/about-texas) locates its campus
in Austin, Texas. Students filtering for Texas miss these roles; Utah students get false matches.

The Workday adapter now expands this **exact label for tenant `utaustin` only** to `Austin, TX`
before geographic classification, for list results and detail results. Other employer labels,
other Austin campus labels, and genuine Utah locations are untouched. Regression coverage runs
both list-only and detailed fetch paths through normalization. No generated shards were edited;
the next normal successful ingest applies this correction. Do not claim all 22 have changed live
until that export is checked.

## Measured census and unresolved issues

- **15,231 open ID/URL variants; 15,133 unique open IDs; 98 excess same-ID variants.** Repeated
  appearances across state shards are removed first. This is the carryover defect already fixed
  in pending PR #124; no duplicate implementation is added here. Confirm zero excess after its
  next normal export, and check closed-ID carryover regressions remain present.
- **119 canonical destination groups have multiple stable IDs; 10 have conflicting class-year
  arrays.** These are investigation candidates, not automatically proven duplicates. Generic
  careers URLs, differing terms, and source metadata require provenance before collapse. This
  existed in the October 16 review and is separate from #124's stable-ID correction.
- **5,928 / 15,133 unique open IDs lack a published description sidecar** (39.2%). In the sample,
  **12 / 40** lack it. This measures published data availability, not whether an employer has a
  description. Existing detail budgets/truncation mean `years: []` cannot prove all students qualify.
- **Source inconsistency:** FOX `fe0981c94b165830` says Tempe AZ in the title/application slug,
  but regions show NY/CA and its stored text identifies New York. WSP `a6b83f82a8e7da64` has
  fourteen regions excluding CA, while the stored role text identifies San Francisco. Verify raw
  per-source identity and merge provenance; do not select a location simply from one phrase.
- **Country suspicion:** ZEISS `8d740b3ad8dd4564` is published as `Oberkochen, CA`, whereas the
  Workday path identifies Oberkochen and [ZEISS's own location page](https://www.zeiss.com/career/en/locations/germany.html)
  places Oberkochen in Germany. The actual posting body was unreadable in the web tool. Trace
  how the California suffix entered the record before suppressing or relabeling it.
- **School/work-study eligibility:** American University musician `ecba6982d00640c5` has explicit
  own-student-only text; Wyoming `28789c91bc018b8c` and Pikeville `ad65be0ce9e26374` /
  `ba41f7d9d89960b2` identify work-study in title or body. These are useful student jobs, but
  empty year arrays do not communicate institution/funding restrictions. Design an explicit
  restriction badge backed by evidence; do not invent an undergraduate eligibility rule.
- Insomniac/Live Nation samples `e32de5a01989922c` and `362214bc2924cd39` have the same title and
  related `JR-93566` / `JR-93566-1` requisitions across separate boards. Candidate duplicate,
  not proof that stripping every Workday numeric suffix is safe.

## Official employer link subset

Ten sample URLs were opened read-only on October 20 UTC. **Three rendered recruiting content
with an application action; seven were inaccessible, empty, or 403 and remain unknown.**
No role was declared closed or deleted because a reader failed. This is not a full-site link audit.
Web-reader results can be cached; these observations are not a guarantee an application succeeds.

| Sample ID | Official destination observation |
| --- | --- |
| `fe0981c94b165830` | FOX Workday inaccessible; status unknown. |
| `1ce94c83a2707e2b` | Federal Reserve Workday empty reader result; status unknown. |
| `850c29ab2ba91764` | [Quantinuum](https://jobs.eu.lever.co/quantinuum/d36cdf8b-3100-4e0f-9b8b-2177a62cd822): Broomfield CO, undergraduate mechanical student, graduation after Dec 2027, sponsorship restrictions. Stored 1,500-character description ends before qualifications; structured restrictions empty. |
| `ed2755cf25892cda` | Axis Workday inaccessible; status unknown. |
| `88be952e02fcde61` | [Olsson](https://job-boards.greenhouse.io/olsson/jobs/5408530008): Des Moines IA, summer 2027, associate drafting program; location agrees, stored sidecar absent. |
| `8d740b3ad8dd4564` | ZEISS Workday empty reader result; job status unknown; country conflict above. |
| `388b576c5864760f` | Insomniac Games Greenhouse inaccessible; status unknown. |
| `362214bc2924cd39` | Live Nation Workday inaccessible; status unknown. |
| `ea2272de194edabe` | [NBCUniversal](https://jobs.smartrecruiters.com/NBCUniversal3/744000153538044): Glendale CA, Spring 2027, student/recent-graduate eligibility and sponsorship restrictions. Deadline Oct 19, 2026 11:59 p.m. Pacific (still upcoming at review); missing published sidecar. Recheck after deadline rather than claiming closure early. |
| `c157e5f2648fb11a` | Medpace returns 403 to reader; status unknown. |

## Forty-role stored-data review

Each row was checked for title, location, degree/year restrictions, term, and available stored
description/insights. “No conflict observed” refers to these available fields; it is not a live
verification or an eligibility guarantee. Full employer URLs live in the JSON sample.

| Field | ID | Review outcome / remaining uncertainty |
| --- | --- | --- |
| Software | `fe0981c94b165830` | FOX location conflict above; no safe correction from stored evidence. |
| Software | `f9237b52a5b027d1` | Lonza: NH, 2027 body agrees with title despite old 2026 URL slug; junior restriction retained. |
| Software | `92b3296462ac0277` | Magna: MI, description absent; eligibility unknown. |
| Software | `a6221727d02e476c` | Altera: Toronto repeated as location format variants; undergraduate text available, no contrary claim observed. |
| Finance | `1ce94c83a2707e2b` | Federal Reserve: OH, description absent; eligibility unknown. |
| Finance | `a6195ed43db56c4b` | Upbound: TX, IT asset role also tagged finance; validate field relevance with student feedback. |
| Finance | `6869d58507d30256` | Elanco: IA, summer 2027 title; description absent. |
| Finance | `25a8cd5b0a6ddce3` | Insulet: MA, June–August 2027 date text but no normalized term; no-sponsorship/GPA retained. |
| Mechanical | `850c29ab2ba91764` | Quantinuum: CO agrees with official page; missing restriction detail described above. |
| Mechanical | `7591e75c01529d22` | Astranis: CA, summer 2027 title; description absent. |
| Mechanical | `178b627667e79da5` | Olsson facilities: OK, description absent. |
| Mechanical | `511c61409e7d2631` | Emerson: MN, stored description adds Chanhassen to two published MN cities; no state conflict. |
| Marketing | `ed2755cf25892cda` | Axis: Chelmsford MA on-site agrees; fall/winter title lacks year, no term inferred. |
| Marketing | `9acb886cd2e4c076` | COUNTRY: IL, graduation 2027 insight; no available-field conflict observed. |
| Marketing | `014c306765962fd1` | Stryker: TX, summer 2027; GPA retained; truncated description limits full eligibility. |
| Marketing | `ad65be0ce9e26374` | Pikeville: KY, work-study title; description absent. |
| Civil | `5df53a328f2b8850` | HNTB: TX, fall 2026 title; description absent. |
| Civil | `88be952e02fcde61` | Olsson drafting: IA agrees with official page; associate-degree requirement missing from published detail. |
| Civil | `a6b83f82a8e7da64` | WSP: location conflict above, investigate source merge. |
| Civil | `45fbfd90fe22706e` | Aerospace: CA, graduate title and masters filter agree; citizenship/clearance retained. |
| Biomedical | `a3ae28f944a901bc` | ZOLL: MA, junior/senior restrictions retained. |
| Biomedical | `8d740b3ad8dd4564` | ZEISS: suspected Germany-to-CA error above. |
| Biomedical | `bbf100afc277ffe7` | Alcon: five US sites agree with multi-site description; GPA retained. |
| Biomedical | `99c9203cc40c1005` | Analog Devices: MA state-only region; Wilmington in URL, no conflicting country observed. |
| Publishing | `388b576c5864760f` | Insomniac Games: CA, undergraduate title agrees with year filter. |
| Publishing | `e32de5a01989922c` | Insomniac: CA, possible cross-board duplicate of music sample. |
| Publishing | `61a2129a6fb359b1` | KQED: CA, description absent. |
| Publishing | `28789c91bc018b8c` | Wyoming: WY, work-study restriction needs visible detail. |
| Music | `c219804f62e7140a` | Insomniac PR: CA, no available-field conflict observed. |
| Music | `a865d093490f14c2` | Insomniac marketing: CA, no available-field conflict observed. |
| Music | `ecba6982d00640c5` | American University: DC, own-enrolled-students-only text needs restriction badge. |
| Music | `362214bc2924cd39` | Live Nation: CA, possible cross-board duplicate above. |
| Theater | `ba41f7d9d89960b2` | Pikeville: KY, FWS in title; description absent. |
| Theater | `6f1844b4837d4de2` | MLSE: Toronto ON, no available-field conflict observed. |
| Theater | `c990b8638fcdd107` | Sony: CA, Jan–Apr 2027 body; part-time on-site role, no normalized term. |
| Theater | `ea2272de194edabe` | NBCUniversal: CA agrees; deadline and eligibility detail unavailable in sidecar. |
| Clinical research | `d488b5a53e8f9b1d` | Merck: MA, PhD-only insight and filter agree. |
| Clinical research | `c157e5f2648fb11a` | Medpace: OH, bachelor in progress in text; official reader blocked. |
| Clinical research | `4c3eb30dab00ff92` | UT Austin: Utah error corrected in source; next ingest verification required. |
| Clinical research | `22b6a875192fd721` | Medpace: OH, distinct Spring 2027 role retained separately from summer role. |

## Repeat and validate

PowerShell from the repository root:

```powershell
$env:PYTHONPATH='backend'
python -m internscout.listing_audit --out reviews/latest-listing-audit.json
python -m pytest backend/tests/test_listing_audit.py backend/tests/test_fetchers.py -q
```

The CLI is offline, does not ingest or mutate listings, caps sampling at 20 fields × 20 roles,
and labels unverified live statuses explicitly. It preserves ID/URL variants so the audit cannot
hide carryover regressions through its own deduplication. Tests: **58 passed** across fetcher
and audit suites. No paid search/model calls, applications, employer messages, or live data writes.
