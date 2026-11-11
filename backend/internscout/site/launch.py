"""Fixed P-4.1 pilot cohorts; no expansion from traffic or taxonomy changes."""

from __future__ import annotations

from dataclasses import dataclass
import re

from .rules import MIN_EMPLOYERS_NEW, SPREAD

MAX_PAGES = 60
MIN_LISTINGS = 10
# Fixed for the four-week observation period. Remote field URLs already exist.
PILOT = (
    ("summer-2027/software-engineering", "swe", None, None),
    ("summer-2027/data-science", "data", None, None),
    ("summer-2027/finance", "finance", None, None),
    ("for-seniors/chicago", None, "senior", "Chicago"),
    ("for-sophomores/denver", None, "sophomore", "Denver"),
)


@dataclass(frozen=True)
class Page:
    path: str
    items: list[dict]
    field: str | None
    year: str | None
    city: str | None
    indexed: bool


def explicit_standing(row: dict, year: str) -> bool:
    """Avoid years_of's all-undergraduate expansion for generic degree titles."""
    standing = (row.get("insights") or {}).get("class_standing")
    if isinstance(standing, list) and year in standing:
        return True
    title = row.get("title") or ""
    pattern = (
        r"\bsophomores?\b"
        if year == "sophomore"
        else r"\brising seniors?\b|\bseniors? (year|standing|students?|undergrad)"
    )
    return bool(re.search(pattern, title, re.I))


def select(listings, existing, live, earning, *, employers_in, indexed, near_same, fold_at, places):
    """Existing pages always win. Count IDs once; never lower the ten-role floor."""
    if len(PILOT) > MAX_PAGES:
        raise ValueError("pilot page cap exceeded")
    unique = {str(row["id"]): row for row in listings}
    taken = {page["path"] for page in existing}
    rivals = [frozenset(str(x["id"]) for x in p["items"]) for p in existing if p.get("items")]
    candidates = []
    for slug, field, year, city in PILOT:
        path = f"/internships/{slug}/"
        if path in taken:
            continue
        items = [
            x
            for x in unique.values()
            if (
                field in (x.get("field_tags") or []) and x.get("term") == "Summer 2027"
                if field
                else city in x["keys"] and explicit_standing(x, year)
            )
        ]
        local = sum(len(x["keys"] & places) < SPREAD for x in items)
        if (
            len(items) < MIN_LISTINGS
            or local < MIN_LISTINGS
            or employers_in(items) < MIN_EMPLOYERS_NEW
        ):
            continue
        candidates.append(
            Page(path, items, field, year, city, indexed(len(items), path, live, earning))
        )
    kept = []
    for page in sorted(candidates, key=lambda p: (-len(p.items), p.path)):
        mine = frozenset(str(x["id"]) for x in page.items)
        if any(near_same(mine, rival, fold_at(page.path)) for rival in rivals):
            continue
        kept.append(page)
        rivals.append(mine)
    return sorted(kept, key=lambda p: p.path)
