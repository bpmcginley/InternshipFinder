# Verified requisition aliases after the first corrected ingest

The October 24 02:25:37 UTC export at main `489f7d34` revealed a remaining DQ-2 gap:
literal employer labels still separated the same individual ATS destination. Examples include
General Dynamics Mission Systems versus its Inc. spelling on iCIMS job 75478, and Leidos/Kudu
labels on one Workday tenant/site/requisition R-00195168. Custom iCIMS URLs also needed positive
adapter evidence before their plain and `?icims=1` forms could be reconciled.

The correction matches observed tenant/site/job identity. It does not maintain a company alias
dictionary. Lever, Ashby and SmartRecruiters retain their board path on shared hosts, including
numeric/UUID-shaped tenant tokens. Greenhouse uses an explicit board path; custom/embed IDs
join that board only through an unambiguous exact-company/id observation. Ambiguous shared IDs,
different tenants/requisitions, generic boards and unsupported URLs remain separate. Existing
public ID suffixes stay unchanged for ordinary previously distinct requisitions.

The offline correction uses that same identity context and only groups **open** records. Existing
source scores, adapter evidence and freshness choose a retained record without changing its facts.
It removes **238 open IDs in 235 proved groups**: total records 24,343 to 24,105; open records
19,117 to 18,879. All **24,105 retained records**, their retained descriptions, all **5,226 closed
records** and `generated_at = 2026-10-24T02:25:37.291740+00:00` remain unchanged. Shard ordering is
preserved after filtering. Shard indexes, first-screen membership and aggregate counts follow the
retained records. The complete retained/removed ID map is in `requisition-backfill.json`.

The context-aware recognized-identity census falls from 235 duplicate groups to zero. The broader
audit canonicalizer still finds 124 candidate URL groups (132 excess variants), including shared
or insufficiently identified destinations. Those are not automatically removed and this change
does not claim that every remaining listing is unique.

Validation: backend **1,293 passed, two optional checks skipped**; site **239 passed**. An independent
reviewer passed a separate 16-case identity matrix in both row orders and verified retained records,
descriptions, closed records and timestamps against main. Regression tests cover tenant collisions,
Greenhouse ambiguity, saved ID stability, carryover, dry-run/write guards and backfill idempotence.
No source fetch, payment, email, deployment or merge was used to prepare this correction.

To reproduce, run `python -m internscout.reconcile_requisitions ../docs/data` from `backend/`.
It defaults to a dry run. A write requires `--write --expected-generated-at` with the exact existing
timestamp. Reverting the data commit restores the removed duplicate IDs; reverting the source
commit restores the earlier literal-company matching behavior. Neither requires a database migration.
