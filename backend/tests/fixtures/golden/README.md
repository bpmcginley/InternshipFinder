# Golden public-site build

This fixture contains 300 invented listings. They are test data, not actual job
openings. All application links use `jobs.example.com`. Four employer names match
the existing optional-detail cohort so the exported facts sidecar and employer
cards are exercised; their titles and descriptions are entirely synthetic.

From the repository root:

```sh
python backend/tests/golden_build.py
cd backend
python -m pytest tests/test_golden_build.py -q
```

The normal backend pytest suite discovers both golden tests. The second test
changes one character in the footer template in its private temporary source
copy and verifies that the comparison fails with changed paths and short diffs.
It never edits the working checkout.

To intentionally approve changed output, review the change, then run:

```sh
python backend/tests/golden_build.py --refresh
```

Commit both `manifest.json` and `expected.tar.gz`, and explain affected page families
in the PR. Refactor output must remain identical except for an explicitly
approved behavior change. Product changes must refresh their baseline in the
same PR, with the intended differences explained. Never refresh merely to make
a refactor test pass. `expected.tar.gz` contains the full public output bytes for
bounded text diffs; it has fixed archive timestamps and contains no production
listing data, private notes, credentials or service responses.

The harness copies current production Python modules and public static assets to
a temporary directory. It omits `docs/data` entirely and seeds an isolated SQLite
database using only `inputs/listings.json`. It executes the actual module command
entry points, in separate processes: `internscout.export_static`,
`internscout.seo_pages`, then `internscout.site_links`. Consequently feeds, role
index, widget data, placements and content dates use production orchestration.
The near-page switch keeps its production value; pytest's in-process autouse
fixture cannot disable it. Coverage assertions require all 500 near pages and
their hub, plus the field, state, major, employer, pay, numbers, new-listing,
term-tracker and digest families, a paid box and cohort detail records.

Deterministic inputs:

- Clock: 2026-11-10 12:00:00 UTC, frozen before production imports, including
  import-time profile terms and optional-detail timestamps. Locale is `C`.
- Live sitemap, held/noindex pages, earning evidence, placements (one active and
  one expired) and prior page-content dates: the files in `inputs/`. Prior content
  dates cover both an unchanged page that retains its date and a changed page.
- Previous export and geocode cache: absent in the isolated tree. Geocoding is
  disabled. No real data, registry, geocode cache or Search Console evidence is
  copied from the checkout.
- Environment: only process-launch OS variables are inherited. Credentials and
  user configuration are excluded; hash seed is zero. Socket connection, DNS and
  datagram attempts fail, including an attempt swallowed by a production helper.
- Text inputs are copied with LF line endings to model the production Linux
  checkout, including when Git on Windows uses CRLF. Binary assets are untouched.
  Output bytes are never normalized before hashing; generated differences remain
  visible. Every output file participates in the SHA-256 manifest.

The test performs no ingestion, remote fetch, mail, database service write,
publication or deployment. Outputs stay in temporary test directories; the CLI
cleans its temporary directory automatically, and pytest controls test retention.
