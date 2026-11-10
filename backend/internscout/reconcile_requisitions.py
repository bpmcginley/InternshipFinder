"""Offline, open-record-only correction of proven duplicate ATS destinations.

Dry run: python -m internscout.reconcile_requisitions ../docs/data
Write: add --write --expected-generated-at <stats.json generated_at>.
No source requests, new facts, timestamp refreshes or closed-record changes.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

from .dedupe import posting_key, recognized_greenhouse_tenants, recognized_icims_hosts
from .export_static import _dump, shard_keys, write_first_screen
from .sources import BOARD_FETCHERS


def reconcile(data: Path, *, write=False, expected_generated_at=None) -> dict:
    stats_path = data / "stats.json"
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    if write and expected_generated_at != stats.get("generated_at"):
        raise ValueError("Write requires the exact existing generated_at; inspect a dry run first")
    index_path = data / "listings/index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("generated_at") != stats.get("generated_at"):
        raise ValueError("The listing index and stats do not describe the same export")
    rows, shards, sidecars, descriptions = {}, {}, {}, {}
    for path in sorted((data / "listings").glob("*.json")):
        if path.name == "index.json":
            continue
        content = json.loads(path.read_text(encoding="utf-8"))
        if path.name.endswith(".desc.json"):
            sidecars[path] = content
            for identity, description in content.items():
                if identity in descriptions and descriptions[identity] != description:
                    raise ValueError("Conflicting descriptions for one listing ID")
                descriptions[identity] = description
            continue
        if not isinstance(content, list):
            raise ValueError("Expected a listing array")
        shards[path] = content
        for row in content:
            identity = row["id"]
            if identity in rows and rows[identity] != row:
                raise ValueError("Conflicting shard variants for one listing ID")
            rows[identity] = row
    if len(rows) != stats.get("total") or sum(x.get("status") == "open" for x in rows.values()) != stats.get("open"):
        raise ValueError("The export totals do not match its unique ID corpus")
    opened = [row for row in rows.values() if row.get("status") == "open"]
    icims = recognized_icims_hosts(opened)
    gh = recognized_greenhouse_tenants(opened)
    groups = defaultdict(list)
    for row in opened:
        key = posting_key(row, icims_hosts=icims, gh_tenants=gh)
        if key:
            groups[key].append(row)

    def preference(row):
        # 2026-10-24: use retained source authority/freshness, never guess employer identity.
        # was: no offline reconciliation. Revert: restore removed rows from this PR's parent.
        authority = (row.get("score_parts") or {}).get("source") or 0
        scanned = bool(set(row.get("scan_sources") or []) & set(BOARD_FETCHERS))
        return (authority, scanned, not row.get("carried"), row.get("last_seen") or "",
                row.get("posted_at") or "", len(descriptions.get(row["id"], "")),
                (row.get("company_name") or "").casefold(), row["id"])

    removed, changes = set(), []
    for key, group in sorted(groups.items()):
        if len(group) < 2:
            continue
        winner = max(group, key=preference)
        losers = [row for row in group if row["id"] != winner["id"]]
        removed.update(row["id"] for row in losers)
        changes.append({"identity": list(key), "retained": winner["id"],
                        "removed": sorted(row["id"] for row in losers)})
    kept = [row for identity, row in rows.items() if identity not in removed]
    report = {"generated_at": stats["generated_at"], "before_total": len(rows), "before_open": len(opened),
              "after_total": len(kept), "after_open": len(opened) - len(removed),
              "closed_unchanged": sum(row.get("status") == "closed" for row in kept),
              "duplicate_groups_removed": len(changes), "removed_ids": sorted(removed), "changes": changes}
    if not write or not removed:
        return report

    for path, content in shards.items():
        filtered = [row for row in content if row["id"] not in removed]
        if len(filtered) != len(content):
            _dump(filtered, str(path))
        key = path.stem
        live = [row for row in filtered if row.get("status") == "open"]
        entry = index["files"][key]
        entry.update(count=len(filtered), open=len(live),
            by_field=dict(Counter(tag for row in live for tag in row.get("field_tags", [])).most_common()),
            by_stage=dict(Counter(tag for row in live for tag in row.get("stage", [])).most_common()),
            by_sector=dict(Counter(row["sector"] for row in live if row.get("sector")).most_common()))
    for path, content in sidecars.items():
        filtered = {identity: value for identity, value in content.items() if identity not in removed}
        if len(filtered) != len(content):
            _dump(filtered, str(path))
    stats.update(total=len(kept), open=report["after_open"], new=sum(bool(row.get("is_new")) for row in kept),
        held=sum(bool(row.get("carried")) for row in kept),
        by_state=dict(Counter(key for row in kept if row.get("status") == "open" for key in shard_keys(row)).most_common()),
        by_ats=dict(Counter(row.get("ats") for row in kept if row.get("status") == "open").most_common()),
        by_field=dict(Counter(tag for row in kept if row.get("status") == "open" for tag in row.get("field_tags", [])).most_common()),
        by_stage=dict(Counter(tag for row in kept if row.get("status") == "open" for tag in row.get("stage", [])).most_common()),
        by_sector=dict(Counter(row["sector"] for row in kept if row.get("status") == "open" and row.get("sector")).most_common()))
    # Retained records are unchanged; first-screen membership and aggregate counts follow them.
    index["first"] = write_first_screen(kept, str(data))
    _dump(index, str(index_path), indent=1)
    _dump(stats, str(stats_path), indent=2)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--expected-generated-at")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = reconcile(args.data, write=args.write, expected_generated_at=args.expected_generated_at)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.report:
        args.report.write_text(rendered, encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in {"changes", "removed_ids"}}, indent=2))


if __name__ == "__main__":
    main()
