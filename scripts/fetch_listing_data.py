"""Install a pinned public listing snapshot into an untracked docs/data directory."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import stat
import subprocess
import tarfile
import tempfile

PUBLIC = "docs/data"
BRANCH = "refs/heads/data"
TRACKING = "refs/remotes/origin/data"


def git(root, *args):
    r = subprocess.run(["git", *args], cwd=root, capture_output=True)
    if r.returncode:
        raise ValueError(f"Git {args[0]} failed")
    return r.stdout


def pin_data(root):
    git(root, "fetch", "--no-tags", "origin", f"{BRANCH}:{TRACKING}")
    return git(root, "rev-parse", "--verify", f"{TRACKING}^{{commit}}").decode("ascii").strip()


def parts_of(path):
    parts = path.split("/")
    if any(
        part in {"", ".", ".."}
        or part[-1:] in {".", " "}
        or part.casefold() == ".git"
        or PureWindowsPath(part).is_reserved()
        or any(c in part for c in '\\:<>"|?*')
        for part in parts
    ):
        raise ValueError("Unsafe snapshot path")
    return parts


def materialize(root, pin, stage):
    blobs = {}
    for record in git(root, "ls-tree", "-rz", pin, "--", PUBLIC).split(b"\0"):
        if not record:
            continue
        meta, raw = record.split(b"\t", 1)
        mode, kind, oid = meta.split()
        name = raw.decode("utf8")
        if (
            mode not in {b"100644", b"100755"}
            or kind != b"blob"
            or not name.startswith(PUBLIC + "/")
        ):
            raise ValueError("Nonregular snapshot entry")
        blobs[name] = oid
    if not blobs:
        raise ValueError("Public snapshot is missing")
    archived = git(root, "archive", "--format=tar", pin, "--", PUBLIC)
    seen, installed = set(), set()
    with tarfile.open(fileobj=io.BytesIO(archived)) as archive:
        for member in archive:
            if member.name in {"docs", PUBLIC} and member.isdir():
                continue
            if not member.name.startswith(PUBLIC + "/"):
                raise ValueError("Unexpected archive path")
            name = member.name.removeprefix(PUBLIC + "/")
            path = stage.joinpath(*parts_of(name))
            if name.casefold() in seen or not path.resolve().is_relative_to(stage.resolve()):
                raise ValueError("Aliased archive path")
            seen.add(name.casefold())
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile() or member.name not in blobs:
                raise ValueError("Unexpected archive member")
            with archive.extractfile(member) as payload:
                data = payload.read()
            oid = (
                hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data)
                .hexdigest()
                .encode("ascii")
            )
            if oid != blobs[member.name]:
                raise ValueError("Archived file differs from pinned Git blob")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            installed.add(member.name)
    if installed != blobs.keys():
        raise ValueError("Archive omitted pinned public files")


def fingerprint(root):
    if root.resolve() != root or root.is_symlink() or not root.is_dir():
        raise ValueError("Unsafe snapshot directory")
    rows = []
    pending = [root]
    while pending:
        folder = pending.pop()
        for path in folder.iterdir():
            name = path.relative_to(root).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode) and path.resolve() == path:
                pending.append(path)
                rows.append((name, "dir"))
            elif stat.S_ISREG(mode):
                rows.append((name, hashlib.sha256(path.read_bytes()).hexdigest()))
            else:
                raise ValueError("Snapshot contains a nonregular path")
    return hashlib.sha256(json.dumps(sorted(rows)).encode("utf8")).hexdigest()


def install(root, *, replace=os.replace):
    root = Path(git(root, "rev-parse", "--show-toplevel").decode("utf8").strip()).resolve()
    docs = root / "docs"
    if docs.resolve() != docs or docs.is_symlink() or not docs.is_dir():
        raise ValueError("Unsafe docs directory")
    target = docs / "data"
    if git(root, "ls-files", "--", PUBLIC) or git(root, "ls-tree", "-r", "HEAD", "--", PUBLIC):
        raise ValueError("Public data is tracked in this checkout")
    marker = Path(
        git(
            root,
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "internscout-public-snapshot.json",
        )
        .decode("utf8")
        .strip()
    )
    lock = marker.with_suffix(".lock")
    # An abrupt interruption may leave the lock and the staged backup for manual recovery.
    try:
        with lock.open("x", encoding="utf8"):
            pass
    except FileExistsError:
        raise ValueError("A public listing install is already locked in this worktree.") from None
    stage = None
    pending_marker = None
    safe_cleanup = True
    try:
        pin = pin_data(root)
        stage = Path(tempfile.mkdtemp(prefix=".listing-install-", dir=docs)).resolve()
        if stage.parent != docs:
            raise ValueError("Unsafe snapshot staging path")
        incoming, backup = stage / "incoming", stage / "previous"
        incoming.mkdir()
        materialize(root, pin, incoming)
        desired = fingerprint(incoming)
        exists = target.exists() or target.is_symlink()
        current = fingerprint(target) if exists else None
        if exists and current != desired:
            try:
                prior = json.loads(marker.read_bytes())["digest"]
            except (OSError, ValueError, TypeError, KeyError):
                prior = None
            if current != prior:
                raise ValueError("Existing public data was not installed unchanged by this helper")
        changed = current != desired
        metadata = json.dumps({"commit": pin, "digest": desired}) + "\n"
        # Preserve the old tree until the new directory and its marker are both committed.
        safe_cleanup = False
        try:
            if changed and exists:
                replace(target, backup)
                if fingerprint(backup) != current:
                    raise ValueError("Local public files changed while preparing the install.")
            if changed:
                replace(incoming, target)
            fd, name = tempfile.mkstemp(prefix="internscout-marker-", dir=marker.parent)
            pending_marker = Path(name)
            with os.fdopen(fd, "w", encoding="utf8") as output:
                output.write(metadata)
            replace(pending_marker, marker)
            safe_cleanup = True
        except (OSError, ValueError, KeyboardInterrupt):
            try:
                if pending_marker is not None and not pending_marker.exists():
                    # The interruption may have arrived immediately after the marker rename.
                    if (
                        marker.read_text(encoding="utf8") != metadata
                        or fingerprint(target) != desired
                    ):
                        raise ValueError("Could not establish whether the snapshot was installed.")
                else:
                    # Check the actual directories, even when a rename completed before raising.
                    if changed and not incoming.exists():
                        replace(target, incoming)
                    if backup.exists():
                        replace(backup, target)
                safe_cleanup = True
            except (OSError, ValueError, KeyboardInterrupt):
                raise ValueError(
                    f"Could not restore the previous snapshot. Recovery directory: {stage}"
                ) from None
            raise
        return pin
    finally:
        try:
            if pending_marker is not None:
                pending_marker.unlink(missing_ok=True)
        finally:
            lock.unlink(missing_ok=True)
        if stage is not None and safe_cleanup and stage.parent == docs and stage.resolve() == stage:
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path, nargs="?", default=Path.cwd())
    args = parser.parse_args()
    try:
        pin = install(args.checkout)
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    except (OSError, tarfile.TarError):
        parser.exit(1, "Could not fetch or install public listing data.\n")
    print(f"Installed public listing snapshot {pin}.")


if __name__ == "__main__":
    main()
