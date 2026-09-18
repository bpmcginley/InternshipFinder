"""Export the DB to static JSON files for the GitHub Pages frontend.

Produces:
  <out>/listings/<ST>.json    - the listings in one state; remote.json (US-remote), US.json (country only)
  <out>/listings/<ST>.desc.json - {id: description} for that file's open listings, fetched on demand
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
from .classify import STAGES, never_student, stage_of, years_of
from .majors import majors_export
from .normalize import listing_id
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
    with no state, "US" for roles that name only the country.

    This can come back empty, and a listing it comes back empty for is in no file and so cannot be
    reached from the site at all. The pipeline cannot produce one - it drops anything whose
    locations do not classify - but a carried listing can become one, because _regions re-reads the
    stored location under today's rules and today's rules may no longer place it. There is no
    honest file for it: "US" would be claiming a country the listing never named. So it is withheld
    and counted, and export says how many, because a corpus that quietly shrinks between the total
    and the state files is worse than one that shrinks out loud.
    """
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


# The dashboard renders a list from these rows and needs none of this per row. Measured on
# MA.json: the description was 48% of every row's bytes, region_locations 5% and score_parts 4.6%,
# and a first visit loaded 8.15 MB (1.55 MB gzipped) of it before showing a single card. The
# dashboard scores with score_parts["source"] alone, and reads location_raw only as the fallback
# when a listing has no regions. The description is still needed - for the search box and the
# Auto-Apply payload - so it moves to a sidecar the dashboard fetches only when it needs one.
ROW_ONLY_IN_SIDECAR = ("description", "region_locations")


def shard_row(x: dict) -> dict:
    """A listing as a state file carries it: everything the list view reads, nothing else."""
    row = {k: v for k, v in x.items() if k not in ROW_ONLY_IN_SIDECAR}
    parts = x.get("score_parts")
    if isinstance(parts, dict):
        row["score_parts"] = {"source": parts["source"]} if "source" in parts else {}
    if x.get("regions"):
        row.pop("location_raw", None)
    return row


def desc_file(key: str) -> str:
    return f"{key}.desc.json"


def write_shards(listings: list[dict], out_dir: str, generated_at: str) -> dict:
    """Write <ST>.json (slim rows) and <ST>.desc.json ({id: description} for its open rows)."""
    shard_dir = os.path.join(out_dir, "listings")
    os.makedirs(shard_dir, exist_ok=True)
    shards: dict[str, list] = defaultdict(list)
    for x in listings:
        for k in shard_keys(x):
            shards[k].append(x)
    index = {"generated_at": generated_at, "files": {}}
    for k, items in sorted(shards.items()):
        _dump([shard_row(x) for x in items], os.path.join(shard_dir, f"{k}.json"))
        _dump({x["id"]: x["description"] for x in items if x["status"] == "open" and x.get("description")},
              os.path.join(shard_dir, desc_file(k)))
        live = [x for x in items if x["status"] == "open"]
        index["files"][k] = {
            "file": f"listings/{k}.json", "desc": f"listings/{desc_file(k)}",
            "count": len(items), "open": len(live),
            "by_field": dict(Counter(t for x in live for t in x["field_tags"]).most_common()),
            "by_stage": dict(Counter(s for x in live for s in x["stage"]).most_common()),
            "by_sector": dict(Counter(x["sector"] for x in live if x.get("sector")).most_common()),
        }
    for name in os.listdir(shard_dir):  # a state with no listings left, and its sidecar
        stem = name[:-len(".desc.json")] if name.endswith(".desc.json") else name[:-5]
        if name.endswith(".json") and name != "index.json" and stem not in shards:
            os.remove(os.path.join(shard_dir, name))
    _dump(index, os.path.join(shard_dir, "index.json"), indent=1)
    return index


def _listing_dict(row: Listing) -> dict:
    regions = _regions(row)
    ins = extract(row.description) if row.status == "open" else None
    if ins is not None and "pay" not in ins and row.salary:
        ins["pay"] = "paid"
    return {
        # Not row.id: the database is rebuilt every run, so that was the insert order.
        "id": listing_id(row.dedupe_key),
        "company_name": row.company_name,
        "title": row.title,
        "field_tags": row.field_tags or [],
        "sector": row.sector,
        "stage": merged_stages(row.stage, row.title),
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


def merged_stages(stored: list[str] | None, title: str) -> list[str]:
    """Every stage this posting has, in STAGES order: the stored ones and today's reading of it.

    A stored stage is the answer the rules gave the day the row arrived, and the rules move. The
    last export published 25 postings that plainly say research - "PhD Research Intern", "Research
    Science Intern, Financial Innovation Lab", "Research and Technology Co-Op" - as internships
    and nothing else, because they were stored before the research rule learned the bare word. A
    student filtering for research did not see them.

    The stored list is kept rather than replaced, because it is the only record of what the source
    said the employment type was. Eight listings owe their whole stage to it: the title of a
    Palantir posting is "Growth" and of another "Cohort 0", and only the feed says intern.

    A title no student can hold loses every stage whatever the feed said. The 6c0d9df export
    published 13 SkillBridge placements - active-duty service members only - because the feed
    called them internships, and the title rule that rejects them never got the last word.
    """
    if never_student(title):
        return []
    found = set(stored or []) | set(stage_of(title))
    # A stored "research" and nothing else is asked again. No feed ever says research - it is always
    # the title's reading - and the rule that read it once admitted "VP, Research" and "Researcher,
    # Interpretability" on the word alone. If today's rules find no student stage in that title, the
    # row has none, and still_student_opportunities drops it like any other stale row.
    if found == {"research"} and not stage_of(title):
        found = set()
    return [s for s in STAGES if s in found]


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


NEW_DAYS = 7

# A board has to lose more than half of at least this many open listings before we treat the
# run as a failure rather than as the employer closing jobs.
COLLAPSE_RATIO = 0.5
COLLAPSE_FLOOR = 3
# How long a listing may be shown after the last run that actually saw it on the board.
CARRY_DAYS = 2


def previous_export(out_dir: str) -> list[dict]:
    """Every listing in the export this run is about to replace.

    CI commits the exported JSON and checks it back out, so the last run is still on disk here
    and write_shards only overwrites it afterwards. It is the only memory the pipeline has:
    the database does not outlive a run.

    A listing appears in one file per state it names, so it is returned once, keyed on its
    apply URL. A half-written or missing shard is skipped rather than failing the run.
    """
    shard_dir = os.path.join(out_dir, "listings")
    seen: set[str] = set()
    out: list[dict] = []
    names = sorted(os.listdir(shard_dir)) if os.path.isdir(shard_dir) else []
    # The descriptions live in the sidecars now. A carried listing is put back exactly as it is
    # returned here, so without them every board that failed a fetch would lose its descriptions.
    descs: dict[str, str] = {}
    for name in names:
        if name.endswith(".desc.json"):
            try:
                with open(os.path.join(shard_dir, name), encoding="utf-8") as f:
                    got = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(got, dict):
                descs.update(got)
    for name in names:
        if not name.endswith(".json") or name == "index.json" or name.endswith(".desc.json"):
            continue
        try:
            with open(os.path.join(shard_dir, name), encoding="utf-8") as f:
                items = json.load(f)
        except (OSError, ValueError):   # a half-written shard is not worth failing a run over
            continue
        if not isinstance(items, list):
            continue
        for it in items:
            key = it.get("apply_url") or "id:" + str(it.get("id"))
            if key not in seen:
                seen.add(key)
                if not it.get("description") and descs.get(str(it.get("id"))):
                    it["description"] = descs[str(it.get("id"))]
                out.append(it)
    return out


def _seen_within(stamp: str | None, today, days: int) -> bool:
    """Whether a first-seen stamp falls inside the window. An unreadable one counts as new."""
    if not stamp:
        return True
    try:
        seen = datetime.fromisoformat(stamp.replace("Z", "+00:00")).date()
    except ValueError:
        return True
    return (today - seen).days < days


def carry_first_seen(listings: list[dict], out_dir: str, today=None, prev=None) -> int:
    """Give each listing the first-seen date it had in the export this one replaces.

    CI keeps no database between runs, so first_seen was set to the moment of the run every
    time and is_new - which the pipeline sets on insert and clears on update - was never once
    cleared. All 13,652 listings in the last export carried first_seen of that morning and
    is_new true. The New badge sat on every card, the New-only filter removed nothing, and
    the sort that breaks ties on first_seen had nothing to break them with.

    The last export is still on disk when this runs - CI commits it and checks it out again -
    so it is the record the database is not. A listing found there keeps the date it had.

    Matched on the id first, and on the apply URL when the id misses. The URL catches the two
    cases the id cannot: the run this ships in, where the previous export still carries the
    old row-order ids, and a posting whose title the employer edited afterwards, which changes
    the dedupe key the id is built from but is plainly the same posting.
    """
    by_id: dict[str, str] = {}
    by_url: dict[str, str] = {}
    for it in previous_export(out_dir) if prev is None else prev:
        seen = it.get("first_seen")
        if not seen:
            continue
        by_id.setdefault(str(it.get("id")), seen)
        if it.get("apply_url"):
            by_url.setdefault(it["apply_url"], seen)

    today = today or datetime.now(timezone.utc).date()
    carried = 0
    for x in listings:
        seen = by_id.get(str(x.get("id"))) or by_url.get(x.get("apply_url") or "")
        if seen:
            x["first_seen"] = seen
            carried += 1
        x["is_new"] = _seen_within(x.get("first_seen"), today, NEW_DAYS)
    return carried


def carry_open_boards(listings: list[dict], out_dir: str, today=None, prev=None) -> int:
    """Hold the listings of a board whose fetch collapsed this run, rather than deleting them.

    An export is only what this run managed to fetch, so a board that timed out deletes all of
    its jobs from the site until the next run puts them back. Between the 08:43 and 08:50
    exports on 2026-09-18, 2,341 open listings disappeared and 71 arrived: a sixth of the
    corpus, none of it closed. Workday is where it happens - 97 boards answered nothing at all
    and 161 more answered with a fraction of what they had held minutes earlier.

    A student who saved a job on Monday found it gone on Tuesday and back on Wednesday, and the
    counts on the landing page moved by thousands for no reason a reader could see.

    So a board that comes back with half or less of what it had is read as a failed fetch, and
    its listings are carried over from the last export. The floor of three keeps ordinary churn
    out of it: an employer closing two of three postings in a six-hour window is believable, one
    closing thirty of forty is not. Measured on that pair, this holds 2,114 of the 2,341.

    The hold is not open-ended. A carried listing keeps the last_seen of the run that really did
    fetch it, so a board that is genuinely gone empties out after CARRY_DAYS and stays empty.
    Carried listings are marked, so the dashboard can say the board did not answer this time.
    """
    prev = previous_export(out_dir) if prev is None else prev
    today = today or datetime.now(timezone.utc).date()
    have = {x["apply_url"] for x in listings if x.get("apply_url")}

    def board(x):
        return (x.get("ats"), x.get("company_name"))

    now_open = Counter(board(x) for x in listings if x.get("status") == "open")
    was_open: dict[tuple, list[dict]] = defaultdict(list)
    for it in prev:
        if it.get("status") == "open" and it.get("ats") and it.get("company_name"):
            # The last export's rows answer today's stage question too, before they are counted.
            # When the research rule stopped admitting staff jobs on the bare word, a lab whose
            # board was mostly "Research Scientist" lost more than half its rows in one run, which
            # reads exactly like a fetch that collapsed - and 472 of those staff jobs were carried
            # straight back, stale stage and all.
            stage = merged_stages(it.get("stage"), it.get("title") or "")
            if not stage:
                continue
            was_open[board(it)].append({**it, "stage": stage})

    held = 0
    for key, rows in was_open.items():
        if len(rows) < COLLAPSE_FLOOR or now_open.get(key, 0) > COLLAPSE_RATIO * len(rows):
            continue
        for it in rows:
            url = it.get("apply_url")
            if not url or url in have:
                continue
            if not _seen_within(it.get("last_seen") or it.get("first_seen"), today, CARRY_DAYS):
                continue   # the board has been quiet for days; it is not coming back
            kept = dict(it)
            kept["carried"] = True
            listings.append(kept)
            have.add(url)
            held += 1
    return held


def export(out_dir: str) -> dict:
    init_db()
    os.makedirs(out_dir, exist_ok=True)
    with SessionLocal() as db:
        rows = db.scalars(
            select(Listing).order_by(Listing.relevance_score.desc(), Listing.first_seen.desc())
        ).all()
        listings = still_student_opportunities([_listing_dict(r) for r in rows])
        generated_at = datetime.now(timezone.utc).isoformat()
        for x in listings:
            x["last_seen"] = generated_at   # this run really did read these off the board
        # Before write_shards overwrites it: the export on disk is the only record of when we
        # first saw any of this and of what the boards held, because the db does not outlive a run.
        prev = previous_export(out_dir)
        carried = carry_first_seen(listings, out_dir, prev=prev)
        held = carry_open_boards(listings, out_dir, prev=prev)
        stats = {
            "total": len(listings),
            "open": sum(1 for x in listings if x["status"] == "open"),
            "new": sum(1 for x in listings if x["is_new"]),
            "held": held,
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
    print(f"[export] {carried} of {len(listings)} listings kept a first-seen date from the "
          f"last export; {sum(1 for x in listings if x['is_new'])} new in {NEW_DAYS} days")
    print(f"[export] {held} listings held from the last export because their board came back "
          f"with half or less of what it had")
    index = write_shards(listings, out_dir, generated_at)
    unplaced = [x for x in listings if not shard_keys(x)]
    print(f"[export] wrote {len(listings) - len(unplaced)} listings "
          f"({len(index['files'])} state files) to {out_dir}")
    if unplaced:
        print(f"[export] {len(unplaced)} listings name no US location today's rules can place, so "
              f"they are in no state file and the site cannot show them: "
              + "; ".join(f"{x.get('company_name')} - {x.get('location_raw') or 'no location'}"
                          for x in unplaced[:5]))
    return stats


if __name__ == "__main__":
    import sys
    export(sys.argv[1] if len(sys.argv) > 1 else "docs/data")
