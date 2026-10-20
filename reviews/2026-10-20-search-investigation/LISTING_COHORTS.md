# Listing cohort investigation — 2026-10-20

## Measured public behavior

At investigation time, `/internships/cybersecurity/` and employer pages for Essentia Health, KKR,
EQ Bank and UL Solutions each returned HTTP 200, a self-referencing canonical and no HTML or
HTTP `noindex` directive. Cybersecurity showed 197 open roles. The employer URLs retained their
expected names and listings; no empty template or redirect was observed.

Historical public exported data was read from `origin/main`, using the last commit before each
day's 23:59:59 Eastern cutoff. Current `seo_pages.load()` and its unchanged cohort rules were used
to deduplicate open roles. These counts describe source data, not historical HTTP responses or
Google's selected canonicals.

| Cutoff | Commit | Cybersecurity roles | Essentia Health | KKR | EQ Bank | UL Solutions |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Oct 14 | e157177e | 196 | 8 | 6 | 20 | 12 |
| Oct 15 | cb9161b2 | 197 | 8 | 6 | 20 | 12 |
| Oct 16 | 44f69445 | 195 | 8 | 6 | 20 | 12 |
| Oct 17 | 972cf487 | 194 | 8 | 6 | 20 | 12 |
| Oct 18 | 4cdccf32 | 193 | 8 | 6 | 20 | 12 |
| Oct 20, latest available | 91a41604 | 197 | 8 | 4 | 20 | 12 |

The four employer cohorts kept identical listing IDs between Oct 15 and Oct 18. Their page
threshold is five new / three retained roles, so none crossed the retention boundary. KKR's
later change to four roles still meets the existing-page retention threshold. The cybersecurity
page retained 37 of its 40 displayed IDs between the Oct 15 and Oct 18 snapshots, using the actual
`seo_pages.shown()` order. The only landing-page generator diff in the Oct 16–18 interval changed
weekly-email example copy.

This evidence does not show a listing export or page-retention outage that explains the reported
search decline. Historical source availability alone cannot prove that a URL was continuously
served or establish why Google changed a result's position.

## Reproducible relevance defect and bounded correction

`backend/internscout/classify.py` used bare `security` as evidence for the field displayed as
Cybersecurity. As a result, the public cybersecurity page included ACLU/Brennan Center national
security legal and undergraduate placements, plus Johnson Controls' Security Systems Apprentice.
The latter's public description concerns installing intrusion alarms, access control, CCTV,
intercom and fire alarms. These are useful opportunities, but the titles do not describe cyber
security roles.

The correction excludes explicit national/food/physical security, guards/officers and Security
Systems Apprentice titles from this field unless explicit computing-security evidence is also
present. Existing law or other field matches remain; a listing with no other match remains
available as `other`. Ambiguous Security Intern / Security Operations / Global Security titles
are preserved. Cyber, information/network/application/software/hardware security and digital
forensics remain supported, including national-security cyber roles.

Across all 15,064 current public exported roles, comparing the old and new title classifier:

- Exactly seven records change; Cybersecurity goes from 197 to 190.
- Three national-security legal placements retain `law`.
- Three national-security undergraduate/fellowship placements and one physical systems apprentice
  retain the general `other` fallback; no listing is deleted.
- All other titles and field classifications are unchanged.

Six of those off-topic records already appeared in the displayed cybersecurity rows in both the
Oct 15 and Oct 18 snapshots. Therefore this defect predates the observed decline, and the
correction is a relevance improvement, not an established explanation or ranking recovery.

## Validation and release behavior

From `backend/`: `python -m pytest tests/test_classify_stage.py tests/test_seo_pages.py -q`:
**185 passed**. Fixtures cover the observed false positives, retained legal tagging, ambiguous
security titles and explicit cyber work overriding a national/physical security phrase.

Normalization calls `classify(title)` at `backend/internscout/normalize.py:353`. The change reaches
published listing data and generated pages after the next normal ingest/export and successful
Pages deployment; this source patch alone does not rewrite the current public data.
