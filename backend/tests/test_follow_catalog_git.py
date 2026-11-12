"""Real local Git object reads; no checkout-based production input or remote transport."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import pytest

from internscout.follow_catalog import build_follow_catalog
from internscout.site import follow_catalog_git as acquire
from internscout.site.follow_catalog_git import acquire_follow_catalog
from test_follow_catalog import inputs, raw


def git(repo, *args, data=None):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], input=data, stderr=subprocess.DEVNULL
    )


def fixture(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "core.autocrlf", "false")
    index, shards, majors, options = inputs()
    selected = {"listings/index.json": index, "majors.json": majors, **shards}
    for name, data in selected.items():
        path = repo / "docs/data" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    git(repo, "add", "docs")
    tree = git(repo, "write-tree").strip().decode()
    commit = (
        git(
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit-tree",
            tree,
            data=b"public fixture\n",
        )
        .strip()
        .decode()
    )
    data_tree = git(repo, "rev-parse", commit + ":docs/data").strip().decode()
    payload = build_follow_catalog(index, shards, majors, **options)
    args = dict(
        enabled=True,
        commit=commit,
        tree=data_tree,
        timeout_seconds=30,
        source_sha256=json.loads(payload)["source_sha256"],
        prior_bytes=payload,
        prior_sha256=hashlib.sha256(payload).hexdigest(),
        **{k: v for k, v in options.items() if k.startswith("max_")},
    )
    return repo, args, payload, selected


def test_disabled_and_invalid_identity_never_start_git(monkeypatch):
    monkeypatch.setattr(acquire.subprocess, "Popen", lambda *a, **k: pytest.fail("Git invoked"))
    assert acquire_follow_catalog() is None
    for change in ({}, {"commit": "HEAD"}, {"commit": "a" * 40, "tree": "b" * 40}):
        with pytest.raises(ValueError):
            acquire_follow_catalog("unused", enabled=True, **change)


def test_raw_bytes_receipt_dirty_checkout_and_crlf_independent(tmp_path):
    repo, args, payload, selected = fixture(tmp_path)
    # Git checkout conversion and even missing tracked files cannot influence raw acquisition.
    git(repo, "config", "core.autocrlf", "true")
    for name in selected:
        (repo / "docs/data" / name).write_bytes(b"changed worktree\r\n")
    (repo / "docs/data/majors.json").unlink()
    before = git(repo, "status", "--porcelain")
    result = acquire_follow_catalog(repo, **args)
    assert result.catalog.payload == payload
    assert result.commit == args["commit"] and result.tree == args["tree"]
    assert result.catalog.catalog_sha256 == args["prior_sha256"]
    assert git(repo, "status", "--porcelain") == before


@pytest.mark.parametrize("change", ["tree", "commit", "blob_commit", "source", "bounds"])
def test_wrong_or_missing_pins_and_bounds_fail_closed(tmp_path, change):
    repo, args, _, _ = fixture(tmp_path)
    if change == "tree":
        args["tree"] = "0" * 40
    elif change == "commit":
        args["commit"] = "0" * 40
    elif change == "blob_commit":
        args["commit"] = (
            git(repo, "rev-parse", args["commit"] + ":docs/data/majors.json").strip().decode()
        )
    elif change == "source":
        args["source_sha256"] = "0" * 64
    else:
        args["max_source_bytes"] = 1
    with pytest.raises(ValueError):
        acquire_follow_catalog(repo, **args)


@pytest.mark.parametrize("mode", ["120000", "160000", "040000"])
def test_nonregular_declared_objects_reject(tmp_path, mode):
    repo, args, _, _ = fixture(tmp_path)
    if mode == "120000":
        identity = git(repo, "hash-object", "-w", "--stdin", data=b"outside").strip().decode()
    elif mode == "160000":
        identity = args["commit"]
    else:
        identity = args["tree"]
    git(repo, "update-index", "--force-remove", "docs/data/majors.json")
    if mode != "040000":
        git(repo, "update-index", "--add", "--cacheinfo", mode, identity, "docs/data/majors.json")
    else:
        # A file replaced by a directory appears as a tree, never a readable regular blob.
        git(
            repo,
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            git(repo, "hash-object", "-w", "--stdin", data=b"x").strip().decode(),
            "docs/data/majors.json/child",
        )
    tree = git(repo, "write-tree").strip().decode()
    args["commit"] = (
        git(
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit-tree",
            tree,
            data=b"mode fixture\n",
        )
        .strip()
        .decode()
    )
    args["tree"] = git(repo, "rev-parse", args["commit"] + ":docs/data").strip().decode()
    with pytest.raises(ValueError):
        acquire_follow_catalog(repo, **args)


def test_replacements_and_environment_cannot_switch_selected_objects(tmp_path, monkeypatch):
    repo, args, payload, _ = fixture(tmp_path)
    original = git(repo, "rev-parse", args["commit"] + ":docs/data/majors.json").strip().decode()
    replacement = git(repo, "hash-object", "-w", "--stdin", data=b"{}\n").strip().decode()
    git(repo, "replace", original, replacement)
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "missing.git"))
    monkeypatch.setenv("GIT_OBJECT_DIRECTORY", str(tmp_path / "missing-objects"))
    result = acquire_follow_catalog(repo, **args)
    assert result.catalog.payload == payload


def test_blob_size_rejected_before_payload_command(tmp_path, monkeypatch):
    repo, args, _, selected = fixture(tmp_path)
    args["max_source_bytes"] = len(selected["listings/index.json"]) - 1
    original = acquire.subprocess.Popen
    commands = []

    def run(command, **options):
        commands.append(command)
        return original(command, **options)

    monkeypatch.setattr(acquire.subprocess, "Popen", run)
    with pytest.raises(ValueError):
        acquire_follow_catalog(repo, **args)
    assert any(command[-3:-1] == ["cat-file", "-s"] for command in commands)
    assert not any(command[-3:-1] == ["cat-file", "blob"] for command in commands)
    assert all(command[1] == "--no-replace-objects" for command in commands)


@pytest.mark.parametrize("missing", [False, True])
def test_invalid_manifest_and_missing_shard_fail_without_alternate_capture(tmp_path, missing):
    repo, args, _, _ = fixture(tmp_path)
    if missing:
        git(repo, "update-index", "--force-remove", "docs/data/listings/ON.json")
    else:
        (repo / "docs/data/listings/index.json").write_bytes(raw({"files": {"../escape": {}}}))
        git(repo, "add", "docs/data/listings/index.json")
    tree = git(repo, "write-tree").strip().decode()
    args["commit"] = (
        git(
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit-tree",
            tree,
            data=b"bad manifest\n",
        )
        .strip()
        .decode()
    )
    args["tree"] = git(repo, "rev-parse", args["commit"] + ":docs/data").strip().decode()
    with pytest.raises(ValueError):
        acquire_follow_catalog(repo, **args)


def test_child_deadline_and_metadata_overflow_are_bounded(tmp_path, monkeypatch):
    repo, args, _, _ = fixture(tmp_path)
    original = acquire.subprocess.Popen
    commands = []
    for program in (
        "import time; time.sleep(10)",
        "import sys; sys.stdout.buffer.write(b'x'*2000)",
    ):

        def slow(command, **options):
            commands.append(command)
            assert options["env"]["GIT_NO_LAZY_FETCH"] == "1"
            assert options["env"]["GIT_ALLOW_PROTOCOL"] == ""
            assert options["stderr"] == subprocess.DEVNULL
            return original([sys.executable, "-c", program], **options)

        monkeypatch.setattr(acquire.subprocess, "Popen", slow)
        started = time.monotonic()
        with pytest.raises(ValueError):
            acquire_follow_catalog(repo, **(args | {"timeout_seconds": 1}))
        assert time.monotonic() - started < 5
    assert len(commands) == 2


def repin(repo, args):
    git(repo, "add", "docs/data")
    root = git(repo, "write-tree").strip().decode()
    commit = (
        git(
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit-tree",
            root,
            data=b"new inventory\n",
        )
        .strip()
        .decode()
    )
    return args | {
        "commit": commit,
        "tree": git(repo, "rev-parse", commit + ":docs/data").strip().decode(),
    }


@pytest.mark.parametrize("extra_shard", [False, True])
def test_pinned_inventory_rejects_omitted_slim_but_ignores_unrelated_names(tmp_path, extra_shard):
    repo, args, payload, _ = fixture(tmp_path)
    for name in ("NY.desc.json", "preview.json"):
        (repo / "docs/data/listings" / name).write_bytes(b"unrelated\n")
    if extra_shard:
        (repo / "docs/data/listings/NY.json").write_bytes(b"[]")
    args = repin(repo, args)
    if extra_shard:
        with pytest.raises(ValueError):
            acquire_follow_catalog(repo, **args)
    else:
        assert acquire_follow_catalog(repo, **args).catalog.payload == payload


def test_empty_and_nested_repository_do_not_fall_back(tmp_path, monkeypatch):
    repo, args, _, _ = fixture(tmp_path)
    monkeypatch.chdir(repo)
    original = acquire.subprocess.Popen
    calls = []

    def count(*a, **k):
        calls.append(a)
        return original(*a, **k)

    monkeypatch.setattr(acquire.subprocess, "Popen", count)
    for missing in ("", "   "):
        with pytest.raises(ValueError):
            acquire_follow_catalog(missing, **args)
    assert not calls
    nested = repo / "nested"
    nested.mkdir()
    with pytest.raises(ValueError):
        acquire_follow_catalog(nested, **args)


@pytest.mark.parametrize("launch_elapsed", [0.85, 2])
def test_delayed_launch_uses_remaining_deadline_and_always_kills(
    tmp_path, monkeypatch, launch_elapsed
):
    repo, args, _, _ = fixture(tmp_path)
    original = acquire.subprocess.Popen
    at = [0.0]
    children = []
    intervals = []
    monkeypatch.setattr(acquire.time, "monotonic", lambda: at[0])

    def launch(_command, **options):
        child = original([sys.executable, "-c", "import time;time.sleep(10)"], **options)
        children.append(child)
        at[0] = launch_elapsed
        return child

    class Timer:
        def __init__(self, interval, kill):
            intervals.append(interval)
            self.kill = kill

        def start(self):
            self.kill()

        def cancel(self):
            pass

    monkeypatch.setattr(acquire.subprocess, "Popen", launch)
    monkeypatch.setattr(acquire, "Timer", Timer)
    with pytest.raises(ValueError):
        acquire_follow_catalog(repo, **(args | {"timeout_seconds": 1}))
    assert children[0].poll() is not None
    assert intervals == pytest.approx([0.15] if launch_elapsed < 1 else [])


def test_timer_start_failure_cannot_leave_child_running(tmp_path, monkeypatch):
    repo, args, _, _ = fixture(tmp_path)
    original = acquire.subprocess.Popen
    children = []

    def launch(_command, **options):
        child = original([sys.executable, "-c", "import time;time.sleep(10)"], **options)
        children.append(child)
        return child

    class Timer:
        def __init__(self, *_):
            pass

        def start(self):
            raise RuntimeError("synthetic timer setup failure")

        def cancel(self):
            pass

    monkeypatch.setattr(acquire.subprocess, "Popen", launch)
    monkeypatch.setattr(acquire, "Timer", Timer)
    with pytest.raises(RuntimeError, match="synthetic"):
        acquire_follow_catalog(repo, **args)
    assert children[0].poll() is not None
