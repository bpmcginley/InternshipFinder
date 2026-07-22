"""Export the DB to static JSON files for the GitHub Pages frontend.

Produces:
  <out>/listings.json  - array of listing objects (all listings)
  <out>/stats.json     - counts + generated_at + profile summary
The static site reads these directly; no backend needed.
"""
from __future__ import annotations
import json
import os
from datetime import datetime, timezone
from sqlalchemy import select, func
from .db import SessionLocal, init_db
from .models import Listing, Application
from .config import PROFILE


def _listing_dict(row: Listing) -> dict:
    return {
        "id": row.id,
        "company_name": row.company_name,
        "title": row.title,
        "field_tags": row.field_tags or [],
        "term": row.term,
        "location_raw": row.location_raw,
        "is_remote": row.is_remote,
        "within_radius": row.within_radius,
        "distance_miles": round(row.distance_miles, 1) if row.distance_miles is not None else None,
        "apply_url": row.apply_url,
        "status": row.status,
        "relevance_score": row.relevance_score,
        "is_new": row.is_new,
        "first_seen": row.first_seen.isoformat() if row.first_seen else None,
        "last_seen": row.last_seen.isoformat() if row.last_seen else None,
        "sources": [{"source": s.source, "source_url": s.source_url} for s in row.source_links],
    }


def export(out_dir: str) -> dict:
    init_db()
    os.makedirs(out_dir, exist_ok=True)
    with SessionLocal() as db:
        rows = db.scalars(
            select(Listing).order_by(Listing.relevance_score.desc(), Listing.first_seen.desc())
        ).all()
        listings = [_listing_dict(r) for r in rows]
        stats = {
            "total": len(rows),
            "open": sum(1 for r in rows if r.status == "open"),
            "new": sum(1 for r in rows if r.is_new),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "profile": {
                "name": PROFILE.name,
                "center_city": PROFILE.center_city,
                "radius_miles": PROFILE.radius_miles,
                "include_remote": PROFILE.include_remote,
                "terms": [f"{s} {y}" for s, y in PROFILE.terms],
            },
        }
    with open(os.path.join(out_dir, "listings.json"), "w") as f:
        json.dump(listings, f, indent=None, separators=(",", ":"))
    with open(os.path.join(out_dir, "stats.json"), "w") as f:
        json.dump(stats, f, indent=2)
    print(f"[export] wrote {len(listings)} listings to {out_dir}")
    return stats


if __name__ == "__main__":
    import sys
    export(sys.argv[1] if len(sys.argv) > 1 else "docs/data")
