# Closure reliability — October 16, 2026

Implemented locally. No production database, paid searches, applications or deployments were used.

## Reproduced problem

`pipeline.run` inferred the sources scanned from the **accepted listings** in the
current batch. If employer A's Greenhouse scan succeeded and employer B's failed,
both employers appeared to be covered by the source name `greenhouse`. An unseen
listing from B could be closed. Conversely, a successful board returning zero
listings could not close its old entries because its source name never entered
that set. Search-only and community-list-only runs could also close postings
merely absent from that day's limited results.

## Resulting behavior

Absence only closes a listing when explicit successful, complete evidence exists
for its exact `(ATS, employer token)` board. The CLI carries that evidence from
`scan_boards(..., completed_boards=...)` to `run(..., completed_boards=...)`.
The default is an empty evidence set, making standalone/fixture callers safe.

Greenhouse, Lever, Ashby and Recruitee expose exhaustive list endpoints. Their
fetchers validate the expected list payload and explicitly signal completion.
Valid empty lists authorize closure for that employer. Malformed HTTP 200 payloads
raise an error instead of masquerading as empty boards. Detail enrichment limits
do not truncate those endpoints' posting inventory.

Other adapters do not yet prove pagination exhaustion. Their successful returns,
including empty returns, remain insufficient evidence for absence closure. Failed,
blocked and capped board scans never authorize it. Google Jobs, community lists
and public feed refreshes likewise do not authorize absence closure: their
current interfaces do not prove exhaustive coverage.

Existing `SourceLink.source_url` and `Listing.apply_url` recover employer
provenance without a schema migration. All recoverable employer boards for a row
must have completed; unresolved ATS provenance retains it. Employer evidence can
close a posting originally discovered through Google or a community list.
Source URLs/timestamps refresh on observation. A posting URL seen in the raw
batch remains protected even when missing enrichment or changed metadata causes
it to be rejected by current filters.

Explicit `active=False` continues to close a fetched posting; it does not depend
on absence inference.

## Validation

Offline SQLite regression coverage includes a failed board beside a successful
board on the same ATS, successful empty boards, incomplete/capped evidence,
unresolved provenance, raw presence with rejected metadata, validated empty versus
malformed responses, and separate `--ats`, `--lists`, and `--google` CLI modes.
The initial targeted run passed 39 tests across closure, board scanning and
pipeline suites. The backend suite at this workstream's completion passed 633
tests, with two optional/environment checks skipped; other workstreams are still
being integrated.

## Remaining tradeoff

This change deliberately retains potentially stale postings from adapters that
cannot yet prove completeness. Add adapter-specific pagination/response evidence
before enabling their absence closures, or validate individual posting closures
through a separate checked path. The legacy schema stores one source link per
source name, so multiple boards of the same ATS cannot always be reconstructed
perfectly; ambiguous provenance is retained instead of guessed. This change does
not reopen listings incorrectly closed by older ingestion runs.

The static exporter separately uses `carry_open_boards` to preserve previously
published rows after a large board-count drop. The new closure regressions cover
SQLite ingestion; they do not establish how that export carry policy interacts
with an authoritative empty-board closure. The exporter needs separate explicit
scan evidence before claiming end-to-end removal correctness. CI also rebuilds
its database between runs, so static carry behavior remains material even after
the ingestion fix.
