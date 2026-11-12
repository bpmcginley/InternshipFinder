"""Dormant, all-or-none Follow vocabulary from one caller-pinned public export."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping

from .site.source import employer_key
from .vocabulary import CANADIAN_PROVINCES, US_PLACE_LABELS

_KINDS = ("companies", "fields", "states")
_STATE_KEYS = frozenset(key for key, _ in (*US_PLACE_LABELS, *CANADIAN_PROVINCES))
_SHARD = re.compile(r"(?:[A-Z]{2}|Canada|remote)")
_FIELD = re.compile(r"[a-z_]{2,32}")
_ID = re.compile(r"[a-f0-9]{16}")
_BAD = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")
_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_MAX_INTEGER = 9_007_199_254_740_991


def _invalid():
    raise ValueError("Invalid or oversized Follow catalog input")


def _text(value, limit):
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip(_TRIM)
        or _BAD.search(value)
        or len(value.encode("utf-8")) > limit
    ):
        _invalid()
    return value


def _key(value, kind):
    value = _text(value, 200)
    if (kind == "fields" and not _FIELD.fullmatch(value)) or (
        kind == "states" and not re.fullmatch(r"[A-Z]{2}", value)
    ):
        _invalid()
    return value


def _object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        _invalid()
    return result


def _read(raw):
    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=lambda _: _invalid()
        )
    except (ValueError, RecursionError):
        _invalid()


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )


def _sorted(values):
    # Match JavaScript's ordinal string ordering, including supplementary Unicode scalars.
    return sorted(values, key=lambda value: value.encode("utf-16-be"))


def build_follow_catalog(
    index_bytes: bytes,
    shards: Mapping[str, bytes],
    majors_bytes: bytes,
    *,
    retained: Mapping[str, frozenset[str]],
    complete: bool,
    max_source_bytes: int,
    max_source_rows: int,
    max_keys: int,
    max_bytes: int,
) -> bytes:
    """Return canonical v1 bytes; caller owns provenance and explicit public-key retention.

    `retained` is the prior approved catalog's valid sets plus any explicitly approved public
    identities. It is required even for genesis (three empty frozensets). Never supply subscriber
    records. Availability is current; validity is their union, with no automatic retirement.
    """
    if (
        complete is not True
        or any(
            type(n) is not int or not 0 < n <= _MAX_INTEGER
            for n in (max_source_bytes, max_source_rows, max_keys, max_bytes)
        )
        or not isinstance(shards, Mapping)
        or not isinstance(retained, Mapping)
        or set(retained) != set(_KINDS)
    ):
        _invalid()
    previous = {}
    for kind in _KINDS:
        values = retained[kind]
        if not isinstance(values, frozenset) or len(values) > max_keys:
            _invalid()
        previous[kind] = {_key(value, kind) for value in values}
    # Validate every input byte bound before decoding any source JSON.
    source = {"listings/index.json": index_bytes, "majors.json": majors_bytes}
    if len(shards) > 26**2 + 2 or any(
        not isinstance(path, str)
        or not re.fullmatch(r"listings/(?:[A-Z]{2}|Canada|remote)\.json", path)
        for path in shards
    ):
        _invalid()
    source.update(shards)
    if (
        any(not isinstance(raw, bytes) for raw in source.values())
        or sum(len(raw) for raw in source.values()) > max_source_bytes
    ):
        _invalid()
    index, majors = _read(index_bytes), _read(majors_bytes)
    files = index.get("files") if isinstance(index, dict) else None
    fields = majors.get("fields") if isinstance(majors, dict) else None
    if (
        not isinstance(files, dict)
        or any(not _SHARD.fullmatch(key) for key in files)
        or set(shards) != {f"listings/{key}.json" for key in files}
        or not isinstance(fields, list)
        or not fields
        or len(fields) > max_keys
    ):
        _invalid()
    field_keys = {_key(value, "fields") for value in fields}
    if len(field_keys) != len(fields):
        _invalid()
    seen, aliases, declared = {}, {}, 0
    for shard, entry in sorted(files.items()):
        path = f"listings/{shard}.json"
        if (
            not isinstance(entry, dict)
            or entry.get("file") != path
            or type(entry.get("count")) is not int
            or type(entry.get("open")) is not int
            or not 0 <= entry["open"] <= entry["count"]
        ):
            _invalid()
        declared += entry["count"]
        if declared > max_source_rows:
            _invalid()
        rows = _read(shards[path])
        if not isinstance(rows, list) or len(rows) != entry["count"]:
            _invalid()
        local, opened = set(), 0
        for row in rows:
            if not isinstance(row, dict):
                _invalid()
            identity, status, tags = row.get("id"), row.get("status"), row.get("field_tags")
            if (
                not isinstance(identity, str)
                or not _ID.fullmatch(identity)
                or identity in local
                or status not in ("open", "closed")
                or not isinstance(tags, list)
                or len(tags) > 64
                or any(not isinstance(tag, str) or tag not in field_keys for tag in tags)
            ):
                _invalid()
            local.add(identity)
            # Compare all captured facts, not just employer/status, across duplicated shards.
            signature = json.dumps(row, sort_keys=True, ensure_ascii=True, allow_nan=False)
            if identity in seen and seen[identity] != signature:
                _invalid()
            seen[identity] = signature
            name = _text(row.get("company_name"), 800)
            if len(name.encode("utf-16-be")) > 400:
                _invalid()
            key = _key(employer_key(name), "companies")
            opened += status == "open"
            if status == "open":
                aliases[name] = key
                if len(aliases) > max_keys:
                    _invalid()
        if opened != entry["open"]:
            _invalid()
    current = {"companies": set(aliases.values()), "fields": field_keys, "states": _STATE_KEYS}
    valid = {kind: current[kind] | previous[kind] for kind in _KINDS}
    if any(len(values) > max_keys for values in valid.values()):
        _invalid()
    # Unambiguous framing binds the exact inputs; no clock, path selection or freshness assertion.
    digest = hashlib.sha256()
    for path in sorted(source):
        for part in (path.encode("utf-8"), source[path]):
            digest.update(str(len(part)).encode("ascii") + b":" + part)
    result = _json(
        {
            "version": 1,
            "source_sha256": digest.hexdigest(),
            "signup": {kind: _sorted(current[kind]) for kind in _KINDS},
            "valid": {kind: _sorted(valid[kind]) for kind in _KINDS},
            "aliases": [[name, aliases[name]] for name in _sorted(aliases)],
        }
    )
    if len(result) > max_bytes:
        _invalid()
    return result
