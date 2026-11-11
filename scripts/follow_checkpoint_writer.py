"""Detached orchestration for the writer's private follow checkpoint."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from math import isfinite
from time import monotonic

from internscout.follow_snapshot_source import _utc
from internscout.follow_writer_provenance import WriterProvenance
from scripts.follow_checkpoint_client import FollowCheckpointLoad
from scripts.follow_checkpoint_promotion import (
    AcceptedFollowObservation,
    PromotionStatus,
    recover_and_promote_follow_checkpoint,
)
from scripts.follow_lineage_checkpoint import _LIFETIME as _ACCEPTED_LIFETIME
from scripts.follow_lineage_checkpoint import (
    AcceptedFollowSource,
    FollowCheckpoint,
    _check_bounds,
    decode_accepted_follow_checkpoint,
)
from scripts.follow_pending_checkpoint import _LIFETIME as _PENDING_LIFETIME
from scripts.follow_pending_checkpoint import (
    PendingFollowCheckpoint,
    PendingFollowPredecessor,
    _check_predecessor,
    prepare_pending_follow_checkpoint,
    read_pending_follow_checkpoint,
)


class FollowWriterCheckpointError(RuntimeError):
    """Follow coverage is unavailable for this writer attempt."""


@dataclass(frozen=True)
class ForwardFollowSeed:
    """Explicit independent attestation of the original forward boundary."""

    predecessor: PendingFollowPredecessor
    observed_at: datetime
    covers_after: datetime


@dataclass(frozen=True)
class VerifiedWriterCheckpoint:
    predecessor: PendingFollowPredecessor
    covers_after: datetime
    accepted: FollowCheckpoint | None
    pending: PendingFollowCheckpoint | None


class FollowCheckpointWriter:
    """One bounded writer attempt using independently attested Git inputs."""

    def __init__(self, checkout, client, *, bounds, deadline, clock, _monotonic=monotonic):
        _check_bounds(bounds)
        try:
            deadline = float(deadline) if type(deadline) in (int, float) else float("nan")
        except OverflowError:
            deadline = float("nan")
        if not isfinite(deadline):
            raise FollowWriterCheckpointError("invalid checkpoint execution deadline")
        self._checkout = checkout
        self._client = client
        self._bounds = bounds
        self._deadline = deadline
        self._clock = clock
        self._monotonic = _monotonic
        self._loaded = None

    def _check_deadline(self):
        remaining = self._deadline - self._monotonic()
        if not isfinite(remaining) or remaining <= 0:
            raise FollowWriterCheckpointError("follow checkpoint execution deadline passed")

    def _call(self, operation, /, *args, **kwargs):
        self._check_deadline()
        result = operation(*args, **kwargs)
        self._check_deadline()
        return result

    def _now(self):
        return _utc(self._call(self._clock))

    def load(
        self,
        source: AcceptedFollowSource,
        observation: AcceptedFollowObservation,
        *,
        forward_seed: ForwardFollowSeed | None = None,
    ) -> VerifiedWriterCheckpoint:
        """Verify one store read against trusted predecessor bytes and the current Git tip."""
        self._loaded = None
        if not isinstance(source, AcceptedFollowSource) or not isinstance(
            observation, AcceptedFollowObservation
        ):
            raise FollowWriterCheckpointError("independent Git evidence required")
        observed = _utc(observation.observed_at)
        predecessor = PendingFollowPredecessor(source.commit, source.public_tree, None)
        current = PendingFollowPredecessor(observation.commit, observation.public_tree, None)
        _check_predecessor(predecessor)
        _check_predecessor(current)
        if len(predecessor.commit) != len(current.commit) or (
            predecessor.commit == current.commit and predecessor.public_tree != current.public_tree
        ):
            raise FollowWriterCheckpointError("inconsistent observed Git identity")

        loaded = self._call(self._client.load)
        now = self._now()
        if observed > now or not isinstance(loaded, FollowCheckpointLoad):
            raise FollowWriterCheckpointError("invalid checkpoint observation")
        accepted = pending = None
        if loaded.state == "active" and isinstance(loaded.accepted, bytes):
            accepted = self._call(
                decode_accepted_follow_checkpoint,
                loaded.accepted,
                source,
                now=now,
                bounds=self._bounds,
            )
            if observed < accepted.accepted_at:
                raise FollowWriterCheckpointError("Git observation predates accepted checkpoint")
            predecessor = PendingFollowPredecessor(
                source.commit, source.public_tree, sha256(loaded.accepted).hexdigest()
            )
            covers_after = accepted.covers_after
        elif loaded.state == "never_seeded" and loaded.accepted is None:
            if (
                not isinstance(forward_seed, ForwardFollowSeed)
                or forward_seed.predecessor != predecessor
            ):
                raise FollowWriterCheckpointError("explicit forward seed required")
            covers_after = _utc(forward_seed.covers_after)
            seed_observed = _utc(forward_seed.observed_at)
            if (
                covers_after.microsecond % 1000
                or not seed_observed <= covers_after <= now
                or seed_observed > observed
            ):
                raise FollowWriterCheckpointError("invalid forward seed boundary")
        else:
            raise FollowWriterCheckpointError("accepted checkpoint unavailable")

        if loaded.pending is not None:
            pending = self._call(
                read_pending_follow_checkpoint,
                self._checkout,
                loaded.pending,
                predecessor=predecessor,
                now=now,
                bounds=self._bounds,
            )
            if pending.provenance.covers_after != covers_after:
                raise FollowWriterCheckpointError(
                    "pending checkpoint changes the coverage boundary"
                )
        elif (source.commit, source.public_tree) != (current.commit, current.public_tree):
            raise FollowWriterCheckpointError("Git advanced without a verified pending checkpoint")

        verified = VerifiedWriterCheckpoint(predecessor, covers_after, accepted, pending)
        if self._ensure_live(verified) < observed:
            raise FollowWriterCheckpointError("checkpoint clock moved backwards")
        self._loaded = (verified, loaded.pending, observation)
        return verified

    def _ensure_live(self, verified):
        now = self._now()
        if now < verified.covers_after:
            raise FollowWriterCheckpointError("checkpoint clock predates coverage")
        if verified.accepted and not (
            timedelta(0) <= now - verified.accepted.accepted_at < _ACCEPTED_LIFETIME
        ):
            raise FollowWriterCheckpointError("accepted checkpoint expired")
        if verified.pending and not (
            timedelta(0) <= now - verified.pending.prepared_at < _PENDING_LIFETIME
        ):
            raise FollowWriterCheckpointError("pending checkpoint expired")
        return now

    def _take(self, verified):
        loaded = self._loaded
        self._loaded = None
        if loaded is None or loaded[0] is not verified:
            raise FollowWriterCheckpointError("reload and verify the checkpoint")
        self._check_deadline()
        return loaded[1:]

    def stage(self, verified: VerifiedWriterCheckpoint, *, candidate, staged, provenance) -> str:
        """Stage one exact new pending generation before the writer attempts publication."""
        self._take(verified)
        if (
            verified.pending is not None
            or not isinstance(provenance, WriterProvenance)
            or (provenance.covers_after != verified.covers_after)
        ):
            raise FollowWriterCheckpointError("checkpoint cannot stage a new generation")
        prepared = self._ensure_live(verified)
        raw = self._call(
            prepare_pending_follow_checkpoint,
            self._checkout,
            candidate=candidate,
            staged=staged,
            provenance=provenance,
            predecessor=verified.predecessor,
            prepared_at=prepared,
            bounds=self._bounds,
        )
        if not timedelta(0) <= self._ensure_live(verified) - prepared < _PENDING_LIFETIME:
            raise FollowWriterCheckpointError("checkpoint stage deadline passed")
        status = self._call(self._client.stage, raw)
        if type(status) is not str or status not in ("pending", "already_pending"):
            raise FollowWriterCheckpointError("checkpoint stage unconfirmed")
        return sha256(raw).hexdigest()

    def recover(self, verified: VerifiedWriterCheckpoint, *, bind_accepted) -> PromotionStatus:
        """Promote a verified accepted descendant once. Reload before using new lineage."""
        raw, observation = self._take(verified)
        if raw is None or observation.commit == verified.predecessor.commit:
            return "no_publication"

        def bind(exact, accepted):
            return self._call(bind_accepted, exact, accepted)

        def compare_and_set(change):
            self._ensure_live(verified)
            return self._call(self._client.compare_and_set, change)

        return self._call(
            recover_and_promote_follow_checkpoint,
            self._checkout,
            raw,
            predecessor=verified.predecessor,
            observation=observation,
            clock=self._now,
            bounds=self._bounds,
            bind_accepted=bind,
            compare_and_set=compare_and_set,
        )
