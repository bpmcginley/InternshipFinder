"""Rippling ATS public board API. It returns one row per (job, location), so rows are grouped by job.

The board list carries no description at all. The per-job call on the same API does, split into
'role', which is the advert, and 'company', which is the same employer boilerplate on every job -
left out for the reason SmartRecruiters' companyDescription is. That call is also the only place
Rippling gives a posting date. Checked live on four tenants, all the same shape.
"""
from __future__ import annotations
import re
from .common import board_item, counts_of, html_to_text, mark_complete
from ..classify import is_internship
from ..region import maybe_in_region

URL = "https://api.rippling.com/platform/api/ats/v1/board/{token}/jobs"
JOB_URL = "https://api.rippling.com/platform/api/ats/v1/board/{token}/jobs/{uuid}"
MAX_DETAIL = 25
# 'createdOn' is a full timestamp with an offset; the day is all that is wanted here.
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def parse_rippling(payload, co: dict) -> list[dict]:
    rows = payload if isinstance(payload, list) else (payload or {}).get("jobs") or []
    jobs: dict[str, dict] = {}
    counts = counts_of(co)
    for j in rows:
        title = j.get("name", "")
        if not is_internship(title):
            counts.discard("not_student")
            continue
        key = j.get("uuid") or j.get("url")
        if key in jobs:
            counts.discard("duplicate")   # the same job's row for another location
        e = jobs.setdefault(key, {"title": title, "url": j.get("url"), "locs": [], "uuid": j.get("uuid")})
        label = (j.get("workLocation") or {}).get("label")
        if label and label not in e["locs"]:
            e["locs"].append(label)
    out = []
    for e in jobs.values():
        it = board_item(co, source="rippling", title=e["title"], locations=e["locs"], url=e["url"])
        it["_rp_uuid"] = e["uuid"]
        out.append(it)
    return out


def parse_rippling_detail(payload: dict) -> tuple[str, str | None]:
    """(description, posted date) from the per-job call. Either may be missing."""
    desc = (payload or {}).get("description") or {}
    day = DATE_RE.match(str((payload or {}).get("createdOn") or ""))
    return html_to_text(desc.get("role")), day.group(1) if day else None


def fetch_rippling_board(c, co: dict) -> list[dict]:
    token = co["ats_token"]
    r = c.get(URL.format(token=token))
    r.raise_for_status()
    payload = r.json()
    # The v1 board call takes no paging parameters and answers with a bare array of every
    # (job, location) row. Only that shape is the whole board: an object wrapping "jobs" could be
    # one page of a paged envelope, so it is read but proves nothing.
    complete = isinstance(payload, list) and all(isinstance(j, dict) for j in payload)
    rows = payload if isinstance(payload, list) else (payload or {}).get("jobs") or []
    counts = counts_of(co)
    counts.rows(len(rows))
    counts.reported(len(rows) if complete else None)
    items = parse_rippling(payload, co)
    for it in [i for i in items if any(maybe_in_region(l) for l in i["locations"])][:MAX_DETAIL]:
        try:
            d = c.get(JOB_URL.format(token=token, uuid=it["_rp_uuid"]))
            if d.status_code == 200:
                desc, posted = parse_rippling_detail(d.json())
                # 2026-10-23: extract eligibility before public trimming; was: [:4000].
                # Revert: restore [:4000] here (DQ-1).
                it["description"] = desc
                it["posted_at"] = posted or it["posted_at"]
        except Exception:
            pass
    for it in items:
        it.pop("_rp_uuid", None)
    mark_complete(co, complete)
    return items
