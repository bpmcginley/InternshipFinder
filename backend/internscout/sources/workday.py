"""Workday career sites via the CXS JSON API (the same calls the site's own UI makes).

Token: "tenant|wdN|site", e.g. "modernatx|wd1|M_tx".
"""
from __future__ import annotations
from .common import board_item, html_to_text
from ..classify import is_internship
from ..region import maybe_in_region

PAGE = 20
MAX_OFFSET = 200
MAX_DETAIL = 40
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def host_of(token: str) -> tuple[str, str, str]:
    tenant, wd, site = token.split("|")
    return f"https://{tenant}.{wd}.myworkdayjobs.com", tenant, site


def parse_workday_list(payload: dict) -> list[dict]:
    return [p for p in payload.get("jobPostings") or [] if is_internship(p.get("title", ""))]


def parse_workday_detail(payload: dict) -> tuple[list[str], str]:
    info = payload.get("jobPostingInfo") or {}
    locs = [info.get("location")] + list(info.get("additionalLocations") or [])
    return [l for l in locs if l], html_to_text(info.get("jobDescription"))


def fetch_workday_board(c, co: dict) -> list[dict]:
    host, tenant, site = host_of(co["ats_token"])
    api = f"{host}/wday/cxs/{tenant}/{site}"
    postings, offset, total = [], 0, None
    while True:
        r = c.post(f"{api}/jobs", headers=HEADERS,
                   json={"appliedFacets": {}, "limit": PAGE, "offset": offset, "searchText": "intern"})
        r.raise_for_status()
        data = r.json()
        page = data.get("jobPostings") or []
        if total is None:
            total = data.get("total") or 0   # only reported on the first page
        postings += parse_workday_list(data)
        offset += PAGE
        if not page or offset >= total or offset >= MAX_OFFSET:
            break

    out = []
    for i, p in enumerate(postings):
        path = p.get("externalPath") or ""
        url = f"{host}/{site}{path}"
        text = p.get("locationsText") or ""
        locs, desc = [text], ""
        multi = "location" in text.lower()   # "3 Locations"
        if i < MAX_DETAIL and (multi or maybe_in_region(text)):
            try:
                d = c.get(f"{api}{path}", headers=HEADERS)
                if d.status_code == 200:
                    dl, desc = parse_workday_detail(d.json())
                    locs = dl or locs
            except Exception:
                pass
        out.append(board_item(co, source="workday", title=p.get("title", ""), locations=locs,
                              url=url, description=desc,
                              employment_type=" ".join(p.get("bulletFields") or [])))
    return out
