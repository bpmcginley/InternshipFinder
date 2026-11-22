# November search and discovery fixes

- Add the Computer Science and Statistics and Data Science major aliases when the majors hub points students to an existing canonical field page. Keep dedicated major pages when they qualify and keep aliases out of the sitemap.
- Prioritize California, Texas and Washington with the existing regional quality gates for field and place pages. This does not relax employer diversity, overlap or indexing rules.
- Hold the language, museum and theater focus searches until each field reaches ten nearby open roles. The weekly report uses the same eligibility rule as ingest, counts the generator’s actual page types and explains that its totals precede deployment retention.
- Fail IndexNow notification if the newly deployed sitemap cannot supply valid site URLs. Do not send removal notifications from an invalid or empty snapshot.

The golden build adds one Computer Science alias; the fixture does not need the Statistics and Data Science alias. Both alias paths have regression cases.

Chrome received a 404 at both current public major URLs, then followed each alias to the expected canonical page in a local production-style build pinned to `6b381156e`. The comparison ran at 1280 and 375 pixels, in light and dark modes. [Computer Science screenshots](../product/screenshots/nov22-search/) show the previous not-found page and the destination after redirect. No sponsored placement or provider submission was exercised.
