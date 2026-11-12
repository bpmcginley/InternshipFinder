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


def prepare(site_dir: str) -> tuple[dict, PostingLinks]:
    """Validate before writing, then stage annotations and return the captured render input.

    The caller has already selected/staged the public export. This adapter does not choose
    Git revisions, fetch data or establish provenance. Destination inputs must match it.
    """
    selected = Path(public_data_dir(site_dir))
    target = Path(site_dir) / "data"
    for root in (selected, target):
        if root.is_symlink() or root.is_junction() or not root.is_dir():
            raise ValueError("Employer publication requires real data directories")
    index = _regular(selected, "listings/index.json").read_bytes()
    decoded = json.loads(index)
    manifest = decoded.get("files") if isinstance(decoded, dict) else None
    if (
        not isinstance(manifest, dict)
        or not manifest
        or any(not re.fullmatch(r"[A-Za-z0-9_-]+", key) for key in manifest)
    ):
        raise ValueError("Invalid employer publication manifest")
    # Derive safe paths from keys; the existing stage validates each declared file and count.
    captured = {"listings/index.json": index}
    for name in [*(f"listings/{key}.json" for key in manifest), "first.json", "majors.json"]:
        captured[name] = _regular(selected, name).read_bytes()
    stage = stage_employer_postings(
        index,
        {
            name: raw
            for name, raw in captured.items()
            if name.startswith("listings/") and name != "listings/index.json"
        },
        captured["first.json"],
    )
    links = PostingLinks.from_stage(stage)
    same_directory = selected.resolve() == target.resolve()
    for name, raw in captured.items():
        destination = _regular(target, name)
        if not same_directory and destination.read_bytes() != raw:
            raise ValueError("Staged site differs from the selected employer export")
    for name in stage.files:
        _regular(target, name, missing=True)
    # The ordinary loader keeps its existing filtering/deduplication. It reads only these
    # captured bytes, never reselects or rereads the changing input directory during rendering.
    with TemporaryDirectory(prefix="internscout-employer-publication-") as temporary:
        snapshot = Path(temporary)
        (snapshot / "listings").mkdir()
        for name, raw in captured.items():
            (snapshot / name).write_bytes(raw)
        data = source.load(site_dir, data_dir=str(snapshot))
    for name, raw in stage.files.items():
        (target / name).write_bytes(raw)
    return data, links
