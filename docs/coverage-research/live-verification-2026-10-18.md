# Live verification: discovery admissions, Teck and Bombardier, query expansion cost

October 18, 2026. Branch `cov-live`, cut from `coverage-expansion`. Free public HTTP reads only:
no SerpAPI or Google Jobs, no AI APIs, no production ingestion, no deploys, no form submissions.
No file under `backend/internscout/sources/`, `pipeline.py`, `run_ingest.py` or
`export_static.py` was changed. Adapter changes that look necessary are written up below instead.

About 433 HTTP requests were made in total, spread over a dozen hosts, all through either the
discovery client (robots checked before every request) or the adapters' own robots checks. That
count includes about 46 requests from one discovery scan whose report could not be written
because of a Windows path length error, and was then rerun.

## 1. Admitted boards

Two boards were admitted through the discovery CLI's explicit path,
`scripts/discover_sources.py --targets <curated file> --scan --verify --apply`, with
`"employer_identity_reviewed": true` set only on targets whose identity had been checked.
The run made 77 requests for three targets. The registry change is commit `8b0755b`.

| Board | Identity evidence | Parsed now | Accepted by normalize() and the pipeline filters |
|---|---|---:|---:|
| `successfactors` `jobs.novascotia.ca`, Province of Nova Scotia, government | The provincial home page `novascotia.ca` links `https://jobs.novascotia.ca`; the host is on the government's own domain. | 1 | 1 |
| `workday` `sanford\|wd5\|SanfordHealth`, Sanford Health, health | `sanfordhealth.org/about/residency-and-student-programs` links `sanfordcareers.com`, which links `sanford.wd5.myworkdayjobs.com/SanfordHealth`. | 14 | 14 |

Content review:

- Nova Scotia: one role, `Intern, Intergovernmental Policy & Corporate Services`, Halifax, NS.
  A real student role in region. The October 16 run saw two; postings turn over.
- Sanford: 14 roles in ND, SD, MN and WI: student nurse internship and advancement programs,
  pharmacy interns (inpatient, retail, specialty), an actuarial intern, two high school interns
  and four `Genesis Program Apprentice` postings. All are student or early training roles in the
  US region. The high school intern and apprentice rows are accepted by the existing classifier;
  whether the product wants them is a classifier policy question, not an identity problem.
- The verification pass took 8 requests (1.3 s) for Nova Scotia and 48 requests (36 s) for
  Sanford, whose `health` sector adds the `student` search on top of `intern` and `co-op`.

Not admitted from the same run: Oak Ridge National Laboratory (see below).

## 2. Starter catalog outcomes

All 16 starters were scanned (`--scan --max-targets 16 --max-pages 3`, 46 requests), then the
readable pages were inspected for career links and three curated follow-up targets were tried.
"Robots unavailable" means the host's `/robots.txt` did not answer 200 or 404, which the discovery
client treats as a block. That is deliberate and was not overridden.

| Target | Outcome | Detail |
|---|---|---|
| Province of Nova Scotia (NS) | **Admitted** | See above. Its legacy `hcm17.sapsf.com` link is `Disallow: /`, but the branded host is open. |
| Sanford Health (SD) | **Admitted** | See above. `sanfordhealth-internship.jobs` redirects its robots file, so it was skipped; the Workday board covers it. |
| Oak Ridge National Laboratory (TN) | Supported board, no student roles parsed | Curated target `ornl.gov/careers-at-ornl/` leads to `jobs.ornl.gov`, a classic SuccessFactors site. The adapter parses it (25 job anchors on the `intern` search), but every hit was a postdoc, staff role or `SkillBridge Military Intern`, which the classifier rejects. ORNL's student internships run through its education programs, which were not examined. Rerun later; admit if student roles appear. |
| Manitoba STEP (MB) | No supported board | Program page links an application form (`web.gov.mb.ca/step/app`). STEP is a matching pool, not a list of public vacancies. |
| Manitoba Hydro (MB) | No supported board | Careers page links `careers.hydro.mb.ca/sap/bc/webdynpro/sap/hrrcf_a_unreg_job_search`, SAP E-Recruiting. No adapter exists. |
| Government of Saskatchewan (SK) | Robots unavailable | The Taleo guide and the public service careers pages are readable. `find-and-apply-for-jobs` links `careers.saskatchewan.ca`, whose `/robots.txt` answers 302 to an error page. The `sortBy=POSTING_DATES_DESC` link suggests Oracle Recruiting Cloud on a branded host, which the Oracle adapter does not recognise (it expects `*.oraclecloud.com`). |
| University of New Brunswick (NB) | No supported board | Readable first-party HTML lists (academic, support staff, graduate student). No ATS link. A custom adapter would be needed. |
| Memorial University (NL) | Login-only for students | Public `hr/careers/external-job-postings` pages are first-party HTML. Student positions go through `my.mun.ca`, which is `Disallow: /` and requires login. |
| Government of Northwest Territories (NT) | No supported board | First-party eRecruit board (`gov.nt.ca/careers/en/search/job`, `.../job/16263`) is public. Candidate for a small custom adapter. One linked page timed out. |
| Government of Nunavut (NU) | Blocked by robots | `/robots.txt` answers 403. |
| Government of Yukon (YT) | Blocked by robots | `/robots.txt` answers 403. |
| Yukon University (YT) | No supported board | First-party HTML pages (`about-us/careers`, `about-us/employment`). No ATS link. |
| State of Maine (ME) | Blocked by robots | `/robots.txt` answers 403. |
| Maine Arts internships (ME) | No supported board | Directory page with no outbound links in its HTML. A directory operator must not be assigned to other employers' roles anyway. |
| State of South Dakota (SD) | Needs manual review | ServiceNow knowledge article, 964 KB, rendered by script; no links in the served HTML. |
| Tennessee Valley Authority (TN) | Blocked by robots | `/robots.txt` answers 403. |

Two observations about the discovery client itself (`source_discovery.py`), left unchanged
because they are policy calls for the owner:

- RFC 9309 treats a 4xx robots file as "no restrictions" and asks crawlers to follow robots
  redirects. The client is stricter: 403s (Nunavut, Yukon, Maine, TVA) and redirects
  (Saskatchewan, UNB's bare host, Sanford's internship microsite) all count as blocked. The 403s
  are most likely bot protection that would also refuse the pages, so the strict reading is safer.
  Following a robots redirect to a final 404 would be a reasonable, narrow relaxation.
- Branded SuccessFactors is detected only on a page the scan actually fetched. ORNL's
  internship hub links its careers page, which links `jobs.ornl.gov`, one level too deep, so a
  curated target was needed.

## 3. Teck and Bombardier: why `/search/` parses nothing

Both `jobs.teck.com` and `jobs.bombardier.com` serve the newer SuccessFactors "Unify" search
template. Evidence from `/search/?q=intern&startrow=0` on each (both 200, 70 KB and 111 KB):

- The body has `class="coreCSB search-page body unify body"`, loads
  `/platform/js/j2w/min/j2w.searchResultsUnify.min.js` and `/platform/js/widgets/reactWidgetLoader.js`,
  and the results area is an empty `<div id="root"></div>`.
- There are zero `jobTitle-link` anchors and zero `/job/` links. Results are drawn in the browser
  from a JSON call. The only server-side job link is the RSS feed,
  `/services/rss/job/?locale=en_US&keywords=(intern)`.
- `robots.txt` on both hosts (identical to every other tenant checked) disallows `/services/`,
  so the JSON endpoint and the RSS feed are both off limits.

By contrast `jobs.ornl.gov` serves the classic template from the same request: 50
`jobTitle-link` anchors, 25 `data-row` rows, `jobLocation` spans. That is the shape
`parse_successfactors` expects.

What is allowed and useful:

- `/sitemap.xml` is not disallowed and lists every posting as `/job/<slug>/<id>/`. Teck: 116 job
  URLs, 25 with student words in the slug (for example
  `Vancouver-Power-Platform-Developer-Co-op-Brit/1434065600`, `Red-Dog-Mine-Engineering-Intern-AK`).
  Bombardier: 1,673 job URLs (380 KB), 447 with student words, including paired English and
  French postings such as `Dorval-Intern%2C-Central-Planning-%28Winter-2027%29-Qu%C3%A9b-H4S-1Y9`
  and `Dorval-Stagiaire%2C-Planification-Centrale-...`.
- `/job/` pages are allowed (about 100 KB). They carry `itemprop="title"` and
  `itemprop="description"`, but no `datePosted` microdata. The date is a labelled field,
  `Posting Start Date: 9/25/26` (M/D/YY). Location is not in microdata: Teck writes it inside the
  description (`Location: Vancouver, BC, Canada`); Bombardier prints an unlabelled span
  (`Wichita, KS, USA, 67209`).

Today the adapter gets a full 70 KB page with no anchors, so it returns zero items without
raising. That is the silent-zero failure its own `len(r.text) < 2000` guard was written to avoid.

Concrete change for `sources/successfactors.py` (for the owning agent):

1. After the first `/search/` response, detect the Unify shell: `searchResultsUnify` in the body,
   or `<div id="root"></div>` with no `jobTitle-link` anchors. Stop the remaining keyword
   searches for that tenant (they return the same shell) and switch to sitemap mode.
2. Sitemap mode: `require_robots(c, base, "/sitemap.xml", token)`, GET `/sitemap.xml`, follow a
   `<sitemapindex>` to at most a few child sitemaps, collect `<loc>` values matching `JOB_RE`.
3. Prefilter on the slug, before any job page request: a student-word regex on the unquoted slug
   (`intern|co-?op|student|stagiaire|stage|apprenti|fellow`), then a region test from the slug
   tail. US slugs already end `-ST-zip` or `-ST` (reuse `_slug_place`). Canadian slugs end in a
   province name cut to four letters (`Brit`, `Albe`, `Onta`, `Québ`/`Queb`, `Sask`, `Mani`, `Nova`;
   `New` is ambiguous between New Brunswick and Newfoundland, so keep it), optionally followed by a postcode (`H4S-1Y9`). Drop clearly
   foreign tails such as Teck's `Metr` and `TA` (Chile).
4. Fetch candidate job pages under a Unify-specific cap (suggest 60 per run, newest id first,
   since ids rise over time). Read the title from `itemprop="title"` and run `is_internship` on
   it, the date from the `Posting Start Date` label, the description with the existing
   `parse_successfactors_detail`, and the location from the slug, falling back to a `Location:`
   line in the description or the first `City, ST, USA` / `City, Province, Canada` span.
5. Raise when a tenant serves neither anchors nor a usable sitemap, so `scan_boards` records a
   failed board instead of a quiet zero.

Expected cost per run: Teck about 28 requests (robots, one search to detect the template, the
sitemap, about 25 job pages); Bombardier 3 plus the cap. Bombardier's 447 student-word slugs
cannot all be read in one run within existing per-board caps, so either accept partial coverage
per run (rotate through ids) or give Unify tenants their own larger cap. Neither board was seeded
in this pass.

## 4. Query expansion: measured cost and yield

Receipts are in `measurements/` (one JSON file per board: request counts, estimated seconds, raw
rows, normalized and accepted counts, and the ids and titles of accepted rows added by each
expansion; no posting text).

Method. Each board was fetched with the adapter's own `fetch_*_board` function, once per keyword
set, cumulatively: `intern`; `+co-op`; `+student`; `+stagiaire`; and the adapter's current
production set where that differs. Keyword sets were changed by patching the adapter module's
`KEYWORDS` tuple (Oracle, Taleo, Eightfold) or wrapping `workday._search` (Workday) in the
measurement process only. Every unique HTTP request was made once, with a 0.3 s pause, and cached;
each configuration replayed against the cache. A configuration's "requests" is every call it
issued, and its "seconds" is the sum of those calls' measured latencies, an estimate of the
sequential time one board takes. Rows were run through `place_bare_cities`, `normalize()`, and
the pipeline's field, term and region filters. "New" means accepted job ids not present in the
`intern`-only run. 188 requests in total.

| Board | Baseline `intern`: requests, s, accepted | Production set: requests, s, accepted | New accepted | Where the new rows came from |
|---|---|---|---:|---|
| Workday Oshkosh (many interns) | 27, 14.5 s, 125 | `intern,co-op`: 47, 26.5 s, 125 | 0 | All four words: 54 requests, 30.9 s, +1 (`Quality Intern (Summer 2027)`, found only by `student`) |
| Workday Manulife `MFCJH_Jobs` | 38, 20.8 s, 20 | `intern,co-op`: 48, 28.8 s, 20 | 0 | All four: 51 requests, 31.2 s, +0 |
| Workday Enbridge | 4, 2.4 s, 0 | `intern,co-op`: 7, 4.3 s, 0 | 0 | All four: 9 requests, 5.5 s, +0. No student postings open today. |
| Oracle Stantec `CX_1` | 32, 16.0 s, 126 | 4 words: 37, 19.5 s, 132 | 6 | `co-op` +5 (Winter 2027 co-op students), `student` +1 (articling student), `stagiaire` +0 |
| Taleo Textron | 11, 2.2 s, 82 | 5 words: 23, 4.4 s, 110 | 28 | `internship` +18 (`2027 Internship: ...` titles the word-exact `intern` search misses), `co-op` +6, `stagiaire` +3 (bilingual `Stage hiver 2027 - ... / 2027 Winter Internship` titles), `student` +1 |
| Eightfold John Deere | 4, 2.4 s, 9 | 5 words: 14, 7.1 s, 48 | 39 | `student` +39 (`Part-Time Student - ...` engineering, software, supply and finance roles), all others +0 |

Accepted counts are job ids; titles repeated across locations collapse further under the
dedupe key (Stantec 72 to 77 keys, Textron 78 to 105, John Deere 9 to 43, Oshkosh 99 to 99).
Request errors: one 4xx response each on Stantec and Textron, consistent with an absent
`robots.txt` (which the adapters read as no restrictions); the harness did not record which URL.
No list or detail call visibly failed.

What the sample says:

- The word-exact ATSes gain the most. Taleo's `internship` and Eightfold's `student` searches
  add real, in-region roles the `intern` search cannot reach. Oracle's `co-op` adds Canadian
  co-op terms.
- Workday's fuzzy search already returns most co-ops for `intern`. On these three boards the
  `co-op` search cost 3 to 20 extra requests per board and added no accepted listing. The one
  extra Oshkosh intern came from `student`, which suggests the `intern` search stopped early on
  its offset or dry-page rule; that is an inference, not confirmed.
- `stagiaire` added three rows on one board (Textron) and nothing elsewhere.

## 5. Extrapolation to the registry (estimate)

Registry after this branch: 3,124 boards, including Workday 1,230, Oracle 131, SuccessFactors 25,
Taleo 11, Eightfold 6. Applying each ATS's sample mean to every board of that ATS:

| ATS | Boards | Extra requests per board, production set vs `intern` only | Extra per run | Extra sequential time | Wall time at 16 workers |
|---|---:|---:|---:|---:|---:|
| Workday (`co-op`) | 1,230 | 11 (range 3 to 20) | about 13,500 | about 2.5 board-hours | about 9 minutes |
| Oracle | 131 | 5 | about 650 | about 460 s | under 1 minute |
| Taleo | 11 | 12 | about 130 | about 25 s | negligible |
| Eightfold | 6 | 10 | about 60 | about 30 s | negligible |
| Total | | | about 14,400 | | about 10 minutes |

Adding `student` and `stagiaire` to every Workday board would cost roughly another 4 requests
per board (about 4,900 per run, about 3.4 more minutes at 16 workers) for one extra accepted row
in the sample. The Workday baseline in this sample averaged 23 requests per board, so the current
`co-op` search raises Workday traffic by roughly half.

These are estimates from six boards on one day in October, when summer 2027 recruiting is open.
Per-board cost varies by an order of magnitude, wall time at 16 workers assumes perfect
parallelism, and yield is seasonal. Treat them as a sizing guide, not a forecast.

Suggested follow-ups for the adapter owner: keep Taleo `internship`, Eightfold `student` and
Oracle `co-op`; consider restricting Workday `co-op` to boards with Canadian or co-op-heavy
postings (or to boards whose `intern` search hit its offset ceiling), since it is 94% of the added
traffic; and check why Oshkosh's `intern` search missed `Quality Intern (Summer 2027)`.
