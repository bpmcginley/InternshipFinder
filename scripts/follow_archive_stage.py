"""Stage a validated public Follow archive in a fresh, private generation only."""

from __future__ import annotations

import os
import re
import stat
import tempfile
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from types import MappingProxyType

from internscout.follow_snapshot_archive import (
    INDEX,
    FollowArchiveBounds,
    FollowArchivePlan,
    _check_bounds,
    validate_follow_archive_transition,
)

_PATH = re.compile(r"data/follows/(?:index|[a-f0-9]{64})\.json")
_DIGEST = re.compile(r"[a-f0-9]{64}")


@dataclass(frozen=True)
class ArchiveFileReceipt:
    path: str
    sha256: str
    size: int


@dataclass(frozen=True)
class StagedFollowArchive:
    directory: Path
    base_index_sha256: str | None
    index_sha256: str
    files: tuple[ArchiveFileReceipt, ...]


def _capture(files, bounds):
    if type(files) not in (dict, MappingProxyType) or len(files) > bounds.max_entries + 1:
        raise ValueError("archive input count/type")
    captured, total = {}, 0
    for number, (name, raw) in enumerate(files.items(), 1):
        if (
            number > bounds.max_entries + 1
            or type(name) is not str
            or not _PATH.fullmatch(name)
            or name in captured
            or type(raw) is not bytes
        ):
            raise ValueError("archive input shape")
        total += len(raw)
        if total > bounds.max_archive_bytes:
            raise ValueError("archive input byte bound")
        captured[name] = raw
    if len(captured) != len(files):
        raise ValueError("archive input changed")
    return MappingProxyType(captured)


def _regular(info):
    return not (
        stat.S_ISLNK(info.st_mode)
        or getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _directory(path):
    info = path.lstat()
    if not _regular(info) or not stat.S_ISDIR(info.st_mode):
        raise ValueError("private directory must be real")
    return info.st_dev, info.st_ino


def _parent(value):
    if not isinstance(value, (str, Path)) or not value:
        raise ValueError("explicit private parent required")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("absolute private parent required")
    for ancestor in (*reversed(path.parents), path):
        _directory(ancestor)
    if path.resolve(strict=True) != path:
        raise ValueError("private parent alias")
    return path


def _write(path, raw):
    flags = os.O_CREAT | os.O_EXCL | os.O_RDWR
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w+b") as stream:
        info = os.fstat(stream.fileno())
        if not _regular(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("exclusive regular output required")
        if stream.write(raw) != len(raw):
            raise OSError("incomplete archive write")
        stream.flush()
        os.fsync(stream.fileno())
        stream.seek(0)
        if stream.read(len(raw) + 1) != raw:
            raise OSError("archive readback mismatch")
        final = path.lstat()
        if (
            not _regular(final)
            or not stat.S_ISREG(final.st_mode)
            or final.st_nlink != 1
            or (final.st_dev, final.st_ino) != (info.st_dev, info.st_ino)
        ):
            raise ValueError("archive output changed")


def _verify(path, raw):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    # O_NONBLOCK prevents a replaced special file from blocking before fstat.
    flags |= getattr(os, "O_NONBLOCK", 0)
    before = path.lstat()
    if not _regular(before) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ValueError("regular archive readback required")
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not _regular(info)
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_size != len(raw)
            or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino)
            or stream.read(len(raw) + 1) != raw
        ):
            raise ValueError("archive final readback mismatch")
        after = path.lstat()
        if not _regular(after) or (after.st_dev, after.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("archive final path changed")


def stage_follow_archive(
    current,
    plan: FollowArchivePlan,
    *,
    parent: Path | str,
    now: datetime,
    bounds: FollowArchiveBounds,
) -> StagedFollowArchive:
    """Return verified output, never publish it or replace an existing archive.

    The caller exclusively owns the real parent throughout this operation and later
    artifact assembly. Prior acquisition and accepted-operation authority are upstream.
    """
    _check_bounds(bounds)
    if type(plan) is not FollowArchivePlan or (
        plan.base_index_sha256 is not None
        and (
            type(plan.base_index_sha256) is not str or not _DIGEST.fullmatch(plan.base_index_sha256)
        )
    ):
        raise ValueError("typed archive plan required")
    prior = _capture(current, bounds)
    proposed = FollowArchivePlan(plan.base_index_sha256, _capture(plan.files, bounds))
    validate_follow_archive_transition(prior, proposed, now=now, bounds=bounds)
    if INDEX not in proposed.files:
        raise ValueError("completed archive manifest required")
    private = _parent(parent)
    identities = {private: _directory(private)}
    root = Path(tempfile.mkdtemp(prefix="follow-archive-", dir=private))
    # mkdtemp is exclusive; the generation is never reused, renamed or made public.
    paths = tuple(root / name for name in sorted(proposed.files))
    directories = (root, root / "data", root / "data" / "follows")
    try:
        if root.parent != private or root.resolve(strict=True) != root:
            raise ValueError("private generation escaped parent")
        identities[root] = _directory(root)
        for directory in directories[1:]:
            directory.mkdir(mode=0o700)
            identities[directory] = _directory(directory)
        for path in paths:
            if any(_directory(p) != identity for p, identity in identities.items()):
                raise ValueError("private directory changed")
            _write(path, proposed.files[path.relative_to(root).as_posix()])
        if any(_directory(p) != identity for p, identity in identities.items()):
            raise ValueError("private directory changed")
        for path in paths:
            _verify(path, proposed.files[path.relative_to(root).as_posix()])
        inventories = {
            root: {root / "data"},
            root / "data": {root / "data" / "follows"},
            root / "data" / "follows": set(paths),
        }
        for directory, expected in inventories.items():
            if _directory(directory) != identities[directory]:
                raise ValueError("private directory changed")
            # Do not materialize an unbounded directory listing on ownership failure.
            found = set()
            with os.scandir(directory) as entries:
                for item in entries:
                    child = directory / item.name
                    if child not in expected or child in found:
                        raise ValueError("unexpected archive output")
                    found.add(child)
            if found != expected:
                raise ValueError("missing archive output")
        if _directory(private) != identities[private]:
            raise ValueError("private parent changed")
        receipts = tuple(
            ArchiveFileReceipt(name, sha256(raw).hexdigest(), len(raw))
            for name, raw in sorted(proposed.files.items())
        )
        return StagedFollowArchive(
            root, proposed.base_index_sha256, sha256(proposed.files[INDEX]).hexdigest(), receipts
        )
    except BaseException:
        # No recursive deletion, traversal or touching prior/current output. On a
        # violated ownership precondition leave an unusable private orphan instead.
        if root in identities and all(
            _unchanged(p, identity) for p, identity in identities.items()
        ):
            for path in paths:
                try:
                    if not stat.S_ISDIR(path.lstat().st_mode):
                        path.unlink()
                except OSError:
                    pass
            for directory in reversed(directories):
                try:
                    directory.rmdir()
                except OSError:
                    pass
        raise


def _unchanged(path, identity):
    try:
        return _directory(path) == identity
    except (OSError, ValueError):
        return False
