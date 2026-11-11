from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from shutil import copytree

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker

from internscout import export_static, pipeline
from internscout.db import Base
from internscout.follow_writer_provenance import FollowWriterCapture, _fixed_export
from internscout.models import Listing
from test_ingest_data_writer import writer

NOW = datetime(2026, 11, 11, 18, tzinfo=timezone.utc)
BASELINE = NOW - timedelta(hours=1)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is not None else NOW.replace(tzinfo=None)


@pytest.fixture
def database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{(tmp_path / 'synthetic.db').as_posix()}")
    Base.metadata.create_all(engine)

    class IsolatedSession(Session):
        pass

    sessions = sessionmaker(bind=engine, class_=IsolatedSession)
    for module in (pipeline, export_static):
        monkeypatch.setattr(module, "SessionLocal", sessions)
        monkeypatch.setattr(module, "init_db", lambda: None)
        monkeypatch.setattr(module, "datetime", FrozenDateTime)
    try:
        yield sessions, IsolatedSession
    finally:
        engine.dispose()


def raw(name, suffix):
    return {
        "company_name": name,
        "title": "Software Engineering Intern",
        "locations": ["Boston, MA"],
        "source": "fixture",
        "employment_type": "Intern",
        "url": f"https://jobs.example.test/{suffix}",
    }


def seed(directory, rows):
    export_static.write_shards(rows, str(directory), (BASELINE - timedelta(minutes=1)).isoformat())
    return _fixed_export(directory)[0]


def observe_seed(identity):
    return FollowWriterCapture(
        covers_after=BASELINE, seed_observed_by=BASELINE, prior_identity=identity
    )


def public_bytes(directory):
    return {p.relative_to(directory): p.read_bytes() for p in directory.rglob("*") if p.is_file()}


def test_committed_sqlite_origin_and_carry_selection_with_exact_public_byte_parity(
    tmp_path, database
):
    sessions, _ = database
    enabled, disabled = tmp_path / "enabled", tmp_path / "disabled"
    rows = [raw("Fixture Fresh", "fresh"), raw("Fixture Existing", "existing")]
    assert pipeline.run(rows[1:], verbose=False)["new"] == 1
    with sessions() as db:
        existing = export_static._listing_dict(db.scalar(select(Listing)))
    # Competing raw-URL predecessor is intentionally different. ID wins.
    id_stamp, url_stamp = "2026-11-01T10:00:00", "2026-11-02T11:00:00"
    identity = seed(
        enabled,
        [
            existing | {"apply_url": "https://jobs.example.test/prior-url", "first_seen": id_stamp},
            existing | {"id": "f" * 16, "first_seen": url_stamp},
        ],
    )
    copytree(enabled, disabled)
    capture = observe_seed(identity)
    assert pipeline.run(rows, verbose=False, follow_capture=capture)["new"] == 1
    export_static.export(str(enabled), follow_capture=capture)
    export_static.export(str(disabled))
    assert public_bytes(enabled) == public_bytes(disabled)
    proof = capture.result
    assert proof is not None
    assert (
        proof.identity.index_sha256
        == sha256((enabled / "listings/index.json").read_bytes()).hexdigest()
    )
    assert (
        proof.identity.shard_sha256["MA"]
        == sha256((enabled / "listings/MA.json").read_bytes()).hexdigest()
    )
    old = proof.rows[existing["id"]]
    assert (old.raw_first_seen, old.verified_utc, old.observed_by) == (id_stamp, None, BASELINE)
    fresh = next(value for key, value in proof.rows.items() if key != existing["id"])
    assert (fresh.raw_first_seen, fresh.verified_utc, fresh.observed_by) == (
        NOW.replace(tzinfo=None).isoformat(),
        NOW,
        None,
    )

    # A later isolated caller can pass the trusted lineage with its exact identity.
    second = FollowWriterCapture(
        covers_after=BASELINE, prior_identity=proof.identity, prior_lineage=proof.lineage
    )
    assert pipeline.run(rows, verbose=False, follow_capture=second)["new"] == 0
    export_static.export(str(enabled), follow_capture=second)
    assert second.result is not None
    assert second.result.rows == proof.rows


def test_url_fallback_and_search_carry_record_the_selected_predecessor(tmp_path, database):
    sessions, _ = database
    current = raw("Fixture Current", "existing")
    pipeline.run([current], verbose=False)
    with sessions() as db:
        existing = export_static._listing_dict(db.scalar(select(Listing)))
    recent = (BASELINE - timedelta(minutes=5)).replace(tzinfo=None).isoformat()
    older = existing | {"id": "b" * 16, "first_seen": recent}
    search = existing | {
        "id": "c" * 16,
        "apply_url": "https://jobs.example.test/search-only",
        "via_search": True,
        "first_seen": recent,
        "last_seen": recent,
    }
    collapsed = [
        search
        | {
            "id": str(i) * 16,
            "apply_url": f"https://boards.greenhouse.io/example/jobs/{i}",
            "ats": "greenhouse",
            "via_search": False,
        }
        for i in range(1, 4)
    ]
    identity = seed(tmp_path / "public", [older, search, *collapsed])
    capture = observe_seed(identity)
    export_static.export(str(tmp_path / "public"), follow_capture=capture)
    assert capture.result is not None
    assert set(capture.result.rows) == {existing["id"], search["id"], *(r["id"] for r in collapsed)}
    assert all(value.observed_by == BASELINE for value in capture.result.rows.values())


def test_failed_sqlite_commit_does_not_release_new_row_origin(tmp_path, database):
    sessions, session_type = database
    directory = tmp_path / "public"
    capture = observe_seed(seed(directory, []))

    def reject(_session):
        raise RuntimeError("synthetic commit failure")

    event.listen(session_type, "before_commit", reject)
    with pytest.raises(RuntimeError, match="synthetic"):
        pipeline.run([raw("Fixture Retry", "retry")], verbose=False, follow_capture=capture)
    event.remove(session_type, "before_commit", reject)
    with sessions() as db:
        assert db.scalar(select(Listing)) is None
    # An unobserved retry must not borrow evidence from the failed transaction.
    pipeline.run([raw("Fixture Retry", "retry")], verbose=False)
    export_static.export(str(directory), follow_capture=capture)
    assert capture.result is None


def test_seed_bound_requires_prior_observation(tmp_path):
    identity = seed(tmp_path / "public", [])
    with pytest.raises(ValueError, match="coverage start"):
        FollowWriterCapture(
            covers_after=BASELINE,
            prior_identity=identity,
            seed_observed_by=BASELINE + timedelta(microseconds=1),
        )


@pytest.mark.parametrize("failure", ["digest", "missing", "malformed"])
def test_invalid_predecessor_falls_back_to_normal_public_export(tmp_path, database, failure):
    sessions, _ = database
    healthy, enabled, disabled = (tmp_path / name for name in ("healthy", "enabled", "disabled"))
    rows = [raw("Fixture Prior", "prior"), raw("Fixture Fresh", "fresh")]
    pipeline.run(rows[:1], verbose=False)
    with sessions() as db:
        prior = export_static._listing_dict(db.scalar(select(Listing)))
    identity = seed(healthy, [prior | {"first_seen": "2026-11-01T10:00:00"}])
    copytree(healthy, enabled)
    capture = observe_seed(identity)
    pipeline.run(rows, verbose=False, follow_capture=capture)
    export_static.export(str(healthy), follow_capture=capture)
    assert capture.result is not None

    index = enabled / "listings/index.json"
    if failure == "digest":
        index.write_bytes(index.read_bytes() + b" ")
    elif failure == "missing":
        index.unlink()
    else:
        index.write_bytes(b"{invalid")
    copytree(enabled, disabled)
    assert export_static.export(str(enabled), follow_capture=capture) == export_static.export(
        str(disabled)
    )
    assert capture.result is None
    assert public_bytes(enabled) == public_bytes(disabled)
    assert public_bytes(enabled) == public_bytes(healthy)


def test_failed_seal_preserves_completed_public_export(tmp_path, database, monkeypatch):
    from internscout import follow_writer_provenance

    enabled, disabled = tmp_path / "enabled", tmp_path / "disabled"
    capture = observe_seed(seed(enabled, []))
    copytree(enabled, disabled)
    pipeline.run([raw("Fixture Fresh", "fresh")], verbose=False, follow_capture=capture)
    original = follow_writer_provenance._fixed_export
    calls = 0

    def fail_at_seal(directory):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("synthetic evidence read failure")
        return original(directory)

    monkeypatch.setattr(follow_writer_provenance, "_fixed_export", fail_at_seal)
    assert export_static.export(str(enabled), follow_capture=capture) == export_static.export(
        str(disabled)
    )
    assert calls == 2
    assert capture.result is None
    assert public_bytes(enabled) == public_bytes(disabled)


def test_unrelated_public_writer_errors_still_propagate(tmp_path, database, monkeypatch):
    directory = tmp_path / "public"
    capture = observe_seed(seed(directory, []))

    def fail_write(*_args):
        raise OSError("synthetic public write failure")

    monkeypatch.setattr(export_static, "write_shards", fail_write)
    with pytest.raises(OSError, match="public write failure"):
        export_static.export(str(directory), follow_capture=capture)
    assert capture.result is None


@pytest.fixture
def staged_writer(tmp_path, database):
    repo = tmp_path / "data-repo"
    state = tmp_path / "writer-state"
    state.mkdir()
    writer.git(tmp_path, "init", str(repo))
    writer.git(repo, "config", "core.autocrlf", "true")
    directory = repo / "docs/data"
    capture = observe_seed(seed(directory, []))
    pipeline.run(
        [
            raw("Fixture MA", "ma"),
            raw("Fixture NY", "ny") | {"locations": ["Albany, NY"]},
        ],
        verbose=False,
        follow_capture=capture,
    )
    export_static.export(str(directory), follow_capture=capture)
    assert capture.result is not None
    assert capture.result.identity.shard_sha256.keys() == {"MA", "NY"}
    return repo, state, capture.result


def stage(repo, state):
    writer.stage_snapshot(repo, state)
    return writer.git(repo, "write-tree").stdout.decode("ascii").strip()


def test_staged_proof_uses_exact_validated_git_bytes(staged_writer):
    repo, state, proof = staged_writer
    candidate = stage(repo, state)
    original = public_bytes(repo / "docs/data")
    assert writer.validate_tree(repo, candidate) is None
    checked = writer.validate_staged_follow_provenance(repo, candidate, proof)
    assert checked.candidate_tree == candidate
    assert checked.generated_at == proof.generated_at
    assert checked.covers_after == proof.covers_after
    assert checked.index_bytes == (repo / "docs/data/listings/index.json").read_bytes()
    assert checked.shard_sha256 == proof.identity.shard_sha256
    assert set(checked.shards) == {"listings/MA.json", "listings/NY.json"}
    assert checked.for_adapter(tuple_evidence, tuple_evidence) == (
        proof.identity.index_sha256,
        proof.identity.shard_sha256,
        {
            key: (value.raw_first_seen, value.verified_utc, value.observed_by)
            for key, value in proof.rows.items()
        },
    )
    assert not hasattr(proof, "for_adapter")
    assert public_bytes(repo / "docs/data") == original
    # An unstaged working-copy edit cannot replace the immutable candidate bytes.
    path = repo / "docs/data/listings/MA.json"
    path.write_bytes(b"unstaged")
    assert writer.validate_staged_follow_provenance(repo, candidate, proof).shards == checked.shards
    with pytest.raises(TypeError):
        checked.shards["listings/MA.json"] = b"substitute"


def tuple_evidence(*args):
    return args


@pytest.mark.parametrize(
    ("name", "reason"),
    [
        ("listings/index.json", "staged listing index"),
        ("listings/MA.json", "staged listing shards"),
    ],
)
def test_valid_but_changed_staged_blob_invalidates_proof(staged_writer, name, reason):
    repo, state, proof = staged_writer
    path = repo / "docs/data" / name
    path.write_bytes(path.read_bytes() + b" ")
    candidate = stage(repo, state)
    writer.validate_tree(repo, candidate)
    with pytest.raises(ValueError, match=reason):
        writer.validate_staged_follow_provenance(repo, candidate, proof)


def test_missing_staged_blob_fails_writer_validation(staged_writer):
    repo, state, proof = staged_writer
    (repo / "docs/data/listings/NY.json").unlink()
    candidate = stage(repo, state)
    with pytest.raises(ValueError, match="missing or invalid"):
        writer.validate_staged_follow_provenance(repo, candidate, proof)


def test_partial_proof_and_wrong_candidate_fail_closed(staged_writer):
    repo, state, proof = staged_writer
    older = stage(repo, state)
    partial = replace(
        proof,
        identity=replace(proof.identity, shard_sha256={"MA": proof.identity.shard_sha256["MA"]}),
    )
    with pytest.raises(ValueError, match="staged listing index"):
        writer.validate_staged_follow_provenance(repo, older, partial)
    stats = repo / "docs/data/stats.json"
    stats.write_bytes(stats.read_bytes() + b" ")
    newer = stage(repo, state)
    assert newer != older
    writer.validate_staged_follow_provenance(repo, newer, proof)
    with pytest.raises(ValueError, match="exact staged candidate"):
        writer.validate_staged_follow_provenance(repo, older, proof)


def test_changed_index_stage_during_validation_cannot_issue_receipt(staged_writer, monkeypatch):
    repo, state, proof = staged_writer
    candidate = stage(repo, state)
    validate = writer.validate_tree

    def restage(checkout, tree, **kwargs):
        validate(checkout, tree, **kwargs)
        stats = repo / "docs/data/stats.json"
        stats.write_bytes(stats.read_bytes() + b" ")
        assert stage(repo, state) != candidate

    monkeypatch.setattr(writer, "validate_tree", restage)
    with pytest.raises(ValueError, match="changed during"):
        writer.validate_staged_follow_provenance(repo, candidate, proof)


def test_archive_attributes_cannot_hide_a_staged_slim_shard(staged_writer):
    repo, state, proof = staged_writer
    path = "docs/data/listings/VA.json"
    (repo / path).write_bytes(b"[]")
    (repo / ".git/info/attributes").write_text(f"{path} export-ignore\n", encoding="utf-8")
    candidate = stage(repo, state)
    writer.validate_tree(repo, candidate)
    with pytest.raises(ValueError, match="paths differ"):
        writer.validate_staged_follow_provenance(repo, candidate, proof)


@pytest.mark.parametrize("use_original_stage", [True, False])
def test_staged_follow_receipt_ignores_replacement_tree(staged_writer, use_original_stage):
    repo, state, proof = staged_writer
    original = stage(repo, state)
    name = "docs/data/listings/MA.json"
    path = repo / name
    raw = path.read_bytes()
    changed = raw + b" "
    path.write_bytes(changed)
    alternative = stage(repo, state)
    assert original != alternative
    if use_original_stage:
        path.write_bytes(raw)
        assert stage(repo, state) == original
        source, replacement, replaced_bytes = original, alternative, changed
    else:
        source, replacement, replaced_bytes = alternative, original, raw
    writer.git(repo, "replace", source, replacement)
    assert writer.git(repo, "cat-file", "blob", f"{source}:{name}").stdout == replaced_bytes
    if use_original_stage:
        receipt = writer.validate_staged_follow_provenance(repo, original, proof)
        assert receipt.shards["listings/MA.json"] == raw
    else:
        with pytest.raises(ValueError, match="staged listing shards"):
            writer.validate_staged_follow_provenance(repo, alternative, proof)


def test_staged_proof_refuses_unrelated_gitlink_ignored_by_default_diff(staged_writer):
    repo, state, proof = staged_writer
    tree = stage(repo, state)
    commit = (
        writer.git(
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit-tree",
            tree,
            "-m",
            "Synthetic gitlink",
        )
        .stdout.decode("ascii")
        .strip()
    )
    writer.git(repo, "config", "diff.ignoreSubmodules", "all")
    writer.git(repo, "update-index", "--add", "--cacheinfo", f"160000,{commit},unrelated-module")
    candidate = writer.git(repo, "write-tree").stdout.decode("ascii").strip()
    assert candidate != tree
    writer.ensure_owned_stage(repo)
    with pytest.raises(ValueError, match="unrelated staged files"):
        writer.validate_staged_follow_provenance(repo, candidate, proof)
