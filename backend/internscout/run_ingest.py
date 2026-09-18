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
import httpx
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from .sources import fetch_github_lists, fetch_google_jobs, fetch_usajobs, fetch_nyc_jobs, BOARD_FETCHERS
from .sources.base import client
from .sources.common import RobotsDisallowed
from .sources.github_lists import parse_fixture
from .config import GOOGLE_JOBS_QUERIES, GOOGLE_JOBS_MAX_SEARCHES, FETCH_WORKERS, google_jobs_locations
from .discover import (load_registry, save_registry, seed_registry, discover, boards,
                       label_boards, label_sectors, record_result, prune)
from .probe import probe_boards
from .geo import save_cache
from .pipeline import run


# A board that fails the way a busy server fails - 429, a 5xx, a timeout, a dropped connection -
# gets one more try after the main pass, a few at a time. The CI run of 2026-09-18 failed 426 of
# 1,186 Workday boards and all 61 Workable ones; ten of those Workday boards sampled the same
# morning from a laptop all answered 200. The failures were the run, not the boards, and at
# MAX_FAILS they would have cost 223 working Workday boards their place in the registry.
RETRY_PAUSE = 15      # seconds between the main pass and the retry
RETRY_WORKERS = 4
RETRY_MAX = 400       # a retry pass is not allowed to double the length of the run
# An ATS that fails on at least half its boards in one run has a problem of its own (a block on the
# runner's address range, an API change), and the registry must not read that as its boards dying.
SYSTEMIC_SHARE = 0.5
SYSTEMIC_MIN_BOARDS = 10


def _cause(e: Exception) -> str:
    """A short name for why a board failed, for the run summary: an HTTP status or an error type."""
    if isinstance(e, httpx.HTTPStatusError):
        return str(e.response.status_code)
    return type(e).__name__


def _transient(e: Exception) -> bool:
    if isinstance(e, httpx.HTTPStatusError):
        s = e.response.status_code
        return s == 429 or s >= 500
    return isinstance(e, (httpx.TimeoutException, httpx.RemoteProtocolError, httpx.ReadError))


def _fetch_boards(c, jobs: list, workers: int) -> dict:
    """(ats, token) -> the board's items, or the exception it raised."""
    res = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(BOARD_FETCHERS[ats], c, co): (ats, tok) for ats, tok, co in jobs}
        for f in as_completed(futs):
            try:
                res[futs[f]] = f.result()
            except Exception as e:
                res[futs[f]] = e
    return res


def scan_boards(reg: dict, workers: int = FETCH_WORKERS, verbose: bool = True) -> list[dict]:
    """Fetch every registered board in parallel; records success/failure in the registry."""
    todo = [(ats, tok, e) for ats, tok, e in boards(reg) if ats in BOARD_FETCHERS]
    jobs = [(ats, tok, {"name": e["name"], "ats_token": tok, "is_quant_target": e.get("quant", False),
                        "sector": e.get("sector") or ("quant_finance" if e.get("quant") else None),
                        "location": e.get("location")})
            for ats, tok, e in todo]
    out: list[dict] = []
    per_ats, failed, closed = Counter(), Counter(), Counter()
    causes: dict[str, Counter] = {}
    t0 = time.monotonic()
    with client() as c:
        res = _fetch_boards(c, jobs, workers)
        again = [j for j in jobs
                 if isinstance(res[j[0], j[1]], Exception) and _transient(res[j[0], j[1]])][:RETRY_MAX]
        if again:
            time.sleep(RETRY_PAUSE)
            res.update(_fetch_boards(c, again, RETRY_WORKERS))
    size = Counter(ats for ats, _, _ in jobs)
    for (ats, tok), r in res.items():
        if isinstance(r, RobotsDisallowed):
            closed[ats] += 1
        elif isinstance(r, Exception):
            failed[ats] += 1
            causes.setdefault(ats, Counter())[_cause(r)] += 1
    systemic = {a for a, n in failed.items()
                if size[a] >= SYSTEMIC_MIN_BOARDS and n >= SYSTEMIC_SHARE * size[a]}
    for (ats, tok), r in res.items():
        if isinstance(r, RobotsDisallowed):
            # Not a failure to report as one, but the board still has to leave the registry,
            # and record_result is what ages a board out.
            record_result(reg, ats, tok, False)
        elif isinstance(r, Exception):
            if ats not in systemic:
                record_result(reg, ats, tok, False)
        else:
            record_result(reg, ats, tok, True)
            out += r
            per_ats[ats] += len(r)
    if verbose:
        note = f"; closed by robots.txt {dict(closed)}" if closed else ""
        print(f"[boards] {len(todo)} boards in {time.monotonic() - t0:.0f}s "
              f"({len(again)} retried); "
              f"intern postings {dict(per_ats)}; failed boards {dict(failed)}{note}")
        why = {a: dict(k.most_common(4)) for a, k in sorted(causes.items(), key=lambda x: -failed[x[0]])}
        print(f"[boards] failure causes {why}")
        if systemic:
            print(f"[boards] not aged this run, failing on half their boards or more: {sorted(systemic)}")
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
