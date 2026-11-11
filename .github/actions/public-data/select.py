"""Select one complete public export for a reader job."""

import json
import os
from pathlib import Path, PurePosixPath
import re
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


def check_snapshot(directory: Path) -> None:
    index = directory / "listings" / "index.json"
    try:
        if not all((directory / name).is_file() for name in ROOT_FILES):
            raise ValueError
        manifest = json.loads(index.read_text(encoding="utf-8"))
        if manifest["first"]["file"] != "first.json":
            raise ValueError
        for metadata in manifest["files"].values():
            for key in ("file", "desc"):
                name = PurePosixPath(metadata[key])
                if (
                    len(name.parts) != 2
                    or name.parts[0] != "listings"
                    or name.suffix != ".json"
                    or not (directory / name).is_file()
                ):
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
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=checkout, capture_output=True, text=True
    )
    if result.returncode or result.stdout.strip() != sha:
        raise SystemExit("The public data checkout does not match the resolved snapshot.")
    directory = checkout / EXPORT
    check_snapshot(directory)
    return directory


def main() -> None:
    workspace = Path(os.environ["GITHUB_WORKSPACE"])
    if sys.argv[1] == "resolve":
        output = f"sha={resolve(workspace)}"
    else:
        output = f"directory={select(workspace, os.environ['DATA_SHA'])}"
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as target:
        target.write(output + "\n")


if __name__ == "__main__":
    main()
