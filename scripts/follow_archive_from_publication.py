"""Offline planning from an accepted ingest publication and explicit coverage."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from types import MappingProxyType

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
    _DIGEST,
    _LISTING_ID,
    _MAX_SAFE_INTEGER,
    _SHARD,
    snapshot_from_fixed_export,
)
from internscout.follow_writer_provenance import FirstSeenLineage
from scripts.ingest_data_writer import _PublishedFollowProvenance, _StagedFollowProvenance

_GIT_ID = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")


def _bounded_source(staged: _StagedFollowProvenance, max_bytes: int, max_rows: int) -> bool:
    # Match the adapter's source limits before materializing a second evidence mapping.
    if (
        any(
            type(limit) is not int or not 0 < limit <= _MAX_SAFE_INTEGER
            for limit in (max_bytes, max_rows)
        )
        or not isinstance(staged.index_bytes, bytes)
        or not all(
            isinstance(value, MappingProxyType)
            for value in (staged.shards, staged.shard_sha256, staged._rows)
        )
        or len(staged._rows) > max_rows
    ):
        return False
    total = len(staged.index_bytes)
    for blob in staged.shards.values():
        if not isinstance(blob, bytes):
            return False
        total += len(blob)
        if total > max_bytes:
            return False
    if total > max_bytes:
        return False

    if (
        not staged.shard_sha256
        or not isinstance(staged.index_sha256, str)
        or not _DIGEST.fullmatch(staged.index_sha256)
        or any(
            not isinstance(key, str)
            or not _SHARD.fullmatch(key)
            or not isinstance(digest, str)
            or not _DIGEST.fullmatch(digest)
            for key, digest in staged.shard_sha256.items()
        )
        or staged.shards.keys() != {f"listings/{key}.json" for key in staged.shard_sha256}
    ):
        return False

    proof_bytes = 0
    for role_id, proof in staged._rows.items():
        if (
            not isinstance(role_id, str)
            or not _LISTING_ID.fullmatch(role_id)
            or not isinstance(proof, FirstSeenLineage)
            or not isinstance(proof.raw_first_seen, str)
            or not proof.raw_first_seen.isascii()
            or not 19 <= len(proof.raw_first_seen) <= 26
            or (proof.verified_utc is None) == (proof.observed_by is None)
            or not isinstance(proof.verified_utc or proof.observed_by, datetime)
        ):
            return False
        proof_bytes += len(role_id) + len(proof.raw_first_seen)
        if proof_bytes > max_bytes:
            return False
    return True


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
            or not _bounded_source(staged, max_source_bytes, max_source_rows)
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
