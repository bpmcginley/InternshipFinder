# October 23 audit: listing data quality

Scope: DQ-1 through DQ-5. No live data, provider configuration, accounts,
payments, emails or publication changed during this implementation.

## Evidence and corrections

The pinned October 23 export has 15,519 open records. Recognized individual ATS identities
group 160 repeated company-scoped requisitions with 162 excess record variants. The earlier
unscoped identity count was 167 groups/169 variants; employer scoping preserves unrelated boards.
This differs from the original audit's URL canonicalizer (161 groups, 163 variants), not a claim
that a fresh production ingest has already removed that many rows.

- DQ-1: complete fetched descriptions stay internal until eligibility extraction. The retained real
  CVS source preserves graduation years 2027 and 2028 instead of cutting off the range at 4000
  characters. Public descriptions still cap at 1500 characters. Legacy carried graduation windows
  without the new evidence version become unknown until refreshed; unrelated insights and dates stay.
- DQ-2: employer source facts now win over contradictory community titles and terms for
  a verified individual requisition. Distinct requisitions with equal titles survive. Generic
  board links and separate Workday sites survive. Source links remain attached. Locale/title
  changes cannot restore an older carried copy over a fetched requisition.
- DQ-3: thirteen existing `10.5-week` descriptions publish `5 weeks`. Decimal and explicit
  range parsing now keeps `10.5 weeks` and `10-12 weeks`; malformed/reversed ranges stay unknown.
- DQ-4: physical materials testing no longer matches bare software `test engineer`;
  cryptography no longer matches finance through bare `crypto`. Cryptocurrency/inventory,
  explicit software and genuinely mixed disciplines retain their tags.
- DQ-5: the existing `$0.02 /Yr` and `$20.00/Yr` amounts become unknown display pay, never
  guessed hourly salaries. Shared backend checks and client display checks agree. Existing
  raw supplied salary stays in the database for investigation. Rejected description amounts
  cannot recreate a Paid badge, but independent explicit employer paid wording survives.
  Post-carry cleanup also removes old inferred Paid badges when the raw amount is malformed;
  independent explicit paid wording survives. Raw supplied salary stays available for investigation.

## Validation

Individual data agent: backend 1,257 passed, two optional environment/media checks skipped,
then 29 focused tests passed after the final two negative-description cases. Site: 229 passed.
The separate complete-source eligibility agent passed six additional regressions. Focused cases assert fresh
versus carried identity, source authority in either arrival order, different requisitions,
separate boards, mixed fields, valid low hourly pay and legacy carried graduation limits.
Production data correction still requires the normal ingest/export. Final integrated PR validation
is recorded in its description; these individual totals are not added to each other.

## Revert

Revert the data-quality commit to restore the previous parser/deduper/display behavior.
No data schema migration is required. Reverting also restores the demonstrated incorrect duration,
compensation and eligibility behavior. Keep graduation-evidence marker and cleanup together.
