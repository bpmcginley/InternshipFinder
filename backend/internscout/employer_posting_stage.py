"""Stage one pinned dashboard export and its matching employer-key catalog."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from urllib.parse import urlsplit

from .employer_catalog import build_employer_catalog
from .site.source import employer_key
from .site.text import safe_url

CATALOG_PATH = "employer-posting-keys.json"
CATALOG_BYTES = 256 * 1024
_FIRST_PATH = "first.json"
_SHARD = re.compile(r"[A-Za-z0-9_-]+")
_BAD_URL = re.compile(r"[\x00-\x1f\x7f\\]")


@dataclass(frozen=True)
class EmployerPostingStage:
    """Paths relative to public data, plus keys for the same release's direct links."""

    files: Mapping[str, bytes]
    posting_keys: Mapping[str, str]


def _unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON field in employer release input")
    return result


def _read(raw):
    if not isinstance(raw, bytes):
        raise ValueError("Employer release input must be pinned JSON bytes")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    except (ValueError, RecursionError):
        raise ValueError("Invalid employer release JSON") from None


def _write(value):
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        )
    except (ValueError, RecursionError):
        raise ValueError("Invalid employer release row") from None


def _direct_posting(url):
    if not isinstance(url, str) or _BAD_URL.search(url):
        return False
    link = safe_url(url)
    if not link:
        return False
    try:
        target = urlsplit(link)
        host = target.hostname
        return bool(host and target.username is None and not any(c.isspace() for c in host))
    except ValueError:
        return False


def _row_identity(row):
    if not isinstance(row, dict) or "employer_key" in row:
        raise ValueError("Expected an unannotated organic dashboard row")
    role_id, name, status, url = (
        row.get("id"),
        row.get("company_name"),
        row.get("status"),
        row.get("apply_url"),
    )
    if (
        not isinstance(role_id, str)
        or not role_id
        or status not in ("open", "closed")
        or (url is not None and not isinstance(url, str))
    ):
        raise ValueError("Invalid organic dashboard row")
    key = None
    if _direct_posting(url):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Missing public employer name")
        key = employer_key(name)
    return role_id, key, status, url


def _listing_rows(raw, count):
    rows = _read(raw)
    if type(count) is not int or not isinstance(rows, list) or len(rows) != count:
        raise ValueError("Listing count does not match employer release manifest")
    return rows


def stage_employer_postings(
    index_bytes: bytes, shards: Mapping[str, bytes], first_bytes: bytes
) -> EmployerPostingStage:
    """Build all annotations and the catalog, or reject without returning any output.

    The caller supplies exact bytes from one independently verified public export.
    Description shards and listing links outside that export are not inputs.
    """
    index = _read(index_bytes)
    manifest = index.get("files") if isinstance(index, dict) else None
    first = index.get("first") if isinstance(index, dict) else None
    if (
        not isinstance(manifest, dict)
        or not manifest
        or any(not _SHARD.fullmatch(key) for key in manifest)
        or not isinstance(first, dict)
        or first.get("file") != _FIRST_PATH
    ):
        raise ValueError("Invalid employer release manifest")
    expected = {f"listings/{key}.json": entry for key, entry in manifest.items()}
    if not isinstance(shards, Mapping) or shards.keys() != expected.keys():
        raise ValueError("Incomplete employer release shards")

    identities, posting_keys, output, names = {}, {}, {}, set()
    for path, entry in sorted(expected.items()):
        if not isinstance(entry, dict) or entry.get("file") != path:
            raise ValueError("Invalid employer release shard path")
        rows = _listing_rows(shards[path], entry.get("count"))
        seen, opened = set(), 0
        for row in rows:
            role_id, key, status, url = _row_identity(row)
            identity = (key, status, url)
            if role_id in seen or identities.setdefault(role_id, identity) != identity:
                raise ValueError("Conflicting organic listing occurrences")
            seen.add(role_id)
            opened += status == "open"
            if key is not None:
                names.add(row["company_name"])
                posting_keys[role_id] = key
                row["employer_key"] = key
        if type(entry.get("open")) is not int or opened != entry["open"]:
            raise ValueError("Open count does not match employer release manifest")
        output[path] = _write(rows)

    first_rows = _listing_rows(first_bytes, first.get("rows"))
    seen = set()
    for row in first_rows:
        role_id, key, status, url = _row_identity(row)
        if status != "open" or role_id in seen or identities.get(role_id) != (key, status, url):
            raise ValueError("First-screen role differs from the full employer release")
        seen.add(role_id)
        if key is not None:
            row["employer_key"] = key
    output[_FIRST_PATH] = _write(first_rows)
    output[CATALOG_PATH] = build_employer_catalog(
        sorted(names), complete=True, max_bytes=CATALOG_BYTES
    )
    return EmployerPostingStage(MappingProxyType(output), MappingProxyType(posting_keys))
