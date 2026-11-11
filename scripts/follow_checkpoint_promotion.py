"""Recover and promote a pending follow checkpoint through a caller-owned transaction."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Literal

from internscout.follow_snapshot_source import _utc
from internscout.follow_writer_provenance import ExportIdentity
from scripts.follow_lineage_checkpoint import _LIFETIME as _ACCEPTED_LIFETIME
from scripts.follow_lineage_checkpoint import (
    FollowCheckpointBounds,
    _reject,
    encode_accepted_follow_checkpoint,
)
from scripts.follow_pending_checkpoint import (
    _LIFETIME as _PENDING_LIFETIME,
)
from scripts.follow_pending_checkpoint import (
    PendingFollowCheckpoint,
    PendingFollowPredecessor,
    _check_predecessor,
    read_pending_follow_checkpoint,
)
from scripts.ingest_data_writer import _PublishedFollowProvenance, _StagedFollowProvenance

PromotionStatus = Literal["promoted", "already_promoted", "stale", "no_publication"]


@dataclass(frozen=True)
class AcceptedFollowObservation:
    """Independently verified accepted publication identity and trusted observed time."""

    commit: str
    public_tree: str
    observed_at: datetime


@dataclass(frozen=True)
class FollowCheckpointPromotion:
    predecessor: PendingFollowPredecessor
    pending_generation: str
    prepared_at: datetime
    accepted: PendingFollowPredecessor
    accepted_at: datetime
    checked_at: datetime
    payload: bytes

    def live_at(self, now: datetime) -> bool:
        now = _utc(now)
        return (
            now >= self.checked_at
            and timedelta(0) <= now - self.prepared_at < _PENDING_LIFETIME
            and timedelta(0) <= now - self.accepted_at < _ACCEPTED_LIFETIME
        )


def recover_and_promote_follow_checkpoint(
    checkout: str | Path,
    raw: bytes,
    *,
    predecessor: PendingFollowPredecessor,
    observation: AcceptedFollowObservation | None,
    clock: Callable[[], datetime],
    bounds: FollowCheckpointBounds,
    bind_accepted: Callable[
        [PendingFollowCheckpoint, AcceptedFollowObservation], _PublishedFollowProvenance | None
    ],
    compare_and_set: Callable[[FollowCheckpointPromotion], PromotionStatus],
) -> PromotionStatus:
    """Reverify a pending generation and submit one atomic promotion.

    The trusted binder uses the #348 Git binding on this exact pending candidate and
    the independent accepted observation. The store takes a fresh authoritative time
    in its transaction. It checks both old accepted identity and pending generation,
    their lifetimes, installs accepted bytes, and clears exactly that pending. It may
    return already_promoted for the same generation and accepted Git identity, using
    the original stored acceptance time and payload. Ambiguous store errors propagate.
    """
    if observation is None:
        return "no_publication"
    if not isinstance(observation, AcceptedFollowObservation):
        raise _reject("independent accepted observation required")
    observed = _utc(observation.observed_at)
    _check_predecessor(PendingFollowPredecessor(observation.commit, observation.public_tree, None))
    now = _utc(clock())
    pending = read_pending_follow_checkpoint(
        checkout, raw, predecessor=predecessor, now=now, bounds=bounds
    )
    if not pending.prepared_at <= observed <= now or observation.public_tree != pending.public_tree:
        raise _reject("accepted observation differs from pending candidate")

    receipt = bind_accepted(pending, observation)
    if (
        not isinstance(receipt, _PublishedFollowProvenance)
        or receipt.commit != observation.commit
        or receipt.public_tree != observation.public_tree
        or not isinstance(receipt.staged, _StagedFollowProvenance)
    ):
        raise _reject("exact typed accepted receipt required")
    staged = receipt.staged
    proof = pending.provenance
    if (
        staged.candidate_tree != pending.candidate_tree
        or ExportIdentity(staged.index_sha256, staged.shard_sha256) != proof.identity
        or staged.generated_at != proof.generated_at
        or staged.covers_after != proof.covers_after
        or staged._rows != proof.rows
    ):
        raise _reject("accepted receipt differs from pending proof")
    payload = encode_accepted_follow_checkpoint(receipt, proof, accepted_at=observed, bounds=bounds)
    after_proof = _utc(clock())
    if after_proof < now:
        return "stale"
    promotion = FollowCheckpointPromotion(
        predecessor,
        pending.generation,
        pending.prepared_at,
        PendingFollowPredecessor(receipt.commit, receipt.public_tree, sha256(payload).hexdigest()),
        observed,
        after_proof,
        payload,
    )
    if not promotion.live_at(after_proof):
        return "stale"
    return compare_and_set(promotion)
