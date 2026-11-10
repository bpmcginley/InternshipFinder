"""Report the first-result payload budget without launching a browser or changing exported data.

Gzip values are reproducible estimates (level 9, mtime 0), not observed CDN transfer sizes.
Text assets use LF endings to match the Linux Pages build rather than a Windows checkout.
Transfer-only seconds exclude latency, concurrency, parsing, rendering and browser priorities.
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import re
import subprocess


def payload(data: bytes, kib_per_second: float) -> dict:
    compressed = gzip.compress(data, mtime=0)
    return {"raw_bytes": len(data), "gzip_bytes": len(compressed),
            "gzip_transfer_only_seconds": round(len(compressed) / (1024 * kib_per_second), 3)}


def asset(path: Path) -> bytes:
    data = path.read_bytes()
    return data.replace(b"\r\n", b"\n") if path.suffix in {".html", ".js", ".json"} else data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--kib-per-second", type=float, default=20)
    parser.add_argument("--baseline-ref", help="Read the older first.json from this local Git ref")
    args = parser.parse_args()
    if args.kib_per_second <= 0:
        parser.error("--kib-per-second must be greater than zero")
    root = args.root
    source = (root / "backend/internscout/export_static.py").read_text(encoding="utf-8")
    preview_rows = int(re.search(r"^FIRST_SCREEN_ROWS = (\d+)$", source, re.MULTILINE).group(1))
    first = (subprocess.check_output(["git", "show", f"{args.baseline_ref}:docs/data/first.json"], cwd=root)
             if args.baseline_ref else asset(root / "docs/data/first.json"))
    rows = json.loads(first)
    current_rows = json.loads(asset(root / "docs/data/first.json"))
    candidate = json.dumps(current_rows[:preview_rows], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assets = ["index.html", "js/core.js", "js/app.js", "data/listings/index.json",
              "fonts/ibm-plex-sans-latin.woff2", "fonts/source-serif-4-latin.woff2"]
    print(json.dumps({
        "measurement": "local payload bytes; not a browser timing or field measurement",
        "data_generated_at": json.loads((root / "docs/data/listings/index.json").read_bytes())["generated_at"],
        "transfer_model_kib_per_second": args.kib_per_second,
        "assets": {name: payload(asset(root / "docs" / name), args.kib_per_second) for name in assets},
        "baseline_ref": args.baseline_ref or "working tree",
        "baseline_preview": {"rows": len(rows), **payload(first, args.kib_per_second)},
        "proposed_preview": {"rows": min(preview_rows, len(current_rows)), **payload(candidate, args.kib_per_second)},
        "note": "Existing preview is trimmed consistently; future exports keep this budget. State files still contain every result."
    }, indent=2))


if __name__ == "__main__":
    main()
