"""Guess ATS boards for companies that show up without one (lists and search results that link to a
company careers page). Each company is probed at most once every TTL_DAYS; misses are remembered in
backend/data/probe_cache.json so CI doesn't hammer the ATS APIs.

Probing uses its own short-timeout, high-concurrency client: these are cheap existence checks (mostly
fast 404s), not content fetches, and reusing the 25s ingest-wide HTTP_TIMEOUT here would let a handful
of slow/dead hosts serialize the whole run.

Only some ATSes can be probed at all, because a probe is a guess at a token built from the company
name. Counting the 2,707 boards already in the registry, the token is reachable from the name for 73%
of ashby, 81% of jobvite, 68% of greenhouse, 65% of lever, 55% of workable and bamboohr, and 43% of
smartrecruiters - but for **none** of workday, oracle, taleo or adp, whose tokens are tenant|site
pairs (aaaie|wd1|csaacareers) or opaque UUIDs. No naming rule reaches those, so they are left out on
purpose rather than forgotten; boards on them arrive through discovery or a seed.
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


# SmartRecruiters is keyed by an identifier that is usually the squashed company name, and it answers
# on any case, so the lowercase slug is enough. It never 404s - an unknown company is an empty result
# set - so the posting's own company block is what confirms the board, and that needs a posting.
def _smartrecruiters(c, slug, name):
    r = c.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings", params={"limit": 1})
    if r.status_code != 200:
        return False
    posts = r.json().get("content") or []
    return bool(posts) and _same_name((posts[0].get("company") or {}).get("name"), name)


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
          ("smartrecruiters", _smartrecruiters), ("jazzhr", _jazzhr)]


# A Greenhouse board embedded in the employer's own careers page leaves no token in the apply URL:
# "?gh_jid=8044334" names the job, and the public API is keyed by the board. Nothing else finds these
# - ats_of labels the URL "greenhouse" with no token, so it reads like a board we already have, and
# the name probe never sees it - which is how careers.aqr.com, www.coinbase.com and stripe.com sat in
# the data with no board behind them. The page serving the job does carry the board, in the embed
# script or in a link back to greenhouse.io, and boards-api settles it by serving that same job id
# under the token. Checked live 2026-09-18 on the 13 such hosts in the data: 10 resolved, among them
# quantbot-technologies and optiverus, whose tokens no naming rule would have guessed.
GH_JID = re.compile(r"[?&]gh_jid=(\d+)")
GH_TOKEN = re.compile(r"(?:embed/job_board[^\"'<>]*?[?&]for=|job-boards\.greenhouse\.io/"
                      r"|boards\.greenhouse\.io/(?!embed)|boards-api\.greenhouse\.io/v1/boards/)"
                      r"([A-Za-z0-9_-]+)", re.I)
# What the embed URL itself is made of, never a board.
GH_NOT_TOKENS = {"embed", "job_board", "js", "jobs"}
GH_PAGE_TIMEOUT = 15.0   # a whole careers page, not one of the small existence checks
MAX_GH_HOSTS = 12


def _serves_job(c, token: str, jid: str) -> bool:
    try:
        return c.get(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{jid}").status_code == 200
    except Exception:
        return False


def gh_host_token(c, url: str, jid: str, name: str = "") -> str | None:
    """The Greenhouse board behind an employer's own careers host, or None if nothing answers.

    Whatever the page gives up is tried first, then the employer's name, because a careers page
    that builds its list server-side - AlixPartners, Trillium, Domino Data Lab - names no board at
    all. The job id keeps the name guess honest: it is the same check the plain name probe makes,
    with the posting we are holding as the proof, so a board belonging to a company of a similar
    name cannot be mistaken for this one.
    """
    cands = []
    try:
        page = c.get(url, timeout=GH_PAGE_TIMEOUT)
        cands = [t for t in GH_TOKEN.findall(page.text or "") if t.lower() not in GH_NOT_TOKENS]
    except Exception:
        pass
    for tok in dict.fromkeys(cands + (slugs_for(name) if name else [])):
        if _serves_job(c, tok, jid):
            return tok
    return None


def gh_hosts(reg: dict, items: list[dict], cache: dict, today: date) -> list[tuple[str, str, str, str]]:
    """(host, url, job id, employer) for each branded host whose board is still unknown."""
    known = {norm(e.get("name")) for e in reg.get("greenhouse", {}).values()}
    cutoff = (today - timedelta(days=TTL_DAYS)).isoformat()
    out: dict[str, tuple[str, str, str, str]] = {}
    for it in items:
        url = it.get("apply_url") or ""
        m = GH_JID.search(url)
        if not m:
            continue
        h = re.match(r"https?://([^/]+)", url)
        # greenhouse.io's own hosts carry the token in the path; ats_of has it already.
        if not h:
            continue
        host = h.group(1).lower()
        if host.endswith("greenhouse.io") or host in out:
            continue
        if cache.get("gh:" + host, "") >= cutoff or norm(it.get("company_name")) in known:
            continue
        out[host] = (host, url, m.group(1), (it.get("company_name") or "").strip())
    return list(out.values())


def probe_gh_hosts(reg: dict, items: list[dict], cache: dict, today: date, c) -> int:
    found = 0
    for host, url, jid, name in gh_hosts(reg, items, cache, today)[:MAX_GH_HOSTS]:
        cache["gh:" + host] = today.isoformat()
        token = gh_host_token(c, url, jid, name)
        if token:
            found += add_board(reg, "greenhouse", token, name or host)
    return found


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
        found += probe_gh_hosts(reg, items, cache, today, c)
    save_cache(cache)
    return found
