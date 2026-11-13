"""Canonical accepted follow lineage checkpoint. No storage, Git or network I/O."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from types import MappingProxyType

from internscout.follow_snapshot_source import (
    _DIGEST,
    _LISTING_ID,
    _MAX_SAFE_INTEGER,
    _SHARD,
    _collect_rows,
    _parse_time,
    _read,
    _utc,
)
from internscout.follow_writer_provenance import ExportIdentity, FirstSeenLineage, WriterProvenance
from scripts.follow_archive_from_publication import _GIT_ID
from scripts.ingest_data_writer import _PublishedFollowProvenance, _StagedFollowProvenance

_FIELDS = {
    "version",
    "accepted_commit",
    "public_tree",
    "accepted_at",
    "covers_after",
    "index_sha256",
    "shard_sha256",
    "rows",
}
_LIFETIME = timedelta(days=7)


@dataclass(frozen=True)
class FollowCheckpointBounds:
    max_bytes: int
    max_rows: int
    max_source_bytes: int
    max_source_rows: int


@dataclass(frozen=True)
class AcceptedFollowSource:
    """The next runner's independently verified immutable predecessor."""

    commit: str
    public_tree: str
    index_bytes: bytes
    shards: Mapping[str, bytes]


@dataclass(frozen=True)
class FollowCheckpoint:
    accepted_at: datetime
    covers_after: datetime
    identity: ExportIdentity
    lineage: Mapping[tuple[str, str], FirstSeenLineage]
    by_listing_url: Mapping[tuple[str, str], FirstSeenLineage]


def _reject(reason):
    return ValueError(f"Invalid follow checkpoint: {reason}")


def _wire(value):
    return _utc(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _instant(raw):
    value = _utc(_parse_time(raw))
    if _wire(value) != raw:
        raise _reject("noncanonical UTC instant")
    return value


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _check_bounds(bounds):
    if not isinstance(bounds, FollowCheckpointBounds) or any(
        type(limit) is not int or not 0 < limit <= _MAX_SAFE_INTEGER
        for limit in (
            bounds.max_bytes,
            bounds.max_rows,
            bounds.max_source_bytes,
            bounds.max_source_rows,
        )
    ):
        raise _reject("explicit bounds required")


def _source_rows(source, identity, bounds):
    if (
        not isinstance(source, AcceptedFollowSource)
        or any(
            not isinstance(key, str) or not _GIT_ID.fullmatch(key)
            for key in (source.commit, source.public_tree)
        )
        or len(source.commit) != len(source.public_tree)
        or not isinstance(source.index_bytes, bytes)
        or not isinstance(source.shards, Mapping)
        or not isinstance(identity, ExportIdentity)
        or not isinstance(identity.index_sha256, str)
        or not _DIGEST.fullmatch(identity.index_sha256)
        or not isinstance(identity.shard_sha256, Mapping)
        or not identity.shard_sha256
        or any(
            not isinstance(key, str)
            or not _SHARD.fullmatch(key)
            or not isinstance(digest, str)
            or not _DIGEST.fullmatch(digest)
            for key, digest in identity.shard_sha256.items()
        )
    ):
        raise _reject("malformed source identity")
    expected = {f"listings/{key}.json": digest for key, digest in identity.shard_sha256.items()}
    if source.shards.keys() != expected.keys():
        raise _reject("incomplete source shard set")
    size = len(source.index_bytes)
    for blob in source.shards.values():
        if not isinstance(blob, bytes):
            raise _reject("invalid source shard bytes")
        size += len(blob)
        if size > bounds.max_source_bytes:
            raise _reject("source byte bound")
    if sha256(source.index_bytes).hexdigest() != identity.index_sha256 or any(
        sha256(source.shards[path]).hexdigest() != digest for path, digest in expected.items()
    ):
        raise _reject("source digest mismatch")
    index = _read(source.index_bytes)
    files = index.get("files") if isinstance(index, dict) else None
    if not isinstance(files, dict) or files.keys() != identity.shard_sha256.keys():
        raise _reject("incomplete source index")
    return _utc(_parse_time(index.get("generated_at"))), _collect_rows(
        files, source.shards, bounds.max_source_rows
    )


def _coverage(accepted, lower, generated):
    completed = generated.replace(microsecond=generated.microsecond // 1000 * 1000)
    if accepted < generated or lower.microsecond % 1000 or lower >= completed:
        raise _reject("invalid acceptance or coverage time")


def _check_lineage(lineage, rows, lower, generated):
    by_url = {}
    associations = {}
    naive_open = {}
    for role_id, row in rows.items():
        raw = row.get("first_seen")
        url = row.get("apply_url")
        if not isinstance(url, str) or not url or not isinstance(raw, str):
            raise _reject("missing raw listing association")
        if by_url.setdefault(url, raw) != raw:
            raise _reject("contradictory raw URL association")
        stamp = _parse_time(raw)
        if stamp.utcoffset() is not None and _utc(stamp) > generated:
            raise _reject("first-seen time after source generation")
        proof = lineage.get((role_id, raw))
        if row["status"] == "open" and stamp.utcoffset() is None:
            if proof is None:
                raise _reject("missing naive open lineage")
            naive_open[role_id] = proof
        if proof is None:
            continue
        if not isinstance(proof, FirstSeenLineage) or proof.raw_first_seen != raw:
            raise _reject("mismatched raw lineage")
        if (proof.verified_utc is None) == (proof.observed_by is None):
            raise _reject("ambiguous evidence kind")
        if proof.observed_by is not None:
            upper = _utc(proof.observed_by)
            if upper > lower or (stamp.utcoffset() is not None and _utc(stamp) > upper):
                raise _reject("unproven prior observation")
        else:
            verified = _utc(proof.verified_utc)
            expected = verified.replace(tzinfo=None) if stamp.utcoffset() is None else verified
            if expected != stamp or verified > generated:
                raise _reject("mismatched verified UTC origin")
        associations[(role_id, url)] = proof
    if len(associations) != len(lineage):
        raise _reject("lineage does not match exact accepted rows")
    return naive_open, associations


def encode_accepted_follow_checkpoint(receipt, provenance, *, accepted_at, bounds) -> bytes:
    """Bind the trusted caller's original full lineage to an accepted writer receipt."""

    _check_bounds(bounds)
    if (
        not isinstance(receipt, _PublishedFollowProvenance)
        or not isinstance(receipt.staged, _StagedFollowProvenance)
        or not isinstance(provenance, WriterProvenance)
        or not isinstance(provenance.lineage, Mapping)
        or len(provenance.lineage) > bounds.max_rows
    ):
        raise _reject("missing or oversized accepted proof")
    staged = receipt.staged
    if (
        not isinstance(staged.candidate_tree, str)
        or not _GIT_ID.fullmatch(staged.candidate_tree)
        or not isinstance(receipt.commit, str)
        or len(staged.candidate_tree) != len(receipt.commit)
    ):
        raise _reject("malformed candidate tree identity")
    identity = ExportIdentity(staged.index_sha256, staged.shard_sha256)
    if (
        provenance.identity != identity
        or provenance.generated_at != staged.generated_at
        or provenance.covers_after != staged.covers_after
        or provenance.rows != staged._rows
    ):
        raise _reject("writer proof differs from accepted receipt")
    source = AcceptedFollowSource(
        receipt.commit, receipt.public_tree, staged.index_bytes, staged.shards
    )
    generated, rows = _source_rows(source, identity, bounds)
    lower, accepted = _utc(staged.covers_after), _utc(accepted_at)
    if _utc(staged.generated_at) != generated:
        raise _reject("source generation differs from receipt")
    _coverage(accepted, lower, generated)
    naive_open, _ = _check_lineage(provenance.lineage, rows, lower, generated)
    if naive_open != staged._rows:
        raise _reject("full lineage differs from accepted open evidence")

    header = {
        "version": 1,
        "accepted_commit": source.commit,
        "public_tree": source.public_tree,
        "accepted_at": _wire(accepted),
        "covers_after": _wire(lower),
        "index_sha256": identity.index_sha256,
        "shard_sha256": dict(identity.shard_sha256),
    }
    return _encode_lineage(header, provenance.lineage, bounds.max_bytes)


def _encode_lineage(header, lineage, max_bytes):
    tuples = header["rows"] = []
    size = len(_json(header))
    for (role_id, raw), proof in sorted(lineage.items()):
        kind = "observed_by" if proof.observed_by is not None else "verified_utc"
        record = [role_id, raw, kind, _wire(getattr(proof, kind))]
        size += len(_json(record)) + bool(tuples)
        if size > max_bytes:
            raise _reject("checkpoint byte bound")
        tuples.append(record)
    if size > max_bytes:
        raise _reject("checkpoint byte bound")
    return _json(header)


def decode_accepted_follow_checkpoint(raw, source, *, now, bounds) -> FollowCheckpoint:
    """Reconstruct exact predecessor keys from trusted accepted bytes and a live record."""

    _check_bounds(bounds)
    if not isinstance(raw, bytes) or not 0 < len(raw) <= bounds.max_bytes:
        raise _reject("checkpoint byte bound")
    record = _read(raw)
    if (
        not isinstance(record, dict)
        or record.keys() != _FIELDS
        or type(record["version"]) is not int
        or record["version"] != 1
        or not isinstance(source, AcceptedFollowSource)
        or record["accepted_commit"] != source.commit
        or record["public_tree"] != source.public_tree
        or not isinstance(record["rows"], list)
        or len(record["rows"]) > bounds.max_rows
        or _json(record) != raw
    ):
        raise _reject("malformed, oversized or mismatched checkpoint")
    accepted, lower, observed = (
        _instant(record["accepted_at"]),
        _instant(record["covers_after"]),
        _utc(now),
    )
    if not timedelta(0) <= observed - accepted < _LIFETIME:
        raise _reject("checkpoint outside its accepted lifetime")
    if not isinstance(record["shard_sha256"], dict):
        raise _reject("malformed shard identity")
    identity = ExportIdentity(record["index_sha256"], MappingProxyType(record["shard_sha256"]))
    generated, rows = _source_rows(source, identity, bounds)
    _coverage(accepted, lower, generated)

    lineage = _decode_lineage(record["rows"])
    _, associations = _check_lineage(lineage, rows, lower, generated)
    return FollowCheckpoint(
        accepted, lower, identity, MappingProxyType(lineage), MappingProxyType(associations)
    )


def _decode_lineage(tuples):
    lineage = {}
    previous = ""
    for item in tuples:
        if not isinstance(item, list) or len(item) != 4:
            raise _reject("malformed evidence tuple")
        role_id, stamp, kind, at = item
        if (
            not isinstance(role_id, str)
            or not _LISTING_ID.fullmatch(role_id)
            or role_id <= previous
            or not isinstance(stamp, str)
            or kind not in ("observed_by", "verified_utc")
        ):
            raise _reject("invalid or duplicate evidence tuple")
        previous = role_id
        lineage[(role_id, stamp)] = FirstSeenLineage(stamp, **{kind: _instant(at)})
    return lineage
