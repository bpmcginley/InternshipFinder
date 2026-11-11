"""Offline production-entry-point build; run with --refresh to approve a new baseline."""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import gzip
import hashlib
import io
import json
import locale
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).with_name("fixtures") / "golden"
STAMP = "2026-11-10T12:00:00+00:00"
TEXT_SUFFIXES = {".py", ".html", ".js", ".css", ".json", ".txt", ".md", ".webmanifest", ".svg"}


def copy_file(source, target):
    """Model Linux checkout bytes, independent of Windows Git autocrlf."""
    data = Path(source).read_bytes()
    if Path(source).suffix in TEXT_SUFFIXES:
        data = data.replace(b"\r\n", b"\n")
    Path(target).write_bytes(data)
    return str(target)


def prepare(work):
    work.mkdir(parents=True)
    shutil.copytree(
        REPO / "backend" / "internscout",
        work / "backend" / "internscout",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        copy_function=copy_file,
    )
    shutil.copytree(
        REPO / "docs", work / "site", ignore=shutil.ignore_patterns("data"), copy_function=copy_file
    )
    (work / "site" / "CNAME").unlink(missing_ok=True)
    (work / "scripts").mkdir()
    copy_file(REPO / "scripts" / "make_og_image.py", work / "scripts" / "make_og_image.py")
    shutil.copytree(FIXTURE / "inputs", work / "inputs", copy_function=copy_file)
    (work / "backend" / "data").mkdir()
    copy_file(
        work / "inputs" / "search-console.json",
        work / "backend" / "data" / "search_console_pages.json",
    )
    (work / "site" / "data").mkdir()
    copy_file(
        work / "inputs" / "page-content-dates.json",
        work / "site" / "data" / "page-content-dates.json",
    )


def frozen_runtime():
    """Freeze before production imports, so config defaults and secondary modules agree."""
    real_datetime, real_date = dt.datetime, dt.date
    stamp = real_datetime.fromisoformat(STAMP)

    class FrozenDateTime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            value = stamp.astimezone(tz) if tz else stamp.replace(tzinfo=None)
            return cls.fromisoformat(value.isoformat())

        @classmethod
        def utcnow(cls):
            return cls.now().replace(tzinfo=None)

        @classmethod
        def today(cls):
            return cls.now()

    class FrozenDate(real_date):
        @classmethod
        def today(cls):
            return cls(stamp.year, stamp.month, stamp.day)

    dt.datetime, dt.date = FrozenDateTime, FrozenDate
    locale.setlocale(locale.LC_ALL, "C")
    attempts = []

    def deny_network(event, args):
        if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
            attempts.append(event)
            raise AssertionError("Golden build attempted network access")

    sys.addaudithook(deny_network)
    return attempts


def stage(name, work):
    attempts = frozen_runtime()
    # No package is imported from the parent pytest process or its autouse fixtures.
    sys.path.insert(0, str(work / "backend"))
    if name == "export":
        from internscout.db import SessionLocal, init_db
        from internscout.models import Listing, SourceLink

        init_db()
        with SessionLocal() as session:
            for values in json.loads(
                (work / "inputs" / "listings.json").read_text(encoding="utf-8")
            ):
                values = dict(values)
                sources = values.pop("sources")
                for field in ("first_seen", "last_seen", "posted_at"):
                    values[field] = (
                        dt.datetime.fromisoformat(values[field]) if values[field] else None
                    )
                listing = Listing(**values)
                listing.source_links = [
                    SourceLink(
                        source=source, source_url=values["apply_url"], seen_at=dt.datetime.now()
                    )
                    for source in sources
                ]
                session.add(listing)
            session.commit()
        args = [str(work / "site" / "data")]
        module = "internscout.export_static"
    elif name == "pages":
        sys.path.insert(0, str(work))
        args = [
            "--site",
            str(work / "site"),
            str(work / "inputs" / "live-sitemap.xml"),
            str(work / "inputs" / "live-noindex.txt"),
            "--placements",
            str(work / "inputs" / "placements.json"),
            "--placements-report",
            str(work / "placements-report.json"),
        ]
        module = "scripts.make_og_image"
    elif name == "assets":
        args = [str(work / "site")]
        module = "internscout.asset_versions"
    else:
        args = [str(work / "site")]
        module = "internscout.site_links"
    sys.argv = [module, *args]
    try:
        runpy.run_module(module, run_name="__main__")
    finally:
        assert not attempts, "A production helper swallowed a denied network attempt"


def build(work):
    # Keep only OS process-launch necessities; never inherit provider credentials or config.
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"}
    }
    env.update(
        PYTHONHASHSEED="0",
        PYTHONUTF8="1",
        PYTHONDONTWRITEBYTECODE="1",
        INTERNSCOUT_DB=str(work / "fixture.sqlite"),
        INTERNSCOUT_DATA=str(work / "backend" / "data"),
        INTERNSCOUT_GEOCODE="0",
    )
    for name in ("export", "pages", "assets", "links"):
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--stage",
                name,
                "--workspace",
                str(work),
            ],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
        assert result.returncode == 0, f"{name} failed:\n{result.stdout}\n{result.stderr}"
    return {
        p.relative_to(work / "site").as_posix(): p.read_bytes()
        for p in sorted((work / "site").rglob("*"))
        if p.is_file()
    }


def manifest(files):
    return {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}


def differences(files):
    expected = json.loads((FIXTURE / "manifest.json").read_text(encoding="utf-8"))
    actual = manifest(files)
    changes = [
        name
        for name in sorted(expected.keys() | actual.keys())
        if expected.get(name) != actual.get(name)
    ]
    if not changes:
        return ""
    lines = [f"Golden output differs in {len(changes)} files:"]
    lines.extend(
        f"{'added' if name not in expected else 'removed' if name not in actual else 'changed'}: {name}"
        for name in changes
    )
    with tarfile.open(FIXTURE / "expected.tar.gz", "r:gz") as archive:
        for name in changes[:3]:
            old = archive.extractfile(name).read() if name in expected else b""
            assert not old or hashlib.sha256(old).hexdigest() == expected[name], (
                "Baseline archive/manifest mismatch"
            )
            if name.endswith("/share.png") and old and name in files:
                from PIL import Image, features

                with (
                    Image.open(io.BytesIO(old)) as baseline,
                    Image.open(io.BytesIO(files[name])) as built,
                ):
                    pixels = baseline.tobytes() == built.tobytes()
                lines.append(
                    f"{name}: bytes changed, pixel match={pixels}; "
                    f"FreeType={features.version_module('freetype2')}, "
                    f"zlib-ng={features.version_feature('zlib_ng')}"
                )
                continue
            try:
                before, after = old.decode("utf-8"), files.get(name, b"").decode("utf-8")
            except UnicodeDecodeError:
                lines.append(f"{name}: binary bytes changed")
                continue
            # Minified HTML/JSON can have huge lines: bound both lines and characters.
            diff = list(
                difflib.unified_diff(
                    before.splitlines(),
                    after.splitlines(),
                    fromfile=f"expected/{name}",
                    tofile=f"actual/{name}",
                    n=1,
                )
            )
            lines.extend(line[:400] for line in diff[:18])
    return "\n".join(lines)


def refresh(files):
    (FIXTURE / "manifest.json").write_text(
        json.dumps(manifest(files), indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    with (FIXTURE / "expected.tar.gz").open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as archive:
                for name, data in sorted(files.items()):
                    item = tarfile.TarInfo(name)
                    item.size, item.mode = len(data), 0o644
                    archive.addfile(item, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--stage", choices=["export", "pages", "assets", "links"])
    parser.add_argument("--workspace", type=Path)
    args = parser.parse_args()
    if args.stage:
        assert args.workspace
        stage(args.stage, args.workspace)
        return
    with tempfile.TemporaryDirectory(prefix="internscout-golden-") as directory:
        work = Path(directory) / "build"
        prepare(work)
        files = build(work)
        if args.refresh:
            refresh(files)
            print(f"Refreshed {len(files)} golden hashes and review archive")
        else:
            report = differences(files)
            if report:
                raise SystemExit(report)
            print(f"Golden build matched {len(files)} files")


if __name__ == "__main__":
    main()
