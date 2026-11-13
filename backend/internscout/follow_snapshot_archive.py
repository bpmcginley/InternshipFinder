"""Plan one immutable follow archive update without reading or writing files."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from math import isfinite
from types import MappingProxyType

from .follow_snapshot import FollowSnapshotBounds, _ROLE_KEYS

INDEX = "data/follows/index.json"
_PREFIX = "data/follows/"
_DIGEST = re.compile(r"[a-f0-9]{64}")
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
_JOB_LIFETIME = timedelta(hours=48)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_PUBLIC_ROLE_KEYS = _ROLE_KEYS | {"company_key"}
_ROLE_LISTS = {"field_tags", "states"}


@dataclass(frozen=True)
class FollowArchiveBounds:
    snapshot: FollowSnapshotBounds
    max_enqueue_age_ms: int
    publish_margin_ms: int
    max_entries: int
    max_archive_bytes: int


@dataclass(frozen=True)
class FollowArchivePlan:
    base_index_sha256: str | None
    files: Mapping[str, bytes]


@dataclass(frozen=True)
class _Entry:
    generated_at: str
    sha256: str
    bytes: int
    enqueue_until: str
    retain_until: str

    @property
    def path(self) -> str:
        return f"{_PREFIX}{self.sha256}.json"


@dataclass(frozen=True)
class _Archive:
    entries: tuple[_Entry, ...] = ()
    high_water: str | None = None
    checked_at: str | None = None

    def index(self) -> bytes:
        return json.dumps(
            {
                "version": 1,
                "latest": self.entries[-1].sha256 if self.entries else None,
                "high_water": self.high_water,
                "checked_at": self.checked_at,
                "entries": [asdict(entry) for entry in self.entries],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")


def _fail(reason: str) -> ValueError:
    return ValueError(f"Invalid follow archive: {reason}")


def _stamp(value: datetime) -> str:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise _fail("aware time required")
    value = value.astimezone(timezone.utc)
    if value.microsecond % 1000:
        raise _fail("exact millisecond time required")
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _instant(value: object) -> datetime:
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        raise _fail("invalid UTC timestamp")
    return datetime.fromisoformat(value[:-1] + "+00:00")


def _pairs(items: list[tuple[str, object]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise _fail("duplicate JSON key")
    return result


def _nonfinite(_value: str):
    raise _fail("non-finite JSON number")


def _finite_float(value: str) -> float:
    result = float(value)
    if not isfinite(result):
        raise _fail("non-finite JSON number")
    return result


def _decode(raw: bytes):
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_pairs,
            parse_constant=_nonfinite,
            parse_float=_finite_float,
        )
    except (ValueError, RecursionError) as error:
        raise _fail("malformed UTF-8 JSON") from error


def _positive(value: object) -> bool:
    return type(value) is int and 0 < value <= _MAX_SAFE_INTEGER


def _check_bounds(bounds: FollowArchiveBounds) -> None:
    if not isinstance(bounds, FollowArchiveBounds) or not isinstance(
        bounds.snapshot, FollowSnapshotBounds
    ):
        raise _fail("explicit bounds required")
    if not all(
        _positive(value)
        for value in (
            *vars(bounds.snapshot).values(),
            bounds.max_enqueue_age_ms,
            bounds.publish_margin_ms,
            bounds.max_entries,
            bounds.max_archive_bytes,
        )
    ):
        raise _fail("invalid archive bounds")


def _digest(raw: bytes) -> str:
    return sha256(raw).hexdigest()


def _base(files: Mapping[str, bytes]) -> str | None:
    return _digest(files[INDEX]) if INDEX in files else None


def _snapshot(raw: bytes, bounds: FollowSnapshotBounds) -> tuple[str, str]:
    if not isinstance(raw, bytes) or not 0 < len(raw) <= bounds.max_bytes:
        raise _fail("snapshot byte bound")
    envelope = _decode(raw)
    if (
        not isinstance(envelope, dict)
        or envelope.keys() != {"version", "complete", "generated_at", "covers_after", "roles"}
        or type(envelope["version"]) is not int
        or envelope["version"] != 1
        or envelope["complete"] is not True
        or not isinstance(envelope["roles"], list)
        or len(envelope["roles"]) > bounds.max_roles
    ):
        raise _fail("invalid complete snapshot envelope")
    # The adapter and Worker own eligibility. This layer still rejects fields outside the
    # public wire shape, including nested values that could carry a raw source row.
    for role in envelope["roles"]:
        if (
            not isinstance(role, dict)
            or role.keys() != _PUBLIC_ROLE_KEYS
            or any(not isinstance(role[key], str) for key in _PUBLIC_ROLE_KEYS - _ROLE_LISTS)
            or any(
                not isinstance(role[key], list)
                or any(not isinstance(item, str) for item in role[key])
                for key in _ROLE_LISTS
            )
        ):
            raise _fail("invalid public role shape")
    upper, lower = envelope["generated_at"], envelope["covers_after"]
    duration = _instant(upper) - _instant(lower)
    if duration <= timedelta(0) or duration // timedelta(milliseconds=1) > bounds.max_window_ms:
        raise _fail("snapshot coverage bound")
    return upper, lower


def _entry(raw: bytes, bounds: FollowArchiveBounds) -> _Entry:
    upper, _ = _snapshot(raw, bounds.snapshot)
    try:
        enqueue = _instant(upper) + timedelta(milliseconds=bounds.max_enqueue_age_ms)
        retain = enqueue + _JOB_LIFETIME + timedelta(milliseconds=bounds.publish_margin_ms)
    except OverflowError as error:
        raise _fail("deadline overflow") from error
    return _Entry(upper, _digest(raw), len(raw), _stamp(enqueue), _stamp(retain))


def _validate(files: Mapping[str, bytes], bounds: FollowArchiveBounds) -> _Archive:
    if not isinstance(files, Mapping) or len(files) > bounds.max_entries + 1:
        raise _fail("archive file count")
    if not files:
        return _Archive()
    if INDEX not in files or any(not isinstance(value, bytes) for value in files.values()):
        raise _fail("missing manifest or non-byte file")
    if sum(map(len, files.values())) > bounds.max_archive_bytes:
        raise _fail("archive byte bound")
    index = _decode(files[INDEX])
    if (
        not isinstance(index, dict)
        or index.keys() != {"version", "latest", "entries", "high_water", "checked_at"}
        or type(index["version"]) is not int
        or index["version"] != 1
        or not isinstance(index["entries"], list)
        or len(index["entries"]) > bounds.max_entries
    ):
        raise _fail("invalid manifest")
    high_water, checked_at = index["high_water"], index["checked_at"]
    if _instant(high_water) > _instant(checked_at):
        raise _fail("invalid archive high-water")
    entries = []
    days = set()
    for item in index["entries"]:
        if (
            not isinstance(item, dict)
            or item.keys() != {"generated_at", "sha256", "bytes", "enqueue_until", "retain_until"}
            or not isinstance(item["sha256"], str)
            or not _DIGEST.fullmatch(item["sha256"])
            or not _positive(item["bytes"])
        ):
            raise _fail("invalid archive entry")
        entry = _Entry(**item)
        if entry.path not in files or _entry(files[entry.path], bounds) != entry:
            raise _fail("missing or changed snapshot bytes or metadata")
        day = entry.generated_at[:10]
        if day in days or (entries and entry.generated_at <= entries[-1].generated_at):
            raise _fail("nonmonotonic or duplicate UTC day")
        days.add(day)
        entries.append(entry)
    expected = {INDEX} | {entry.path for entry in entries}
    if files.keys() != expected or (entries and high_water != entries[-1].generated_at):
        raise _fail("unexpected archive file or high-water")
    state = _Archive(tuple(entries), high_water, checked_at)
    if files[INDEX] != state.index():
        raise _fail("noncanonical manifest or latest pointer")
    return state


def plan_follow_snapshot_archive(
    files: Mapping[str, bytes],
    candidate: bytes | None,
    *,
    now: datetime,
    bounds: FollowArchiveBounds,
) -> FollowArchivePlan:
    """Return the complete next file set and the manifest digest the writer must compare."""
    _check_bounds(bounds)
    at = _stamp(now)
    state = _validate(files, bounds)
    if state.checked_at is not None and at < state.checked_at:
        raise _fail("clock rollback")
    base = _base(files)
    added = None
    if candidate is not None:
        entry = _entry(candidate, bounds)
        if not entry.generated_at <= at < entry.enqueue_until:
            raise _fail("candidate outside its enqueue lifetime")
        if state.high_water is None or entry.generated_at[:10] > state.high_water[:10]:
            added = entry
        elif entry.generated_at < state.high_water:
            raise _fail("candidate generation rollback")
        elif entry.generated_at == state.high_water and (
            not state.entries or entry != state.entries[-1]
        ):
            raise _fail("conflicting candidate at accepted generation")

    kept = tuple(entry for entry in state.entries if at < entry.retain_until)
    if added is None and kept == state.entries:
        return FollowArchivePlan(base, MappingProxyType(dict(files)))
    entries = kept + ((added,) if added else ())
    high_water = added.generated_at if added else state.high_water
    planned = {entry.path: files[entry.path] for entry in kept}
    if added is not None:
        planned[added.path] = candidate
    planned[INDEX] = _Archive(entries, high_water, at).index()
    _validate(planned, bounds)
    return FollowArchivePlan(base, MappingProxyType(planned))


def validate_follow_archive_transition(
    current: Mapping[str, bytes],
    plan: FollowArchivePlan,
    *,
    now: datetime,
    bounds: FollowArchiveBounds,
) -> None:
    """Reject a stale base or any staged file set that differs from a fresh forward plan."""
    _check_bounds(bounds)
    _validate(current, bounds)
    if plan.base_index_sha256 != _base(current):
        raise _fail("stale archive base")
    staged = _validate(plan.files, bounds)
    added = [entry for entry in staged.entries if entry.path not in current]
    if len(added) > 1:
        raise _fail("multiple new archive entries")
    candidate = plan.files[added[0].path] if added else None
    expected = plan_follow_snapshot_archive(current, candidate, now=now, bounds=bounds)
    if expected.files != plan.files:
        raise _fail("unsafe prune or archive rollback")


def select_follow_snapshot_for_enqueue(
    files: Mapping[str, bytes],
    *,
    effective_lower: datetime,
    now: datetime,
    bounds: FollowArchiveBounds,
) -> bytes | None:
    """Return current bytes only when this watermark is covered. This never changes progress."""
    _check_bounds(bounds)
    at, lower = _stamp(now), _stamp(effective_lower)
    state = _validate(files, bounds)
    if not state.entries or at < state.checked_at:
        return None
    latest = state.entries[-1]
    if not latest.generated_at <= at < latest.enqueue_until:
        return None
    raw = files[latest.path]
    upper, covers_after = _snapshot(raw, bounds.snapshot)
    return raw if covers_after <= lower <= upper else None
