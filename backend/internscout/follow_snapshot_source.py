"""Adapt one caller-attested listing export to the dormant follow byte producer."""

from __future__ import annotations

import json
import re
from hashlib import sha256
from math import isfinite
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .follow_snapshot import FollowSnapshotBounds, FollowSnapshotCatalog, build_follow_snapshot
from .site.source import place

_SHARD = re.compile(r"(?:[A-Z]{2}|Canada|remote)")
_DIGEST = re.compile(r"[a-f0-9]{64}")
_LISTING_ID = re.compile(r"[a-f0-9]{16}")
_TIMESTAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?",
    re.ASCII,
)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


@dataclass(frozen=True)
class FollowExportCapture:
    """Trusted facts supplied separately from the index and its shard bytes."""

    generated_at: datetime
    covers_after: datetime
    index_sha256: str
    shard_sha256: Mapping[str, str]
    complete: bool
    legacy_utc_first_seen: bool = False


def _invalid(reason: str) -> ValueError:
    return ValueError(f"Invalid follow export: {reason}")


def _utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise _invalid("aware capture time required")
    try:
        return value.astimezone(timezone.utc)
    except OverflowError as error:
        raise _invalid("UTC timestamp out of range") from error


def _time(value: object, *, legacy_utc: bool = False) -> datetime:
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value) or value.endswith("-00:00"):
        raise _invalid("malformed export time")
    try:
        parsed = datetime.fromisoformat(
            value.removesuffix("Z") + ("+00:00" if value.endswith("Z") else "")
        )
    except ValueError as error:
        raise _invalid("malformed export time") from error
    if parsed.utcoffset() is None and legacy_utc:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return _utc(parsed)


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise _invalid("duplicate JSON key")
    return result


def _bad_number(_value: str) -> None:
    raise _invalid("non-finite JSON number")


def _finite_float(value: str) -> float:
    result = float(value)
    if not isfinite(result):
        raise _invalid("non-finite JSON number")
    return result


def _read(data: bytes):
    try:
        return json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_bad_number,
            parse_float=_finite_float,
        )
    except (ValueError, RecursionError) as error:
        raise _invalid("invalid UTF-8 JSON") from error


def _signature(row: dict) -> str:
    try:
        return json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (ValueError, RecursionError) as error:
        raise _invalid("invalid shard row facts") from error


def _collect_rows(
    files: dict, shards: Mapping[str, bytes], max_source_rows: int
) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    declared = 0
    for key, entry in sorted(files.items()):
        path = f"listings/{key}.json"
        if (
            not isinstance(entry, dict)
            or entry.get("file") != path
            or type(entry.get("count")) is not int
            or type(entry.get("open")) is not int
            or not 0 <= entry["open"] <= entry["count"]
        ):
            raise _invalid("invalid shard manifest entry")
        declared += entry["count"]
        if declared > max_source_rows:
            raise _invalid("source row bound")
        contents = _read(shards[path])
        if not isinstance(contents, list) or len(contents) != entry["count"]:
            raise _invalid("shard row count mismatch")
        in_shard: set[str] = set()
        open_count = 0
        for row in contents:
            if not isinstance(row, dict) or row.get("status") not in ("open", "closed"):
                raise _invalid("invalid shard row")
            role_id = row.get("id")
            if not isinstance(role_id, str) or not _LISTING_ID.fullmatch(role_id):
                raise _invalid("invalid listing ID")
            if role_id in in_shard:
                raise _invalid("duplicate ID in one shard")
            in_shard.add(role_id)
            open_count += row["status"] == "open"
            if role_id in rows:
                if _signature(rows[role_id]) != _signature(row):
                    raise _invalid("conflicting multi-shard facts")
            else:
                rows[role_id] = row
        if open_count != entry["open"]:
            raise _invalid("shard open count mismatch")
    return rows


def _display_and_states(row: dict, allowed: frozenset[str]) -> tuple[str, list[str]]:
    regions = row.get("regions")
    if not isinstance(regions, list) or any(
        not isinstance(region, dict)
        or any(
            region.get(key) is not None and not isinstance(region[key], str)
            for key in ("loc", "state")
        )
        or not (region.get("loc") or region.get("state"))
        for region in regions
    ):
        raise _invalid("invalid public regions")
    if regions:
        location = place(row)
        actual = {region.get("state") for region in regions}
    else:
        location = "Remote" if row.get("is_remote") is True else row.get("location_raw")
        state = row.get("state")
        if (
            not isinstance(location, str)
            or not location
            or (state is not None and not isinstance(state, str))
        ):
            raise _invalid("missing public location")
        actual = {state}
    return location, sorted((actual & allowed) - {"Remote", "remote", "REMOTE"})


def snapshot_from_fixed_export(
    index_bytes: bytes,
    shards: Mapping[str, bytes],
    *,
    capture: FollowExportCapture,
    catalog: FollowSnapshotCatalog,
    bounds: FollowSnapshotBounds,
    max_source_bytes: int,
    max_source_rows: int,
) -> bytes:
    """Validate fixed index/shard bytes and build a complete snapshot, or reject the whole capture."""
    if (
        not isinstance(capture, FollowExportCapture)
        or capture.complete is not True
        or type(capture.legacy_utc_first_seen) is not bool
        or not isinstance(capture.index_sha256, str)
        or not _DIGEST.fullmatch(capture.index_sha256)
        or not isinstance(capture.shard_sha256, Mapping)
        or not capture.shard_sha256
        or any(
            not isinstance(key, str)
            or not _SHARD.fullmatch(key)
            or not isinstance(digest, str)
            or not _DIGEST.fullmatch(digest)
            for key, digest in capture.shard_sha256.items()
        )
        or not isinstance(index_bytes, bytes)
        or not isinstance(shards, Mapping)
        or any(
            type(limit) is not int or not 0 < limit <= _MAX_SAFE_INTEGER
            for limit in (max_source_bytes, max_source_rows)
        )
        or not isinstance(catalog, FollowSnapshotCatalog)
        or any(
            not isinstance(keys, frozenset) or any(not isinstance(key, str) for key in keys)
            for keys in (catalog.companies, catalog.fields, catalog.states)
        )
    ):
        raise _invalid("missing capture attestation or explicit bounds")
    expected_paths = {
        f"listings/{key}.json": digest for key, digest in capture.shard_sha256.items()
    }
    if shards.keys() != expected_paths.keys() or any(
        not isinstance(blob, bytes) for blob in shards.values()
    ):
        raise _invalid("missing or unexpected shard bytes")
    if len(index_bytes) + sum(map(len, shards.values())) > max_source_bytes:
        raise _invalid("source byte bound")
    if sha256(index_bytes).hexdigest() != capture.index_sha256 or any(
        sha256(shards[path]).hexdigest() != digest for path, digest in expected_paths.items()
    ):
        raise _invalid("source bytes do not match the capture")

    exact = _utc(capture.generated_at)
    upper = exact.replace(microsecond=exact.microsecond // 1000 * 1000)
    lower = _utc(capture.covers_after)
    if lower.microsecond % 1000 or lower >= upper:
        raise _invalid("incomplete millisecond coverage")
    index = _read(index_bytes)
    if not isinstance(index, dict) or _time(index.get("generated_at")) != exact:
        raise _invalid("index generation mismatch")
    files = index.get("files")
    if not isinstance(files, dict) or files.keys() != capture.shard_sha256.keys():
        raise _invalid("incomplete shard manifest")
    source_rows = _collect_rows(files, shards, max_source_rows)

    roles = []
    for row in source_rows.values():
        if row["status"] == "closed":
            continue
        first = _time(row.get("first_seen"), legacy_utc=capture.legacy_utc_first_seen)
        if first > exact:
            raise _invalid("first-seen time after source generation")
        if not lower < first <= upper:
            continue
        # For aligned L and U, L < ceil_ms(t) <= U iff L < t <= U. Exclude the
        # sub-ms export tail before rounding so it remains eligible next time.
        first += timedelta(microseconds=(-first.microsecond) % 1000)
        fields = row.get("field_tags")
        if not isinstance(fields, list) or any(not isinstance(field, str) for field in fields):
            raise _invalid("invalid field tags")
        location, states = _display_and_states(row, catalog.states)
        roles.append(
            {
                "id": row["id"],
                "first_seen": first,
                "status": "open",
                "company_name": row.get("company_name"),
                "title": row.get("title"),
                "location": location,
                "apply_url": row.get("apply_url"),
                "field_tags": sorted(set(fields) & catalog.fields),
                "states": states,
            }
        )
    return build_follow_snapshot(
        roles, generated_at=upper, covers_after=lower, complete=True, catalog=catalog, bounds=bounds
    )
