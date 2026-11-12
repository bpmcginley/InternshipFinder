"""Dormant same-process ingest/publication seam. No CLI or transport configuration."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from internscout import run_ingest
from internscout.config import DATA_DIR
from internscout.follow_writer_provenance import ExportIdentity, FollowWriterCapture
from scripts import ingest_data_writer as git
from scripts.follow_checkpoint_client import FollowCheckpointClientError
from scripts.follow_checkpoint_promotion import AcceptedFollowObservation, BoundFollowAcceptance
from scripts.follow_checkpoint_writer import (
    FollowCheckpointWriter,
    FollowWriterCheckpointError,
    ForwardFollowSeed,
)
from scripts.follow_lineage_checkpoint import (
    AcceptedFollowSource,
    FollowCheckpointBounds,
    _source_rows,
)

_HELD = (OSError, ValueError, FollowCheckpointClientError, FollowWriterCheckpointError)


@dataclass(frozen=True)
class FollowPublication:
    """Trusted caller supplies independently observed Git and bounded private-store access.

    An existing pending record must be recovered or explicitly resolved before this attempt.
    `observe` must reread accepted Git, not repeat the push response or local HEAD.
    """

    writer: FollowCheckpointWriter
    source: AcceptedFollowSource
    observation: AcceptedFollowObservation
    observe: Callable[[], AcceptedFollowObservation]
    bounds: FollowCheckpointBounds
    forward_seed: ForwardFollowSeed | None = None


@dataclass(frozen=True)
class IngestPublication:
    publication: tuple[str, str]
    follow: str


def ingest_and_publish(
    checkout: Path,
    state: Path,
    message: str,
    *,
    ingest_args: Sequence[str],
    follow: FollowPublication | None = None,
) -> IngestPublication:
    """Run ingest/export in this process, with an optional single pre-push stage.

    Checkpoint uncertainty holds Follow while independently validated listings may publish.
    Unexpected ingest/Git errors propagate. Lost mutation replies are never blindly retried.
    An outer process deadline remains required before production integration.
    """
    if Path(state).resolve() != Path(DATA_DIR).resolve():
        raise ValueError('Publication state must match configured ingestion state')
    if any(arg == '--export' or arg.startswith('--export=') for arg in ingest_args):
        raise ValueError('The publication checkout owns the export destination')
    checkout = Path(checkout)
    capture = verified = None
    status = 'disabled' if follow is None else 'held'
    if follow is not None:
        try:
            verified = follow.writer.load(
                follow.source, follow.observation, forward_seed=follow.forward_seed
            )
            if verified.pending is None:
                prior = verified.accepted
                identity = (
                    prior.identity
                    if prior is not None
                    else ExportIdentity(
                        sha256(follow.source.index_bytes).hexdigest(),
                        {
                            path.removeprefix('listings/').removesuffix('.json'): sha256(
                                raw
                            ).hexdigest()
                            for path, raw in follow.source.shards.items()
                        },
                    )
                )
                _source_rows(follow.source, identity, follow.bounds)
                capture = FollowWriterCapture(
                    covers_after=verified.covers_after,
                    prior_identity=identity,
                    prior_lineage=prior.lineage if prior is not None else None,
                    seed_observed_by=(follow.forward_seed.observed_at if prior is None else None),
                )
        except _HELD:
            pass
    run_ingest.main([*ingest_args, '--export', str(checkout / git.PUBLIC)], follow_capture=capture)
    proof = capture.result if capture is not None else None
    attempted = None

    def stage(candidate, staged):
        nonlocal attempted
        attempted = (candidate, staged)
        try:
            follow.writer.stage(verified, candidate=candidate, staged=staged, provenance=proof)
        except _HELD:
            # This may have committed. Only a fresh read can resolve it after publication.
            pass

    if proof is None:
        result = git.publish(checkout, state, message)
    else:
        result, _ = git.publish_with_follow_provenance(
            checkout, state, message, proof, before_first_push=stage
        )
        if not attempted:
            status = 'no_publication' if result[0] == 'No changes.' else 'held'
    if attempted:
        try:
            current = follow.writer.load(
                follow.source, follow.observe(), forward_seed=follow.forward_seed
            )

            def bind(exact, observation):
                candidate, staged = attempted
                if exact.candidate_commit != candidate:
                    return None
                # Retain the immutable pre-push proof across an unrelated Git merge.
                # The pending reader revalidates its committed objects independently.
                receipt = git._bind_published_follow(
                    checkout, candidate, observation.commit, staged
                )
                return BoundFollowAcceptance(exact.candidate_commit, receipt) if receipt else None

            recovered = follow.writer.recover(current, bind_accepted=bind)
            status = 'held' if recovered == 'no_publication' else recovered
        except _HELD:
            status = 'held'
    return IngestPublication(result, status)
