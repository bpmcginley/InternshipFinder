"""Orchestrates: fetch -> normalize -> term/location filter -> dedupe -> score -> persist.

Absence only closes a listing after its exact employer board completed an
authoritative scan. Sampled searches and failed/capped scans cannot prove closure.
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timezone
from sqlalchemy import select
from .db import SessionLocal, init_db
from .models import Listing, SourceLink, Company, Application
from .config import PROFILE
from .normalize import normalize
from .dedupe import merge_batch, _canon_job
from .discover import ats_of
from .region import place_bare_cities
from .score import score_parts
from .scan_evidence import SEARCH_SCOPED, canonical, url_board


def _term_ok(season, year) -> bool:
    wanted = set(PROFILE.terms)
    if season and year:
        return (season, year) in wanted
    # undetermined term: keep (dashboard can filter) unless a wrong year is known
    if year and (any(y == year for _, y in wanted) is False):
        return False
    return True


def _field_ok(tags) -> bool:
    if not PROFILE.fields:      # empty tuple = accept every discipline
        return True
    return any(t in PROFILE.fields for t in tags)


def _board_key(url, source=None):
    return url_board(url, source)


def _listing_boards(row):
    """Recover employer provenance without a schema migration; ambiguity retains the row."""
    apply_board = _board_key(row.apply_url)
    found = {apply_board} if apply_board else set()
    # Search/community provenance is not an authoritative source of absence. Its
    # employer URL can identify a board, but disappearance from a list never can.
    from .sources import BOARD_FETCHERS
    for link in row.source_links:
        board = _board_key(link.source_url, link.source)
        if board:
            found.add(board)
        elif link.source in BOARD_FETCHERS and (not apply_board or apply_board[0] != link.source):
            return set()  # an ATS observation whose board cannot be recovered
    return found


def _in_scan_scope(row, boards) -> bool:
    """Whether every board's evidence covers this row (see scan_evidence.SEARCH_SCOPED).

    A keyword-scoped scan can only vouch for postings its own searches return, so the row must
    have been found by that adapter before. One known only from a search engine or a list may be
    a title the keywords never match, and its absence from them says nothing.
    """
    sources = {link.source for link in row.source_links}
    return all(ats not in SEARCH_SCOPED or ats in sources for ats, _ in boards)


def run(raw_items: list[dict], *, verbose=True, completed_boards=None, metrics=None) -> dict:
    """Persist items; only explicitly completed employer boards authorize absence closure.

    completed_boards contains (ats, token) pairs, including successfully empty
    boards. Omission is deliberately safe for fixtures and partial callers.
    """
    init_db()
    completed_boards = canonical(completed_boards)
    seen_urls = {_canon_job(raw.get(key)) for raw in raw_items
                 for key in ("apply_url", "url", "source_url") if raw.get(key)} - {None}
    placed = place_bare_cities(raw_items)
    normalized = []
    for raw in raw_items:
        source = raw.get("source")
        if metrics is not None:
            metrics.count("fetched", source=source)
        n = normalize(raw, on_reject=(lambda reason: metrics.reject(reason, source=source))
                      if metrics is not None else None)
        if not n:
            continue
        if metrics is not None:
            metrics.count("parsed", source=source)
        if not _field_ok(n["field_tags"]):
            if metrics is not None:
                metrics.reject("field_filter", source=source, stage="filter")
            continue
        if not _term_ok(n["season"], n["year"]):
            if metrics is not None:
                metrics.reject("term_filter", source=source, stage="filter")
            continue
        if not n["geo"]["in_region"]:   # anywhere in the US, or US-remote
            if metrics is not None:
                metrics.reject("outside_region", source=source, stage="filter")
            continue
        normalized.append(n)
        if metrics is not None:
            metrics.count("accepted", source=source)

    merged = merge_batch(normalized)
    if metrics is not None:
        metrics.count("unique", len(merged))
    stats = {"raw": len(raw_items), "kept": len(normalized), "unique": len(merged),
             "new": 0, "updated": 0, "closed": 0}

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        seen_keys = set()
        for key, it in merged.items():
            seen_keys.add(key)
            sources = [s for s, _ in it["_sources"]]
            row = db.scalar(select(Listing).where(Listing.dedupe_key == key))
            if row is None:
                row = Listing(dedupe_key=key, first_seen=now, is_new=True)
                db.add(row)
                stats["new"] += 1
            else:
                row.is_new = False
                stats["updated"] += 1
            row.company_name = it["company_name"]
            row.title = it["title"]
            row.description = it.get("description")
            row.field_tags = it["field_tags"]
            row.stage = it.get("stage") or []
            row.employment_type = it.get("employment_type")
            row.season = it["season"]; row.year = it["year"]; row.term = it["term"]
            row.location_raw = it["location_raw"]
            row.lat = it["lat"]; row.lng = it["lng"]
            row.is_remote = it["is_remote"]
            row.within_radius = it["within_radius"]
            row.distance_miles = it["distance_miles"]
            row.state = it["geo"]["state"]
            row.region_locations = it["geo"]["region_locations"]
            row.ats = ats_of(it["apply_url"])[0]
            row.sector = it.get("sector") or row.sector
            row.salary = it.get("salary")
            row.duration = it.get("duration")
            row.apply_url = it["apply_url"]
            # Keep a date we already have when this run did not come with one. iCIMS, Rippling
            # and BambooHR only learn the date on a per-job detail call and those are capped
            # per board, so the same posting arrives dated on one run and undated on the next.
            row.posted_at = it["posted_at"] or row.posted_at
            row.last_seen = now
            row.status = "open" if it.get("active", True) else "closed"
            row.score_parts = score_parts(
                field_tags=it["field_tags"], geo=it["geo"], first_seen=row.first_seen,
                posted_at=row.posted_at, status=row.status, sources=sources,
            )
            row.relevance_score = round(sum(row.score_parts.values()), 1)
            db.flush()
            # source links
            existing = {sl.source: sl for sl in row.source_links}
            for s, url in it["_sources"]:
                if s not in existing:
                    link = SourceLink(listing_id=row.id, source=s, source_url=url, seen_at=now)
                    db.add(link)
                    existing[s] = link
                else:
                    existing[s].seen_at = now
                    if url:
                        existing[s].source_url = url
            if row.application is None:
                db.add(Application(listing_id=row.id, state="none"))

        # A successful board on an ATS says nothing about its failed neighbors.
        # Nor does a missing search result mean the employer removed a posting.
        if completed_boards:
            for row in db.scalars(select(Listing).where(Listing.status == "open")):
                if row.dedupe_key in seen_keys:
                    continue
                if any(_canon_job(url) in seen_urls for url in
                       [row.apply_url] + [sl.source_url for sl in row.source_links] if url):
                    continue  # fetched but rejected/changed metadata is not proof of absence
                row_boards = _listing_boards(row)
                if row_boards and row_boards.issubset(completed_boards) and _in_scan_scope(row, row_boards):
                    row.status = "closed"
                    stats["closed"] += 1
        db.commit()
    if metrics is not None:
        metrics.count("persisted", len(merged))

    if verbose:
        print(f"[pipeline] {stats}; {placed} bare town names placed by their board")
        print("[pipeline] by state:", dict(Counter(it["geo"]["state"] for it in merged.values()).most_common()))
        print("[pipeline] by source:", dict(Counter(s for it in merged.values() for s, _ in it["_sources"]).most_common()))
    return stats
