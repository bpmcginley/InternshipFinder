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


def build(webstore: bool = False) -> Path:
    """webstore=True drops manifest "key". The key pins the extension ID for "Load unpacked" installs
    (so sign-in redirects and the Worker's CORS pin match the store ID); the store assigns that ID
    itself and may refuse a manifest that carries one."""
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    DIST.mkdir(exist_ok=True)
    out = DIST / f"internscout-extension-{version}{'-webstore' if webstore else ''}.zip"
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and included(p.relative_to(EXT)))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            rel = p.relative_to(EXT).as_posix()
            if webstore and rel == "manifest.json":
                manifest.pop("key", None)
                zf.writestr(rel, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
            else:
                zf.write(p, rel)
    return out


if __name__ == "__main__":
    store = build(webstore=True)
    path = build()
    for p in (store, path):
        with zipfile.ZipFile(p) as zf:
            count = len(zf.namelist())
        print(f"{p.name}: {count} files, {p.stat().st_size // 1024} KB", file=sys.stderr)
    print(path)   # last line: the release workflow attaches this one
