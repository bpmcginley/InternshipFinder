"""Export the DB to static JSON files for the GitHub Pages frontend.

Produces:
  <out>/listings/<ST>.json    - the listings in one state; remote.json (US-remote), US.json (country only)
  <out>/listings/index.json   - per-file counts by field and stage, so the dashboard loads only picked states
  <out>/stats.json            - counts + generated_at + profile summary
  <out>/majors.json           - majors -> field tags for the profile picker
The static site reads these directly; no backend needed.
"""
from __future__ import annotations
import json
from collections import Counter, defaultdict
import os
from datetime import datetime, timezone
from sqlalchemy import select, func
from .db import SessionLocal, init_db
from .models import Listing, Application
from .config import PROFILE, REGION, BASELINE_STATES, wanted_states
from .insights import extract, PATTERNS
from .classify import stage_of, years_of
from .majors import majors_export
from .score import W
from .region import evaluate_locations

DESC_CHARS = 1500


def _regions(row: Listing) -> list[dict]:
    # Re-read the raw locations so older rows get today's rules too; region_locations keeps
    # places other sources of the same role listed.
    ev = evaluate_locations([row.location_raw or ""] + (row.region_locations or []))["regions"]
    return list({g["loc"]: g for g in ev}.values())


def shard_keys(listing: dict) -> set[str]:
    """The listing files a listing belongs in: each state it names, "remote" for US-remote roles
    with no state, "US" for roles that name only the country."""
    keys = set()
    for g in listing.get("regions") or []:
        if g["state"] and g["state"] != "Remote":
            keys.add(g["state"])
        else:
            keys.add("remote" if g["kind"] == "remote" else "US")
    if not keys and listing.get("state"):
        keys.add("remote" if listing["state"] == "Remote" else listing["state"])
    return keys


def _dump(obj, path: str, indent=None) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=indent, separators=None if indent else (",", ":"), ensure_ascii=False)


def write_shards(listings: list[dict], out_dir: str, generated_at: str) -> dict:
    shard_dir = os.path.join(out_dir, "listings")
    os.makedirs(shard_dir, exist_ok=True)
    shards: dict[str, list] = defaultdict(list)
    for x in listings:
        for k in shard_keys(x):
            shards[k].append(x)
    index = {"generated_at": generated_at, "files": {}}
    for k, items in sorted(shards.items()):
        _dump(items, os.path.join(shard_dir, f"{k}.json"))
        live = [x for x in items if x["status"] == "open"]
        index["files"][k] = {
            "file": f"listings/{k}.json", "count": len(items), "open": len(live),
            "by_field": dict(Counter(t for x in live for t in x["field_tags"]).most_common()),
            "by_stage": dict(Counter(s for x in live for s in x["stage"]).most_common()),
            "by_sector": dict(Counter(x["sector"] for x in live if x.get("sector")).most_common()),
        }
    for name in os.listdir(shard_dir):  # a state with no listings left
        if name.endswith(".json") and name != "index.json" and name[:-5] not in shards:
            os.remove(os.path.join(shard_dir, name))
    _dump(index, os.path.join(shard_dir, "index.json"), indent=1)
    return index


def _listing_dict(row: Listing) -> dict:
    regions = _regions(row)
    ins = extract(row.description) if row.status == "open" else None
    if ins is not None and "pay" not in ins and row.salary:
        ins["pay"] = "paid"
    return {
        "id": row.id,
        "company_name": row.company_name,
        "title": row.title,
        "field_tags": row.field_tags or [],
        "sector": row.sector,
        "stage": row.stage or stage_of(row.title),
        "years": years_of(row.title, ins),
        "term": row.term,
        "salary": row.salary,
        "duration": row.duration,
        "posted_at": row.posted_at.isoformat() if row.posted_at else None,
        "location_raw": row.location_raw,
        "is_remote": row.is_remote,
        "state": row.state,
        "region_locations": [g["loc"] for g in regions] or (row.region_locations or []),
        "regions": regions,
        "ats": row.ats,
        "apply_url": row.apply_url,
        # trimmed JD: the Auto-Apply agent uses it to tailor answers
        "description": (row.description or "")[:DESC_CHARS] if row.status == "open" else None,
        "status": row.status,
        "score_parts": row.score_parts,
        # requirements, eligibility limits and deadline parsed from the full description
        "insights": ins,
        "is_new": row.is_new,
        "first_seen": row.first_seen.isoformat() if row.first_seen else None,
    }


def still_student_opportunities(listings: list[dict]) -> list[dict]:
    """The listings that would still be admitted today, by the test normalize applies on the way in.

    normalize() refuses anything stage_of() cannot name a student stage for, so no new-grad job can
    enter. A row already in the store never meets that test again, though, and the rules have
    tightened since some of them arrived: the last export published 46 listings with no stage at
    all, and every one was a job this is not for - "Software Engineer, New Grad" at nine companies,
    "Trader Trainee", "Campus Police Officer", "Adjunct Faculty-Off-Campus Advisor". The plan is
    student opportunities only, so the same question is asked again here, where it costs nothing
    and answers for old rows as well as new ones.
    """
    return [x for x in listings if x["stage"]]


def export(out_dir: str) -> dict:
    init_db()
    os.makedirs(out_dir, exist_ok=True)
    with SessionLocal() as db:
        rows = db.scalars(
            select(Listing).order_by(Listing.relevance_score.desc(), Listing.first_seen.desc())
        ).all()
        listings = still_student_opportunities([_listing_dict(r) for r in rows])
        generated_at = datetime.now(timezone.utc).isoformat()
        stats = {
            "total": len(listings),
            "open": sum(1 for x in listings if x["status"] == "open"),
            "new": sum(1 for x in listings if x["is_new"]),
            "generated_at": generated_at,
            "profile": {
                "name": PROFILE.name,
                "center_city": PROFILE.center_city,
                "radius_miles": PROFILE.radius_miles,
                "include_remote": PROFILE.include_remote,
                "terms": [f"{s} {y}" for s, y in PROFILE.terms],
                "region": REGION.name,
                "baseline_states": sorted(BASELINE_STATES),
                "wanted_states": sorted(wanted_states()),
                "nyc_radius_miles": REGION.nyc_radius_miles,
            },
            "by_state": dict(Counter(k for x in listings if x["status"] == "open" for k in shard_keys(x)).most_common()),
            "by_ats": dict(Counter(x["ats"] for x in listings if x["status"] == "open").most_common()),
            "by_field": dict(Counter(t for x in listings if x["status"] == "open" for t in x["field_tags"]).most_common()),
            "by_stage": dict(Counter(s for x in listings if x["status"] == "open" for s in x["stage"]).most_common()),
            "by_sector": dict(Counter(x["sector"] for x in listings if x["status"] == "open" and x.get("sector")).most_common()),
            "score_weights": W,
            "skill_patterns": PATTERNS,
        }
    legacy = os.path.join(out_dir, "listings.json")  # replaced by the per-state files
    if os.path.exists(legacy):
        os.remove(legacy)
    _dump(stats, os.path.join(out_dir, "stats.json"), indent=2)
    _dump(majors_export(), os.path.join(out_dir, "majors.json"))
    index = write_shards(listings, out_dir, generated_at)
    print(f"[export] wrote {len(listings)} listings ({len(index['files'])} state files) to {out_dir}")
    return stats


if __name__ == "__main__":
    import sys
    export(sys.argv[1] if len(sys.argv) > 1 else "docs/data")
