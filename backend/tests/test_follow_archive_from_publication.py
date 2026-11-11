from __future__ import annotations

import json
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256
from types import SimpleNamespace

import pytest

from internscout.follow_snapshot import (
    FollowSnapshotBounds,
    FollowSnapshotCatalog,
    build_follow_snapshot,
)
from internscout.follow_snapshot_archive import (
    INDEX,
    FollowArchiveBounds,
    plan_follow_snapshot_archive,
    validate_follow_archive_transition,
)
from test_follow_writer_provenance import BASELINE, NOW, database, staged_writer
from test_ingest_data_writer import ROOT

BOUNDS = FollowArchiveBounds(
    snapshot=FollowSnapshotBounds(20_000, 10, 2_000, 86_400_000),
    max_enqueue_age_ms=3_600_000,
    publish_margin_ms=3_600_000,
    max_entries=4,
    max_archive_bytes=90_000,
)
CATALOG = FollowSnapshotCatalog(
    frozenset({"fixture ma", "fixture ny"}), frozenset({"swe"}), frozenset({"MA", "NY"})
)


@pytest.fixture
def accepted(staged_writer, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    from scripts import ingest_data_writer
    from scripts.follow_archive_from_publication import plan_follow_archive_from_publication

    repo, state, proof = staged_writer
    for key, value in {
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_AUTHOR_NAME": "Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }.items():
        monkeypatch.setenv(key, value)

    remote = repo.parent / "file-remote.git"
    w = ingest_data_writer
    w.git(repo.parent, "init", "--bare", str(remote))
    w.git(repo, "symbolic-ref", "HEAD", w.BRANCH)
    w.git(repo, "commit", "--allow-empty", "-m", "Synthetic baseline")
    w.git(repo, "remote", "add", "origin", str(remote))
    w.git(repo, "push", "-u", "origin", f"HEAD:{w.BRANCH}")
    (_, commit), receipt = w.publish_with_follow_provenance(repo, state, "Synthetic refresh", proof)
    assert receipt is not None and receipt.commit == commit == w.revision(remote, w.BRANCH)
    assert receipt.public_tree == w.revision(remote, f"{commit}:{w.PUBLIC}")
    return plan_follow_archive_from_publication, receipt, repo


def plan(builder, receipt, files, **overrides):
    return builder(
        receipt,
        files,
        **(
            {
                "effective_lower": BASELINE,
                "now": NOW,
                "bounds": BOUNDS,
                "catalog": CATALOG,
                "max_source_bytes": 80_000,
                "max_source_rows": 50,
            }
            | overrides
        ),
    )


def test_actual_accepted_file_remote_receipt_builds_canonical_archive(accepted):
    builder, receipt, repo = accepted
    # The function consumes immutable receipt bytes after a checkout change.
    (repo / "docs/data/listings/index.json").write_bytes(b"unstaged replacement")
    result = plan(builder, receipt, {})
    assert result is not None and result.base_index_sha256 is None
    validate_follow_archive_transition({}, result, now=NOW, bounds=BOUNDS)
    manifest = json.loads(result.files[INDEX])
    digest = manifest["latest"]
    snapshot = result.files[f"data/follows/{digest}.json"]
    assert set(result.files) == {INDEX, f"data/follows/{digest}.json"}
    assert sha256(snapshot).hexdigest() == digest
    assert (
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode() == result.files[INDEX]
    )
    decoded = json.loads(snapshot)
    assert decoded["covers_after"] == "2026-11-11T17:00:00.000Z"
    assert decoded["generated_at"] == "2026-11-11T18:00:00.000Z"
    assert {role["company_key"] for role in decoded["roles"]} == {"fixture ma", "fixture ny"}
    assert {role["first_seen"] for role in decoded["roles"]} == {"2026-11-11T18:00:00.000Z"}
    assert plan(builder, receipt, result.files).files == result.files


def test_missing_false_or_mismatched_receipts_yield_no_plan(accepted):
    builder, receipt, _ = accepted
    for invalid in (
        None,
        receipt.staged,
        SimpleNamespace(
            commit=receipt.commit, public_tree=receipt.public_tree, staged=receipt.staged
        ),
        replace(receipt, commit="not-an-object-id"),
        replace(receipt, staged=replace(receipt.staged, covers_after=None)),
        replace(
            receipt,
            staged=replace(receipt.staged, index_bytes=receipt.staged.index_bytes + b" "),
        ),
    ):
        assert plan(builder, invalid, {}) is None
    assert plan(builder, receipt, {}, max_source_bytes=1) is None


def test_stale_receipt_and_coverage_gap_leave_existing_archive_intact(accepted):
    builder, receipt, _ = accepted
    files = dict(plan(builder, receipt, {}).files)
    baseline = files.copy()
    assert plan(builder, receipt, files, now=NOW + timedelta(hours=1)) is None
    assert (
        plan(builder, receipt, files, effective_lower=BASELINE - timedelta(milliseconds=1)) is None
    )
    assert plan(builder, receipt, files, effective_lower=NOW + timedelta(milliseconds=1)) is None
    assert files == baseline


def test_same_day_first_pin_must_itself_cover_the_requested_lower(accepted):
    builder, receipt, _ = accepted
    # The later receipt covers BASELINE. The immutable first pin for this date does not.
    first = build_follow_snapshot(
        [],
        generated_at=NOW - timedelta(minutes=10),
        covers_after=BASELINE + timedelta(minutes=10),
        complete=True,
        catalog=CATALOG,
        bounds=BOUNDS.snapshot,
    )
    files = plan_follow_snapshot_archive({}, first, now=NOW, bounds=BOUNDS).files
    assert plan(builder, receipt, files) is None
    covered = plan(builder, receipt, files, effective_lower=BASELINE + timedelta(minutes=10))
    assert covered is not None and covered.files == files
