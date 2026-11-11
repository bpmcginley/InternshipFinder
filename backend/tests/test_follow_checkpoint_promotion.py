from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from datetime import datetime, timedelta
from hashlib import sha256

import pytest

from test_follow_pending_checkpoint import pending
from test_follow_writer_provenance import NOW, database


@pytest.fixture
def recovery(pending):
    repo, writer, _, accepted, previous, payload, bounds = pending
    from scripts import follow_checkpoint_promotion as promotion

    candidate = writer.revision(repo, "HEAD")
    tree = writer.revision(repo, "HEAD^{tree}")
    public_tree = writer.revision(repo, "HEAD:docs/data")
    later = (
        writer.git(repo, "commit-tree", tree, "-p", candidate, "-m", "Accepted fixture")
        .stdout.decode()
        .strip()
    )
    observed = promotion.AcceptedFollowObservation(later, public_tree, NOW + timedelta(minutes=1))

    def bind(exact_pending, observation):
        assert exact_pending.candidate_commit == candidate
        staged = writer.validate_staged_follow_provenance(
            repo, exact_pending.candidate_tree, exact_pending.provenance
        )
        receipt = writer._bind_published_follow(repo, candidate, observation.commit, staged)
        return promotion.BoundFollowAcceptance(candidate, receipt) if receipt is not None else None

    def run(cas, *, observation=observed, clock=lambda: observed.observed_at, binder=bind):
        return promotion.recover_and_promote_follow_checkpoint(
            repo,
            payload,
            predecessor=previous,
            observation=observation,
            clock=clock,
            bounds=bounds,
            bind_accepted=binder,
            compare_and_set=cas,
        )

    return run, bind, accepted, previous, observed, payload, bounds


class LocalCheckpoint:
    """Offline fixture for the atomic store contract, with no runtime binding."""

    def __init__(self, path, previous, pending_digest):
        self.path = path
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.execute(
                """CREATE TABLE checkpoint (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                commit_id TEXT, tree_id TEXT, digest TEXT, accepted_at TEXT, accepted BLOB,
                pending TEXT, promoted TEXT
                )"""
            )
            conn.execute(
                "INSERT INTO checkpoint VALUES (1, ?, ?, ?, NULL, NULL, ?, NULL)",
                (previous.commit, previous.public_tree, previous.checkpoint_sha256, pending_digest),
            )

    def execute(self, sql, args=()):
        with closing(sqlite3.connect(self.path)) as conn, conn:
            return conn.execute(sql, args).fetchone()

    def read(self):
        return self.execute(
            "SELECT commit_id, tree_id, digest, accepted_at, accepted, pending, promoted "
            "FROM checkpoint WHERE id = 1"
        )

    def cas(self, change, now):
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT commit_id, tree_id, accepted_at, promoted FROM checkpoint WHERE id = 1"
            ).fetchone()
            stamp = now()
            if not change.live_at(stamp):
                return "stale"
            old_time = current[2]
            if old_time is not None and not (
                timedelta(0) <= stamp - datetime.fromisoformat(old_time) < timedelta(days=7)
            ):
                return "stale"
            if (change.accepted.commit, change.accepted.public_tree, change.pending_generation) == (
                current[0],
                current[1],
                current[3],
            ):
                return "already_promoted"
            result = conn.execute(
                """UPDATE checkpoint SET commit_id = ?, tree_id = ?, digest = ?,
                accepted_at = ?, accepted = ?, pending = NULL, promoted = ?
                WHERE id = 1 AND commit_id = ? AND tree_id = ? AND digest IS ? AND pending = ?""",
                (
                    change.accepted.commit,
                    change.accepted.public_tree,
                    change.accepted.checkpoint_sha256,
                    change.accepted_at.isoformat(),
                    change.payload,
                    change.pending_generation,
                    change.predecessor.commit,
                    change.predecessor.public_tree,
                    change.predecessor.checkpoint_sha256,
                    change.pending_generation,
                ),
            )
            return "promoted" if result.rowcount == 1 else "stale"


def test_lost_ack_replay_keeps_original_accepted_clock_and_closed_lineage(recovery, tmp_path):
    run, bind, accepted, previous, observed, raw, bounds = recovery
    store = LocalCheckpoint(tmp_path / "checkpoint.sqlite", previous, sha256(raw).hexdigest())
    staged_receipt = None

    def capture(pending, observation):
        nonlocal staged_receipt
        binding = bind(pending, observation)
        staged_receipt = binding.receipt
        return binding

    def committed_but_ack_lost(change):
        assert store.cas(change, lambda: observed.observed_at) == "promoted"
        raise OSError("fixture acknowledgement lost")

    with pytest.raises(OSError, match="acknowledgement lost"):
        run(committed_but_ack_lost, binder=capture)
    committed = store.read()  # Reopen SQLite as a cold reader without the cleared pending record.
    assert committed[:2] == (observed.commit, observed.public_tree)
    assert committed[3] == observed.observed_at.isoformat()
    assert committed[5:] == (None, sha256(raw).hexdigest())
    assert committed[2] == sha256(committed[4]).hexdigest()
    source = accepted.AcceptedFollowSource(
        observed.commit,
        observed.public_tree,
        staged_receipt.staged.index_bytes,
        staged_receipt.staged.shards,
    )
    record = accepted.decode_accepted_follow_checkpoint(
        committed[4], source, now=observed.observed_at, bounds=bounds
    )
    closed = next(key for key in record.by_listing_url if key[1].endswith("/closed"))
    assert record.by_listing_url[closed].verified_utc == NOW

    retry = replace(observed, observed_at=observed.observed_at + timedelta(minutes=5))
    store.execute("UPDATE checkpoint SET pending = ?", ("newer pending",))
    before_retry = store.read()
    assert (
        run(
            lambda change: store.cas(change, lambda: retry.observed_at),
            observation=retry,
            clock=lambda: retry.observed_at,
        )
        == "already_promoted"
    )
    assert store.read() == before_retry
    with pytest.raises(ValueError, match="accepted lifetime"):
        accepted.decode_accepted_follow_checkpoint(
            committed[4], source, now=observed.observed_at + timedelta(days=7), bounds=bounds
        )


def test_sqlite_fences_both_identities_expiry_and_rollback(recovery, tmp_path):
    run, _, _, previous, observed, raw, _ = recovery
    store = LocalCheckpoint(tmp_path / "checkpoint.sqlite", previous, sha256(raw).hexdigest())
    changes = []
    assert run(lambda change: changes.append(change) or "stale") == "stale"
    change = changes[0]
    initial = store.read()
    assert (
        run(lambda _: pytest.fail("no publication cannot promote"), observation=None)
        == "no_publication"
    )
    assert store.cas(change, lambda: NOW + timedelta(hours=24)) == "stale"
    assert store.cas(change, lambda: NOW) == "stale"
    checked_later = replace(change, checked_at=observed.observed_at + timedelta(milliseconds=1))
    assert store.cas(checked_later, lambda: observed.observed_at) == "stale"
    assert store.read() == initial

    store.execute("UPDATE checkpoint SET pending = 'newer'")
    assert store.cas(change, lambda: observed.observed_at) == "stale"
    assert store.read()[5] == "newer"
    store.execute(
        "UPDATE checkpoint SET pending = ?, digest = 'other predecessor'",
        (change.pending_generation,),
    )
    assert store.cas(change, lambda: observed.observed_at) == "stale"
    assert store.read()[2] == "other predecessor"

    old = replace(previous, checkpoint_sha256="f" * 64)
    store.execute(
        "UPDATE checkpoint SET digest = ?, accepted_at = ?",
        (old.checkpoint_sha256, (observed.observed_at - timedelta(days=7)).isoformat()),
    )
    assert store.cas(replace(change, predecessor=old), lambda: observed.observed_at) == "stale"
    assert store.read()[5] == change.pending_generation

    store.execute("UPDATE checkpoint SET digest = NULL, accepted_at = NULL")
    store.execute(
        """CREATE TRIGGER reject_fixture BEFORE UPDATE ON checkpoint
        WHEN NEW.pending IS NULL BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"""
    )
    before_abort = store.read()
    with pytest.raises(sqlite3.IntegrityError, match="fixture rollback"):
        store.cas(change, lambda: observed.observed_at)
    assert store.read() == before_abort


def test_git_identity_and_post_verification_clock_fail_closed(recovery):
    run, bind, _, _, observed, _, _ = recovery

    def forbidden(_):
        pytest.fail("unexpected promotion")

    with pytest.raises(ValueError, match="typed accepted receipt"):
        run(forbidden, observation=replace(observed, commit="f" * 40))
    with pytest.raises(ValueError, match="differs from pending"):
        run(forbidden, observation=replace(observed, public_tree="f" * 40))

    def wrong_stage(pending, observation):
        binding = bind(pending, observation)
        receipt = binding.receipt
        return replace(
            binding,
            receipt=replace(receipt, staged=replace(receipt.staged, candidate_tree="f" * 40)),
        )

    with pytest.raises(ValueError, match="differs from pending proof"):
        run(forbidden, binder=wrong_stage)
    times = iter((observed.observed_at, NOW + timedelta(hours=24)))
    assert run(forbidden, clock=lambda: next(times)) == "stale"


def test_simultaneous_sqlite_promotions_install_once(recovery, tmp_path):
    run, _, _, previous, observed, raw, _ = recovery
    store = LocalCheckpoint(tmp_path / "checkpoint.sqlite", previous, sha256(raw).hexdigest())
    changes = []
    run(lambda change: changes.append(change) or "stale")
    change = changes[0]
    with ThreadPoolExecutor(max_workers=2) as workers:
        outcomes = list(
            workers.map(lambda _: store.cas(change, lambda: observed.observed_at), range(2))
        )
    assert sorted(outcomes) == ["already_promoted", "promoted"]
    assert store.read()[3:] == (
        observed.observed_at.isoformat(),
        change.payload,
        None,
        change.pending_generation,
    )


def test_ambiguous_store_results_raise_without_retry(recovery):
    run, _, _, _, _, _, _ = recovery

    class StringLike(str):
        pass

    for result in (
        None,
        True,
        {"status": "promoted"},
        "unknown",
        "no_publication",
        StringLike("promoted"),
    ):
        calls = []

        def cas(change):
            calls.append(change)
            return result

        with pytest.raises(ValueError, match="ambiguous promotion store result"):
            run(cas)
        assert len(calls) == 1


def test_same_tree_sibling_bound_to_other_candidate_cannot_promote(recovery, pending):
    run, _, _, previous, observed, _, _ = recovery
    repo, writer, _, _, _, _, _ = pending
    from scripts.follow_checkpoint_promotion import BoundFollowAcceptance

    sibling = (
        writer.git(
            repo,
            "commit-tree",
            writer.revision(repo, "HEAD^{tree}"),
            "-p",
            previous.commit,
            "-m",
            "Same-tree sibling",
        )
        .stdout.decode()
        .strip()
    )
    observation = replace(observed, commit=sibling)

    def forbidden(_):
        pytest.fail("sibling cannot promote")

    with pytest.raises(ValueError, match="typed accepted receipt"):
        run(forbidden, observation=observation)

    def wired_to_sibling(exact_pending, accepted):
        staged = writer.validate_staged_follow_provenance(
            repo, exact_pending.candidate_tree, exact_pending.provenance
        )
        receipt = writer._bind_published_follow(repo, sibling, accepted.commit, staged)
        assert receipt is not None
        return BoundFollowAcceptance(sibling, receipt)

    with pytest.raises(ValueError, match="different pending candidate"):
        run(forbidden, observation=observation, binder=wired_to_sibling)
