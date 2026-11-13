"""Build a pinned follow snapshot from an already validated, complete public window."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from .site.source import employer_key

_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_ID = re.compile(r"[a-f0-9]{16}")
_BAD_TEXT = re.compile(r"[\x00-\x1f\x7f\u2028\u2029\ud800-\udfff]")
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_URL = re.compile(r"(?:[A-Za-z0-9._~!$&()*+,;=:@/?#-]|%[a-fA-F0-9]{2})+")
_ROLE_KEYS = frozenset(
    (
        "id",
        "first_seen",
        "status",
        "company_name",
        "title",
        "location",
        "apply_url",
        "field_tags",
        "states",
    )
)


@dataclass(frozen=True)
class FollowSnapshotCatalog:
    companies: frozenset[str]
    fields: frozenset[str]
    states: frozenset[str]


@dataclass(frozen=True)
class FollowSnapshotBounds:
    max_bytes: int
    max_roles: int
    max_text_bytes: int
    max_window_ms: int


def _instant(value: object) -> str:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError("Follow snapshot requires aware timestamps")
    utc = value.astimezone(timezone.utc)
    if utc.microsecond % 1000:
        raise ValueError("Follow snapshot requires exact millisecond timestamps")
    return utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: object, max_bytes: int, max_units: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or value.startswith("\ufeff")
        or value.endswith("\ufeff")
        or _BAD_TEXT.search(value)
        or sum(1 + (ord(char) > 0xFFFF) for char in value) > max_units
        or len(value.encode("utf-8")) > max_bytes
    ):
        raise ValueError("Invalid follow snapshot text")
    return value


def _posting_url(value: object, max_bytes: int) -> str:
    # Accept a conservative subset of the Worker's WHATWG URL grammar. ASCII DNS only,
    # no user info, and only URL characters whose encoding cannot expand the href.
    url = _text(value, max_bytes, 2000)
    if not _URL.fullmatch(url) or not re.match(r"https?://", url, re.ASCII | re.IGNORECASE):
        raise ValueError("Unsupported follow posting URL")
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port
    except ValueError as error:
        raise ValueError("Unsupported follow posting URL") from error
    labels = host.removesuffix(".").split(".")
    if (
        "@" in parts.netloc
        or parts.netloc.endswith(":")
        or not 2 <= len(labels)
        or len(host) > 253
        or not re.fullmatch(r"[a-z][a-z0-9-]*", labels[-1])
        or any(not _DNS_LABEL.fullmatch(label) or label.startswith("xn--") for label in labels)
        or (port is not None and port < 1)
        or len(url) + (not parts.path) > 2000
    ):
        raise ValueError("Unsupported follow posting URL")
    return url


def _keys(value: object, allowed: frozenset[str]) -> list[str]:
    if (
        not isinstance(value, (list, tuple))
        or len(value) > 64
        or any(not isinstance(key, str) or key not in allowed for key in value)
        or len(set(value)) != len(value)
    ):
        raise ValueError("Invalid follow snapshot scope keys")
    return sorted(value)


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def build_follow_snapshot(
    rows: list[Mapping[str, object]] | tuple[Mapping[str, object], ...],
    *,
    generated_at: datetime,
    covers_after: datetime,
    complete: bool,
    catalog: FollowSnapshotCatalog,
    bounds: FollowSnapshotBounds,
) -> bytes:
    """Serialize all supplied eligible roles or raise ValueError without returning partial bytes."""
    if (
        complete is not True
        or not isinstance(rows, (list, tuple))
        or not isinstance(catalog, FollowSnapshotCatalog)
        or not all(
            isinstance(keys, frozenset)
            for keys in (catalog.companies, catalog.fields, catalog.states)
        )
        or not isinstance(bounds, FollowSnapshotBounds)
        or any(
            type(limit) is not int or not 0 < limit <= _MAX_SAFE_INTEGER
            for limit in (
                bounds.max_bytes,
                bounds.max_roles,
                bounds.max_text_bytes,
                bounds.max_window_ms,
            )
        )
        or len(rows) > bounds.max_roles
    ):
        raise ValueError("Invalid or incomplete follow snapshot")
    upper, lower = _instant(generated_at), _instant(covers_after)
    width = generated_at.astimezone(timezone.utc) - covers_after.astimezone(timezone.utc)
    if not lower < upper or width // timedelta(milliseconds=1) > bounds.max_window_ms:
        raise ValueError("Invalid follow snapshot window")

    prefix = _json({"version": 1, "complete": True, "generated_at": upper, "covers_after": lower})
    prefix = prefix[:-1] + b',"roles":['
    size = len(prefix) + len(b"]}")
    if size > bounds.max_bytes:
        raise ValueError("Follow snapshot exceeds byte bound")
    encoded = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping) or row.keys() != _ROLE_KEYS or row["status"] != "open":
            raise ValueError("Invalid follow snapshot role shape")
        role_id = row["id"]
        if not isinstance(role_id, str) or not _ID.fullmatch(role_id) or role_id in seen:
            raise ValueError("Invalid or duplicate follow listing ID")
        seen.add(role_id)
        first = _instant(row["first_seen"])
        if not lower < first <= upper:
            raise ValueError("Role is outside the complete follow window")
        company = _text(row["company_name"], bounds.max_text_bytes, 200)
        company_key = _text(employer_key(company), 200, 200)
        if company_key not in catalog.companies:
            raise ValueError("Unknown follow employer key")
        content = _json(
            {
                "id": role_id,
                "company_key": company_key,
                "field_tags": _keys(row["field_tags"], catalog.fields),
                "states": _keys(row["states"], catalog.states),
                "first_seen": first,
                "status": "open",
                "company_name": company,
                "title": _text(row["title"], bounds.max_text_bytes, 300),
                "location": _text(row["location"], bounds.max_text_bytes, 300),
                "apply_url": _posting_url(row["apply_url"], bounds.max_text_bytes),
            }
        )
        size += len(content) + bool(encoded)
        if size > bounds.max_bytes:
            raise ValueError("Follow snapshot exceeds byte bound")
        encoded.append((role_id, first, content))

    encoded.sort(key=lambda item: item[0])
    encoded.sort(key=lambda item: item[1], reverse=True)
    return prefix + b",".join(content for _, _, content in encoded) + b"]}"
