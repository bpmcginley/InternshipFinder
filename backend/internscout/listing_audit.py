"""Offline listing-quality census and bounded review sample. Never requests employer URLs.

Run from the repository root: PYTHONPATH=backend python -m internscout.listing_audit
The sample is coverage-oriented, not a statistical estimate of listing accuracy.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

from .dedupe import _canon_job

DEFAULT_FIELDS = ("swe", "finance", "mechanical", "marketing", "civil",
                  "biomedical", "publishing", "music", "theater", "clinical_research")


def read_corpus(data_dir: Path) -> tuple[list[dict], dict[str, str]]:
    """Collapse repeated state-shard appearances, preserving conflicting ID/URL variants."""
    variants = {}
    descriptions = {}
    for path in sorted((data_dir / "listings").glob("*.json")):
        if path.name == "index.json":
            continue
        content = json.loads(path.read_text(encoding="utf-8"))
        if path.name.endswith(".desc.json"):
            descriptions.update({key: value for key, value in content.items() if value})
            continue
        for row in content:
            variants.setdefault((row["id"], row.get("apply_url")), row)
    return list(variants.values()), descriptions


def audit(rows: list[dict], descriptions: dict[str, str], *,
          fields=DEFAULT_FIELDS, per_field: int = 4) -> dict:
    if not 1 <= per_field <= 20 or not 1 <= len(fields) <= 20:
        raise ValueError("Use 1–20 fields and 1–20 samples per field")
    opened = [row for row in rows if row.get("status") == "open"]
    by_id = defaultdict(list)
    by_url = defaultdict(list)
    for row in opened:
        by_id[row["id"]].append(row)
        canonical = _canon_job(row.get("apply_url"))
        if canonical:
            by_url[canonical].append(row)
    # Prefer fresh over carried for sampling only. Keep all variants in census counts.
    representatives = [min(group, key=lambda r: (
        bool(r.get("carried")), r.get("apply_url") or "")) for group in by_id.values()]
    samples = []
    selected = set()
    field_counts = Counter(tag for row in representatives for tag in row.get("field_tags", []))
    for field in fields:
        candidates = [r for r in representatives if field in r.get("field_tags", []) and r["id"] not in selected]
        candidates.sort(key=lambda r: hashlib.sha256((field + ":" + r["id"]).encode()).hexdigest())
        for row in candidates[:per_field]:
            selected.add(row["id"])
            samples.append({"sample_field": field, **{key: row.get(key) for key in (
                "id", "company_name", "title", "field_tags", "stage", "years", "regions",
                "apply_url", "ats", "term", "insights", "carried")},
                "description_available": bool(descriptions.get(row["id"])),
                "live_status": "not_checked"})
    conflicts = [{"canonical_url": url, "ids": sorted({r["id"] for r in group}),
                  "years_conflict": len({tuple(sorted(r.get("years") or [])) for r in group}) > 1}
                 for url, group in sorted(by_url.items()) if len({r["id"] for r in group}) > 1]
    return {"scope": "offline census; deterministic field-stratified coverage sample; no live status inferred",
            "open_record_variants": len(opened), "unique_open_ids": len(by_id),
            "excess_id_variants": len(opened) - len(by_id),
            "ids_with_multiple_variants": sum(len(group) > 1 for group in by_id.values()),
            "unique_ids_without_description": sum(not descriptions.get(row["id"]) for row in representatives),
            "field_counts": dict(sorted(field_counts.items())),
            "canonical_groups_with_multiple_ids": len(conflicts),
            "canonical_groups_with_years_conflict": sum(c["years_conflict"] for c in conflicts),
            "canonical_candidates": conflicts, "samples": samples}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("docs/data"))
    parser.add_argument("--fields", default=",".join(DEFAULT_FIELDS))
    parser.add_argument("--per-field", type=int, default=4)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    rows, descriptions = read_corpus(args.data)
    result = audit(rows, descriptions, fields=args.fields.split(","), per_field=args.per_field)
    stats = args.data / "stats.json"
    result["export_generated_at"] = json.loads(stats.read_text(encoding="utf-8")).get("generated_at") if stats.exists() else None
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
