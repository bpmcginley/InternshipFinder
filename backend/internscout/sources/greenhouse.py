"""Greenhouse public boards API. The list call is light; content is fetched only for
internship postings that might be in region."""
from __future__ import annotations
from .base import client
from .common import board_item, counts_of, html_to_text, reported_count, stamp_board_newest
from ..classify import is_internship
from ..region import board_state, maybe_in_region, place_bare_cities

LIST_URL = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs"
JOB_URL = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}"
MAX_DETAIL = 25


def parse_greenhouse(payload: dict, co: dict) -> list[dict]:
    out, board, counts = [], [], counts_of(co)
    for j in payload.get("jobs", []):
        loc = (j.get("location") or {}).get("name")
        board.append(loc)
        title = j.get("title", "")
        if not is_internship(title):
            counts.discard("not_student")
            continue
        it = board_item(co, source="greenhouse", title=title, locations=[loc],
                        url=j.get("absolute_url"),
                        posted_at=j.get("first_published") or j.get("updated_at"),
                        description=html_to_text(j.get("content")))
        it["_gh_id"] = j.get("id")
        out.append(it)
    place_bare_cities(out, board_state(board))
    # Every job's dates, not only the internships': is anyone still adding to this board?
    stamp_board_newest(out, [d for j in payload.get("jobs", []) for d in (j.get("first_published"), j.get("updated_at"))])
    return out


def fetch_greenhouse_board(c, co: dict) -> list[dict]:
    token = co["ats_token"]
    resp = c.get(LIST_URL.format(token=token))
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list) or not all(
            isinstance(job, dict) for job in payload["jobs"]):
        raise ValueError("Greenhouse response is missing its complete jobs list")
    counts = counts_of(co)
    counts.rows(len(payload["jobs"]))
    # The list is unpaged, so what it holds is what the board listed; meta.total, when the API
    # sends one, is the board's own count and is preferred.
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    stated = reported_count(meta.get("total"))
    counts.reported(stated if stated is not None else len(payload["jobs"]))
    items = parse_greenhouse(payload, co)
    for it in [i for i in items if any(maybe_in_region(l) for l in i["locations"])][:MAX_DETAIL]:
        try:
            d = c.get(JOB_URL.format(token=token, id=it["_gh_id"]))
            if d.status_code == 200:
                it["description"] = html_to_text(d.json().get("content"))[:4000]
        except Exception:
            pass
    co["_scan_complete"] = True  # list endpoint is exhaustive; detail limits do not truncate it
    return items


def fetch_greenhouse(companies: list[dict]) -> list[dict]:
    out: list[dict] = []
    with client() as c:
        for co in companies:
            try:
                out += fetch_greenhouse_board(c, co)
            except Exception as e:
                print(f"[greenhouse] {co['name']} ({co['ats_token']}) failed: {e}")
    return out
