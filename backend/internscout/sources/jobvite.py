"""Jobvite hosted career pages (public agencies, mid-size employers). Token: the company slug in
jobs.jobvite.com/<slug>/jobs. The list page is HTML with every opening; in-region internships get
one job-page fetch for the description (capped)."""
from __future__ import annotations
import html
import re
from .common import board_item, html_to_text
from ..classify import is_internship
from ..region import maybe_in_region

BASE = "https://jobs.jobvite.com"
MAX_DETAIL = 25
_ROW = re.compile(r'<td class="jv-job-list-name">\s*<a href="([^"]+)">([^<]+)</a>\s*</td>\s*'
                  r'<td class="jv-job-list-location">(.*?)</td>', re.S)
_DESC = re.compile(r'<div class="jv-job-detail-description"[^>]*>(.*?)<div class="jv-job-detail-bottom', re.S)


def parse_jobvite(page: str, co: dict) -> list[dict]:
    out = []
    for href, title, loc in _ROW.findall(page):
        title = html.unescape(title).strip()
        if not is_internship(title):
            continue
        loc = re.sub(r"\s+", " ", html_to_text(loc)).strip()
        loc = re.sub(r"\s+,", ",", loc)
        url = BASE + href if href.startswith("/") else href
        out.append(board_item(co, source="jobvite", title=title, locations=[loc], url=url,
                              apply_url=url.rstrip("/") + "/apply"))
    return out


def parse_jobvite_detail(page: str) -> str:
    m = _DESC.search(page)
    return html_to_text(m.group(1)) if m else ""


def fetch_jobvite_board(c, co: dict) -> list[dict]:
    r = c.get(f"{BASE}/{co['ats_token']}/jobs")
    r.raise_for_status()
    out = parse_jobvite(r.text, co)
    n = 0
    for it in out:
        if n >= MAX_DETAIL or not maybe_in_region(it["locations"][0]):
            continue
        n += 1
        try:
            d = c.get(it["url"])
            if d.status_code == 200:
                it["description"] = parse_jobvite_detail(d.text)[:4000]
        except Exception:
            pass
    return out
