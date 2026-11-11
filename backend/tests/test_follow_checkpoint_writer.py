from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from hashlib import sha256
import json

import pytest

from internscout import export_static, pipeline
from internscout.follow_writer_provenance import FollowWriterCapture
from test_follow_lineage_checkpoint import accepted, encoded
from test_follow_pending_checkpoint import pending
from test_follow_writer_provenance import BASELINE, NOW, FrozenDateTime, database, raw


class Store:
    def __init__(self, state):
        self.state = state
        self.calls = []
        self.after_load = lambda: None
        self.after_stage = lambda: None
        self.after_cas = lambda: None

    def load(self):
        self.calls.append("load")
        self.after_load()
        return self.state

    def stage(self, payload):
        self.calls.append("stage")
        self.state = replace(self.state, pending=payload)
        self.after_stage()
        return "pending"

    def compare_and_set(self, change):
        self.calls.append("cas")
        self.state = type(self.state)("active", change.payload, None)
        self.after_cas()
        return "promoted"


@pytest.fixture
def scenario(pending):
    repo, git, _, accepted, previous, payload, bounds = pending
    from scripts import follow_checkpoint_writer as orchestration
    from scripts.follow_checkpoint_client import FollowCheckpointLoad
    from scripts.follow_checkpoint_promotion import AcceptedFollowObservation, BoundFollowAcceptance

    candidate = git.revision(repo, "HEAD")
    tree = git.revision(repo, "HEAD^{tree}")
    later = (
        git.git(repo, "commit-tree", tree, "-p", candidate, "-m", "Accepted recovery fixture")
        .stdout.decode()
        .strip()
    )

    def source(commit):
        prefix = f"{commit}:docs/data"
        index = git.git(repo, "cat-file", "blob", prefix + "/listings/index.json").stdout
        shards = {
            entry["file"]: git.git(repo, "cat-file", "blob", prefix + "/" + entry["file"]).stdout
            for entry in json.loads(index)["files"].values()
        }
        return accepted.AcceptedFollowSource(commit, git.revision(repo, prefix), index, shards)

    original = source(previous.commit)
    current = source(later)
    seed = orchestration.ForwardFollowSeed(previous, BASELINE, BASELINE)
    old = AcceptedFollowObservation(original.commit, original.public_tree, BASELINE)
    observed = AcceptedFollowObservation(current.commit, current.public_tree, NOW)
    elapsed = [0]
    clock = [NOW]

    def session(store):
        return orchestration.FollowCheckpointWriter(
            repo,
            store,
            bounds=bounds,
            deadline=10,
            clock=lambda: clock[0],
            _monotonic=lambda: elapsed[0],
        )

    def bind(exact, observation):
        staged = git.validate_staged_follow_provenance(repo, exact.candidate_tree, exact.provenance)
        receipt = git._bind_published_follow(
            repo, exact.candidate_commit, observation.commit, staged
        )
        return (
            BoundFollowAcceptance(exact.candidate_commit, receipt) if receipt is not None else None
        )

    return (
        orchestration,
        FollowCheckpointLoad,
        session,
        original,
        current,
        seed,
        old,
        observed,
        payload,
        bind,
        elapsed,
        clock,
    )


def test_stage_and_recovery_require_verified_state_and_explicit_reload(scenario):
    module, load, session, original, current, seed, old, observed, payload, bind, elapsed, _ = (
        scenario
    )
    store = Store(load("never_seeded", None, None))
    writer = session(store)
    clean = writer.load(original, old, forward_seed=seed)
    assert clean.pending is None and clean.covers_after == BASELINE

    recorded = load("never_seeded", None, payload)
    proof = session(Store(recorded)).load(original, old, forward_seed=seed).pending
    staged = bind(proof, observed).receipt.staged
    generation = writer.stage(
        clean, candidate=proof.candidate_commit, staged=staged, provenance=proof.provenance
    )
    assert generation == sha256(store.state.pending).hexdigest() == proof.generation
    with pytest.raises(module.FollowWriterCheckpointError, match="reload"):
        writer.stage(
            clean, candidate=proof.candidate_commit, staged=staged, provenance=proof.provenance
        )

    unresolved = writer.load(original, old, forward_seed=seed)
    assert (
        writer.recover(unresolved, bind_accepted=lambda *_: pytest.fail("unpublished"))
        == "no_publication"
    )
    pending_tip = writer.load(original, observed, forward_seed=seed)
    assert writer.recover(pending_tip, bind_accepted=bind) == "promoted"
    with pytest.raises(module.FollowWriterCheckpointError, match="reload"):
        writer.recover(pending_tip, bind_accepted=bind)
    accepted = writer.load(current, observed)
    assert accepted.pending is None and accepted.predecessor.commit == observed.commit
    assert accepted.predecessor.checkpoint_sha256 == sha256(store.state.accepted).hexdigest()
    assert any(url.endswith("/closed") for _, url in accepted.accepted.by_listing_url)
    assert store.calls == ["load", "stage", "load", "load", "cas", "load"]

    late_store = Store(load("never_seeded", None, None))
    late_writer = session(late_store)
    clean = late_writer.load(original, old, forward_seed=seed)
    late_store.after_stage = lambda: elapsed.__setitem__(0, 10)
    with pytest.raises(module.FollowWriterCheckpointError, match="deadline"):
        late_writer.stage(
            clean, candidate=proof.candidate_commit, staged=staged, provenance=proof.provenance
        )
    assert late_store.state.pending is not None
    with pytest.raises(module.FollowWriterCheckpointError, match="reload"):
        late_writer.stage(
            clean, candidate=proof.candidate_commit, staged=staged, provenance=proof.provenance
        )
    assert late_store.calls == ["load", "stage"]


def test_lost_ack_is_never_retried_and_cold_reader_reverifies(scenario):
    module, load, session, original, current, seed, _, observed, payload, bind, *_ = scenario
    store = Store(load("never_seeded", None, payload))
    writer = session(store)
    verified = writer.load(original, observed, forward_seed=seed)

    def lost_reply():
        raise OSError("synthetic lost acknowledgement")

    store.after_cas = lost_reply
    with pytest.raises(OSError, match="lost acknowledgement"):
        writer.recover(verified, bind_accepted=bind)
    with pytest.raises(module.FollowWriterCheckpointError, match="reload"):
        writer.recover(verified, bind_accepted=bind)

    wrong = replace(current, index_bytes=current.index_bytes + b" ")
    with pytest.raises(ValueError, match="source digest mismatch"):
        session(store).load(wrong, observed)
    recovered = session(store).load(current, observed)
    assert recovered.accepted is not None and recovered.pending is None
    assert store.calls.count("cas") == 1


def test_missing_or_inconsistent_state_cannot_advance(scenario):
    module, load, session, original, _, seed, old, observed, payload, _, *_ = scenario
    for state in ("expired", "unavailable"):
        store = Store(load(state, None, None))
        with pytest.raises(module.FollowWriterCheckpointError, match="unavailable"):
            session(store).load(original, old, forward_seed=seed)
        assert store.calls == ["load"]
    store = Store(load("never_seeded", None, None))
    with pytest.raises(module.FollowWriterCheckpointError, match="explicit forward seed"):
        session(store).load(original, old)
    with pytest.raises(module.FollowWriterCheckpointError, match="Git advanced"):
        session(store).load(original, observed, forward_seed=seed)
    store.state = load("never_seeded", None, payload)
    wrong_boundary = replace(seed, covers_after=BASELINE + timedelta(seconds=1))
    with pytest.raises(module.FollowWriterCheckpointError, match="coverage boundary"):
        session(store).load(original, old, forward_seed=wrong_boundary)
    assert set(store.calls) == {"load"}


def test_deadline_fences_late_read_binder_and_mutation_reply(scenario):
    module, load, session, original, _, seed, _, observed, payload, bind, elapsed, _ = scenario
    store = Store(load("never_seeded", None, payload))
    store.after_load = lambda: elapsed.__setitem__(0, 10)
    with pytest.raises(module.FollowWriterCheckpointError, match="deadline"):
        session(store).load(original, observed, forward_seed=seed)
    assert store.calls == ["load"]

    elapsed[0] = 0
    store.after_load = lambda: None
    writer = session(store)
    verified = writer.load(original, observed, forward_seed=seed)

    def late_bind(exact, observation):
        result = bind(exact, observation)
        elapsed[0] = 10
        return result

    with pytest.raises(module.FollowWriterCheckpointError, match="deadline"):
        writer.recover(verified, bind_accepted=late_bind)
    assert "cas" not in store.calls

    elapsed[0] = 0
    verified = writer.load(original, observed, forward_seed=seed)
    store.after_cas = lambda: elapsed.__setitem__(0, 10)
    with pytest.raises(module.FollowWriterCheckpointError, match="deadline"):
        writer.recover(verified, bind_accepted=bind)
    with pytest.raises(module.FollowWriterCheckpointError, match="reload"):
        writer.recover(verified, bind_accepted=bind)
    assert store.calls.count("cas") == 1


@pytest.fixture
def successor(accepted, monkeypatch):
    codec, _, _, source, bounds, directory, listing = accepted
    from scripts import ingest_data_writer as git
    from scripts.follow_checkpoint_client import FollowCheckpointLoad
    from scripts.follow_checkpoint_promotion import AcceptedFollowObservation
    from scripts.follow_checkpoint_writer import FollowCheckpointWriter

    raw_accepted = encoded(accepted)
    original = codec.decode_accepted_follow_checkpoint(raw_accepted, source, now=NOW, bounds=bounds)

    class Next(FrozenDateTime):
        @classmethod
        def now(cls, tz=None):
            value = NOW + timedelta(hours=1)
            return value if tz is not None else value.replace(tzinfo=None)

    monkeypatch.setattr(export_static, "datetime", Next)
    monkeypatch.setattr(pipeline, "datetime", Next)
    capture = FollowWriterCapture(
        covers_after=original.covers_after,
        prior_identity=original.identity,
        prior_lineage=original.lineage,
    )
    pipeline.run(
        [listing | {"active": False}, raw("Fixture Open", "open"), raw("New Fixture", "new")],
        verbose=False,
        follow_capture=capture,
    )
    export_static.export(str(directory), follow_capture=capture)
    repo = directory.parent.parent
    git.git(repo, "add", "--all")
    tree = git.git(repo, "write-tree").stdout.decode().strip()
    staged = git.validate_staged_follow_provenance(repo, tree, capture.result)
    git.git(repo, "commit", "-m", "Synthetic next candidate")
    candidate = git.revision(repo, "HEAD")
    utc = [NOW + timedelta(hours=2)]

    def session(store):
        return FollowCheckpointWriter(
            repo, store, bounds=bounds, deadline=10, clock=lambda: utc[0], _monotonic=lambda: 0
        )

    def observe():
        return AcceptedFollowObservation(source.commit, source.public_tree, utc[0])

    def store(pending=None):
        return Store(FollowCheckpointLoad("active", raw_accepted, pending))

    return (
        repo,
        codec,
        source,
        bounds,
        original,
        candidate,
        staged,
        capture.result,
        utc,
        session,
        observe,
        store,
    )


def test_stage_ack_fails_after_utc_expiry_or_rollback_without_retry(successor):
    from scripts.follow_checkpoint_writer import FollowWriterCheckpointError

    _, _, source, _, _, candidate, staged, provenance, utc, session, observe, new_store = successor
    cutoff = NOW + timedelta(days=7)
    for after, expected in (
        (cutoff, "accepted checkpoint expired"),
        (cutoff - timedelta(seconds=2), "clock moved backwards"),
    ):
        utc[0] = cutoff - timedelta(seconds=1)
        store = new_store()
        writer = session(store)
        verified = writer.load(source, observe())
        store.after_stage = lambda: utc.__setitem__(0, after)
        with pytest.raises(FollowWriterCheckpointError, match=expected):
            writer.stage(verified, candidate=candidate, staged=staged, provenance=provenance)
        assert store.state.pending is not None
        with pytest.raises(FollowWriterCheckpointError, match="reload"):
            writer.stage(verified, candidate=candidate, staged=staged, provenance=provenance)
        assert store.calls == ["load", "stage"]
        utc[0] = cutoff - timedelta(seconds=3)
        with pytest.raises(FollowWriterCheckpointError, match="clock moved backwards"):
            writer.load(source, observe())


def test_missing_retained_closed_evidence_is_refused_on_stage_and_cold_load(successor):
    from scripts.follow_checkpoint_writer import FollowWriterCheckpointError, _continuity_check
    from scripts.follow_pending_checkpoint import prepare_pending_follow_checkpoint

    (
        repo,
        codec,
        source,
        bounds,
        old,
        candidate,
        staged,
        provenance,
        utc,
        session,
        observe,
        new_store,
    ) = successor
    closed_key = next(key for key in old.lineage if key[0] not in provenance.rows)
    stripped = replace(
        provenance,
        lineage={key: proof for key, proof in provenance.lineage.items() if key != closed_key},
    )
    store = new_store()
    writer = session(store)
    verified = writer.load(source, observe())
    with pytest.raises(FollowWriterCheckpointError, match="retained listing"):
        writer.stage(verified, candidate=candidate, staged=staged, provenance=stripped)
    assert store.calls == ["load"] and store.state.pending is None

    stripped_raw = prepare_pending_follow_checkpoint(
        repo,
        candidate=candidate,
        staged=staged,
        provenance=stripped,
        predecessor=verified.predecessor,
        prepared_at=utc[0],
        bounds=bounds,
    )
    cold = new_store(stripped_raw)
    with pytest.raises(FollowWriterCheckpointError, match="retained listing"):
        session(cold).load(source, observe())
    assert cold.calls == ["load"]

    good = writer.load(source, observe())
    writer.stage(good, candidate=candidate, staged=staged, provenance=provenance)
    loaded = session(store).load(source, observe())
    assert closed_key in loaded.pending.provenance.lineage

    check = _continuity_check(source, old, bounds)
    _, rows = codec._source_rows(source, old.identity, bounds)
    closed_id, raw_time = closed_key
    alias = "f" * 16
    aliased = {alias: {**rows[closed_id], "id": alias, "status": "open"}}
    check({}, {})  # A row that was genuinely removed has no obligation.
    with pytest.raises(FollowWriterCheckpointError, match="retained listing"):
        check(aliased, {})
    check(aliased, {(alias, raw_time): old.lineage[closed_key]})
