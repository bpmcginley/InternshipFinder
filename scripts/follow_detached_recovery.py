"""Dormant recovery from persisted pending lineage and external operation authority."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import os
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


def _detached_environment():
    # Legacy staged/binding ports inherit the process environment. Require a
    # dedicated process instead of temporarily changing process-global Git state.
    env = {k: v for k, v in os.environ.items() if k.upper().startswith("GIT_")}
    # POSIX Git reads literal uppercase names. Never normalize a lowercase alias
    # or allow it to shadow an unsafe uppercase control. Windows os.environ
    # already exposes its case-insensitive native keys in uppercase.
    if any(k != k.upper() for k in env):
        raise ValueError("canonical Git environment names required")
    required = {
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_NO_LAZY_FETCH": "1",
    }
    identities = {
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_AUTHOR_DATE",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "GIT_COMMITTER_DATE",
    }
    if (
        any(env.get(k) != v for k, v in required.items())
        or env.get("GIT_ALLOW_PROTOCOL") not in ("", "file")
        or set(env) - required.keys() - identities - {"GIT_ALLOW_PROTOCOL"}
    ):
        raise ValueError("isolated detached Git process required")


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

    checkout must be private to this caller, with HEAD at the original pending
    candidate and its native index equal to that candidate tree. The dedicated
    process must satisfy _detached_environment and stay unchanged for this call.
    Never reset it here. The caller separately supplies verified predecessor source,
    explicit seed if needed, and external
    accepted-operation authority. This function performs no push or authority lookup.
    A returned receipt can feed plan_follow_archive_from_publication unchanged in
    this new process. Missing/uncertain recovery returns no receipt and is not retried.
    """
    if enabled is not True:
        return DetachedFollowRecovery("disabled")
    try:
        selected = _authority(authority)
        _detached_environment()
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
            _detached_environment()
            raw_git = writer._call(_candidate_git, checkout)
            if (
                writer._call(raw_git, "rev-parse", "HEAD").strip().decode("ascii")
                != pending.candidate_commit
                or writer._call(raw_git, "write-tree").strip().decode("ascii")
                != pending.candidate_tree
            ):
                raise ValueError("original candidate HEAD and native index required")
            # This checks the asserted edge, not the authority of the operation.
            if writer._call(raw_git, "cat-file", "-t", observed.commit).strip() != b"commit":
                raise ValueError("accepted identity must be a commit")
            size = int(writer._call(raw_git, "cat-file", "-s", observed.commit))
            if not 0 < size <= bounds.max_source_bytes:
                raise ValueError("accepted commit byte bound")
            commit = writer._call(raw_git, "cat-file", "commit", observed.commit)
            if len(commit) != size:
                raise ValueError("accepted commit size changed")
            headers = commit.split(b"\n\n", 1)[0].split(b"\n")
            oid = rb"[a-f0-9]{%d}" % len(observed.commit)
            if not headers or not re.fullmatch(b"tree " + oid, headers[0]):
                raise ValueError("invalid accepted commit tree header")
            parents = []
            position = 1
            while position < len(headers) and headers[position].startswith(b"parent "):
                if not re.fullmatch(b"parent " + oid, headers[position]):
                    raise ValueError("invalid accepted commit parent header")
                parents.append(headers[position][7:].decode("ascii"))
                position += 1
            if any(line.startswith(b"parent ") for line in headers[position:]):
                raise ValueError("noncontiguous accepted commit parent header")
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
