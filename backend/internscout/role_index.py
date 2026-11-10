"""The role index: every open role an employer could buy a paid listing for, as small JSON files.

The buy page (docs/employers/buy/) searches it for an employer's open roles, and the Worker re-reads
the same files from the site to check every role an order names (worker/ORDERS.md, "The role index"),
so a buyer can never name a role, an apply link or a field InternScout does not list. seo_pages.main
writes it on every Pages build, from the listings build() already loaded:

  <site_dir>/data/roles/index.json     {"generated", "employers": [{"k", "n", "c", "s"}]}
  <site_dir>/data/roles/<shard>.json   {"generated", "roles": [{"id", "k", "co", "t", "loc", "u", "f", "unpaid"}]}

k is seo_pages.employer_key, n the spelling most of its roles use, c its open roles, s its shard: the
first character of k when it is a-z or 0-9, else "_". One shard is all the buy page fetches for an
employer and all the Worker reads for an order. "generated" is when the listings were exported, so two
builds of the same data on the same day write the same bytes.
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter
from datetime import datetime, timezone

from . import seo_pages as sp
from .placements import _deadline_passed, unpaid

FOLDER = os.path.join("data", "roles")

# The id placements and the dashboard key a listing on (normalize.listing_id). An older export's
# integer id, or a fixture's "id5", cannot be named in an order.
_ID = re.compile(r"^[0-9a-f]{16}$")
_SHARD = re.compile(r"^[a-z0-9_]\.json$")


def shard(k: str) -> str:
    return k[0] if k and ("a" <= k[0] <= "z" or "0" <= k[0] <= "9") else "_"


def qualifies(x: dict, today: str) -> bool:
    """Open, from a real employer, applied to over https, its deadline (if any) not passed, and with a
    well-formed id. seo_pages.load already kept only open roles with an http(s) link; an order needs
    https, which is also all a placement accepts (placements._well_formed)."""
    return (x.get("status") == "open" and sp.real_company(x.get("company_name") or "")
            and str(x.get("apply_url") or "").startswith("https://")
            and not _deadline_passed(x, today) and bool(_ID.match(str(x.get("id")))))


def roles(listings: list[dict], today: str) -> list[dict]:
    """Every shard's rows, by company, then title, then id. One row per role within each employer
    (unique_roles, the rule the employer pages count by), so a requisition posted on two boards is
    offered once; it runs after the rules, so a copy that fails them never hides one that passes."""
    rows = [{"id": x["id"], "k": sp.employer_key(x["company_name"]), "co": x["company_name"],
             "t": x.get("title") or "", "loc": sp.place(x), "u": x["apply_url"],
             "f": list(x.get("field_tags") or []), "unpaid": unpaid(x)}
            for x in sp.unique_roles([x for x in listings if qualifies(x, today)])]
    return sorted(rows, key=lambda r: (r["co"].lower(), r["t"].lower(), r["id"]))


def employers(rows: list[dict]) -> list[dict]:
    """One entry per employer key. Its name is the spelling most of its roles use, the rule that names
    its page (seo_pages.build, "Ties go to the key and to the name itself")."""
    names: dict[str, Counter] = {}
    for r in rows:
        names.setdefault(r["k"], Counter())[r["co"]] += 1
    out = [{"k": k, "n": min(c, key=lambda n: (-c[n], len(n), n)), "c": sum(c.values()), "s": shard(k)}
           for k, c in names.items()]
    return sorted(out, key=lambda e: (e["n"].lower(), e["n"], e["k"]))


def _dump(path: str, obj: dict) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def write(site_dir: str, listings: list[dict], now: datetime, today: str | None = None) -> dict[str, int]:
    """Writes the index and its shards into <site_dir>/data/roles; {file name: roles} for the log.

    now: when the listings were exported (seo_pages.GENERATED), the files' "generated". today: the UTC
    day a deadline is read against, the build's own (seo_pages.today_utc, as placements.resolve reads
    it); now's day when None. A shard file left from an earlier build with no roles now is removed."""
    today = today or now.astimezone(timezone.utc).strftime("%Y-%m-%d")
    generated = now.astimezone(timezone.utc).isoformat(timespec="seconds")
    rows = roles(listings, today)
    by_shard: dict[str, list[dict]] = {}
    for r in rows:
        by_shard.setdefault(shard(r["k"]), []).append(r)
    folder = os.path.join(site_dir, FOLDER)
    os.makedirs(folder, exist_ok=True)
    for name in os.listdir(folder):
        if _SHARD.match(name) and name[:-5] not in by_shard:
            os.remove(os.path.join(folder, name))
    for s, part in sorted(by_shard.items()):
        _dump(os.path.join(folder, f"{s}.json"), {"generated": generated, "roles": part})
    _dump(os.path.join(folder, "index.json"), {"generated": generated, "employers": employers(rows)})
    return {f"{s}.json": len(part) for s, part in sorted(by_shard.items())}
