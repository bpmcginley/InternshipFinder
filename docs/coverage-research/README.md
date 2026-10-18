# Coverage expansion handoff

October 16, 2026. Work branch: `codex/expand-north-america-coverage`. No deployment, merge, production ingestion, paid AI/search calls, outreach, or applications performed. Existing unrelated untracked files were preserved.

## Implemented

- Oracle, Taleo and SuccessFactors now retain explicitly Canadian locations, including Canadian-only postings and mixed US/Canada roles. Other-country locations remain excluded.
- Workday searches both `intern` and `co-op`, merging overlapping job paths and retaining its existing pagination and detail limits. This adds search requests per board; production run duration and incremental yield still need measurement. A US example whose title lacks `intern` is [Manulife's Boston co-op](https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_Jobs/job/Spring-Co-op-2027---Software-Engineering--Security---Operations_JR26091121); actual search-index omission is inferred, not measured.
- French `stagiaire` titles and exact `Stage` employment types are admitted. French seasons map to existing term values. Bare English `stage` titles remain excluded. French discipline classification and broader student-role vocabulary remain follow-up work.
- SuccessFactors searches `stagiaire`, accepts locale-suffixed numeric job URLs and normalizes explicitly Canadian `Québ` province labels. These parser fixtures do not establish compatibility with every current employer search template.
- Scotiabank is seeded via its public SuccessFactors board. A live `/search/?q=co-op&startrow=0` request returned three parsed internships, all normalizable within US/Canada. This verifies retrieval/normalization only, not incremental unique production yield or every detail page. [Official student board](https://jobs.scotiabank.com/go/Student-%26-New-Grad-Jobs/2298417/).
- The existing coverage command now includes state/province/territory rows, including zeroes, and separate country-only/remote buckets. The all-states field table is correctly labeled US + Canada. CI already invokes this command, so its next run will include geographic gaps.

## Validation and baseline

`PYTHONPATH=backend python -m pytest backend/tests -q`: **612 passed, 2 skipped**. Tests include cross-border adapter fixtures, US namesakes, foreign exclusions, French terms, English theatre-role exclusions, Workday co-op retrieval/deduplication, and per-jurisdiction unique counts. `git diff --check` passed.

[Measured export baseline](north-america-baseline.md) uses the committed October 13 export. No published listing files were rewritten. Canada's Atlantic provinces, Manitoba, Saskatchewan and territories are the clearest geographic gaps in this snapshot; sparse counts can reflect collection gaps, seasonality or actual opportunity volume.

## Deferred and next verification

1. **Teck and Bombardier:** official pages expose student roles, but live `/search/` responses in this session contained zero parser-compatible job anchors, even after locale URL support. Not seeded. Investigate the public search templates and allowed access paths before enabling them. Do not equate a reachable HTTP 200 page with working ingestion. [Teck co-op](https://jobs.teck.com/job/Logan-Lake-Mine-Operations-Co-op-Student-Brit/54503-en_US/), [Bombardier French internship](https://jobs.bombardier.com/job/Stagiaire%2C-G%C3%A9nie-hydrom%C3%A9canique-%28Hiver-2027%29/15210-fr_CA/).
2. **Closure reliability:** source inspection of `pipeline.py` shows closure tracked by ATS-level source names, while `run_ingest.scan_boards` can omit individually failed boards. A failed employer scan alongside successful peers can therefore close its unseen listings. Reproduce with offline database fixtures and design board-level successful-scan tracking before changing closure semantics. This was not fixed in this pass.
3. **Run measurement:** after an authorized production rollout, compare new unique listings by state/province, source failures, co-op query latency, and ingestion duration. No numerical listing-growth claim is justified before that run.
4. **Source breadth:** prioritize official provincial/state student programs and employer boards in thin jurisdictions, using the report to choose targets. Avoid increasing paid search budgets without instruction.
5. **International expansion:** see [Europe research](europe-expansion.md) and [Eastern Asia research](eastern-asia-expansion.md). These are research-only recommendations. Implement explicit country identity, country-scoped remote handling, adapter admission, export routing and eligibility/language metadata before enabling either region.
