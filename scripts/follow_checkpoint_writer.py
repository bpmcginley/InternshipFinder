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
    _source_rows,
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


def _continuity_check(source, accepted, bounds):
    if accepted is None or not accepted.lineage:
        return None
    _, previous_rows = _source_rows(source, accepted.identity, bounds)
    by_id = {}
    by_url = {}
    # Match previous_export's first row per raw URL in sorted shard order.
    for role_id, row in previous_rows.items():
        url = row["apply_url"]
        if url not in by_url:
            key = (role_id, row["first_seen"])
            by_id[role_id] = by_url[url] = key

    def check(rows, lineage):
        for role_id, row in rows.items():
            prior = by_id.get(role_id) or by_url.get(row["apply_url"])
            if prior is None:
                continue
            proof = accepted.lineage.get(prior)
            stamp = row["first_seen"]
            if proof is not None and (stamp != prior[1] or lineage.get((role_id, stamp)) != proof):
                raise FollowWriterCheckpointError("retained listing changed predecessor lineage")

    return check


def _store_live(now, started, lifetime):
    # The Worker clock is integer UTC milliseconds. It ceils admission and floors expiry.
    remainder = timedelta(microseconds=started.microsecond % 1000)
    elapsed = now - (started - remainder)
    starts = timedelta(milliseconds=1) if remainder else timedelta(0)
    return starts <= elapsed < lifetime


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
        self._utc_high_water = None

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
        now = _utc(self._call(self._clock))
        if self._utc_high_water is not None and now < self._utc_high_water:
            raise FollowWriterCheckpointError("checkpoint clock moved backwards")
        self._utc_high_water = now
        return now

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

        if observed > self._now():
            raise FollowWriterCheckpointError("invalid checkpoint observation")
        loaded = self._call(self._client.load)
        now = self._now()
        if not isinstance(loaded, FollowCheckpointLoad):
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

        continuity = self._call(_continuity_check, source, accepted, self._bounds)
        if loaded.pending is not None:
            pending = self._call(
                read_pending_follow_checkpoint,
                self._checkout,
                loaded.pending,
                predecessor=predecessor,
                now=now,
                bounds=self._bounds,
                _continuity=continuity,
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
        self._loaded = (verified, loaded.pending, observation, continuity)
        return verified

    def _ensure_live(self, verified):
        now = self._now()
        if now < verified.covers_after:
            raise FollowWriterCheckpointError("checkpoint clock predates coverage")
        if verified.accepted and not _store_live(
            now, verified.accepted.accepted_at, _ACCEPTED_LIFETIME
        ):
            raise FollowWriterCheckpointError("accepted checkpoint expired")
        if verified.pending and not _store_live(
            now, verified.pending.prepared_at, _PENDING_LIFETIME
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
        _, _, continuity = self._take(verified)
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
            _continuity=continuity,
        )
        generation = sha256(raw).hexdigest()
        self._ensure_stage_live(verified, prepared)
        status = self._call(self._client.stage, raw)
        self._ensure_stage_live(verified, prepared)
        if type(status) is not str or status not in ("pending", "already_pending"):
            raise FollowWriterCheckpointError("checkpoint stage unconfirmed")
        return generation

    def _ensure_stage_live(self, verified, prepared):
        if not _store_live(self._ensure_live(verified), prepared, _PENDING_LIFETIME):
            raise FollowWriterCheckpointError("checkpoint stage deadline passed")

    def recover(self, verified: VerifiedWriterCheckpoint, *, bind_accepted) -> PromotionStatus:
        """Promote a verified accepted descendant once. Reload before using new lineage."""
        raw, observation, _ = self._take(verified)
        self._ensure_live(verified)
        if raw is None or observation.commit == verified.predecessor.commit:
            return "no_publication"

        def bind(exact, accepted):
            self._ensure_live(verified)
            return self._call(bind_accepted, exact, accepted)

        def compare_and_set(change):
            self._ensure_live(verified)
            status = self._call(self._client.compare_and_set, change)
            self._ensure_live(verified)
            return status

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
