"""Guess ATS boards for companies that show up without one (lists and search results that link to a
company careers page). Each company is probed at most once every TTL_DAYS; misses are remembered in
backend/data/probe_cache.json so CI doesn't hammer the ATS APIs.

Probing uses its own short-timeout, high-concurrency client: these are cheap existence checks (mostly
fast 404s), not content fetches, and reusing the 25s ingest-wide HTTP_TIMEOUT here would let a handful
of slow/dead hosts serialize the whole run.
"""
from __future__ import annotations
import json
import os
import re
import httpx
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from .config import DATA_DIR, USER_AGENT
from .discover import add_board, ats_of

CACHE_PATH = os.path.join(DATA_DIR, "probe_cache.json")
TTL_DAYS = 45
MAX_PER_RUN = 150
PROBE_TIMEOUT = 6.0
PROBE_WORKERS = 24
_SUFFIX = re.compile(r"\b(inc|llc|ltd|l\.?p|corp|corporation|co|company|group|holdings|technologies|the)\b\.?", re.I)


def norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def slugs_for(name: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", _SUFFIX.sub(" ", name.lower()))
    return list(dict.fromkeys(s for s in ("".join(words), "-".join(words)) if len(s) >= 3))


def _same_name(board_name: str | None, name: str) -> bool:
    a, b = norm(board_name), norm(_SUFFIX.sub(" ", name))
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


_JAZZHR_ORG = re.compile(r'"@type"\s*:\s*"Organization"\s*,\s*"name"\s*:\s*"([^"]{2,80})"')


def _greenhouse(c, slug, name):
    r = c.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}")
    return r.status_code == 200 and _same_name(r.json().get("name"), name)


# Empty Workable accounts named after big employers exist (Mayo Clinic, HCA), so the board must have jobs.
def _workable(c, slug, name):
    r = c.get(f"https://apply.workable.com/api/v1/widget/accounts/{slug}", params={"details": "true"})
    return r.status_code == 200 and _same_name(r.json().get("name"), name) and len(r.json().get("jobs") or []) > 0


# Lever and Ashby have no board-name endpoint, so only the exact squashed name counts, and the board must have jobs.
def _lever(c, slug, name):
    if slug != norm(_SUFFIX.sub(" ", name)) or len(slug) < 5:
        return False
    r = c.get(f"https://api.lever.co/v0/postings/{slug}", params={"mode": "json", "limit": 1})
    return r.status_code == 200 and isinstance(r.json(), list) and len(r.json()) > 0


def _ashby(c, slug, name):
    if slug != norm(_SUFFIX.sub(" ", name)) or len(slug) < 5:
        return False
    r = c.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    return r.status_code == 200 and len(r.json().get("jobs") or []) > 0


# JazzHR answers 200 for every subdomain anyone ever types at it: a made-up tenant serves a JazzHR
# marketing page with no jobs on it, naming JazzHR itself as the organization. The status code proves
# nothing here, so a board only counts when it names the employer we asked for and has jobs on it.
def _jazzhr(c, slug, name):
    r = c.get(f"https://{slug}.applytojob.com/apply")
    if r.status_code != 200 or '<li class="list-group-item">' not in r.text:
        return False
    m = _JAZZHR_ORG.search(r.text)
    org = m.group(1).strip() if m else ""
    return org.lower() != "jazzhr" and _same_name(org, name)


# JazzHR goes last: it is the only probe paying for a whole HTML page rather than a small JSON
# existence check, so it is only reached when nothing cheaper matched.
PROBES = [("greenhouse", _greenhouse), ("ashby", _ashby), ("lever", _lever), ("workable", _workable),
          ("jazzhr", _jazzhr)]


def load_cache() -> dict:
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    cutoff = (date.today() - timedelta(days=TTL_DAYS)).isoformat()
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in sorted(cache.items()) if v >= cutoff}, f, indent=0)


def candidates(reg: dict, items: list[dict], cache: dict, today: date) -> list[str]:
    known = {norm(e.get("name")) for b in reg.values() for e in b.values()}
    cutoff = (today - timedelta(days=TTL_DAYS)).isoformat()
    out: dict[str, str] = {}
    for it in items:
        name = (it.get("company_name") or "").strip()
        k = norm(name)
        if len(k) < 3 or k in known or k in out or cache.get(k, "") >= cutoff:
            continue
        if ats_of(it.get("apply_url"))[0] != "other" or ats_of(it.get("url"))[0] != "other":
            continue  # already on an ATS we know (or one we can't scan)
        out[k] = name
    return list(out.values())


def _probe_one(c, name: str) -> tuple[str, str] | None:
    for slug in slugs_for(name):
        for ats, fn in PROBES:
            try:
                if fn(c, slug, name):
                    return ats, slug
            except Exception:
                continue
    return None


def probe_boards(reg: dict, items: list[dict], _client=None, max_names: int = MAX_PER_RUN,
                 workers: int = PROBE_WORKERS) -> int:
    """`_client` is accepted for backward compatibility but ignored — probing always uses its own
    short-timeout client (see module docstring) rather than the caller's ingest-wide one."""
    cache, today = load_cache(), date.today()
    names = candidates(reg, items, cache, today)[:max_names]
    found = 0
    with httpx.Client(timeout=PROBE_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as c, \
         ThreadPoolExecutor(max_workers=workers) as ex:
        for name, hit in zip(names, ex.map(lambda n: _probe_one(c, n), names)):
            cache[norm(name)] = today.isoformat()
            if hit:
                found += add_board(reg, hit[0], hit[1], name)
    save_cache(cache)
    return found
