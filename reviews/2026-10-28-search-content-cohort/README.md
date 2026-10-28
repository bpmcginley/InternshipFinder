# Four employer pages with useful posting details

Google search arrivals fell in the October 17-19 period. Current technical checks do not establish
an indexing, robots, canonical or server failure, and do not prove a Google quality penalty. This
small observational cohort adds source-backed information while existing private metrics follow
the same URLs. It is not a guaranteed ranking fix.

## Exposure and comparison

The deterministic allowlist is `seo_role_details.COHORT_PATHS`. On the October 28 data at base
`7d2b67fc`, the before/after build changed exactly these four HTML pages:

| Employer path below `/internships/at/` | Open/shown roles | Cards with details | Added HTML bytes | Oct 12-18 GSC impressions |
|---|---:|---:|---:|---:|
| `under-armour/` | 10/10 | 10 | 1,062 | 162 |
| `medtronic/` | 5/5 | 1 | 281 | 1 |
| `lyft/` | 22/22 | 14 | 1,271 | 31 |
| `bose/` | 12/12 | 5 | 586 | 9 |

All four pages remain indexable. Thirty of 49 visible cards gain details. KKR is excluded because
its page is not currently generated. No page creation, noindex, sitemap inclusion, index threshold,
protected-page list, canonical, JSON-LD, job order or application-link rule changes. The other
generated HTML pages are byte-identical under the same inputs.

Unchanged comparison pages are `shure/` (55 roles, 40 shown), `sun-life/` (13), `ul-solutions/`
(13), and `capital-one/` (4). All are currently indexable. Their October 12-18 GSC impressions were
76, 54, 52 and 46. These replace the originally suggested low-traffic pages. Employers, audiences
and inventory differ; these are observational comparators, not randomized controls.

## Source and freshness

Cards may show graduation years, class years or up to four skills explicitly mentioned in the
linked posting. Labels say "mentioned", and the page explains that brief details are not a complete
eligibility check. Missing or ambiguous facts are omitted. No degree, citizenship, sponsorship,
GPA, deadline or required-versus-preferred guarantee is added. Examples include 2027/2028 graduation
years on Under Armour postings and Python/C++ on a Bose embedded-software posting. No complete
descriptions or padding are copied. Values are escaped as HTML.

The usual exporter extracts insights from fetched full text before the existing 1,500-character
public-description cap. Because excerpts can end before qualifications, it now writes
`docs/data/seo-posting-details.json` separately from slim client rows, for these four named employers
only. The cap stays unchanged. At most the same 40 displayed, deduplicated roles per employer get
packets, 160 total. Static builds make no network requests for this feature.

Packets record the posting URL, full-text SHA-256/length, check date, schema version, and a hash
binding current role identity, employer, URL and insights/version. Facts must agree with stored and
fresh insights plus independent literal source-clause checks. Negation and ambiguous words are
suppressed: the verb "excel" is not Microsoft Excel, `.NET` is not relabeled C#, and inferred later
class years are not called literal mentions.

The initial 6,391-byte sidecar seeds ten Under Armour records and one Medtronic record, checked
October 28 against their exact public employer postings with the existing robots-aware
SuccessFactors/Workday parsers. Other cards use matching facts from existing description excerpts.
Private source passages and hashes were independently reviewed; only normalized facts and
provenance are committed.

Every normal export recomputes packets from freshly fetched full text. A fresh source without
supported facts removes older details. An unchanged carried row may keep its original source
check for seven days; carryover never recomputes provenance from truncated text or refreshes the
date/hash. Changed URL, insights/version, identity, closed role, malformed packet or expired check
suppresses it. Check the post-merge ingest before claiming all four treatments remain exposed.

## Measurement, validation and revert

Record actual production exposure time and Google's first later crawl for each treatment. The
existing collector reads those four URL Inspection states and the exact eight-page/date cohort.
Compare final Pacific-day clicks, impressions and CTR for complete weeks before and after the
observed recrawl, with unchanged comparators alongside. Keep page/query cohorts consistent for
position. Low counts, recruiting demand, query mix and other deployments limit causal claims.
An absent API row is not proof of deindexing. See `growth/SEARCH_REPORTING.md`.

Hold four-page scope through two complete post-recrawl weeks. Check factual correctness, coverage
and actual reader behavior before considering wider rollout. No new analytics provider or browser
payload is added.

Tests cover source alternatives/negation, inferred class years, ambiguous products, stale/missing
and oversized source, escaping, schema/canonical/link preservation, unchanged controls, meaningful
content dates, full-text facts beyond the cap, sidecar isolation, the per-page 40-row bound and
carry/refresh/expiry invalidation. Required backend and site suites run before PR.

Final local validation: backend 1,395 passed, two optional skips; site 244 passed. Independent
reviewer checks recomputed all 11 seed packet hashes, lengths, guarded facts and row bindings from
the checked source text and confirmed the four-page exposure and unchanged comparison pages.

Revert: set `COHORT_PATHS = frozenset()` to remove visible details. Remove the optional exporter
writer and sidecar to stop its records. Neither changes indexing rules. Fixed-page private reporting
can remain; restore the previous comparison tuple only if desired.
