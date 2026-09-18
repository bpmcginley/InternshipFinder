"""Taleo career sections (state agencies, health systems, insurers). Token: "tenant|section" or
"tenant|section|portal", e.g. "textron|textron|8140753014". The portal id is read from the public
search page when the token lacks it. Searched server-side by keyword.

The search results carry no description, and the job page renders its own from a hidden field
rather than serving it as markup: the career section stores the whole page state in one
percent-encoded, "!|!"-separated string called initialHistory, and the description is the part of
it that contains HTML. Fields the employer wrote as plain text - pay ranges, EEO and export-control
statements - carry no markup and so stay out, which is the boilerplate we would have dropped
anyway. Every block is serialized twice, and ":" arrives escaped, since it separates the pieces.

No tenant serves a robots.txt at all (checked on textron, massanf and hyatt: 404), and the page is
80-400 KB, so it is fetched on the same terms as the other boards - only for postings that might be
somewhere a student asked for, capped per board."""
from __future__ import annotations
import json
import re
import urllib.parse
from .common import board_item, html_to_text
from ..classify import is_internship
from ..region import maybe_in_region

BASE = "https://{tenant}.taleo.net/careersection"
KEYWORDS = ("intern", "internship", "co-op", "student")
MAX_PAGES = 8   # 25 per page
MAX_DETAIL = 25
HEADERS = {"Content-Type": "application/json", "tz": "GMT-04:00", "tzname": "America/New_York"}
_PORTAL = re.compile(r"portal[^0-9]{0,20}(\d{6,})")
_HISTORY = re.compile(r'name="initialHistory"[^>]*value="([^"]*)"')


def _body(keyword: str, page: int) -> dict:
    return {"multilineEnabled": False,
            "sortingSelection": {"sortBySelectionParam": "3", "ascendingSortingOrder": "false"},
            "fieldData": {"fields": {"KEYWORD": keyword, "LOCATION": "", "ORGANIZATION": ""}, "valid": True},
            "filterSelectionParam": {"searchFilterSelections": []},
            "advancedSearchFiltersSelectionParam": {"searchFilterSelections": []},
            "pageNo": page}


def _place(s: str) -> str | None:
    """"US-Maryland-Hunt Valley" -> "Hunt Valley, Maryland"; non-US -> None."""
    parts = [p.strip() for p in s.split("-", 2)]
    if parts[0].upper() not in ("US", "USA", "UNITED STATES"):
        return None
    if len(parts) == 3:
        return f"{parts[2]}, {parts[1]}"
    return parts[1] if len(parts) == 2 else "United States"


def _date(s: str | None) -> str | None:
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", (s or "").strip())
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def parse_taleo(payload: dict, co: dict, tenant: str, section: str) -> tuple[list[dict], int]:
    out = []
    for r in payload.get("requisitionList") or []:
        cols = r.get("column") or []
        title = cols[r.get("linkedColumn", 0)] if cols else ""
        if not is_internship(title):
            continue
        locs, dates = [], []
        for i, v in enumerate(cols):
            if i in (r.get("locationsColumns") or []):
                try:
                    raw = json.loads(v) if v.startswith("[") else [v]
                except ValueError:
                    raw = [v]
                locs += [p for p in map(_place, raw) if p]
            elif _date(v):
                dates.append(_date(v))
        if not locs:
            continue
        out.append(board_item(co, source="taleo", title=title, locations=locs,
                              url=f"{BASE.format(tenant=tenant)}/{section}/jobdetail.ftl?job={r.get('contestNo')}",
                              posted_at=dates[0] if dates else None))
    return out, int((payload.get("pagingData") or {}).get("totalCount") or 0)


def parse_taleo_detail(html: str) -> str:
    """The requisition's own text, out of the career section's serialized page state."""
    m = _HISTORY.search(html or "")
    if not m:
        return ""
    blocks: list[str] = []
    for part in m.group(1).split("!|!"):
        if "%3C" not in part:          # a part with no markup in it is a label or a flag, not the advert
            continue
        part = part[3:] if part.startswith("!*!") else part
        if part not in blocks:         # each block is serialized twice
            blocks.append(part)
    return "\n".join(html_to_text(urllib.parse.unquote(b).replace("\\:", ":")) for b in blocks)


def _portal(c, tenant: str, section: str) -> str:
    r = c.get(f"{BASE.format(tenant=tenant)}/{section}/jobsearch.ftl", params={"lang": "en"})
    r.raise_for_status()
    m = _PORTAL.search(r.text)
    if not m:
        raise ValueError(f"no Taleo portal id for {tenant}/{section}")
    return m.group(1)


def fetch_taleo_board(c, co: dict) -> list[dict]:
    parts = co["ats_token"].split("|")
    tenant, section = parts[0], parts[1]
    portal = parts[2] if len(parts) > 2 else _portal(c, tenant, section)
    url = f"{BASE.format(tenant=tenant)}/rest/jobboard/searchjobs"
    seen: dict[str, dict] = {}
    for kw in KEYWORDS:
        for page in range(1, MAX_PAGES + 1):
            r = c.post(url, params={"lang": "en", "portal": portal}, json=_body(kw, page), headers=HEADERS)
            r.raise_for_status()
            items, total = parse_taleo(r.json(), co, tenant, section)
            for it in items:
                seen.setdefault(it["url"], it)
            if page * 25 >= total:
                break
    out = list(seen.values())
    for it in [i for i in out if any(maybe_in_region(l) for l in i["locations"])][:MAX_DETAIL]:
        try:
            d = c.get(it["url"])
            if d.status_code == 200:
                it["description"] = parse_taleo_detail(d.text)[:4000]
        except Exception:
            pass
    return out
