"""Offline planning from an accepted ingest publication and explicit coverage."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime

from internscout.follow_snapshot import FollowSnapshotCatalog
from internscout.follow_snapshot_archive import (
    FollowArchiveBounds,
    FollowArchivePlan,
    plan_follow_snapshot_archive,
    select_follow_snapshot_for_enqueue,
)
from internscout.follow_snapshot_source import (
    FollowExportCapture,
    FollowFirstSeenEvidence,
    FollowTimeProvenance,
    snapshot_from_fixed_export,
)
from scripts.ingest_data_writer import _PublishedFollowProvenance, _StagedFollowProvenance

_GIT_ID = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")


def plan_follow_archive_from_publication(
    receipt: object,
    files: Mapping[str, bytes],
    *,
    effective_lower: datetime,
    now: datetime,
    bounds: FollowArchiveBounds,
    catalog: FollowSnapshotCatalog,
    max_source_bytes: int,
    max_source_rows: int,
) -> FollowArchivePlan | None:
    """Return a plan usable at the explicit lower boundary, or no plan."""

    if not isinstance(receipt, _PublishedFollowProvenance) or not isinstance(
        receipt.staged, _StagedFollowProvenance
    ):
        return None
    staged = receipt.staged
    ids = (receipt.commit, receipt.public_tree, staged.candidate_tree)
    if any(not isinstance(value, str) or not _GIT_ID.fullmatch(value) for value in ids):
        return None
    if len({len(value) for value in ids}) != 1 or not isinstance(bounds, FollowArchiveBounds):
        return None
    try:
        if (
            not isinstance(effective_lower, datetime)
            or effective_lower.utcoffset() is None
            or effective_lower.microsecond % 1000
        ):
            return None
        capture = FollowExportCapture(
            generated_at=staged.generated_at,
            covers_after=staged.covers_after,
            index_sha256=staged.index_sha256,
            shard_sha256=staged.shard_sha256,
            complete=True,
            first_seen_provenance=staged.for_adapter(FollowTimeProvenance, FollowFirstSeenEvidence),
        )
        candidate = snapshot_from_fixed_export(
            staged.index_bytes,
            staged.shards,
            capture=capture,
            catalog=catalog,
            bounds=bounds.snapshot,
            max_source_bytes=max_source_bytes,
            max_source_rows=max_source_rows,
        )
        if not staged.covers_after <= effective_lower <= staged.generated_at:
            return None
        plan = plan_follow_snapshot_archive(files, candidate, now=now, bounds=bounds)
        if (
            select_follow_snapshot_for_enqueue(
                plan.files, effective_lower=effective_lower, now=now, bounds=bounds
            )
            is None
        ):
            return None
        return plan
    except (ValueError, OverflowError):
        return None
