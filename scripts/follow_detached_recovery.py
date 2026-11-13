"""Dormant recovery from persisted pending lineage and external operation authority."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
from time import monotonic

from internscout.follow_snapshot_source import _utc
from scripts.follow_checkpoint_promotion import AcceptedFollowObservation, BoundFollowAcceptance
from scripts.follow_checkpoint_writer import FollowCheckpointWriter
from scripts.follow_pending_checkpoint import _candidate_git
from scripts.ingest_data_writer import (
    _PublishedFollowProvenance,
    _bind_published_follow,
    validate_staged_follow_provenance,
)


@dataclass(frozen=True)
class AcceptedFollowOperation:
    """Caller-verified authority, NOT authentication performed by this record.

    The caller must independently prove this exact accepted operation belongs to the
    stated run/attempt/ordinal, including the original observation time. No provider,
    journal, trailer, current-tip inference or production authority is supplied here.
    All fields are transient; no new retained witness data is written.
    """

    run_id: int
    run_attempt: int
    ordinal: int
    expected_predecessor: str
    pending_candidate: str
    pending_generation: str
    observation: AcceptedFollowObservation


@dataclass(frozen=True)
class DetachedFollowRecovery:
    status: str
    receipt: _PublishedFollowProvenance | None = None


def _authority(value):
    if type(value) is not AcceptedFollowOperation:
        raise ValueError("external accepted-operation authority required")
    o = value.observation
    if type(o) is not AcceptedFollowObservation or type(o.observed_at) is not datetime:
        raise ValueError("invalid accepted-operation observation")
    numbers = (value.run_id, value.run_attempt, value.ordinal)
    ids = (value.expected_predecessor, value.pending_candidate, o.commit, o.public_tree)
    if (
        any(type(n) is not int or not 0 < n <= 2**53 - 1 for n in numbers)
        or value.ordinal > 3
        or any(type(s) is not str or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", s) for s in ids)
        or len({len(s) for s in ids}) != 1
        or type(value.pending_generation) is not str
        or not re.fullmatch(r"[a-f0-9]{64}", value.pending_generation)
        or o.observed_at.microsecond % 1000
    ):
        raise ValueError("invalid accepted-operation authority")
    # Copy the complete primitive authority before any injected/private operation.
    return AcceptedFollowOperation(
        *numbers,
        value.expected_predecessor,
        value.pending_candidate,
        value.pending_generation,
        AcceptedFollowObservation(o.commit, o.public_tree, _utc(o.observed_at)),
    )


def recover_detached_follow(
    checkout,
    client,
    source,
    authority,
    *,
    enabled=False,
    bounds=None,
    deadline=None,
    clock=None,
    forward_seed=None,
    _monotonic=monotonic,
) -> DetachedFollowRecovery:
    """Return a typed receipt only after an acknowledged existing promotion.

    checkout must be private to this caller, with its index still equal to the
    original pending candidate tree. Never reset it here. The caller separately
    supplies verified predecessor source, explicit seed if needed, and external
    accepted-operation authority. This function performs no push or authority lookup.
    A returned receipt can feed plan_follow_archive_from_publication unchanged in
    this new process. Missing/uncertain recovery returns no receipt and is not retried.
    """
    if enabled is not True:
        return DetachedFollowRecovery("disabled")
    try:
        selected = _authority(authority)
        writer = FollowCheckpointWriter(
            checkout, client, bounds=bounds, deadline=deadline, clock=clock, _monotonic=_monotonic
        )
        verified = writer.load(source, selected.observation, forward_seed=forward_seed)
        receipt = None

        def bind(pending, observed):
            nonlocal receipt
            if (
                pending.generation != selected.pending_generation
                or pending.candidate_commit != selected.pending_candidate
                or observed != selected.observation
            ):
                raise ValueError("operation differs from persisted pending identity")
            raw_git = _candidate_git(checkout)
            # This checks the asserted edge, not the authority of the operation.
            commit = raw_git("cat-file", "commit", observed.commit)
            parents = [
                line[7:].decode("ascii")
                for line in commit.split(b"\n\n", 1)[0].splitlines()
                if line.startswith(b"parent ")
            ]
            if selected.expected_predecessor not in parents:
                raise ValueError("accepted operation predecessor differs")
            staged = validate_staged_follow_provenance(
                checkout, pending.candidate_tree, pending.provenance
            )
            exact = _bind_published_follow(
                checkout, pending.candidate_commit, observed.commit, staged
            )
            if exact is None or exact.public_tree != observed.public_tree:
                raise ValueError("accepted publication differs from pending source")
            receipt = exact
            return BoundFollowAcceptance(pending.candidate_commit, exact)

        status = writer.recover(verified, bind_accepted=bind)
        if status not in ("promoted", "already_promoted") or receipt is None:
            return DetachedFollowRecovery("held")
        return DetachedFollowRecovery(status, receipt)
    except Exception:
        # Includes lost mutation acknowledgement. Do not echo private details or retry.
        return DetachedFollowRecovery("held")
