"""Prepare reviewed, major-specific campus outreach drafts from the current listing export.

This script writes files only. It never looks up contacts, sends email, or posts to a community.
Run from the repository root: python growth/outreach.py docs --out outreach-kit
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
import audience  # noqa: E402
import digest  # noqa: E402
from internscout import seo_pages as sp  # noqa: E402

MIN_NEW = 3
MAX_AGE = timedelta(days=2)


def one_line(value: object) -> str:
    """Keep untrusted job-board text from altering the layout of a draft."""
    return re.sub(r"\s+", " ", str(value or "")).strip()


def major_url(major: dict, medium: str, now: datetime) -> str:
    tags = sorted(set(major.get("tags") or []) - sp.SKIP_FIELDS)[:6]
    query = urlencode({
        "field": ",".join(tags),
        "utm_source": "campus_partner",
        "utm_medium": medium,
        "utm_campaign": f"campus_{now:%Y_%m}",
        "utm_content": sp.slugify(major["name"]),
    })
    return f"{sp.SITE}/?{query}"


def pick_roles(items: list[dict], count: int = 3) -> list[dict]:
    """Prefer different employers so one prolific board does not dominate a club note."""
    ordered = sp.newest_first(items)
    chosen, employers = [], set()
    for x in ordered:
        employer = sp.employer_key(x.get("company_name") or "")
        if employer in employers:
            continue
        chosen.append(x)
        employers.add(employer)
        if len(chosen) == count:
            return chosen
    return chosen + [x for x in ordered if x not in chosen][:count - len(chosen)]


def place_nearby(x: dict) -> str:
    if "remote" in x["keys"]:
        return "Remote"
    state = next((k for k in sorted(x["keys"] & sp.HOME_STATES) if k != "remote"), None)
    return one_line(sp.place(x, state))


def build(data: dict, now: datetime | None = None, limit: int = 8) -> dict:
    generated = sp._when(data.get("generated_at"))
    now = now or datetime.now(timezone.utc)
    if not generated or now - generated > MAX_AGE or generated - now > timedelta(hours=1):
        return {"generated_at": data.get("generated_at"), "status": "stale", "majors": []}

    listings = data["listings"]
    fresh = digest.new_roles(data, generated)
    result = []
    for major in data["majors"]:
        if major.get("level") not in (None, "undergrad"):
            continue
        tags = set(major.get("tags") or []) - sp.SKIP_FIELDS
        if not tags:
            continue
        fits = lambda x: bool(tags & set(x.get("field_tags") or [])) and bool(x["keys"] & sp.HOME_STATES)  # noqa: E731
        open_count = sum(1 for x in listings if fits(x))
        if open_count < audience.PRIMARY:
            continue
        new = [x for x in fresh if fits(x)]
        if len(new) < MIN_NEW:
            continue
        roles = [{"title": one_line(x.get("title")), "company": one_line(x.get("company_name")),
                  "place": place_nearby(x), "url": sp.safe_url(x.get("apply_url"))}
                 for x in pick_roles(new)]
        result.append({"major": major["name"], "open": open_count, "new": len(new),
                       "email_url": major_url(major, "email", generated),
                       "community_url": major_url(major, "community", generated), "roles": roles})
    result.sort(key=lambda x: (-x["new"], -x["open"], x["major"]))
    return {"generated_at": generated.isoformat(), "status": "ready", "majors": result[:limit]}


def render(kit: dict) -> str:
    if kit["status"] != "ready":
        return "No outreach drafts: the listing export is missing, too old, or dated in the future. Refresh the ingest first.\n"
    if not kit["majors"]:
        return "No outreach drafts: no undergraduate major meets both the coverage and fresh-role thresholds.\n"
    parts = [f"InternScout campus outreach kit — listing export {kit['generated_at']}",
             "Review every example and link before sharing. Replace [Name] and add your own signature. No messages have been sent."]
    for row in kit["majors"]:
        examples = "\n".join(f"- {r['title']} — {r['company']} ({r['place']})" for r in row["roles"])
        parts += [
            f"\n{'=' * 72}\n{row['major']}: {row['open']} open in the Northeast or remote; {row['new']} found this week",
            "\nPARTNER EMAIL DRAFT",
            f"Subject: Fresh {row['major']} internship leads for your members",
            f"Hi [Name],\n\nI'm a UMass Amherst student building InternScout, a free internship search tool. "
            f"This week's scan found {row['new']} new {row['major']} matches in the Northeast or remote. "
            "A few examples:\n" + examples + "\n\n"
            f"Would this be useful to share with your members? They can browse the current listings here: {row['email_url']}\n\n"
            "Please check the employer posting before applying; roles can close. InternScout isn't affiliated with UMass or these employers.\n\n[Your name]",
            "\nCOMMUNITY POST DRAFT — share only where a club or moderator welcomes it",
            f"New {row['major']} internship leads from InternScout's scan this week:\n{examples}\n\n"
            f"Browse the current list: {row['community_url']}\n"
            "Free search; no sign-in needed. Check each employer posting before applying. Built by a UMass student; not affiliated with UMass.",
        ]
    return "\n\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", nargs="?", default="docs")
    parser.add_argument("--out", default="outreach-kit")
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    kit = build(sp.load(args.site), limit=args.limit)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "drafts.txt").write_text(render(kit), encoding="utf-8")
    (out / "drafts.json").write_text(json.dumps(kit, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[outreach] {len(kit['majors'])} drafts; status={kit['status']}; wrote {out}")


if __name__ == "__main__":
    main()
