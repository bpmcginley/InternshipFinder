from __future__ import annotations

import json
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256

import pytest

from internscout import export_static, pipeline
from test_follow_lineage_checkpoint import rewrite
from test_follow_writer_provenance import BASELINE, NOW, database, observe_seed, raw, seed
from test_ingest_data_writer import ROOT


@pytest.fixture
def pending(tmp_path, database, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    from scripts import follow_lineage_checkpoint as accepted
    from scripts import follow_pending_checkpoint as codec
    from scripts import ingest_data_writer as w

    for role in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{role}_NAME", "Fixture")
        monkeypatch.setenv(f"GIT_{role}_EMAIL", "fixture@example.invalid")
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "")
    repo = tmp_path / "candidate"
    w.git(tmp_path, "init", str(repo))
    directory = repo / "docs/data"
    capture = observe_seed(seed(directory, []))
    w.git(repo, "add", "--all")
    w.git(repo, "commit", "-m", "Observed synthetic baseline")
    previous = codec.PendingFollowPredecessor(
        w.revision(repo, "HEAD"), w.revision(repo, "HEAD:docs/data"), None
    )

    pipeline.run(
        [raw("Fixture Closed", "closed") | {"active": False}, raw("Fixture Open", "open")],
        verbose=False,
        follow_capture=capture,
    )
    export_static.export(str(directory), follow_capture=capture)
    w.git(repo, "add", "--all")
    tree = w.git(repo, "write-tree").stdout.decode().strip()
    staged = w.validate_staged_follow_provenance(repo, tree, capture.result)
    w.git(repo, "commit", "-m", "Synthetic pending candidate")
    candidate = w.revision(repo, "HEAD")
    bounds = accepted.FollowCheckpointBounds(12_000, 5, 80_000, 10)
    payload = codec.prepare_pending_follow_checkpoint(
        repo,
        candidate=candidate,
        staged=staged,
        provenance=capture.result,
        predecessor=previous,
        prepared_at=NOW,
        bounds=bounds,
    )
    return repo, w, codec, accepted, previous, payload, bounds


def test_local_recovery_preserves_closed_lineage_in_later_accepted_identity(pending):
    repo, w, codec, accepted, previous, payload, bounds = pending
    # Recovery reads committed objects even after local files and index move.
    (repo / "docs/data/listings/index.json").write_bytes(b"{}")
    w.git(repo, "add", "--all")
    restored = codec.read_pending_follow_checkpoint(
        repo, payload, predecessor=previous, now=NOW + timedelta(minutes=1), bounds=bounds
    )
    assert payload == rewrite(json.loads(payload))
    assert b"example.test" not in payload
    assert restored.generation == sha256(payload).hexdigest()
    assert restored.provenance.covers_after == BASELINE
    assert len(restored.provenance.rows) == 1 and len(restored.provenance.lineage) == 2

    w.git(repo, "read-tree", restored.candidate_commit)
    staged = w.validate_staged_follow_provenance(repo, restored.candidate_tree, restored.provenance)
    later = (
        w.git(
            repo,
            "commit-tree",
            restored.candidate_tree,
            "-p",
            restored.candidate_commit,
            "-m",
            "Synthetic accepted descendant",
        )
        .stdout.decode()
        .strip()
    )
    receipt = w._bind_published_follow(repo, restored.candidate_commit, later, staged)
    assert receipt is not None and receipt.commit == later != restored.candidate_commit
    source = accepted.AcceptedFollowSource(
        later, receipt.public_tree, staged.index_bytes, staged.shards
    )
    promoted = accepted.encode_accepted_follow_checkpoint(
        receipt, restored.provenance, accepted_at=NOW + timedelta(minutes=1), bounds=bounds
    )
    decoded = accepted.decode_accepted_follow_checkpoint(
        promoted, source, now=NOW + timedelta(minutes=1), bounds=bounds
    )
    assert decoded.lineage == restored.provenance.lineage
    closed = next(key for key in decoded.by_listing_url if key[1].endswith("/closed"))
    assert decoded.by_listing_url[closed].verified_utc == NOW


def test_pending_bounds_and_exact_predecessor(pending):
    repo, _, codec, _, previous, payload, bounds = pending
    read = codec.read_pending_follow_checkpoint
    exact = replace(bounds, max_bytes=len(payload), max_rows=2)
    assert read(
        repo,
        payload,
        predecessor=previous,
        now=NOW + timedelta(hours=24, microseconds=-1),
        bounds=exact,
    )
    for data, expected, now, caps in (
        (payload, previous, NOW + timedelta(hours=24), bounds),
        (payload, previous, NOW - timedelta(microseconds=1), bounds),
        (payload, replace(previous, checkpoint_sha256="1" * 64), NOW, bounds),
        (payload, replace(previous, public_tree="2" * 40), NOW, bounds),
        (payload, previous, NOW, replace(exact, max_rows=1)),
        (payload, previous, NOW, replace(exact, max_bytes=len(payload) - 1)),
        (payload, previous, NOW, replace(exact, max_source_bytes=1000)),
        (payload, previous, NOW, replace(exact, max_source_rows=1)),
        (payload + b" ", previous, NOW, bounds),
    ):
        with pytest.raises(ValueError):
            read(repo, data, predecessor=expected, now=now, bounds=caps)


def test_raw_candidate_parent_and_owned_tree_survive_local_view_overrides(pending, monkeypatch):
    repo, w, codec, _, previous, payload, bounds = pending
    original = json.loads(payload)
    candidate, tree = original["candidate_commit"], original["candidate_tree"]

    def read(record):
        return codec.read_pending_follow_checkpoint(
            repo, rewrite(record), predecessor=previous, now=NOW, bounds=bounds
        )

    wrong = w.git(repo, "commit-tree", tree, "-m", "Unrelated candidate").stdout.decode().strip()
    w.git(repo, "replace", wrong, candidate)
    assert read(original).candidate_commit == candidate
    with pytest.raises(ValueError, match="raw predecessor"):
        read(original | {"candidate_commit": wrong})
    (repo / ".git/info/grafts").write_text(f"{wrong} {previous.commit}\n", encoding="ascii")
    with pytest.raises(ValueError, match="raw predecessor"):
        read(original | {"candidate_commit": wrong})

    (repo / "unrelated.txt").write_text("unowned", encoding="ascii")
    w.git(repo, "add", "unrelated.txt")
    w.git(repo, "commit", "--amend", "--no-edit")
    monkeypatch.setenv("GIT_LITERAL_PATHSPECS", "1")
    with pytest.raises(ValueError, match="diff-tree"):
        read(original | {"candidate_commit": w.revision(repo, "HEAD")})
    for corrupted in (
        original | {"public_tree": "f" * 40},
        original | {"rows": original["rows"] + original["rows"][:1]},
        original | {"index_sha256": "0" * 64},
    ):
        with pytest.raises(ValueError):
            read(corrupted)
