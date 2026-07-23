"""Orchestrates: fetch -> normalize -> term/location filter -> dedupe -> score -> persist.

Open/closed tracking: any listing whose dedupe_key is not seen in a run of a given
source set is marked closed (if it was previously sourced there).
"""
from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy import select
from .db import SessionLocal, init_db
from .models import Listing, SourceLink, Company, Application
from .config import PROFILE
from .normalize import normalize
from .dedupe import merge_batch
from .geo import passes_location_filter
from .score import score_listing


def _term_ok(season, year) -> bool:
    wanted = set(PROFILE.terms)
    if season and year:
        return (season, year) in wanted
    # undetermined term: keep (dashboard can filter) unless a wrong year is known
    if year and (any(y == year for _, y in wanted) is False):
        return False
    return True


def _field_ok(tags) -> bool:
    return any(t in PROFILE.fields for t in tags)


def run(raw_items: list[dict], *, verbose=True) -> dict:
    init_db()
    normalized = []
    for raw in raw_items:
        n = normalize(raw)
        if not n:
            continue
        if not _field_ok(n["field_tags"]):
            continue
        if not _term_ok(n["season"], n["year"]):
            continue
        if not passes_location_filter(n["geo"]):
            continue
        # carry quant-target flag from ATS payloads
        n["is_quant_target"] = raw.get("_is_quant_target", False)
        normalized.append(n)

    merged = merge_batch(normalized)
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
            row.season = it["season"]; row.year = it["year"]; row.term = it["term"]
            row.location_raw = it["location_raw"]
            row.lat = it["lat"]; row.lng = it["lng"]
            row.is_remote = it["is_remote"]
            row.within_radius = it["within_radius"]
            row.distance_miles = it["distance_miles"]
            row.salary = it.get("salary")
            row.duration = it.get("duration")
            row.apply_url = it["apply_url"]
            row.posted_at = it["posted_at"]
            row.last_seen = now
            row.status = "open" if it.get("active", True) else "closed"
            row.relevance_score = score_listing(
                field_tags=it["field_tags"], geo=it["geo"], first_seen=row.first_seen,
                status=row.status, is_quant_target=it.get("is_quant_target", False),
                sources=sources,
            )
            db.flush()
            # source links
            existing = {sl.source for sl in row.source_links}
            for s, url in it["_sources"]:
                if s not in existing:
                    db.add(SourceLink(listing_id=row.id, source=s, source_url=url))
                    existing.add(s)
            if row.application is None:
                db.add(Application(listing_id=row.id, state="none"))

        # close listings no longer seen from the sources we just ran
        run_sources = {s for it in merged.values() for s, _ in it["_sources"]}
        if run_sources:
            for row in db.scalars(select(Listing).where(Listing.status == "open")):
                if row.dedupe_key in seen_keys:
                    continue
                row_sources = {sl.source for sl in row.source_links}
                if row_sources and row_sources.issubset(run_sources):
                    row.status = "closed"
                    stats["closed"] += 1
        db.commit()

    if verbose:
        print(f"[pipeline] {stats}")
    return stats
