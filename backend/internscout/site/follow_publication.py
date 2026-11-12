"""Dormant bounded byte staging; never opens, selects, publishes or fetches an export."""

from dataclasses import dataclass
import hashlib
import re

from .. import follow_catalog as codec


@dataclass(frozen=True)
class CatalogStage:
    payload: bytes
    source_sha256: str
    catalog_sha256: str
    prior_sha256: str | None


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


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
    selected=None,
    *,
    enabled=False,
    source_sha256=None,
    prior_bytes=None,
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
        if prior_bytes is not None or prior_sha256 is not None:
            codec._invalid()
        retained = {kind: frozenset() for kind in codec._KINDS}
    else:
        if (
            type(prior_bytes) is not bytes
            or len(prior_bytes) > max_bytes
            or not _digest(prior_sha256)
        ):
            codec._invalid()
        retained = _prior(prior_bytes, prior_sha256, max_keys)
    if type(selected) is not dict or len(selected) > 26**2 + 4:
        codec._invalid()
    captured = dict(selected)
    if (
        any(type(path) is not str or type(data) is not bytes for path, data in captured.items())
        or sum(len(data) for data in captured.values()) > max_source_bytes
        or "listings/index.json" not in captured
        or "majors.json" not in captured
    ):
        codec._invalid()
    index, majors = captured.pop("listings/index.json"), captured.pop("majors.json")
    # The producer validates the exact declared shard paths, count and content.
    shards = captured
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
