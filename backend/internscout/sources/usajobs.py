"""USAJOBS Search API, student hiring path (Pathways internships, student trainees).
Needs a free key from developer.usajobs.gov: USAJOBS_API_KEY, plus USAJOBS_EMAIL (the address the
key was requested with; USAJOBS requires it as the User-Agent). Skipped when either is missing."""
from __future__ import annotations
import os
from .base import client
from .common import ScanCounts, board_item, html_to_text, report_source, reported_count
from ..classify import is_internship

API = "https://data.usajobs.gov/api/search"
PAGE, MAX_PAGES = 500, 10


# OPM's occupational series for the social-science group (0100), the field a posting's title often
# leaves out: a student-path posting is as often a bare "Student Trainee" or "Pathways Intern" as a
# "Student Trainee (Economist)". The series is on every posting, so it names the field when the
# title cannot. Only used when the title alone says nothing (normalize's "other").
SERIES_FIELDS = {
    "0101": "social_science", "0102": "social_science",   # social science; its aides and technicians
    "0110": "economics", "0119": "economics",              # economist; economics assistant
    "0130": "social_science", "0131": "social_science",   # foreign affairs; international relations
    "0140": "social_science", "0150": "social_science",   # workforce research; geography
    "0170": "social_science",                             # history (OPM files it with the social sciences)
    "0180": "psychology", "0181": "psychology",            # psychology; its aides and technicians
    "0184": "social_science", "0190": "social_science", "0193": "social_science",  # sociology, anthropology, archeology
    "0185": "social_work", "0186": "social_work", "0187": "social_work",
    "1040": "languages", "1046": "languages",              # language specialist; language clerical
}


def _series_field(d: dict) -> str | None:
    for cat in d.get("JobCategory") or []:
        field = SERIES_FIELDS.get(str((cat or {}).get("Code") or "").zfill(4))
        if field:
            return field
    return None


def _place(name: str) -> str:
    parts = [p.strip() for p in (name or "").split(",") if p.strip()]
    return ", ".join(parts[-2:])   # "Point Loma Complex, San Diego, California" -> "San Diego, California"


def _text(v) -> str:
    return "\n".join(map(str, v)) if isinstance(v, list) else str(v or "")


def parse_usajobs(payload: dict, counts: ScanCounts | None = None) -> tuple[list[dict], int]:
    res = payload.get("SearchResult") or {}
    out, counts = [], counts if counts is not None else ScanCounts()
    for hit in res.get("SearchResultItems") or []:
        d = hit.get("MatchedObjectDescriptor") or {}
        title = d.get("PositionTitle") or ""
        sched = ((d.get("PositionSchedule") or [{}])[0] or {}).get("Name") or ""
        emp = f"Intern {sched}".strip()      # every student-path posting is a student role
        if not is_internship(title, emp):
            counts.discard("not_student")
            continue
        locs = [_place(l.get("LocationName")) for l in d.get("PositionLocation") or []
                if (l.get("CountryCode") or "") in ("United States", "US")]
        if not locs:
            counts.discard("outside_region")
            continue
        details = (d.get("UserArea") or {}).get("Details") or {}
        pay = (d.get("PositionRemuneration") or [{}])[0] or {}
        lines = []
        if pay.get("MinimumRange"):
            lines.append(f"Salary: ${pay['MinimumRange']} - ${pay.get('MaximumRange') or pay['MinimumRange']} "
                         f"{pay.get('Description') or ''}".strip())
        who = (details.get("WhoMayApply") or {}).get("Name")
        if who:
            lines.append(f"Who may apply: {who}")
        if d.get("ApplicationCloseDate"):
            lines.append(f"Apply by: {d['ApplicationCloseDate'][:10]}")
        lines += [_text(details.get("JobSummary")), _text(details.get("MajorDuties")), _text(d.get("QualificationSummary"))]
        url = d.get("PositionURI")
        item = board_item({"name": d.get("OrganizationName") or d.get("DepartmentName") or "US Government"},
                          source="usajobs", title=title, locations=locs, url=url,
                          apply_url=(d.get("ApplyURI") or [url])[0], posted_at=d.get("PublicationStartDate"),
                          description=html_to_text("\n".join(l for l in lines if l.strip())),
                          employment_type=emp)
        field = _series_field(d)
        if field:
            item["field_hint"] = field
        out.append(item)
    return out, int(res.get("SearchResultCountAll") or 0)


def fetch_usajobs(api_key: str | None = None, email: str | None = None, report=None) -> list[dict]:
    api_key = api_key or os.environ.get("USAJOBS_API_KEY")
    email = email or os.environ.get("USAJOBS_EMAIL")
    if not (api_key and email):
        print("[usajobs] no USAJOBS_API_KEY/USAJOBS_EMAIL set; skipping")
        report_source(report, "usajobs", skipped="no_api_key")
        return []
    headers = {"Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": api_key}
    out: list[dict] = []
    counts, error, total = ScanCounts(), None, 0
    try:
        with client() as c:
            for page in range(1, MAX_PAGES + 1):
                r = c.get(API, params={"HiringPath": "student", "ResultsPerPage": PAGE, "Page": page}, headers=headers)
                r.raise_for_status()
                payload = r.json()
                if not isinstance(payload, dict):
                    raise ValueError("USAJOBS search response is not an object")
                res = payload.get("SearchResult") if isinstance(payload.get("SearchResult"), dict) else {}
                rows = res.get("SearchResultItems")
                if page == 1:
                    counts.reported(reported_count(res.get("SearchResultCountAll")))
                counts.rows(len(rows) if isinstance(rows, list) else 0)
                items, total = parse_usajobs(payload, counts)
                out += items
                if page * PAGE >= total:
                    break
            else:
                if MAX_PAGES * PAGE < total:
                    counts.stop("page_cap")
    except Exception as e:
        error = e
        print(f"[usajobs] failed: {e}")
    print(f"[usajobs] {len(out)} student postings")
    # A failure part way through is still a failure, whatever it returned before it.
    report_source(report, "usajobs", items=out, error=error, counts=counts)
    return out
