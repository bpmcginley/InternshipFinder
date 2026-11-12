"""Dormant raw Git acquisition for a caller-selected, pinned public Follow export."""

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import subprocess
from threading import Timer, TIMEOUT_MAX
import time

from .. import follow_catalog as codec
from .follow_publication import CatalogStage, prepare_follow_catalog


def _fail():
    raise ValueError("Pinned Follow export unavailable")


def _oid(value):
    return type(value) is str and re.fullmatch(r"[a-f0-9]{40}", value) is not None


@dataclass(frozen=True)
class GitCatalogStage:
    commit: str
    tree: str
    catalog: CatalogStage


def acquire_follow_catalog(
    repo=None, *, enabled=False, commit=None, tree=None, timeout_seconds=None, **staging
) -> GitCatalogStage | None:
    """Read exact local objects only. The caller supplies trusted commit/tree/source/prior pins."""
    if enabled is not True:
        return None
    if (
        not _oid(commit)
        or not _oid(tree)
        or type(timeout_seconds) is not int
        or not 0 < timeout_seconds <= TIMEOUT_MAX
        or repo is None
        or any(
            type(staging.get(key)) is not int or not 0 < staging[key] <= codec._MAX_INTEGER
            for key in ("max_source_bytes", "max_source_rows", "max_keys", "max_bytes")
        )
    ):
        _fail()
    repository = os.fspath(repo)
    if not isinstance(repository, str) or not repository.strip():
        _fail()
    repository = str(Path(repository).absolute())
    deadline = time.monotonic() + timeout_seconds
    # Never inherit alternate object stores, replacement refs or an implicit repository.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        GIT_NO_LAZY_FETCH="1",
        GIT_NO_REPLACE_OBJECTS="1",
        GIT_OPTIONAL_LOCKS="0",
        GIT_TERMINAL_PROMPT="0",
        GIT_ALLOW_PROTOCOL="",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
    )

    def read(args, cap):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail()
        with subprocess.Popen(
            [
                "git",
                "--no-replace-objects",
                "-c",
                "protocol.allow=never",
                "-C",
                repository,
                *args,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        ) as child:

            def kill():
                try:
                    child.kill()
                except OSError:
                    pass

            timer = None
            try:
                # Process creation itself is not preemptible; never grant its elapsed time again.
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _fail()
                timer = Timer(remaining, kill)
                timer.daemon = True
                timer.start()
                # Bounded before allocation, including metadata and a single overflow byte.
                data = child.stdout.read(cap + 1)
                if len(data) > cap:
                    kill()
                    _fail()
                code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
                if code or time.monotonic() >= deadline:
                    _fail()
                return data
            finally:
                try:
                    if timer is not None:
                        timer.cancel()
                finally:
                    kill()

    def entry(ref, path):
        raw = read(["ls-tree", "-z", ref, "--", path], 512)
        match = re.fullmatch(rb"([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)\0", raw)
        if not match or match[4] != path.encode("ascii"):
            _fail()
        return match[1], match[2], match[3].decode("ascii")

    if read(["rev-parse", "--show-prefix"], 512) != b"\n":
        _fail()
    if read(["cat-file", "-t", commit], 16) != b"commit\n":
        _fail()
    mode, kind, actual_tree = entry(commit, "docs/data")
    if mode != b"040000" or kind != b"tree" or actual_tree != tree:
        _fail()
    remaining_bytes = staging["max_source_bytes"]

    def blob(path):
        nonlocal remaining_bytes
        mode, kind, identity = entry(tree, path)
        if mode not in (b"100644", b"100755") or kind != b"blob":
            _fail()
        size = read(["cat-file", "-s", identity], 32)
        if not re.fullmatch(rb"[0-9]+\n", size) or int(size) > remaining_bytes:
            _fail()
        length = int(size)
        raw = read(["cat-file", "blob", identity], length)
        if (
            len(raw) != length
            or hashlib.sha1(b"blob " + str(length).encode() + b"\0" + raw).hexdigest() != identity
        ):
            _fail()
        remaining_bytes -= length
        return raw

    selected = {"listings/index.json": blob("listings/index.json")}
    value = codec._read(selected["listings/index.json"])
    manifest = value.get("files") if isinstance(value, dict) else None
    if (
        not isinstance(manifest, dict)
        or len(manifest) > 26**2 + 2
        or any(not isinstance(key, str) or not codec._SHARD.fullmatch(key) for key in manifest)
    ):
        _fail()
    mode, kind, listing_tree = entry(tree, "listings")
    if mode != b"040000" or kind != b"tree":
        _fail()
    # Bounded metadata inventory, not payload reads; descriptions and preview names are unrelated.
    names = read(["ls-tree", "-z", "--name-only", listing_tree], (26**2 + 2) * 128)
    if not names.endswith(b"\0"):
        _fail()
    eligible = [
        name[:-5].decode("ascii")
        for name in names[:-1].split(b"\0")
        if re.fullmatch(rb"(?:[A-Z]{2}|Canada|remote)\.json", name)
    ]
    if len(eligible) != len(set(eligible)) or set(eligible) != set(manifest):
        _fail()
    for key in sorted(manifest):
        path = f"listings/{key}.json"
        selected[path] = blob(path)
    selected["majors.json"] = blob("majors.json")
    catalog = prepare_follow_catalog(selected, enabled=True, **staging)
    if time.monotonic() >= deadline:
        _fail()
    return GitCatalogStage(commit, tree, catalog)
