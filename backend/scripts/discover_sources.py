"""Official-source discovery: offline worklist by default; never uses paid search.

From backend: python scripts/discover_sources.py --help
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from internscout.source_discovery import (starter_targets, discovery_plan, validate_targets,
    DiscoveryClient, scan_target, verify_boards, admit_verified)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jurisdictions", default="", help="comma-separated state/province codes; default all")
    parser.add_argument("--targets", type=Path, help="JSON array of researched official-source targets")
    parser.add_argument("--scan", action="store_true", help="fetch bounded public official pages")
    parser.add_argument("--verify", action="store_true", help="also exercise supported ATS adapters, requires --scan")
    parser.add_argument("--apply", action="store_true", help="save newly verified boards to registry, requires --verify")
    parser.add_argument("--max-targets", type=int, default=10)
    parser.add_argument("--offset", type=int, default=0, help="resume next target batch")
    parser.add_argument("--max-pages", type=int, default=3, help="pages per target, including career hub")
    parser.add_argument("--max-requests", type=int, default=200, help="total HTTP requests including robots and verification")
    parser.add_argument("--output", type=Path, help="write research report; otherwise JSON to stdout")
    args = parser.parse_args(argv)
    if args.verify and not args.scan:
        parser.error("--verify requires --scan")
    if args.apply and not args.verify:
        parser.error("--apply requires --verify (fresh verification in the same run)")
    if min(args.max_targets, args.max_pages, args.max_requests) < 1 or args.offset < 0:
        parser.error("limits must be positive and offset nonnegative")
    codes = {c.strip().upper() for c in args.jurisdictions.split(",") if c.strip()}
    if codes - {r["jurisdiction"] for r in discovery_plan()}:
        parser.error("unknown jurisdiction code")
    try:
        targets = validate_targets(json.loads(args.targets.read_text(encoding="utf-8"))
                                   if args.targets else starter_targets())
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    targets = [t for t in targets if not codes or t["jurisdiction"] in codes]
    report = dict(mode="scan" if args.scan else "offline_plan", paid_requests=0,
                  plan=discovery_plan(codes), target_count=len(targets), targets=targets,
                  results=[], boards_added=[], requests=0)
    if args.scan:
        from internscout.sources.base import client
        from internscout.sources import BOARD_FETCHERS
        with client() as raw:
            c = DiscoveryClient(raw, max_requests=args.max_requests)
            for target in targets[args.offset:args.offset + args.max_targets]:
                if c.remaining <= 0:
                    break
                result = scan_target(c, target, max_pages=args.max_pages)
                if args.verify and c.remaining > 0:
                    verify_boards(c, result, BOARD_FETCHERS)
                report["results"].append(result)
            report["requests"] = c.requests
            report["request_budget_exhausted"] = c.remaining == 0
        if args.apply:
            from internscout.discover import load_registry, save_registry
            registry = load_registry()
            report["boards_added"] = admit_verified(registry, report["results"])
            if report["boards_added"]:
                save_registry(registry)
    content = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
