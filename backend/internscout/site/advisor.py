"""Static weekly major editions; no subscription, provider or build side effects."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from ..classify import ALL_FIELDS
from . import source, taxonomy


@dataclass(frozen=True)
class Edition:
    name: str
    path: str
    items: list[dict]
    stamp: datetime | None
    state: str
    parent: str


def _stamp(value) -> datetime | None:
    parsed = source._when(value) if isinstance(value, str) else None
    return parsed.astimezone(timezone.utc) if parsed else None


def _safe_posting(value) -> bool:
    if not isinstance(value, str) or any(
        c.isspace() or c == "\\" or ord(c) < 32 or 127 <= ord(c) <= 159 for c in value
    ):
        return False
    try:
        parsed = urlsplit(value)
        # Accessing port validates malformed/out-of-range values; urlsplit alone does not.
        _ = parsed.port
        return (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.netloc.endswith(":")
        )
    except ValueError:
        return False


def in_week(row: dict, end: datetime, baseline: str | None) -> bool:
    """A full seven-day instant window, without bootstrap or newly discovered old postings."""
    seen, posted = _stamp(row.get("first_seen")), _stamp(row.get("posted_at"))
    if not seen or not end - timedelta(days=7) < seen <= end:
        return False
    if baseline and seen.date().isoformat() <= baseline:
        return False
    if source.canada_first_scan(row):
        return False
    if row.get("posted_at") and not posted:
        return False
    return posted is None or end - timedelta(days=14) < posted <= end


def select(data: dict, major_links: dict[str, str] | None = None) -> list[Edition]:
    """One bounded model per named undergraduate mapping, including honest empty states.

    Input is the build's public exported data. Membership is the union of direct tags; related
    fields never fill an empty edition. Canonical parent links come from the actual built catalog.
    """
    stamp = _stamp(data.get("generated_at"))
    baseline = data.get("baseline")
    baseline = baseline if isinstance(baseline, str) else None
    pool = []
    for row in data.get("listings") or []:
        if (
            source.well_formed(row)
            and row.get("status") == "open"
            and _safe_posting(row.get("apply_url"))
            and stamp is not None
            and in_week(row, stamp, baseline)
        ):
            pool.append(row)
    majors = [
        m
        for m in data.get("majors") or []
        if isinstance(m, dict)
        and isinstance(m.get("name"), str)
        and m["name"].strip()
        and m.get("level") in (None, "undergrad")
    ]
    out, paths = [], set()
    for major in sorted(majors, key=lambda m: m["name"]):
        name = major["name"].strip()
        slug = taxonomy.slugify(name)
        path = f"/internships/for/{slug}-majors/weekly/"
        if not slug or path in paths:
            continue
        paths.add(path)
        direct = major.get("tags")
        tags = (
            {
                t
                for t in direct
                if isinstance(t, str) and t in ALL_FIELDS and t not in taxonomy.SKIP_FIELDS
            }
            if isinstance(direct, list)
            else set()
        )
        # Deduplicate within this major so an unrelated duplicate cannot steal its matched role.
        matched = {
            str(row["id"]): row for row in pool if tags.intersection(row.get("field_tags") or [])
        }
        items = source.newest_first(source.unique_roles(list(matched.values())))
        parent = (major_links or {}).get(name, "/internships/for/")
        if (
            not isinstance(parent, str)
            or not parent.startswith("/internships/")
            or ".." in parent.split("/")
            or any(c in parent for c in '\\?#"<>')
        ):
            parent = "/internships/for/"
        state = "unmapped" if not tags else "undated" if stamp is None else "ready"
        out.append(Edition(name, path, items, stamp, state, parent))
    return out
