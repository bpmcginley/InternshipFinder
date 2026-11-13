from __future__ import annotations

import json
import os
from dataclasses import FrozenInstanceError, replace
from hashlib import sha256
from pathlib import Path
from types import MappingProxyType

import pytest

from internscout.follow_snapshot_archive import INDEX, FollowArchivePlan
from test_follow_snapshot_archive import AT, BOUND, DAY, MS, accept, candidate, plan
from test_follow_archive_from_publication import accepted, BOUNDS, NOW, plan as from_receipt
from test_follow_writer_provenance import database, staged_writer
from test_ingest_data_writer import writer


@pytest.fixture
def stage(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from scripts import follow_archive_stage

    return follow_archive_stage


def call(stage, parent, current=None, proposed=None, now=AT, bounds=BOUND):
    current = {} if current is None else current
    proposed = (
        plan(current, candidate(now), now=now, bounds=bounds) if proposed is None else proposed
    )
    return stage.stage_follow_archive(current, proposed, parent=parent, now=now, bounds=bounds)


def read(receipt):
    return {item.path: (receipt.directory / item.path).read_bytes() for item in receipt.files}


def test_actual_publication_receipt_to_private_generation(stage, accepted, tmp_path):
    builder, published, _ = accepted
    proposed = from_receipt(builder, published, {})
    result = call(stage, tmp_path, proposed=proposed, now=NOW, bounds=BOUNDS)
    assert read(result) == proposed.files
    assert result.index_sha256 == sha256(proposed.files[INDEX]).hexdigest()
    assert result.base_index_sha256 is None
    assert result.directory.parent == tmp_path
    assert all(
        item.sha256 == sha256(proposed.files[item.path]).hexdigest() for item in result.files
    )
    assert all(item.size == len(proposed.files[item.path]) for item in result.files)
    with pytest.raises(FrozenInstanceError):
        result.index_sha256 = "0" * 64


def test_retained_bytes_cutoffs_and_old_generation_never_changed(stage, tmp_path):
    first_plan = plan({}, candidate(AT, title="first"), now=AT, bounds=BOUND)
    old = call(stage, tmp_path, proposed=first_plan)
    current = dict(first_plan.files)
    before = dict(current)
    next_plan = plan(current, candidate(AT + DAY, title="next"), now=AT + DAY, bounds=BOUND)
    result = call(stage, tmp_path, current, next_plan, now=AT + DAY)
    assert old.directory != result.directory
    assert current == before == read(old)
    assert read(result) == next_plan.files
    for name, raw in current.items():
        if name != INDEX:
            assert (result.directory / name).read_bytes() == raw
    assert json.loads(read(result)[INDEX])["entries"][0] == json.loads(current[INDEX])["entries"][0]
    assert result.base_index_sha256 == old.index_sha256
    assert result.index_sha256 != old.index_sha256


def test_same_plan_gets_fresh_generation_no_reuse(stage, tmp_path):
    proposed = plan({}, candidate(), now=AT, bounds=BOUND)
    a, b = call(stage, tmp_path, proposed=proposed), call(stage, tmp_path, proposed=proposed)
    assert a.directory != b.directory
    assert a.files == b.files
    assert read(a) == read(b)


def test_original_retention_cutoff_and_empty_manifest(stage, tmp_path):
    current = accept({}, AT)
    at = AT + 4 * DAY
    before = plan(current, None, now=at - MS, bounds=BOUND)
    assert read(call(stage, tmp_path, current, before, now=at - MS)) == current
    expired = plan(current, None, now=at, bounds=BOUND)
    assert set(read(call(stage, tmp_path, current, expired, now=at))) == {INDEX}
    assert len(current) == 2


@pytest.mark.parametrize(
    "fault", ["base", "retained", "missing", "extra", "prune", "noncanonical", "late"]
)
def test_invalid_transition_creates_nothing(stage, tmp_path, fault):
    current = accept({}, AT)
    proposed = plan(current, candidate(AT + DAY), now=AT + DAY, bounds=BOUND)
    files = dict(proposed.files)
    old_blob = next(name for name in current if name != INDEX)
    if fault == "base":
        proposed = replace(proposed, base_index_sha256="0" * 64)
    elif fault == "retained":
        files[old_blob] += b" "
    elif fault == "missing":
        del files[old_blob]
    elif fault == "extra":
        files["data/follows/../outside.json"] = b"x"
    elif fault == "prune":
        files = dict(plan({}, candidate(AT + DAY), now=AT + DAY, bounds=BOUND).files)
    elif fault == "noncanonical":
        files[INDEX] += b"\n"
    proposed = replace(proposed, files=files)
    with pytest.raises(ValueError):
        call(stage, tmp_path, current, proposed, now=AT + (5 if fault == "late" else 1) * DAY)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("fault", ["count", "bytes", "path", "mutable", "base", "untyped", "empty"])
def test_preflight_bounds_and_shapes_before_directory(stage, monkeypatch, tmp_path, fault):
    proposed = plan({}, candidate(), now=AT, bounds=BOUND)
    if fault == "count":
        proposed = replace(proposed, files={str(i): b"" for i in range(BOUND.max_entries + 2)})
    elif fault == "bytes":
        proposed = replace(proposed, files={INDEX: b"x" * (BOUND.max_archive_bytes + 1)})
    elif fault == "path":
        proposed = replace(proposed, files={"/absolute.json": b"x"})
    elif fault == "mutable":
        proposed = replace(proposed, files={INDEX: bytearray(b"x")})
    elif fault == "base":
        proposed = replace(proposed, base_index_sha256=["0" * 64])
    elif fault == "untyped":
        proposed = object()
    elif fault == "empty":
        proposed = FollowArchivePlan(None, {})
    monkeypatch.setattr(stage, "_parent", lambda *_: pytest.fail("filesystem reached"))
    with pytest.raises(ValueError):
        call(stage, tmp_path, proposed=proposed)


@pytest.mark.parametrize("fault", ["write", "sync", "readback"])
def test_partial_failure_no_receipt_no_prior_mutation(stage, monkeypatch, tmp_path, fault):
    first = call(stage, tmp_path)
    original = read(first)
    real_write = stage._write
    calls = 0

    def broken(path, raw):
        nonlocal calls
        calls += 1
        real_write(path, raw)
        if calls == 2:
            raise OSError("synthetic partial write")

    if fault == "write":
        monkeypatch.setattr(stage, "_write", broken)
    elif fault == "sync":
        monkeypatch.setattr(stage.os, "fsync", lambda *_: (_ for _ in ()).throw(OSError("sync")))
    else:
        real_open = stage.os.fdopen

        class ChangedRead:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.stream.close()

            def __getattr__(self, key):
                return getattr(self.stream, key)

            def read(self, *_):
                return b"wrong"

        monkeypatch.setattr(stage.os, "fdopen", lambda *a: ChangedRead(real_open(*a)))
    with pytest.raises(OSError):
        call(stage, tmp_path)
    assert list(tmp_path.iterdir()) == [first.directory]
    assert read(first) == original


@pytest.mark.parametrize("parent", ["", "relative", "missing"])
def test_explicit_real_parent_required(stage, tmp_path, parent):
    value = tmp_path / "missing" if parent == "missing" else parent
    with pytest.raises((ValueError, FileNotFoundError)):
        call(stage, value)
    assert list(tmp_path.iterdir()) == []


def test_linked_parent_rejected(stage, tmp_path):
    target, link = tmp_path / "target", tmp_path / "link"
    target.mkdir()
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("platform requires symlink privilege; Linux lane exercises this")
    with pytest.raises(ValueError):
        call(stage, link)
    assert list(target.iterdir()) == []


def test_windows_junction_parent_rejected(stage, tmp_path):
    if os.name != "nt":
        pytest.skip("Windows junction fixture")
    import subprocess

    target, link = tmp_path / "target", tmp_path / "junction"
    target.mkdir()
    subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True
    )
    try:
        with pytest.raises(ValueError):
            call(stage, link)
        assert list(target.iterdir()) == []
    finally:
        link.rmdir()


def test_input_snapshot_precedes_output(stage, monkeypatch, tmp_path):
    proposed = plan({}, candidate(), now=AT, bounds=BOUND)
    mutable = dict(proposed.files)
    expected = dict(mutable)
    real_parent = stage._parent

    def changing(value):
        mutable.clear()
        return real_parent(value)

    monkeypatch.setattr(stage, "_parent", changing)
    result = call(stage, tmp_path, proposed=replace(proposed, files=MappingProxyType(mutable)))
    assert read(result) == expected


def test_final_readback_rejects_change_to_previously_written_blob(stage, monkeypatch, tmp_path):
    original = stage._write
    previous = []

    def changed(path, raw):
        original(path, raw)
        if previous:
            previous[0].write_bytes(b"changed after its own readback")
        previous.append(path)

    monkeypatch.setattr(stage, "_write", changed)
    with pytest.raises(ValueError, match="final readback"):
        call(stage, tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_extra_output_prevents_receipt(stage, monkeypatch, tmp_path):
    original = stage._write

    def extra(path, raw):
        original(path, raw)
        (path.parent / "unexpected").write_bytes(b"unapproved")

    monkeypatch.setattr(stage, "_write", extra)
    with pytest.raises(ValueError, match="unexpected archive output"):
        call(stage, tmp_path)
    # Unknown output is never deleted automatically. No receipt was returned.
    orphans = list(tmp_path.iterdir())
    assert len(orphans) == 1
    assert [p.name for p in orphans[0].rglob("*") if p.is_file()] == ["unexpected"]


def test_nonpositive_bounds_fail_before_capture_or_io(stage, monkeypatch, tmp_path):
    monkeypatch.setattr(stage, "_capture", lambda *_: pytest.fail("capture reached"))
    for invalid in (0, -1, True):
        with pytest.raises(ValueError):
            call(
                stage,
                tmp_path,
                proposed=FollowArchivePlan(None, {}),
                bounds=replace(BOUND, max_archive_bytes=invalid),
            )
    assert list(tmp_path.iterdir()) == []


def test_exclusive_output_never_reuses_existing_file(stage, tmp_path):
    existing = tmp_path / "existing.json"
    existing.write_bytes(b"original")
    with pytest.raises(FileExistsError):
        stage._write(existing, b"replacement")
    assert existing.read_bytes() == b"original"


def test_hardlinked_output_rejected_without_touching_target(stage, monkeypatch, tmp_path):
    external = tmp_path / "keep.json"
    external.write_bytes(b"outside")
    original = stage._write

    def hardlink(path, raw):
        original(path, raw)
        if path.name == "index.json":
            path.unlink()
            os.link(external, path)

    monkeypatch.setattr(stage, "_write", hardlink)
    with pytest.raises(ValueError, match="regular archive readback"):
        call(stage, tmp_path)
    assert external.read_bytes() == b"outside"
    assert list(tmp_path.iterdir()) == [external]


def test_parent_directory_file_rejected(stage, tmp_path):
    parent = tmp_path / "regular-file"
    parent.write_bytes(b"keep")
    with pytest.raises(ValueError, match="must be real"):
        call(stage, parent)
    assert parent.read_bytes() == b"keep"
