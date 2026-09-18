"""CLI: run the ingestion pipeline against live sources.

Usage:
  python -m internscout.run_ingest              # all sources
  python -m internscout.run_ingest --lists      # GitHub lists only (still grows the registry)
  python -m internscout.run_ingest --ats        # registered ATS boards only
  python -m internscout.run_ingest --google     # Google Jobs (SerpApi) only
  python -m internscout.run_ingest --fixture path.json --source vanshb03
"""
from __future__ import annotations
import argparse
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from .sources import fetch_github_lists, fetch_google_jobs, fetch_usajobs, fetch_nyc_jobs, BOARD_FETCHERS
from .sources.base import client
from .sources.github_lists import parse_fixture
from .config import GOOGLE_JOBS_QUERIES, GOOGLE_JOBS_MAX_SEARCHES, FETCH_WORKERS, google_jobs_locations
from .discover import (load_registry, save_registry, seed_registry, discover, boards,
                       label_boards, label_sectors, record_result, prune)
from .probe import probe_boards
from .geo import save_cache
from .pipeline import run


def scan_boards(reg: dict, workers: int = FETCH_WORKERS, verbose: bool = True) -> list[dict]:
    """Fetch every registered board in parallel; records success/failure in the registry."""
    todo = [(ats, tok, e) for ats, tok, e in boards(reg) if ats in BOARD_FETCHERS]
    out: list[dict] = []
    per_ats, failed = Counter(), Counter()
    t0 = time.monotonic()
    with client() as c, ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {
            ex.submit(BOARD_FETCHERS[ats], c,
                      {"name": e["name"], "ats_token": tok, "is_quant_target": e.get("quant", False),
                       "sector": e.get("sector") or ("quant_finance" if e.get("quant") else None),
                       "location": e.get("location")}): (ats, tok)
            for ats, tok, e in todo
        }
        for f in as_completed(futs):
            ats, tok = futs[f]
            try:
                items = f.result()
                record_result(reg, ats, tok, True)
                out += items
                per_ats[ats] += len(items)
            except Exception:
                record_result(reg, ats, tok, False)
                failed[ats] += 1
    if verbose:
        print(f"[boards] {len(todo)} boards in {time.monotonic() - t0:.0f}s; "
              f"intern postings {dict(per_ats)}; failed boards {dict(failed)}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lists", action="store_true", help="GitHub lists only")
    ap.add_argument("--ats", action="store_true", help="registered ATS boards only")
    ap.add_argument("--google", action="store_true", help="Google Jobs (SerpApi) only")
    ap.add_argument("--public", action="store_true", help="public-sector feeds (USAJOBS, NYC) only")
    ap.add_argument("--fixture", help="parse a local listings.json instead of fetching")
    ap.add_argument("--source", default="vanshb03")
    ap.add_argument("--export", metavar="DIR", help="also write static JSON for GitHub Pages")
    ap.add_argument("--workers", type=int, default=FETCH_WORKERS)
    args = ap.parse_args()

    raw: list[dict] = []
    if args.fixture:
        raw += parse_fixture(args.fixture, source=args.source)
    else:
        do_all = not (args.lists or args.ats or args.google or args.public)
        reg = load_registry()
        seeded = seed_registry(reg)
        found = 0
        if args.lists or do_all:
            items = fetch_github_lists()
            found += discover(reg, items)
            raw += items
        if args.google or do_all:
            items = fetch_google_jobs(GOOGLE_JOBS_QUERIES, google_jobs_locations(), max_searches=GOOGLE_JOBS_MAX_SEARCHES)
            found += discover(reg, items)
            raw += items
        if raw:
            probed = probe_boards(reg, raw)
            found += probed
            print(f"[probe] +{probed} boards guessed from company names", flush=True)
        if args.ats or do_all:
            raw += scan_boards(reg, args.workers)
        if args.public or do_all:  # government feeds: no ATS boards to discover from these
            raw += fetch_usajobs() + fetch_nyc_jobs()
        # Boards first, so the listings below can be labelled off them in the same run.
        named = label_boards(reg)
        # Last, so it sees every item from every source in this run.
        labelled = label_sectors(reg, raw)
        dropped = prune(reg)
        save_registry(reg)
        print(f"[registry] +{seeded} seeded, +{found} discovered, -{dropped} dead, "
              f"+{named} boards labelled by name, "
              f"{labelled} listings labelled from their board; "
              f"{ {a: len(b) for a, b in reg.items()} }")

    run(raw)
    save_cache()
    if args.export:
        from .export_static import export
        export(args.export)


if __name__ == "__main__":
    main()
