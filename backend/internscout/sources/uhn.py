"""University Health Network (Toronto): Canada's largest research hospital, from its own careers site.

forms.uhn.ca/UHNCareers is UHN's job list (Toronto General, Toronto Western, Princess Margaret,
Toronto Rehab, Michener, West Park). The page fills its table from one JSON call, which is all this
reads: title, site, department and employment type, no descriptions. The site serves no robots.txt.
Each posting links to UHN's own posting address, which forwards to the employer's job page.

Most of UHN's 200 or so openings are staff roles; the student ones (summer students, research
students, co-ops) come in seasons, so a run with none is normal. Added 2026-09-30 with Canada, for
the health, research and biology majors the Canadian job boards barely served.
"""
from __future__ import annotations
from .base import client
from .common import board_item
from ..classify import is_internship

LIST_URL = "https://forms.uhn.ca/UHNCareers/Home/GetAll"
POSTING_URL = "https://forms.uhn.ca/UHNCareers/Home/Posting/{id}"
# Every UHN site is in Toronto; the list names the hospital, never the city.
WHERE = "Toronto, ON"


def parse_uhn(payload: dict) -> list[dict]:
    out = []
    for j in (payload or {}).get("data") or []:
        title = (j.get("name") or "").strip()
        emp = j.get("employment") or ""
        if not j.get("id") or not is_internship(title, emp):
            continue
        site, dept = (j.get("site") or "").strip(), (j.get("department") or "").strip()
        about = " · ".join(x for x in (site, dept, emp) if x)
        out.append(board_item({"name": "University Health Network", "sector": "health"}, source="uhn",
                              title=title, locations=[WHERE],
                              url=POSTING_URL.format(id=j["id"]), description=about, employment_type=emp))
    return out


def fetch_uhn() -> list[dict]:
    try:
        with client() as c:
            r = c.get(LIST_URL)
            r.raise_for_status()
            out = parse_uhn(r.json())
    except Exception as e:
        print(f"[uhn] failed: {type(e).__name__}")
        return []
    print(f"[uhn] {len(out)} student postings")
    return out
