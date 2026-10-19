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
from .common import ScanCounts, board_item, report_source
from ..classify import is_internship

LIST_URL = "https://forms.uhn.ca/UHNCareers/Home/GetAll"
POSTING_URL = "https://forms.uhn.ca/UHNCareers/Home/Posting/{id}"
# Every UHN site is in Toronto; the list names the hospital, never the city.
WHERE = "Toronto, ON"


def parse_uhn(payload: dict, counts: ScanCounts | None = None) -> list[dict]:
    out, counts = [], counts if counts is not None else ScanCounts()
    for j in (payload or {}).get("data") or []:
        title = (j.get("name") or "").strip()
        emp = j.get("employment") or ""
        if not j.get("id"):
            counts.discard("unreadable")
            continue
        if not is_internship(title, emp):
            counts.discard("not_student")
            continue
        site, dept = (j.get("site") or "").strip(), (j.get("department") or "").strip()
        about = " · ".join(x for x in (site, dept, emp) if x)
        out.append(board_item({"name": "University Health Network", "sector": "health"}, source="uhn",
                              title=title, locations=[WHERE],
                              url=POSTING_URL.format(id=j["id"]), description=about, employment_type=emp))
    return out


def fetch_uhn(report=None) -> list[dict]:
    counts = ScanCounts()
    try:
        with client() as c:
            r = c.get(LIST_URL)
            r.raise_for_status()
            payload = r.json()
            rows = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(rows, list) or not all(isinstance(j, dict) for j in rows):
                raise ValueError("UHN job list is missing its data rows")
            counts.rows(len(rows))
            counts.reported(len(rows))   # one unpaged call: the list is every opening
            out = parse_uhn(payload, counts)
    except Exception as e:
        print(f"[uhn] failed: {type(e).__name__}")
        report_source(report, "uhn", error=e)
        return []
    print(f"[uhn] {len(out)} student postings")
    report_source(report, "uhn", items=out, counts=counts)
    return out
