"""Build both extension packages and a deterministic source/hash record. Publishes nothing."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import package_extension


def write_record(paths: list[Path], source_commit: str, output: Path) -> dict:
    record = {
        "source_commit": source_commit,
        "assets": [{"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                    "bytes": p.stat().st_size} for p in paths],
    }
    output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8", newline="\n")
    return record


def main() -> None:
    root = package_extension.ROOT
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root).strip():
        raise SystemExit("Refusing a release record from modified tracked source; commit the candidate first.")
    tracked = set(subprocess.check_output(["git", "ls-files", "-z", "--", "extension"], cwd=root,
                                          text=True).split("\0"))
    for path in package_extension.EXT.rglob("*"):
        if path.is_file() and package_extension.included(path.relative_to(package_extension.EXT)):
            if path.relative_to(root).as_posix() not in tracked:
                raise SystemExit(f"Refusing untracked package input: {path.relative_to(root)}")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    developer = package_extension.build()
    webstore = package_extension.build(webstore=True)
    version = json.loads((package_extension.EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
    record = package_extension.DIST / f"internscout-extension-{version}-source.json"
    write_record([developer, webstore], commit, record)
    print(json.dumps({"developer": str(developer), "webstore": str(webstore), "record": str(record)}))


if __name__ == "__main__":
    main()
