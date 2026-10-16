"""Build the extension zip for GitHub Releases and the Chrome Web Store.

  python scripts/package_extension.py

Writes dist/internscout-extension-<manifest version>.zip with manifest.json at the zip root
(what "Load unpacked" and the Web Store expect) and prints the path as the last line.
Leaves out tests, fixtures, *.test.* files, OS junk and signing keys.
"""
from __future__ import annotations
import fnmatch
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"

SKIP_DIRS = {"test", "tests", "fixtures", "__pycache__", "node_modules", ".git"}
# was: SKIP_FILES = ["*.test.*", ".DS_Store", "Thumbs.db", "desktop.ini", "*.pem", "*.crx", "*.zip"]
# README.md is developer notes; it shipped inside both zips and inside the store package.
SKIP_FILES = ["*.test.*", ".DS_Store", "Thumbs.db", "desktop.ini", "*.pem", "*.crx", "*.zip", "README.md"]


LOCAL_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])[:/]")


def included(rel: Path) -> bool:
    if any(part in SKIP_DIRS for part in rel.parts[:-1]):
        return False
    return not any(fnmatch.fnmatch(rel.name, pat) for pat in SKIP_FILES)


def build(webstore: bool = False) -> Path:
    """webstore=True drops manifest "key". The key pins the extension ID for "Load unpacked" installs
    (jmjj...); the store may refuse a manifest that carries one and assigns its own ID. That ID is not
    the unpacked one: the store item was created as hpnbb... on 2026-09-22, so sign-in redirects and
    the Worker's CORS list carry both IDs (worker/wrangler.toml ALLOWED_ORIGINS)."""
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    # The dashboard bridge also matches localhost so the dashboard can be developed against the
    # unpacked folder. In a build that students install, that would let any page served from any local
    # port (another dev tool, a malicious app's local server) ask the extension for the sign-in token
    # and the resume summary, so both zips carry the real dashboard origin only.
    for cs in manifest.get("content_scripts", []):
        cs["matches"] = [m for m in cs.get("matches", []) if not LOCAL_RE.match(m)]
    assert all(cs["matches"] for cs in manifest.get("content_scripts", [])), "a content script lost every match"
    DIST.mkdir(exist_ok=True)
    out = DIST / f"internscout-extension-{version}{'-webstore' if webstore else ''}.zip"
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and included(p.relative_to(EXT)))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            rel = p.relative_to(EXT).as_posix()
            if rel == "manifest.json":
                if webstore:
                    manifest.pop("key", None)
                payload = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
            else:
                payload = p.read_bytes()
            # A fresh checkout changes filesystem mtimes. Fixed metadata makes a rebuild of the same
            # source byte-identical, so a release retry can verify an existing asset instead of replacing it.
            entry = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(entry, payload, compresslevel=9)
    return out


if __name__ == "__main__":
    store = build(webstore=True)
    path = build()
    for p in (store, path):
        with zipfile.ZipFile(p) as zf:
            count = len(zf.namelist())
        print(f"{p.name}: {count} files, {p.stat().st_size // 1024} KB", file=sys.stderr)
    print(path)   # last line: the release workflow attaches this one
