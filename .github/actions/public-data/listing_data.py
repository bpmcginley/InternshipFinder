"""Select one complete public export for a reader job."""

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

DATA_REF = "refs/heads/data"
CHECKOUT = ".listing-data"
EXPORT = Path("docs/data")
ROOT_FILES = ("first.json", "majors.json", "stats.json", "seo-posting-details.json")


def resolve(workspace: Path) -> str:
    result = subprocess.run(
        ["git", "ls-remote", "--exit-code", "--refs", "origin", DATA_REF],
        cwd=workspace,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        capture_output=True,
        text=True,
    )
    if result.returncode == 2:
        return ""
    if result.returncode:
        raise SystemExit("Could not check whether the public data branch exists.")
    fields = result.stdout.split()
    if len(fields) != 2 or fields[1] != DATA_REF or not re.fullmatch(r"[0-9a-f]{40}", fields[0]):
        raise SystemExit("Unexpected response resolving the public data branch.")
    return fields[0]


def check_tree(directory: Path) -> None:
    # Reject filesystem links and special files before reading or staging the export.
    for path in (directory.parent, directory):
        if not path.is_dir() or path.is_symlink() or path.resolve() != path:
            raise ValueError
    pending = [directory]
    while pending:
        for child in pending.pop().iterdir():
            mode = child.lstat().st_mode
            if stat.S_ISDIR(mode) and child.resolve() == child:
                pending.append(child)
            elif not stat.S_ISREG(mode):
                raise ValueError


def check_snapshot(directory: Path) -> None:
    index = directory / "listings" / "index.json"
    try:
        check_tree(directory)
        if not all((directory / name).is_file() for name in ROOT_FILES):
            raise ValueError
        manifest = json.loads(index.read_text(encoding="utf-8"))
        if manifest["first"]["file"] != "first.json":
            raise ValueError
        for shard, metadata in manifest["files"].items():
            if not shard or any(separator in shard for separator in ("/", "\\", ":")):
                raise ValueError
            for field, suffix in (("file", ".json"), ("desc", ".desc.json")):
                name = f"listings/{shard}{suffix}"
                if metadata[field] != name or not (directory / name).is_file():
                    raise ValueError
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise SystemExit("The public data branch does not contain a complete listing export.") from None


def select(workspace: Path, sha: str) -> Path:
    if not sha:
        directory = workspace / EXPORT
        if not directory.is_dir():
            raise SystemExit("The public data branch is absent and the primary export is missing.")
        return directory
    checkout = workspace / CHECKOUT
    if not checkout.is_dir() or checkout.is_symlink() or checkout.resolve() != checkout:
        raise SystemExit("The resolved public data snapshot was not checked out.")
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel", "HEAD"],
        cwd=checkout,
        capture_output=True,
        text=True,
    )
    lines = result.stdout.splitlines()
    if (
        result.returncode
        or len(lines) != 2
        or Path(lines[0]).resolve() != checkout
        or lines[1] != sha
    ):
        raise SystemExit("The public data checkout does not match the resolved snapshot.")
    directory = checkout / EXPORT
    check_snapshot(directory)
    return directory


def main() -> None:
    workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    if sys.argv[1] == "resolve":
        output = f"sha={resolve(workspace)}"
    else:
        output = f"directory={select(workspace, os.environ['DATA_SHA'])}"
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as target:
        target.write(output + "\n")


if __name__ == "__main__":
    main()
