"""Opt-in, in-process timestamp lineage for exact fixed listing exports."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from types import MappingProxyType

_SHARD = re.compile(r"(?:[A-Z]{2}|Canada|remote)")
_ID = re.compile(r"[a-f0-9]{16}")
_STAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?",
    re.ASCII,
)


@dataclass(frozen=True)
class ExportIdentity:
    index_sha256: str
    shard_sha256: Mapping[str, str]


@dataclass(frozen=True)
class FirstSeenLineage:
    raw_first_seen: str
    verified_utc: datetime | None = None
    observed_by: datetime | None = None


@dataclass(frozen=True)
class WriterProvenance:
    identity: ExportIdentity
    generated_at: datetime
    covers_after: datetime
    rows: Mapping[str, FirstSeenLineage]
    lineage: Mapping[tuple[str, str], FirstSeenLineage]


class _EvidenceUnavailable(ValueError):
    pass


def _unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise _EvidenceUnavailable("Duplicate follow capture JSON key")
    return result


def _json(raw):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    except (ValueError, RecursionError) as error:
        raise _EvidenceUnavailable("Invalid follow capture JSON") from error


def _fixed_export(out_dir):
    directory = Path(out_dir) / "listings"
    index_bytes = (directory / "index.json").read_bytes()
    index = _json(index_bytes)
    files = index.get("files") if isinstance(index, dict) else None
    if not isinstance(files, dict) or any(not _SHARD.fullmatch(k) for k in files):
        raise _EvidenceUnavailable("Invalid follow capture manifest")
    expected = {f"{k}.json" for k in files}
    actual = {
        p.name
        for p in directory.glob("*.json")
        if p.name != "index.json" and not p.name.endswith(".desc.json")
    }
    if actual != expected:
        raise _EvidenceUnavailable("Incomplete follow capture manifest")
    shards, digests, rows, signatures = {}, {}, {}, {}
    for key, entry in files.items():
        name = f"{key}.json"
        raw = (directory / name).read_bytes()
        parts = _json(raw)
        if (
            not isinstance(parts, list)
            or not isinstance(entry, dict)
            or entry.get("file") != f"listings/{name}"
            or type(entry.get("count")) is not int
            or type(entry.get("open")) is not int
            or entry["count"] != len(parts)
        ):
            raise _EvidenceUnavailable("Invalid follow capture shard")
        ids = set()
        open_count = 0
        for row in parts:
            role_id = row.get("id") if isinstance(row, dict) else None
            try:
                signature = json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False)
            except (ValueError, RecursionError) as error:
                raise _EvidenceUnavailable("Invalid follow capture row") from error
            if (
                not isinstance(role_id, str)
                or not _ID.fullmatch(role_id)
                or row.get("status") not in ("open", "closed")
                or (row.get("apply_url") is not None and not isinstance(row["apply_url"], str))
                or role_id in ids
                or (role_id in signatures and signatures[role_id] != signature)
            ):
                raise _EvidenceUnavailable("Ambiguous follow capture row")
            ids.add(role_id)
            rows[role_id] = row
            signatures[role_id] = signature
            open_count += row["status"] == "open"
        if entry["open"] != open_count:
            raise _EvidenceUnavailable("Invalid follow capture open count")
        shards[name] = raw
        digests[key] = sha256(raw).hexdigest()
    return (
        ExportIdentity(sha256(index_bytes).hexdigest(), MappingProxyType(digests)),
        shards,
        rows,
        index,
    )


def _aware(value):
    return isinstance(value, datetime) and value.utcoffset() is not None


def _parse(raw):
    if not isinstance(raw, str) or not _STAMP.fullmatch(raw) or raw.endswith("-00:00"):
        return None
    try:
        return datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


class FollowWriterCapture:
    """One opted-in writer operation. The caller attests seed time or prior lineage."""

    def __init__(
        self,
        *,
        covers_after: datetime,
        prior_identity: ExportIdentity,
        seed_observed_by: datetime | None = None,
        prior_lineage: Mapping[tuple[str, str], FirstSeenLineage] | None = None,
    ):
        if (
            not _aware(covers_after)
            or covers_after.microsecond % 1000
            or (seed_observed_by is None) == (prior_lineage is None)
            or (
                seed_observed_by is not None
                and (not _aware(seed_observed_by) or seed_observed_by > covers_after)
            )
        ):
            raise ValueError("Invalid follow capture coverage start")
        self.covers_after = covers_after.astimezone(timezone.utc)
        self._prior_identity = ExportIdentity(
            prior_identity.index_sha256, MappingProxyType(dict(prior_identity.shard_sha256))
        )
        self._seed = seed_observed_by
        self._prior = dict(prior_lineage or {})
        self._origins: dict[str, datetime] = {}
        self._selected: dict[tuple[str, str], FirstSeenLineage] = {}
        self.result: WriterProvenance | None = None

    def committed(self, origins: Mapping[str, datetime]) -> None:
        self._origins.update(origins)

    def predecessor(self, out_dir) -> Mapping[str, bytes] | None:
        """Return fixed predecessor bytes, or leave the caller on the normal export path."""
        self.result = None
        self._selected.clear()
        try:
            identity, shards, rows, index = _fixed_export(out_dir)
        except (_EvidenceUnavailable, OSError):
            return None
        if identity != self._prior_identity:
            return None
        if self._seed is not None:
            generation = _parse(index.get("generated_at"))
            if not _aware(generation) or generation > self._seed:
                return None
        self._previous_ids = set(rows)
        self._previous_urls = {r["apply_url"] for r in rows.values() if r.get("apply_url")}
        return shards

    def from_database(self, row: dict, dedupe_key: str) -> None:
        raw = row.get("first_seen")
        stamp = _parse(raw)
        origin = self._origins.get(dedupe_key)
        if (
            row["id"] not in self._previous_ids
            and row.get("apply_url") not in self._previous_urls
            and stamp is not None
            and _aware(origin)
            and stamp.replace(tzinfo=None) == origin.astimezone(timezone.utc).replace(tzinfo=None)
        ):
            self._selected[row["id"], raw] = FirstSeenLineage(raw, verified_utc=origin)

    def carried(self, row: dict, predecessor: dict) -> None:
        raw = row.get("first_seen")
        stamp = _parse(raw)
        if stamp is None or raw != predecessor.get("first_seen"):
            return
        key = (row["id"], raw)
        self._selected.pop(key, None)
        proof = self._prior.get((predecessor["id"], raw))
        if self._seed is not None:
            proof = FirstSeenLineage(raw, observed_by=self._seed)
        if not isinstance(proof, FirstSeenLineage) or proof.raw_first_seen != raw:
            return
        if proof.observed_by is not None:
            if proof.verified_utc is not None or not _aware(proof.observed_by):
                return
            if proof.observed_by > self.covers_after:
                return
        elif not _aware(proof.verified_utc) or proof.verified_utc.astimezone(timezone.utc).replace(
            tzinfo=None
        ) != stamp.replace(tzinfo=None):
            return
        self._selected[key] = proof

    def seal(self, out_dir, generated_at: str) -> None:
        self.result = None
        try:
            identity, shards, rows, index = _fixed_export(out_dir)
        except (_EvidenceUnavailable, OSError):
            return
        end = _parse(generated_at)
        if (
            index.get("generated_at") != generated_at
            or not _aware(end)
            or end.replace(microsecond=end.microsecond // 1000 * 1000) <= self.covers_after
        ):
            return
        if not shards:
            return
        evidence, lineage = {}, {}
        for role_id, row in rows.items():
            raw = row.get("first_seen")
            stamp = _parse(raw)
            proof = self._selected.get((role_id, raw)) if stamp is not None else None
            if proof is not None:
                lineage[role_id, raw] = proof
            if row["status"] == "open" and not _aware(stamp):
                if stamp is None or proof is None:
                    return
                evidence[role_id] = proof
        self.result = WriterProvenance(
            identity, end, self.covers_after, MappingProxyType(evidence), MappingProxyType(lineage)
        )
