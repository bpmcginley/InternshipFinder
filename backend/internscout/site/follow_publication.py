"""Dormant bounded local capture; never selects, publishes or fetches a public export."""

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import stat

from .. import follow_catalog as codec


@dataclass(frozen=True)
class CatalogStage:
    payload: bytes
    source_sha256: str
    catalog_sha256: str
    prior_sha256: str | None


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _regular(path: Path):
    # Reject links in ancestors too; there is no environment/default-path fallback.
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink() or ancestor.is_junction():
            raise ValueError("Follow catalog staging requires regular local inputs")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Follow catalog staging requires regular local inputs")


def _read(path: Path, limit: int) -> bytes:
    _regular(path)
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Follow catalog staging input exceeds bound")
    return data


def _prior(raw, digest, max_keys):
    if hashlib.sha256(raw).hexdigest() != digest:
        codec._invalid()
    value = codec._read(raw)
    if (
        not isinstance(value, dict)
        or list(value) != ["version", "source_sha256", "signup", "valid", "aliases"]
        or type(value["version"]) is not int
        or value["version"] != 1
        or not _digest(value["source_sha256"])
        or codec._json(value) != raw
    ):
        codec._invalid()
    groups = {}
    for group in ("signup", "valid"):
        obj = value[group]
        if not isinstance(obj, dict) or list(obj) != list(codec._KINDS):
            codec._invalid()
        groups[group] = {}
        for kind, keys in obj.items():
            if not isinstance(keys, list) or len(keys) > max_keys:
                codec._invalid()
            checked = {codec._key(key, kind) for key in keys}
            if keys != codec._sorted(checked):
                codec._invalid()
            groups[group][kind] = frozenset(checked)
    if not groups["signup"]["fields"] or not groups["signup"]["states"]:
        codec._invalid()
    if any(not groups["signup"][kind] <= groups["valid"][kind] for kind in codec._KINDS):
        codec._invalid()
    aliases = value["aliases"]
    if not isinstance(aliases, list) or len(aliases) > max_keys:
        codec._invalid()
    names, targets = [], set()
    for pair in aliases:
        if not isinstance(pair, list) or len(pair) != 2:
            codec._invalid()
        name = codec._text(pair[0], 800)
        if len(name.encode("utf-16-be")) > 400 or not isinstance(pair[1], str):
            codec._invalid()
        if pair[1] not in groups["signup"]["companies"]:
            codec._invalid()
        names.append(name)
        targets.add(pair[1])
    if names != codec._sorted(set(names)) or targets != groups["signup"]["companies"]:
        codec._invalid()
    return groups["valid"]


def prepare_follow_catalog(
    export_dir=None,
    *,
    enabled=False,
    source_sha256=None,
    prior_path=None,
    prior_sha256=None,
    genesis=False,
    max_source_bytes=None,
    max_source_rows=None,
    max_keys=None,
    max_bytes=None,
) -> CatalogStage | None:
    """Return bytes/pins only. Caller independently establishes source/prior authority.

    No Git identity, freshness, retention retirement or production limit is inferred.
    Prior input is the entire pinned approved public catalog, never subscriber state.
    """
    if enabled is not True:
        return None
    bounds = (max_source_bytes, max_source_rows, max_keys, max_bytes)
    if any(type(n) is not int or not 0 < n <= codec._MAX_INTEGER for n in bounds):
        codec._invalid()
    if not _digest(source_sha256) or type(genesis) is not bool:
        codec._invalid()
    if genesis:
        if prior_path is not None or prior_sha256 is not None:
            codec._invalid()
        retained = {kind: frozenset() for kind in codec._KINDS}
    else:
        if prior_path is None or not _digest(prior_sha256):
            codec._invalid()
        retained = _prior(_read(Path(prior_path), max_bytes), prior_sha256, max_keys)
    if export_dir is None:
        codec._invalid()
    root = Path(export_dir)
    if not root.is_dir():
        codec._invalid()
    remaining = max_source_bytes

    def capture(relative):
        nonlocal remaining
        data = _read(root / relative, remaining)
        remaining -= len(data)
        return data

    index = capture("listings/index.json")
    manifest = codec._read(index)
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if (
        not isinstance(files, dict)
        or len(files) > 26**2 + 2
        or any(not isinstance(key, str) or not codec._SHARD.fullmatch(key) for key in files)
    ):
        codec._invalid()
    shards = {f"listings/{key}.json": capture(f"listings/{key}.json") for key in sorted(files)}
    majors = capture("majors.json")
    payload = codec.build_follow_catalog(
        index,
        shards,
        majors,
        retained=retained,
        complete=True,
        max_source_bytes=max_source_bytes,
        max_source_rows=max_source_rows,
        max_keys=max_keys,
        max_bytes=max_bytes,
    )
    actual = codec._read(payload)["source_sha256"]
    if actual != source_sha256:
        raise ValueError("Follow catalog staging source pin mismatch")
    return CatalogStage(payload, actual, hashlib.sha256(payload).hexdigest(), prior_sha256)
