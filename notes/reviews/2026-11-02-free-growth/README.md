# Free search recovery and distribution, November 2

## Decisions

Three parallel reviewers researched Google recovery, social distribution and adversarial risks.
The selected work repairs measured defects and makes existing public listing data easier to reuse.
None of it establishes a reliable algorithm exploit, a ranking recovery or a viral outcome.

1. Fix the Google reporting boundary. The API returns `firstIncompleteDate`; the collector only
   accepted `first_incomplete_date`. It unnecessarily excluded available finalized dates.
2. Preserve the current Altera URL and restore the retired Altera Corporation address. Current
   data has ten deduplicated roles split equally between the two name spellings. The previous
   display-name vote could change the URL when that mix changed. Before this patch the old URL
   was HTTP 404 while the current URL was HTTP 200.
3. Prepare three source-backed role-title discovery sheets. Useful real titles give a student
   something concrete to search and share. These are drafts, not evidence of platform demand.
   Use existing free campaign rendering and artifact delivery; no new publisher or tracking service.
4. Complete the maintained GitHub list's missing description, homepage and relevant topics.
   This account metadata change was verified separately; it does not promise a ranking boost.

The campaign generator already makes real-search and tip packs. RSS, widgets, a public
`/internships/by-the-numbers/` report with Dataset markup, salary reports and referral features
already exist. Do not rebuild them. Additional dataset/editorial work waits for actual reuse.

Meta ads remain paused by Bruce. No spending, provider upgrade, new account, privacy change,
automated outreach or social publication is part of this patch. Student research sessions were
declined and are not a prerequisite. Use existing channel ownership before releasing any draft.

## Search scope and evidence

Actual-data baseline comparison produced 2,103 generated pages before and after the URL fix,
with zero added/removed generated paths, indexing/thin differences or HTML changes. The four
October 28 treatment pages are unchanged. The Altera alias is a separate static redirect file,
not another listing page or sitemap entry. The canonical destination is emitted only under the
existing page-generation rules; the alias is emitted only when that destination exists.

GitHub Pages serves static files, so the alias uses an immediate meta refresh, matching canonical
and visible link. It is not an HTTP 301. No indexing thresholds, held-page rules, sitemap inclusion
rules, build signature or protected search-console page selection file was changed.

Manual Google recrawl requests remain blocked: November 2's Under Armour request reached a blank
verification frame without an acceptance confirmation. Bruce reported that requesting indexing
currently errors. No request for any of the four pages is confirmed submitted. The existing
read-only pickup monitor remains the source for observed recrawl evidence.

## Distribution experiment

Generate with `python growth/title_discovery.py docs --out=NEW_EMPTY_DIRECTORY`. Review the exact
sources and validity window in the pack before publishing. The workflow produces these as an
optional part of the existing campaign artifact; refusal does not discard the original pack.

Try at most three reviewed pieces. Use existing bounded attribution fields, saves/shares and
confirmed provider subscriptions as distinct measurements. After 14 days, revise or stop if no
useful downstream evidence appears. Views alone are not returning users. This is an operating
decision, not a statistically validated conversion threshold or a claim of mass exposure.

## Research basis

- [Google core updates](https://developers.google.com/search/docs/appearance/core-updates):
  helpful improvements may take days to months; there is no guaranteed recovery.
- [Google recrawling](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl):
  repeated requests do not make crawling faster.
- [Google redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects):
  zero-second meta refresh is a permanent redirect signal when server redirects are unavailable.
- [Google REST discovery](https://searchconsole.googleapis.com/$discovery/rest?version=v1):
  the response schema defines camelCase completeness metadata.
- [TikTok recommendations](https://support.tiktok.com/en/using-tiktok/exploring-videos/how-tiktok-recommends-content):
  interactions and watching/skipping influence distribution; content volume is not a guarantee.
- [IndexNow FAQ](https://www.indexnow.org/faq): notification does not guarantee indexing.

## Revert

Validation: full backend suite 1,477 passed, two optional skips; site suite 244 passed. The final
marketing-relevance regression was then covered by the focused title/campaign suite, 51 passed.
An independent reviewer also checked metadata boundaries, scoped alias behavior, output evidence,
attribution, image layout and preservation of the original artifact on supplemental failure.

Revert this commit to remove the supplementary generator/workflow step, restore the prior date
parser and Altera URL construction, and stop emitting the alias on the next clean Pages build.
The separate GitHub description/homepage/topics can be restored through repository settings.
There is no database migration, new credential or paid service to remove.
