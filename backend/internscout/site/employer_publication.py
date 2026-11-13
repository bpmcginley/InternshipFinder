"""Opt-in publication from one captured, already-selected public export."""

from __future__ import annotations

import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from ..employer_posting_stage import stage_employer_postings
from ..public_data import public_data_dir
from . import source
from .employer_posting_links import PostingLinks


def _regular(root: Path, relative: str, *, missing: bool = False) -> Path:
    path = root
    for part in Path(relative).parts:
        path = path / part
        if path.is_symlink() or path.is_junction():
            raise ValueError("Employer publication rejects filesystem links")
    if not (path.is_file() or (missing and not path.exists())):
        raise ValueError("Employer publication requires regular files")
    return path


def capture(site_dir: str, *, max_bytes=None, max_files=None) -> dict[str, bytes]:
    selected = Path(public_data_dir(site_dir))
    target = Path(site_dir) / "data"
    for root in (selected, target):
        if root.is_symlink() or root.is_junction() or not root.is_dir():
            raise ValueError("Employer publication requires real data directories")
    used = 0

    def read(name):
        nonlocal used
        path = _regular(selected, name)
        if max_bytes is not None and path.stat().st_size > max_bytes - used:
            raise ValueError("Captured export exceeds byte bound")
        with path.open("rb") as stream:
            raw = stream.read() if max_bytes is None else stream.read(max_bytes - used + 1)
        used += len(raw)
        if max_bytes is not None and used > max_bytes:
            raise ValueError("Captured export exceeds byte bound")
        return raw

    index = read("listings/index.json")
    decoded = json.loads(index)
    manifest = decoded.get("files") if isinstance(decoded, dict) else None
    if (
        not isinstance(manifest, dict)
        or not manifest
        or (max_files is not None and len(manifest) + 3 > max_files)
        or any(not re.fullmatch(r"[A-Za-z0-9_-]+", key) for key in manifest)
    ):
        raise ValueError("Invalid employer publication manifest")
    # Derive safe paths from keys; the existing stage validates each declared file and count.
    captured = {"listings/index.json": index}
    for name in [*(f"listings/{key}.json" for key in manifest), "first.json", "majors.json"]:
        captured[name] = read(name)
    if selected.resolve() != target.resolve():
        for name, raw in captured.items():
            path = _regular(target, name)
            if max_bytes is not None and path.stat().st_size != len(raw):
                raise ValueError("Staged site differs from selected export")
            with path.open("rb") as stream:
                staged = stream.read() if max_bytes is None else stream.read(len(raw) + 1)
            if staged != raw:
                raise ValueError("Staged site differs from selected export")
    return captured


def load_capture(site_dir, captured):
    with TemporaryDirectory(prefix="internscout-employer-publication-") as temporary:
        snapshot = Path(temporary)
        (snapshot / "listings").mkdir()
        for name, raw in captured.items():
            (snapshot / name).write_bytes(raw)
        return source.load(site_dir, data_dir=str(snapshot))


def prepare(site_dir: str) -> tuple[dict, PostingLinks]:
    captured = capture(site_dir)
    target = Path(site_dir) / "data"
    stage = stage_employer_postings(
        captured["listings/index.json"],
        {
            name: raw
            for name, raw in captured.items()
            if name.startswith("listings/") and name != "listings/index.json"
        },
        captured["first.json"],
    )
    links = PostingLinks.from_stage(stage)
    for name in stage.files:
        _regular(target, name, missing=True)
    data = load_capture(site_dir, captured)
    for name, raw in stage.files.items():
        (target / name).write_bytes(raw)
    return data, links
