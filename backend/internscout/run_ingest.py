"""CLI: run the ingestion pipeline against live sources.

Usage:
  python -m internscout.run_ingest              # all tiers
  python -m internscout.run_ingest --lists      # Tier 1 only (GitHub lists)
  python -m internscout.run_ingest --ats        # Tier 2 only (Greenhouse/Lever)
  python -m internscout.run_ingest --fixture path.json --source vanshb03
"""
from __future__ import annotations
import argparse
from .sources import fetch_github_lists, fetch_greenhouse, fetch_lever, fetch_google_jobs
from .sources.github_lists import parse_fixture
from .companies_seed import GREENHOUSE, LEVER
from .config import GOOGLE_JOBS_QUERIES, GOOGLE_JOBS_LOCATIONS
from .pipeline import run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lists", action="store_true", help="Tier 1 GitHub lists only")
    ap.add_argument("--ats", action="store_true", help="Tier 2 ATS boards only")
    ap.add_argument("--google", action="store_true", help="Google Jobs (SerpApi) only")
    ap.add_argument("--fixture", help="parse a local listings.json instead of fetching")
    ap.add_argument("--source", default="vanshb03")
    ap.add_argument("--export", metavar="DIR", help="also write static JSON for GitHub Pages")
    args = ap.parse_args()

    raw: list[dict] = []
    if args.fixture:
        raw += parse_fixture(args.fixture, source=args.source)
    else:
        do_all = not (args.lists or args.ats)
        if args.lists or do_all:
            raw += fetch_github_lists()
        if args.ats or do_all:
            raw += fetch_greenhouse(GREENHOUSE)
            raw += fetch_lever(LEVER)
        if args.google or do_all:
            raw += fetch_google_jobs(GOOGLE_JOBS_QUERIES, GOOGLE_JOBS_LOCATIONS)

    run(raw)
    if args.export:
        from .export_static import export
        export(args.export)


if __name__ == "__main__":
    main()
