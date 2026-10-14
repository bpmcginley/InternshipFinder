"""Paid listings ("placements"): which of them the site may show today.

A placement is a pointer, never a listing. Bruce records one in the Worker's D1 table (worker/src/
placements.js) when an employer pays to show a role that InternScout already lists, and the site build
reads the public GET /placements once per deploy (.github/workflows/pages.yml). resolve() keeps a
placement only when the listing it points at is one the normal pipeline produced and the site kept
(seo_pages.load: well formed, open, with a safe apply link), its apply link is still the listing's own,
its deadline has not passed, it does not say it is unpaid (unless Bruce confirmed a nonprofit or
government role, unpaid_ok), and today is inside its dates. Anything else is dropped with a reason.

There is no way to add a listing through a placement, and nothing here writes to a listing. The rule:
payment never changes a score, an order, a filter, a count or what Auto-Apply does. Only seo_pages and
growth/digest.py import this module; tests/test_placements.py fails if the pipeline, the scorer or the
export ever names it. The code says "placement", never "paid", because "paid" already means a role
that pays (the pay filter).

The repo and its Actions logs are public, so warnings name only placement ids, listing ids and reasons,
which are public already (they are in /data/placements.json).
"""
from __future__ import annotations

import json
import re

# Paid boxes on one page or in one view. The D1 column page_cap is held at 1 by a CHECK as well.
MAX_PER_PAGE = 1

# Why a placement was dropped, as resolve() reports it.
REASONS = ("malformed", "duplicate", "dates", "listing_gone", "closed", "url_changed", "deadline", "unpaid")

# The fields of a kept placement, the ones written to /data/placements.json. All public.
PUBLIC_KEYS = ("id", "listing_id", "apply_url", "employer", "start", "end")

_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# A placement id the Worker makes ("p-2026-11-acme-1"). Anything else is malformed, which also keeps a
# crafted id from writing its own GitHub Actions command into a ::warning:: line.
_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_LISTING_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def same_url(a, b) -> bool:
    """The same apply link, a trailing slash aside."""
    a, b = str(a or "").strip().rstrip("/"), str(b or "").strip().rstrip("/")
    return bool(a) and a == b


def _company(name) -> str:
    return " ".join(str(name or "").lower().split())


def unpaid(x: dict) -> bool:
    """The listing says the role is unpaid, read as the dashboard's IS.payOf reads it: the first of
    paid, unpaid or stipend in its restrictions, else insights.pay."""
    r = next((t for t in x.get("restrictions") or [] if t in ("paid", "unpaid", "stipend")), None)
    return (r or (x.get("insights") or {}).get("pay")) == "unpaid"


def _deadline_passed(x: dict, today: str) -> bool:
    deadline = str((x.get("insights") or {}).get("deadline") or "")[:10]
    return bool(deadline) and deadline < today


def _well_formed(p) -> bool:
    if not isinstance(p, dict):
        return False
    if not isinstance(p.get("id"), str) or not _ID.match(p["id"]):
        return False
    if not isinstance(p.get("listing_id"), str) or not _LISTING_ID.match(p["listing_id"]):
        return False
    if not isinstance(p.get("apply_url"), str) or not p["apply_url"].startswith("https://"):
        return False
    if not isinstance(p.get("employer"), (str, type(None))):
        return False
    return all(isinstance(p.get(k), str) and _DAY.match(p[k]) for k in ("start", "end"))


def resolve(raw, listings_by_id: dict, today: str, by_url: bool = True) -> tuple[list[dict], list[dict]]:
    """(kept, dropped) for the placements in raw on today (YYYY-MM-DD, UTC).

    listings_by_id: listing id -> listing, the listings the site kept (seo_pages.load). kept: dicts with
    PUBLIC_KEYS only, in raw's order. dropped: {"id", "listing_id", "reason"} per placement left out,
    reason one of REASONS. A placement whose listing id is not found is kept only when by_url is True
    and exactly one listing has the same apply link and the same company; it then carries that
    listing's id and a "note" (see warnings()), so Bruce fixes the record himself. The record in D1 is
    never changed from here. growth/digest.py passes by_url=False: it reads the file this writes, whose
    ids are already resolved.
    """
    kept: list[dict] = []
    dropped: list[dict] = []
    seen: set[str] = set()
    by_url_index: dict[str, list[dict]] = {}
    if by_url:
        for x in listings_by_id.values():
            by_url_index.setdefault(str(x.get("apply_url") or "").strip().rstrip("/"), []).append(x)

    def drop(p, reason):
        ok = isinstance(p, dict) and isinstance(p.get("id"), str) and _ID.match(p["id"])
        lid = p.get("listing_id") if isinstance(p, dict) else None
        dropped.append({"id": p["id"] if ok else None,
                        "listing_id": lid if isinstance(lid, str) and _LISTING_ID.match(lid) else None,
                        "reason": reason})

    for p in raw if isinstance(raw, list) else []:
        if not _well_formed(p):
            drop(p, "malformed")
            continue
        if p["id"] in seen:
            drop(p, "duplicate")
            continue
        seen.add(p["id"])
        if not (p["start"] <= today < p["end"]):
            drop(p, "dates")
            continue
        x = listings_by_id.get(p["listing_id"])
        note = None
        if x is None and by_url:
            same = [y for y in by_url_index.get(p["apply_url"].strip().rstrip("/"), [])
                    if _company(y.get("company_name")) == _company(p.get("employer"))]
            if len(same) == 1 and _company(p.get("employer")):
                x, note = same[0], "matched by URL only; update its listing_id"
        if x is None:
            drop(p, "listing_gone")
            continue
        if x.get("status") != "open":
            drop(p, "closed")
            continue
        if not same_url(p["apply_url"], x.get("apply_url")):
            drop(p, "url_changed")
            continue
        if _deadline_passed(x, today):
            drop(p, "deadline")
            continue
        if unpaid(x) and not p.get("unpaid_ok"):
            drop(p, "unpaid")
            continue
        out = {k: p.get(k) for k in PUBLIC_KEYS}
        out["listing_id"] = str(x["id"])
        out["employer"] = str(p.get("employer") or x.get("company_name") or "")
        if p.get("unpaid_ok"):
            out["unpaid_ok"] = 1       # Bruce confirmed a nonprofit or government role; the digest reads it
        if note:
            out["note"] = note
        kept.append(out)
    return kept, dropped


def warnings(kept: list[dict], dropped: list[dict]) -> list[str]:
    """GitHub Actions ::warning:: lines for the build log: every dropped placement with its reason,
    and every one kept only by its apply link. Ids and reasons only, all public."""
    lines = [f"::warning::placement {p['id']} matched by URL only; update its listing_id to {p['listing_id']}"
             for p in kept if p.get("note")]
    lines += [f"::warning::placement {d['id'] or '(unreadable)'} dropped: {d['reason']}"
              + (f" (listing {d['listing_id']})" if d.get("listing_id") else "") for d in dropped]
    return lines


def public(kept: list[dict]) -> list[dict]:
    """kept without the build-only note: what /data/placements.json carries."""
    return [{k: p[k] for k in (*PUBLIC_KEYS, "unpaid_ok") if k in p} for p in kept]


def read(path: str | None) -> list:
    """The placements list from the file the pages workflow fetched (the Worker's GET /placements
    answer), or [] when there is no path, no file, or it is malformed."""
    if not path:
        return []
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return []
    items = raw.get("placements") if isinstance(raw, dict) else None
    return [p for p in items if isinstance(p, dict)] if isinstance(items, list) else []
