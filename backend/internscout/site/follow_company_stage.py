"""Dormant same-export Follow identities; all-or-none bytes, no I/O or public mode."""

from dataclasses import dataclass
import hashlib
import json
from collections.abc import Mapping
from types import MappingProxyType

from .. import follow_catalog as codec
from .follow_publication import CatalogStage, _digest, prepare_follow_catalog


@dataclass(frozen=True)
class FollowCompanyStage:
    files: Mapping[str, bytes]
    catalog: CatalogStage
    first_sha256: str


def stage_follow_companies(
    selected=None,
    first_bytes=None,
    *,
    enabled=False,
    source_sha256=None,
    catalog_sha256=None,
    first_sha256=None,
    prior_bytes=None,
    prior_sha256=None,
    genesis=False,
    max_source_bytes=None,
    max_source_rows=None,
    max_keys=None,
    max_bytes=None,
    max_first_bytes=None,
    max_first_rows=None,
    max_output_bytes=None,
) -> FollowCompanyStage | None:
    """Stage immutable organic shard/preview bytes plus the exact catalog receipt.

    The trusted caller captures selected and first bytes from one approved export and
    supplies independent expected pins. No freshness, Git selection, URL or production
    bounds are inferred. The catalog binds ORIGINAL input bytes; annotation is output.
    The publisher must choose these returned bytes together, or keep the originals when
    disabled. No partial output or writes occur on rejection.
    """
    if enabled is not True:
        return None
    if (
        any(
            type(n) is not int or not 0 < n <= codec._MAX_INTEGER
            for n in (max_first_bytes, max_first_rows, max_output_bytes)
        )
        or not _digest(catalog_sha256)
        or not _digest(first_sha256)
        or type(first_bytes) is not bytes
        or len(first_bytes) > max_first_bytes
        or hashlib.sha256(first_bytes).hexdigest() != first_sha256
        or type(selected) is not dict
    ):
        codec._invalid()
    captured = dict(selected)
    catalog = prepare_follow_catalog(
        captured,
        enabled=True,
        source_sha256=source_sha256,
        prior_bytes=prior_bytes,
        prior_sha256=prior_sha256,
        genesis=genesis,
        max_source_bytes=max_source_bytes,
        max_source_rows=max_source_rows,
        max_keys=max_keys,
        max_bytes=max_bytes,
    )
    if catalog.catalog_sha256 != catalog_sha256:
        codec._invalid()
    aliases = dict(codec._read(catalog.payload)["aliases"])
    index = codec._read(captured["listings/index.json"])
    preview = index.get("first")
    first = codec._read(first_bytes)
    if (
        not isinstance(preview, dict)
        or preview.get("file") != "first.json"
        or type(preview.get("rows")) is not int
        or not 0 <= preview["rows"] <= max_first_rows
        or not isinstance(first, list)
        or len(first) != preview["rows"]
    ):
        codec._invalid()
    output, identities = {}, {}
    used = 0

    def encode(path, rows):
        nonlocal used
        raw = codec._json(rows)
        used += len(raw)
        if used > max_output_bytes:
            codec._invalid()
        output[path] = raw

    def annotate(row):
        if row["status"] == "open":
            key = aliases.get(row["company_name"])
            if key is None:
                codec._invalid()
            return {**row, "follow_company_key": key}
        return row

    for shard in sorted(index["files"]):
        path = f"listings/{shard}.json"
        rows = codec._read(captured[path])
        for row in rows:
            if "follow_company_key" in row:
                codec._invalid()
            # The catalog producer already rejects every conflicting duplicate ID.
            identities[row["id"]] = json.dumps(row, sort_keys=True, ensure_ascii=True)
        encode(path, [annotate(row) for row in rows])
    seen = set()
    for row in first:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("id"), str)
            or row["id"] in seen
            or row.get("status") != "open"
            or json.dumps(row, sort_keys=True, ensure_ascii=True) != identities.get(row["id"])
        ):
            codec._invalid()
        seen.add(row["id"])
    encode("first.json", [annotate(row) for row in first])
    return FollowCompanyStage(MappingProxyType(output), catalog, first_sha256)
