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
import re
from urllib.parse import parse_qs, urlsplit
from datetime import datetime, timezone
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from .db import SessionLocal, init_db
from .models import Listing, Application
from .seo_pages import baseline_day, canada_first_scan, placeholder_pay
from .config import PROFILE, REGION, BASELINE_STATES, wanted_states
from .insights import extract, PATTERNS
from .classify import STAGES, never_student, non_cyber_security, stage_of, years_of
from .majors import majors_export
from .normalize import listing_id
from .dedupe import _canon_job, requisition_identity
from .pay import only_placeholder_amounts
from .score import W
from .region import evaluate_locations
from .scan_evidence import FULL_LIST, SEARCH_SCOPED, canonical, export_board

DESC_CHARS = 1500
# 2026-10-23: distinguish pre-truncation extraction from legacy exported eligibility (DQ-1).
# Revert: remove this marker and discard_legacy_grad_windows together.
INSIGHTS_TEXT_VERSION = 2


def _regions(row: Listing) -> list[dict]:
    # Re-read the raw locations so older rows get today's rules too; region_locations keeps
    # places other sources of the same role listed.
    ev = evaluate_locations([row.location_raw or ""] + (row.region_locations or []))["regions"]
    return list({g["loc"]: g for g in ev}.values())


def shard_keys(listing: dict) -> set[str]:
    """The listing files a listing belongs in: each state or Canadian province it names, "remote" for
    US-remote roles with no state, "US" for roles that name only the country, "Canada" for Canadian
    roles that name no province (remote ones included: Canada has no remote file of its own).

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
            # was: "remote" if remote else "US"
            keys.add("remote" if g["kind"] == "remote" else "Canada" if g["kind"] == "canada" else "US")
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
    index["first"] = write_first_screen(listings, out_dir)
    _dump(index, os.path.join(shard_dir, "index.json"), indent=1)
    return index


# The first screen (2026-10-14, P2). A first visit (no profile, no filters, newest first) draws its
# list from the Northeast and remote files, about 550 KB, and on a 20 KB/s connection the first row
# came 18 s in. first.json holds the top rows of exactly that view, as the same slim rows the state
# files carry, so the dashboard can paint from one small request and the state files fill in after.
# The order copies IS.sortRows "new" in docs/js/core.js with no profile: dated postings first, then
# posted_at, then first_seen, newest first. The dashboard keeps the first copy of a row it is given,
# so these rows are the very rows the state files hold, and the top of the list doesn't move when
# they land. Outside listings/ so nothing that reads every state file there mistakes it for one.
# Only the first viewport needs to arrive before a student sees usable results. Twelve rows cover
# the ten-result email invitation and two more cards; the unchanged state files fill in the rest.
# Keeping sixty here made that first paint wait for five screens of results it could not show yet.
FIRST_SCREEN_ROWS = 12
FIRST_SCREEN_KEYS = sorted(BASELINE_STATES) + ["remote"]


def first_screen(listings: list[dict], n: int = FIRST_SCREEN_ROWS) -> list[dict]:
    keys = set(FIRST_SCREEN_KEYS)
    rows = [x for x in listings if x["status"] == "open" and shard_keys(x) & keys]
    rows.sort(key=lambda x: (1 if x.get("posted_at") else 0, x.get("posted_at") or "", x.get("first_seen") or ""),
              reverse=True)
    return [shard_row(x) for x in rows[:n]]


def write_first_screen(listings: list[dict], out_dir: str) -> dict:
    rows = first_screen(listings)
    _dump(rows, os.path.join(out_dir, "first.json"))
    return {"file": "first.json", "keys": FIRST_SCREEN_KEYS, "sort": "new", "rows": len(rows)}


def _listing_dict(row: Listing) -> dict:
    regions = _regions(row)
    # 2026-10-23: adapters now retain full fetched text (was: capped at 4000).
    # Extract before the public-description cap below; carried exports keep their saved insights.
    # Revert: restore source caps, leaving this extraction order unchanged (DQ-1).
    ins = extract(row.description) if row.status == "open" else None
    # 2026-10-23: an impossible salary must not create a Paid badge through dollar detection.
    # Raw salary remains in Listing for source investigation. Revert: remove this suppression.
    if (ins and ins.get("pay") == "paid"
            and (placeholder_pay(row.salary) or only_placeholder_amounts(row.description))
            and not re.search(r"\bpaid (?:internship|position|opportunity|role|co-?op)", row.description or "", re.I)):
        ins.pop("pay", None)
    # A placeholder salary ("$0.00 /Yr", "$0.00 - $999.99 Hour") is a board with no pay to show, not
    # a paid role (seo_pages.placeholder_pay); the dashboard's pay badge reads this flag.
    if ins is not None and "pay" not in ins and row.salary and not placeholder_pay(row.salary):
        # was: if ins is not None and "pay" not in ins and row.salary:
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
        # 2026-10-23: was raw salary; keep raw provenance in the DB, omit malformed public pay.
        # Revert: publish row.salary directly again.
        "salary": row.salary if not placeholder_pay(row.salary) else None,
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
        "insights_text_version": INSIGHTS_TEXT_VERSION if ins is not None else None,
        "is_new": row.is_new,
        "first_seen": row.first_seen.isoformat() if row.first_seen else None,
        # The CI database is rebuilt every run. Preserve which keyword adapters
        # actually found this role so a later export can assess their scan scope.
        "scan_sources": sorted({link.source for link in row.source_links
                                if link.source in SEARCH_SCOPED}),
        **({"via_search": True} if _search_only(row) else {}),
    }


def _search_only(row: Listing) -> bool:
    """Found only by the paid Google Jobs searches, which run once a day (see carry_search_finds)."""
    sources = {s.source for s in row.source_links}
    return sources == {"google_jobs"}


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
    published 13 SkillBridge postings - active-duty service members only - because the feed
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
    mark_new(listings, today)
    return carried


def mark_new(listings: list[dict], today=None) -> None:
    """Set is_new on every listing.

    New means what the landing pages mean by it (seo_pages.fresh): found in the last week, not an
    old posting a scan only just reached, and not one already open on the day first_seen began
    (2026-09-18), which marked every listing on the site as new.

    export() calls this again after carry_open_boards and carry_search_finds: the rows they carry
    over come from the last export with the is_new that export gave them, so a role new a week ago
    kept its New badge for as long as its board kept failing to answer.
    """
    today = today or datetime.now(timezone.utc).date()
    baseline = baseline_day(listings)
    for x in listings:
        if canada_first_scan(x):        # seo_pages.CANADA_SINCE: new only if posted this week
            x["is_new"] = bool(x.get("posted_at") and _seen_within(x["posted_at"], today, NEW_DAYS))
            continue
        x["is_new"] = (_seen_within(x.get("first_seen"), today, NEW_DAYS)
                       and not (baseline and str(x.get("first_seen") or "")[:10] <= baseline)
                       and (not x.get("posted_at") or _seen_within(x["posted_at"], today, 2 * NEW_DAYS)))


# Hosts whose first path segment names the employer's board: boards.greenhouse.io/point72,
# jobs.lever.co/sambatv, jobs.ashbyhq.com/brainco, a Workday tenant's /<site>/. Everywhere else the
# host itself is the board (careers-nrdc.icims.com, eaton.eightfold.ai, an employer's own site).
# Workable is left out: one board's links come both as /mindex/j/... and as /j/....
_PATH_BOARD_HOSTS = {"greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "jobs.jobvite.com",
                     "ats.rippling.com", "jobs.smartrecruiters.com"}
# Workday's locale prefix (/en-US/, /fr-CA/). Only the two-part form: two-letter sites exist (KLA's /UR/, /JJ/).
_LOCALE = re.compile(r"^[a-z]{2}-[a-z]{2}$", re.I)


def board_of(x: dict) -> tuple:
    """Which board a listing came from: (ats, company, board read from its apply URL).

    was (until 2026-10-14): (ats, company name), so an employer with two boards on one ATS (AIG's
    two Workday sites, Astera Labs) counted as one, and when one of them failed while the other
    answered, the failed board's listings could drop (release checks for 0.5.7). The company stays
    in the key, so a board is never merged with another employer's, only told apart from the same
    employer's other boards. URL spellings of the same board are folded together (boards. and
    job-boards.greenhouse.io and its embed form, Workday's wd1/wd5 hosts and locale prefix), since a
    board read as new would look like the old one collapsed and its rows would come back twice.
    """
    try:
        u = urlsplit(x.get("apply_url") or "")
    except ValueError:
        return (x.get("ats"), x.get("company_name"), "")
    host = (u.hostname or "").lower()
    segs = [p for p in u.path.split("/") if p]
    if host.endswith(".myworkdayjobs.com"):
        host = host.split(".")[0] + ".myworkdayjobs.com"
        if segs and _LOCALE.match(segs[0]):
            segs = segs[1:]
        token = segs[0].lower() if segs else ""
    elif host in ("boards.greenhouse.io", "job-boards.greenhouse.io"):
        host = "greenhouse.io"
        token = ((parse_qs(u.query).get("for") or [""])[0] if segs[:1] == ["embed"] else (segs[0] if segs else "")).lower()
    elif host in _PATH_BOARD_HOSTS:
        token = segs[0].lower() if segs else ""
    else:
        token = ""
    return (x.get("ats"), x.get("company_name"), f"{host}/{token}")


def _observed_keys(urls) -> set[str]:
    return {key for url in urls or () if (key := _canon_job(url))}


def _absent_from_scan(listing: dict, completed: set, observed: set) -> bool:
    """Completion proves absence only for unobserved records within its scope.

    Older exports lack scope provenance; do not guess that a keyword search
    could have returned them. A full-board list does not need that provenance.
    """
    if _canon_job(listing.get("apply_url")) in observed:
        return False
    board = export_board(listing, completed)
    if not board:
        return False
    sources = listing.get("scan_sources")
    return board[0] in FULL_LIST or (isinstance(sources, list) and board[0] in sources)


def _requisition_key(row: dict):
    identity = requisition_identity(row.get("apply_url"))
    return ((row.get("company_name") or "").casefold(), identity) if identity else None


def carry_open_boards(listings: list[dict], out_dir: str, today=None, prev=None,
                      completed_boards=None, observed_urls=None) -> int:
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

    Complete scans close missing rows only within their scope. Observed posting URLs survive
    missing detail metadata, and keyword scans retain community/legacy rows with unknown scope.
    These cases do not require a board-wide collapse, but keep the existing freshness bound.
    A board that failed, hit a page cap, or has no way to prove a full read keeps the old rule.
    """
    prev = previous_export(out_dir) if prev is None else prev
    today = today or datetime.now(timezone.utc).date()
    have = {x["apply_url"] for x in listings if x.get("apply_url")}
    # 2026-10-23: was exact URLs only; a renamed/locale copy must not resurrect stale facts.
    # Revert: remove have_requisitions and its checks in both carry functions.
    have_requisitions = {_requisition_key(x) for x in listings} - {None}
    completed = canonical(completed_boards)
    observed = _observed_keys(observed_urls)

    # One stable listing can move between an employer's boards or change its URL.
    # A failed old board must not append a stale copy over the freshly fetched ID.
    have_ids = {x["id"] for x in listings if x.get("id")}

    now_open = Counter(board_of(x) for x in listings if x.get("status") == "open")
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
            was_open[board_of(it)].append({**it, "stage": stage})

    held = 0
    for key, rows in was_open.items():
        collapsed = len(rows) >= COLLAPSE_FLOOR and now_open.get(key, 0) <= COLLAPSE_RATIO * len(rows)
        for it in rows:
            url = it.get("apply_url")
            if (not url or url in have or _requisition_key(it) in have_requisitions
                    or (it.get("id") and it["id"] in have_ids)):
                continue
            if not _seen_within(it.get("last_seen") or it.get("first_seen"), today, CARRY_DAYS):
                continue   # the board has been quiet for days; it is not coming back
            if _absent_from_scan(it, completed, observed):
                continue
            board = export_board(it, completed)
            seen = _canon_job(url) in observed
            # Positive URL observations and out-of-scope keyword scans do not
            # depend on an employer losing at least half of three postings.
            if not (collapsed or seen or (board and board[0] in SEARCH_SCOPED)):
                continue
            kept = dict(it)
            kept["carried"] = True
            listings.append(kept)
            have.add(url)
            identity = _requisition_key(it)
            if identity:
                have_requisitions.add(identity)
            if it.get("id"):
                have_ids.add(it["id"])
            held += 1
    return held


def carry_search_finds(listings: list[dict], out_dir: str, today=None, prev=None,
                       completed_boards=None, observed_urls=None) -> int:
    """Keep what the Google Jobs searches found until they have had a chance to find it again.

    Those searches cost money and run once a day, on the first run after midnight UTC; the three
    runs after it do not search. The database does not outlive a run, so a listing only a search
    found was published by the daily export and deleted by the next one, six hours later: the
    2026-09-23 02:48 export held the searches' finds and the 10:49 one had none of them. That also
    blinded focus.py, which reads the last export to see which fields are still thin, to
    everything its own searches turned up.

    So such a listing is carried from the last export for CARRY_DAYS after a search last saw it,
    the same bound a board that failed to answer gets.

    Except when the posting's own board proves absence within the row's scope and the posting
    was not observed in raw input. Google-only rows have no keyword-adapter provenance, so a
    keyword-scoped scan cannot close them, as pipeline.run also requires.
    """
    prev = previous_export(out_dir) if prev is None else prev
    today = today or datetime.now(timezone.utc).date()
    have = {x["apply_url"] for x in listings if x.get("apply_url")}
    have_requisitions = {_requisition_key(x) for x in listings} - {None}
    have_ids = {x["id"] for x in listings if x.get("id")}
    completed = canonical(completed_boards)
    observed = _observed_keys(observed_urls)
    held = 0
    for it in prev:
        url = it.get("apply_url")
        if (not it.get("via_search") or it.get("status") != "open" or not url or url in have
                or _requisition_key(it) in have_requisitions
                or (it.get("id") and it["id"] in have_ids)):
            continue
        if _absent_from_scan(it, completed, observed):
            continue
        if not _seen_within(it.get("last_seen") or it.get("first_seen"), today, CARRY_DAYS):
            continue
        stage = merged_stages(it.get("stage"), it.get("title") or "")
        if not stage:
            continue
        listings.append({**it, "stage": stage, "carried": True})
        have.add(url)
        identity = _requisition_key(it)
        if identity:
            have_requisitions.add(identity)
        if it.get("id"):
            have_ids.add(it["id"])
        held += 1
    return held


def closed_by_scan(listings: list[dict], prev: list[dict], completed_boards, observed_urls=None) -> int:
    """How many of the last export's open rows this run's complete scans closed, for the log."""
    completed = canonical(completed_boards)
    if not completed:
        return 0
    have = {x.get("apply_url") for x in listings}
    observed = _observed_keys(observed_urls)
    return sum(1 for it in prev if it.get("status") == "open" and it.get("apply_url")
               and it["apply_url"] not in have and _absent_from_scan(it, completed, observed))


def correct_non_cyber_security_tags(listings: list[dict]) -> None:
    """Apply the explicit non-cyber exclusion to stored and carried classifications too.

    Normalization classifies fetched rows, but a failed board's carried rows retain their old tags.
    Remove only this disproven tag: do not replace historical field evidence or alter the dates,
    status or provenance of a posting that this run did not actually fetch.
    """
    for x in listings:
        tags = x.get("field_tags") or []
        if "security" in tags and non_cyber_security(x.get("title") or ""):
            x["field_tags"] = [t for t in tags if t != "security"] or ["other"]


def discard_legacy_grad_windows(listings: list[dict]) -> None:
    """Old carried excerpts cannot prove that a graduation window was read to its end.

    2026-10-23: was: every carried grad_years remained a hard eligibility restriction,
    including the known CVS false blocker. Keep unrelated insights and dates; a fresh
    source read restores this field with versioned evidence. Never infer a wider range.
    Revert: remove this call and the insights_text_version marker together (DQ-1).
    """
    for listing in listings:
        if (listing.get("carried") and listing.get("insights_text_version") != INSIGHTS_TEXT_VERSION
                and isinstance(listing.get("insights"), dict) and "grad_years" in listing["insights"]):
            listing["insights"] = {k: v for k, v in listing["insights"].items() if k != "grad_years"}


def discard_placeholder_paid_claims(listings: list[dict]) -> None:
    """Keep carried raw pay provenance, but discard its old inferred Paid badge."""
    # 2026-10-23: was only sanitizing newly fetched rows in _listing_dict. Legacy carryover
    # can contain the same malformed salary and old promoted insights.pay for two more days.
    # Revert: remove this post-carry helper and call together.
    for listing in listings:
        ins = listing.get("insights")
        if (placeholder_pay(listing.get("salary")) and isinstance(ins, dict) and ins.get("pay") == "paid"
                and not re.search(r"\bpaid (?:internship|position|opportunity|role|co-?op)", listing.get("description") or "", re.I)):
            listing["insights"] = {key: value for key, value in ins.items() if key != "pay"}


def export(out_dir: str, completed_boards=None, observed_urls=None) -> dict:
    """Write the static site data.

    completed_boards is the (ats, token) evidence run_ingest.scan_boards collected this run. CI
    rebuilds its database every run, so the carry rules below, not the database, decide whether
    a missing posting stays on the site; passing the evidence makes them close what the scans
    proved closed. Without it (a standalone export) every board keeps the carry rules as before.
    observed_urls holds raw posting URLs seen this run, even when normalization could not place
    them; a complete list is not proof that those postings disappeared.
    """
    init_db()
    os.makedirs(out_dir, exist_ok=True)
    with SessionLocal() as db:
        rows = db.scalars(
            # source_links in one query: _listing_dict reads them for every row (via_search).
            select(Listing).options(selectinload(Listing.source_links))
            .order_by(Listing.relevance_score.desc(), Listing.first_seen.desc())
        ).all()
        listings = still_student_opportunities([_listing_dict(r) for r in rows])
        generated_at = datetime.now(timezone.utc).isoformat()
        for x in listings:
            x["last_seen"] = generated_at   # this run really did read these off the board
        # Before write_shards overwrites it: the export on disk is the only record of when we
        # first saw any of this and of what the boards held, because the db does not outlive a run.
        prev = previous_export(out_dir)
        carried = carry_first_seen(listings, out_dir, prev=prev)
        held = carry_open_boards(listings, out_dir, prev=prev, completed_boards=completed_boards,
                                 observed_urls=observed_urls)
        held += carry_search_finds(listings, out_dir, prev=prev, completed_boards=completed_boards,
                                  observed_urls=observed_urls)
        closed = closed_by_scan(listings, prev, completed_boards, observed_urls=observed_urls)
        correct_non_cyber_security_tags(listings)
        discard_legacy_grad_windows(listings)
        discard_placeholder_paid_claims(listings)
        # Again, now the carried rows are in: they came with the is_new the last export gave them.
        # Dated from generated_at, the "today" seo_pages.fresh uses for /internships/new/.
        mark_new(listings, datetime.fromisoformat(generated_at).date())
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
    print(f"[export] {closed} listings from the last export left the site because a complete "
          f"scan of their board this run did not find them "
          f"({len(canonical(completed_boards))} boards read to the end)")
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
