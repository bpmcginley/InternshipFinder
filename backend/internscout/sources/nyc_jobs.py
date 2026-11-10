"""NYC government jobs from NYC Open Data (dataset kpav-sd4t), filtered to student roles
(interns, college aides, fellows). Free, no key. Each posting links to its cityjobs.nyc.gov page."""
from __future__ import annotations
from datetime import date, datetime
from .base import client
from .common import ScanCounts, board_item, html_to_text, report_source
from ..classify import is_internship

API = "https://data.cityofnewyork.us/resource/kpav-sd4t.json"
LIMIT = 2000
WHERE = ("career_level = 'Student' OR upper(business_title) like '%INTERN%' "
         "OR upper(business_title) like '%FELLOW%' OR upper(civil_service_title) like '%COLLEGE AIDE%'")


def _until(s: str | None) -> date | None:
    try:
        return datetime.strptime((s or "").strip(), "%d-%b-%Y").date()
    except ValueError:
        return None


def parse_nyc_jobs(rows: list[dict], today: date | None = None,
                   counts: ScanCounts | None = None) -> list[dict]:
    today = today or date.today()
    counts = counts if counts is not None else ScanCounts()
    best: dict[str, dict] = {}   # the same job is posted once "Internal" and once "External"
    with_id = 0
    for r in rows:
        jid = r.get("job_id")
        with_id += bool(jid)
        if jid and not (jid in best and best[jid].get("posting_type") == "External"):
            best[jid] = r
    counts.discard("unreadable", len(rows) - with_id)
    counts.discard("duplicate", with_id - len(best))
    out = []
    for jid, r in best.items():
        title = (r.get("business_title") or "").strip()
        emp = "Intern" if r.get("career_level") == "Student" else ""
        if r.get("full_time_part_time_indicator") == "P":
            emp = f"{emp} Part-time".strip()
        until = _until(r.get("post_until"))
        if not is_internship(title, emp):
            counts.discard("not_student")
            continue
        if until and until < today:
            counts.discard("expired")
            continue
        lines = []
        if r.get("salary_range_from"):
            lines.append(f"Salary: ${r['salary_range_from']} - ${r.get('salary_range_to') or r['salary_range_from']} "
                         f"{r.get('salary_frequency') or ''}".strip())
        if until:
            lines.append(f"Apply by: {until.isoformat()}")
        lines += [r.get("job_description") or "", r.get("minimum_qual_requirements") or "", r.get("preferred_skills") or ""]
        out.append(board_item({"name": (r.get("agency") or "NYC Government").title()}, source="nyc_jobs",
                              title=title, locations=["New York, NY"], url=f"https://cityjobs.nyc.gov/job/{jid}",
                              posted_at=(r.get("posting_date") or "")[:10] or None,
                              description=html_to_text("\n".join(l for l in lines if l.strip())),
                              employment_type=emp))
    return out


def fetch_nyc_jobs(report=None) -> list[dict]:
    counts = ScanCounts()
    try:
        with client() as c:
            r = c.get(API, params={"$where": WHERE, "$limit": LIMIT, "$order": "posting_date DESC"})
            r.raise_for_status()
            rows = r.json()
            if not isinstance(rows, list) or not all(isinstance(x, dict) for x in rows):
                raise ValueError("NYC Open Data response is not a list of rows")
            counts.rows(len(rows))
            if len(rows) >= LIMIT:
                counts.stop("row_limit")   # one request, filled: older matches may be cut off
            out = parse_nyc_jobs(rows, counts=counts)
    except Exception as e:
        print(f"[nyc_jobs] failed: {e}")
        report_source(report, "nyc_jobs", error=e)
        return []
    print(f"[nyc_jobs] {len(out)} student postings")
    report_source(report, "nyc_jobs", items=out, counts=counts)
    return out
