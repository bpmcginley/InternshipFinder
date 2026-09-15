"""Build the extension zip for GitHub Releases and the Chrome Web Store.

  python scripts/package_extension.py

Writes dist/internscout-extension-<manifest version>.zip with manifest.json at the zip root
(what "Load unpacked" and the Web Store expect) and prints the path as the last line.
Leaves out tests, fixtures, *.test.* files, OS junk and signing keys.
"""
from __future__ import annotations
import fnmatch
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"

SKIP_DIRS = {"test", "tests", "fixtures", "__pycache__", "node_modules", ".git"}
SKIP_FILES = ["*.test.*", ".DS_Store", "Thumbs.db", "desktop.ini", "*.pem", "*.crx", "*.zip"]


def included(rel: Path) -> bool:
    if any(part in SKIP_DIRS for part in rel.parts[:-1]):
        return False
    return not any(fnmatch.fnmatch(rel.name, pat) for pat in SKIP_FILES)


def build() -> Path:
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    DIST.mkdir(exist_ok=True)
    out = DIST / f"internscout-extension-{version}.zip"
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and included(p.relative_to(EXT)))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            zf.write(p, p.relative_to(EXT).as_posix())
    return out


if __name__ == "__main__":
    path = build()
    with zipfile.ZipFile(path) as zf:
        count = len(zf.namelist())
    print(f"{count} files, {path.stat().st_size // 1024} KB", file=sys.stderr)
    print(path)
