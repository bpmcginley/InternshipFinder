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

The build's record (added 2026-10-14): seo_pages writes report() to a file, and the pages workflow then
runs `python -m internscout.placements record FILE`, which adds the day's kept and dropped placements to
the Worker's placement_runs table over Cloudflare's D1 HTTP API (record_runs), so refunds for days a
paid box was not on the site can be worked out. That step can never fail or hold up a deploy: any
problem is one ::warning:: line naming no secret and no address.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

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


# ---------------------------------------------------------------- the build's record (2026-10-14)
# Which days a live paid listing was on the site, for refunds. Written to the Worker's D1 table
# placement_runs (worker/schema.sql) from the pages workflow, with the same account and database as
# growth/metrics.py d1() and the same CLOUDFLARE_API_TOKEN secret (it needs D1: Edit).

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "d4a5640a67faee275d9df91204c4ec59")
D1_DATABASE = os.environ.get("INTERNSCOUT_D1_ID", "ef477808-f94c-4dce-a0b3-1198f00e5c39")
# A drop that says nothing about a paid day: "dates" is a placement outside its dates today (GET
# /placements also returns one that starts tomorrow, for a late build), and "duplicate" a second copy
# of one that was kept. Neither is a day the box should have been on the site and was not.
NOT_A_PAID_DAY = ("dates", "duplicate")
# Rows per statement: six parameters each, under D1's limit of 100 bound parameters a query.
ROWS_PER_STATEMENT = 16


def report(kept: list[dict], dropped: list[dict], today: str) -> dict:
    """What one build did with the placements, for record_runs: {"day": today, "kept": [id, ...],
    "dropped": [{"id", "reason"}, ...]}. A dropped entry with no readable id is left out."""
    return {"day": today, "kept": [p["id"] for p in kept],
            "dropped": [{"id": d["id"], "reason": d["reason"]} for d in dropped if d.get("id")]}


def runs_rows(rep, now: datetime) -> list[tuple]:
    """(placement_id, day, shown, dropped, reason, updated) per placement in a report: shown 1 for each
    kept id, dropped 1 with its reason for each id dropped while it was live (NOT_A_PAID_DAY left out,
    and so is an id the same build also kept). Anything malformed in the report is skipped."""
    if not isinstance(rep, dict) or not isinstance(rep.get("day"), str) or not _DAY.match(rep["day"]):
        raise ValueError("report has no day")
    day, updated = rep["day"], now.strftime("%Y-%m-%dT%H:%M:%SZ")
    kept = [i for i in rep.get("kept") or [] if isinstance(i, str) and _ID.match(i)]
    rows, seen = [], set()
    for i in kept:
        if i not in seen:
            seen.add(i)
            rows.append((i, day, 1, 0, None, updated))
    for d in rep.get("dropped") or []:
        i = d.get("id") if isinstance(d, dict) else None
        reason = d.get("reason") if isinstance(d, dict) else None
        if not (isinstance(i, str) and _ID.match(i)) or reason not in REASONS or reason in NOT_A_PAID_DAY or i in seen:
            continue
        seen.add(i)
        rows.append((i, day, 0, 1, reason, updated))
    return rows


def runs_sql(rows: list[tuple]) -> list[tuple[str, list]]:
    """The upserts that add rows to placement_runs: the counts add up across builds on one day, the
    reason is the latest drop's (a later build that kept it leaves the reason as it was), and updated
    is the latest build's time."""
    out = []
    for n in range(0, len(rows), ROWS_PER_STATEMENT):
        chunk = rows[n:n + ROWS_PER_STATEMENT]
        out.append(("INSERT INTO placement_runs (placement_id, day, shown, dropped, reason, updated) VALUES "
                    + ", ".join(["(?, ?, ?, ?, ?, ?)"] * len(chunk))
                    + " ON CONFLICT(placement_id, day) DO UPDATE SET shown = shown + excluded.shown, "
                    "dropped = dropped + excluded.dropped, reason = COALESCE(excluded.reason, placement_runs.reason), "
                    "updated = excluded.updated",
                    [v for row in chunk for v in row]))
    return out


def _post(url: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                                          "User-Agent": "InternScout-build"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def record_runs(report_path: str, token: str, post=_post, now: datetime | None = None) -> int:
    """Adds one build's report (seo_pages --placements-report) to placement_runs; the number of
    placements written. Raises on any problem; main() turns that into a warning."""
    with open(report_path, encoding="utf-8") as f:
        rep = json.load(f)
    rows = runs_rows(rep, now or datetime.now(timezone.utc))
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{D1_DATABASE}/query"
    for sql, params in runs_sql(rows):
        r = post(url, {"sql": sql, "params": params}, token)
        if not isinstance(r, dict) or not r.get("success"):
            raise RuntimeError("D1 did not accept the write")
    return len(rows)


def _why(e: Exception) -> str:
    """A short reason for the warning line: never the token, a URL or a response body."""
    if isinstance(e, urllib.error.HTTPError):
        return f"Cloudflare answered HTTP {e.code}"
    if isinstance(e, urllib.error.URLError):
        return "Cloudflare could not be reached"
    if isinstance(e, FileNotFoundError):
        return "no report file"
    if isinstance(e, ValueError):
        return "the report could not be read"
    if isinstance(e, RuntimeError):
        return str(e)
    return type(e).__name__


def main(argv: list[str]) -> int:
    """python -m internscout.placements record REPORT: record_runs with CLOUDFLARE_API_TOKEN. Always
    exits 0 once called that way, so the deploy goes on whatever happens here."""
    if len(argv) != 3 or argv[1] != "record":
        print("usage: python -m internscout.placements record REPORT", file=sys.stderr)
        return 2
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or ""
    if not token:
        print("::warning::paid listing runs not recorded: no Cloudflare token in this run")
        return 0
    try:
        n = record_runs(argv[2], token)
    except Exception as e:          # noqa: BLE001 - nothing here may stop a deploy
        print("::warning::paid listing runs not recorded: " + _why(e).replace(token, "[token]").replace("\n", " "))
        return 0
    print(f"[placements] recorded today's runs for {n} placement(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
