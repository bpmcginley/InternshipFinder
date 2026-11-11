"""Prepare and reverify one private, pre-push follow checkpoint generation."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from hashlib import sha256
import os
from pathlib import Path
from types import MappingProxyType

from internscout.follow_snapshot_source import _DIGEST, _SHARD, _read, _utc
from internscout.follow_writer_provenance import ExportIdentity, WriterProvenance
from scripts.follow_lineage_checkpoint import (
    _GIT_ID,
    AcceptedFollowSource,
    _check_bounds,
    _check_lineage,
    _coverage,
    _decode_lineage,
    _encode_lineage,
    _instant,
    _json,
    _reject,
    _source_rows,
    _wire,
)
from scripts.ingest_data_writer import PUBLIC, _StagedFollowProvenance, git, owned

_FIELDS = {
    "version",
    "predecessor",
    "candidate_commit",
    "candidate_tree",
    "public_tree",
    "prepared_at",
    "covers_after",
    "index_sha256",
    "shard_sha256",
    "rows",
}
_LIFETIME = timedelta(hours=24)


@dataclass(frozen=True)
class PendingFollowPredecessor:
    commit: str
    public_tree: str
    # None represents separately attested absence for an approved forward seed.
    checkpoint_sha256: str | None


@dataclass(frozen=True)
class PendingFollowCheckpoint:
    generation: str
    predecessor: PendingFollowPredecessor
    candidate_commit: str
    candidate_tree: str
    public_tree: str
    prepared_at: datetime
    provenance: WriterProvenance


def _git_id(value):
    return isinstance(value, str) and bool(_GIT_ID.fullmatch(value))


def _digest(value):
    return isinstance(value, str) and bool(_DIGEST.fullmatch(value))


def _check_predecessor(predecessor):
    if (
        not isinstance(predecessor, PendingFollowPredecessor)
        or not _git_id(predecessor.commit)
        or not _git_id(predecessor.public_tree)
        or len(predecessor.commit) != len(predecessor.public_tree)
        or (
            predecessor.checkpoint_sha256 is not None and not _digest(predecessor.checkpoint_sha256)
        )
    ):
        raise _reject("invalid expected predecessor")


def _raw_git(checkout, *args):
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env.update(
        GIT_ALLOW_PROTOCOL="",
        GIT_CEILING_DIRECTORIES=str(Path(checkout).resolve().parent),
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_NO_LAZY_FETCH="1",
    )
    return git(checkout, *args, no_replace=True, env=env).stdout


def _revision(checkout, ref):
    return _raw_git(checkout, "rev-parse", "--verify", ref).decode("ascii").strip()


def _object_size(checkout, ref):
    return int(_raw_git(checkout, "cat-file", "-s", ref))


def _candidate_source(checkout, candidate, predecessor, identity, bounds):
    if not (Path(checkout) / ".git").exists():
        raise _reject("candidate requires an explicit Git checkout")
    if (
        not _git_id(candidate)
        or len(candidate) != len(predecessor.commit)
        or not _digest(identity.index_sha256)
        or not isinstance(identity.shard_sha256, Mapping)
        or not identity.shard_sha256
        or any(
            not isinstance(key, str) or not _SHARD.fullmatch(key) or not _digest(digest)
            for key, digest in identity.shard_sha256.items()
        )
    ):
        raise _reject("malformed pending source identity")
    if any(
        _raw_git(checkout, "cat-file", "-t", commit).strip() != b"commit"
        for commit in (candidate, predecessor.commit)
    ):
        raise _reject("pending commit identity must name a commit object")
    if _object_size(checkout, candidate) > bounds.max_source_bytes:
        raise _reject("candidate commit byte bound")
    raw = _raw_git(checkout, "cat-file", "commit", candidate)
    headers = raw.split(b"\n\n", 1)[0].splitlines()
    parents = [line[7:] for line in headers if line.startswith(b"parent ")]
    trees = [line[5:] for line in headers if line.startswith(b"tree ")]
    if parents != [predecessor.commit.encode("ascii")] or len(trees) != 1:
        raise _reject("candidate must have exact raw predecessor")
    tree = _revision(checkout, f"{candidate}^{{tree}}")
    prior_tree = _revision(checkout, f"{predecessor.commit}^{{tree}}")
    prior_public = _revision(checkout, f"{predecessor.commit}:{PUBLIC}")
    if (
        trees[0] != tree.encode("ascii")
        or tree == prior_tree
        or prior_public != predecessor.public_tree
    ):
        raise _reject("candidate tree, no-op or predecessor public tree")
    changed = _raw_git(
        checkout,
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-only",
        "-z",
        "--ignore-submodules=none",
        "--no-ext-diff",
        "--no-renames",
        "--no-relative",
        "--no-textconv",
        predecessor.commit,
        candidate,
        "--",
    )
    if any(not owned(path.decode("utf-8")) for path in changed.split(b"\0")[:-1]):
        raise _reject("candidate changed a path outside the owned snapshot")

    public_tree = _revision(checkout, f"{candidate}:{PUBLIC}")
    listing_tree = _revision(checkout, f"{candidate}:{PUBLIC}/listings")
    if _object_size(checkout, listing_tree) > bounds.max_source_bytes:
        raise _reject("pending listing tree byte bound")
    expected = {"index.json", *(f"{key}.json" for key in identity.shard_sha256)}
    actual = set()
    for entry in _raw_git(checkout, "ls-tree", "-z", listing_tree).split(b"\0")[:-1]:
        meta, _, name = entry.partition(b"\t")
        mode, kind, _ = meta.split()
        filename = name.decode("utf-8")
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise _reject("invalid candidate listing object")
        if not filename.endswith(".desc.json"):
            actual.add(filename)
    if actual != expected:
        raise _reject("incomplete candidate listing paths")
    remaining = bounds.max_source_bytes

    def blob(path):
        nonlocal remaining
        ref = f"{candidate}:{PUBLIC}/{path}"
        remaining -= _object_size(checkout, ref)
        if remaining < 0:
            raise _reject("pending source byte bound")
        return _raw_git(checkout, "cat-file", "blob", ref)

    index = blob("listings/index.json")
    shards = {f"listings/{key}.json": blob(f"listings/{key}.json") for key in identity.shard_sha256}
    return tree, AcceptedFollowSource(candidate, public_tree, index, MappingProxyType(shards))


def prepare_pending_follow_checkpoint(
    checkout, *, candidate, staged, provenance, predecessor, prepared_at, bounds
) -> bytes:
    """Encode the trusted writer's full lineage after candidate commit and before push."""
    _check_bounds(bounds)
    _check_predecessor(predecessor)
    if (
        not isinstance(staged, _StagedFollowProvenance)
        or not isinstance(provenance, WriterProvenance)
        or not isinstance(provenance.lineage, Mapping)
        or len(provenance.lineage) > bounds.max_rows
    ):
        raise _reject("missing or oversized staged proof")
    identity = ExportIdentity(staged.index_sha256, staged.shard_sha256)
    tree, source = _candidate_source(checkout, candidate, predecessor, identity, bounds)
    if (
        tree != staged.candidate_tree
        or source.index_bytes != staged.index_bytes
        or source.shards != staged.shards
        or provenance.identity != identity
        or provenance.generated_at != staged.generated_at
        or provenance.covers_after != staged.covers_after
        or provenance.rows != staged._rows
    ):
        raise _reject("writer proof differs from committed candidate")
    generated, rows = _source_rows(source, identity, bounds)
    prepared, lower = _utc(prepared_at), _utc(staged.covers_after)
    if generated != _utc(staged.generated_at):
        raise _reject("source generation differs from staged proof")
    _coverage(prepared, lower, generated)
    open_rows, _ = _check_lineage(provenance.lineage, rows, lower, generated)
    if open_rows != staged._rows:
        raise _reject("full lineage differs from staged open evidence")
    header = {
        "version": 1,
        "predecessor": asdict(predecessor),
        "candidate_commit": candidate,
        "candidate_tree": tree,
        "public_tree": source.public_tree,
        "prepared_at": _wire(prepared),
        "covers_after": _wire(lower),
        "index_sha256": identity.index_sha256,
        "shard_sha256": dict(identity.shard_sha256),
    }
    return _encode_lineage(header, provenance.lineage, bounds.max_bytes)


def read_pending_follow_checkpoint(
    checkout, raw, *, predecessor, now, bounds
) -> PendingFollowCheckpoint:
    """Decode a live candidate against the caller's independently trusted predecessor."""
    _check_bounds(bounds)
    _check_predecessor(predecessor)
    if not isinstance(raw, bytes) or not 0 < len(raw) <= bounds.max_bytes:
        raise _reject("pending checkpoint byte bound")
    record = _read(raw)
    if (
        not isinstance(record, dict)
        or record.keys() != _FIELDS
        or type(record["version"]) is not int
        or record["version"] != 1
        or record["predecessor"] != asdict(predecessor)
        or not isinstance(record["shard_sha256"], dict)
        or not isinstance(record["rows"], list)
        or len(record["rows"]) > bounds.max_rows
        or _json(record) != raw
    ):
        raise _reject("malformed, oversized or stale pending checkpoint")
    prepared = _instant(record["prepared_at"])
    if not timedelta(0) <= _utc(now) - prepared < _LIFETIME:
        raise _reject("pending checkpoint outside its lifetime")
    lower = _instant(record["covers_after"])
    lineage = _decode_lineage(record["rows"])
    identity = ExportIdentity(record["index_sha256"], MappingProxyType(record["shard_sha256"]))
    candidate = record["candidate_commit"]
    tree, source = _candidate_source(checkout, candidate, predecessor, identity, bounds)
    if tree != record["candidate_tree"] or source.public_tree != record["public_tree"]:
        raise _reject("pending tree mismatch")
    generated, rows = _source_rows(source, identity, bounds)
    _coverage(prepared, lower, generated)
    open_rows, _ = _check_lineage(lineage, rows, lower, generated)
    return PendingFollowCheckpoint(
        sha256(raw).hexdigest(),
        predecessor,
        candidate,
        tree,
        source.public_tree,
        prepared,
        WriterProvenance(
            identity, generated, lower, MappingProxyType(open_rows), MappingProxyType(lineage)
        ),
    )
