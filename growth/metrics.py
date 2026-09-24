"""Daily numbers for the private analytics dashboard, stored in the app's own database (D1).

Cloudflare Web Analytics has no connector a dashboard page can call, so once a day this reads it
(and Bluesky and the listings data) and writes two tables in the internscout D1 database:

  metrics_daily     one row per day for the last 30 days: visits, and how many came in through a
                    landing page, from a search engine, from social sites, or directly
  metrics_snapshot  one row per run: the week's top pages, referrers and countries, Bluesky
                    followers and engagement, open and new listings, the page count, and the
                    extension's Chrome Web Store users and rating

Only totals: no visitor, student or account is ever stored. The dashboard reads these rows, and the
live sign-in, AI and Stripe numbers, through the viewer's own Cloudflare and Stripe connectors.

Needs CLOUDFLARE_API_TOKEN with Account Analytics: Read and D1: Edit.
Run from the repo root:  python growth/metrics.py [docs] [--write]
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "d4a5640a67faee275d9df91204c4ec59")
SITE_TAG = os.environ.get("CLOUDFLARE_SITE_TAG", "54f99780d57f4ae2a55182b44b082e0a")
D1_DATABASE = os.environ.get("INTERNSCOUT_D1_ID", "ef477808-f94c-4dce-a0b3-1198f00e5c39")
BLUESKY = os.environ.get("BLUESKY_HANDLE") or "internscout.org"
SITE = "https://internscout.org"
STORE_URL = "https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi"
DAYS = 30
# Cloudflare turns away Python's default user agent with a 403, so every request names itself.
UA = {"User-Agent": "InternScout-metrics/1.0 (+https://internscout.org)"}

SEARCH = re.compile(r"(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|"
                    r"yandex\.[a-z.]+|baidu\.com|search\.brave\.com|chatgpt\.com|perplexity\.ai|kagi\.com)$")
SOCIAL = re.compile(r"(^|\.)(bsky\.app|t\.co|x\.com|twitter\.com|reddit\.com|instagram\.com|linkedin\.com|lnkd\.in|"
                    r"facebook\.com|discord\.com|discordapp\.com|mastodon\.social|threads\.net|youtube\.com|"
                    r"tiktok\.com|snapchat\.com)$")

QUERY = """
query($account: string!, $site: string!, $start: Time!, $end: Time!, $weekStart: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    days: rumPageloadEventsAdaptiveGroups(limit: 100, orderBy: [date_ASC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { date } }
    landing: rumPageloadEventsAdaptiveGroups(limit: 100, orderBy: [date_ASC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end, requestPath_like: "/internships/%"}) {
      sum { visits } dimensions { date } }
    refs: rumPageloadEventsAdaptiveGroups(limit: 5000,
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { date refererHost } }
    pages: rumPageloadEventsAdaptiveGroups(limit: 20, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $weekStart, datetime_lt: $end}) { sum { visits } dimensions { requestPath } }
    topRefs: rumPageloadEventsAdaptiveGroups(limit: 12, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $weekStart, datetime_lt: $end}) { sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $weekStart, datetime_lt: $end}) { sum { visits } dimensions { countryName } }
  } }
}
"""


def _json(url: str, body: dict | None = None, token: str | None = None, timeout: int = 30):
    headers = {"Content-Type": "application/json", **UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 method="POST" if body is not None else "GET", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def source(host: str | None) -> str:
    host = (host or "").lower()
    if not host or host.endswith("internscout.org"):
        return "direct"
    if SEARCH.search(host):
        return "search"
    if SOCIAL.search(host):
        return "social"
    return "other"


def visits(token: str, now: datetime) -> tuple[list[dict], dict]:
    """(one row per day, the week's top pages/referrers/countries)."""
    end = now.replace(minute=0, second=0, microsecond=0)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    r = _json("https://api.cloudflare.com/client/v4/graphql",
              {"query": QUERY, "variables": {"account": ACCOUNT, "site": SITE_TAG, "start": iso(end - timedelta(days=DAYS)),
                                             "end": iso(end), "weekStart": iso(end - timedelta(days=7))}}, token)
    if r.get("errors"):
        raise RuntimeError("Cloudflare: " + r["errors"][0].get("message", "unknown error"))
    acct = r["data"]["viewer"]["accounts"][0]
    rows: dict[str, dict] = {}
    for g in acct["days"]:
        rows[g["dimensions"]["date"]] = {"day": g["dimensions"]["date"], "visits": g["sum"]["visits"],
                                         "landing": 0, "search": 0, "social": 0, "direct": 0}
    for g in acct["landing"]:
        rows.setdefault(g["dimensions"]["date"], {"day": g["dimensions"]["date"], "visits": 0, "landing": 0,
                                                  "search": 0, "social": 0, "direct": 0})["landing"] = g["sum"]["visits"]
    for g in acct["refs"]:
        kind = source(g["dimensions"]["refererHost"])
        if kind != "other" and g["dimensions"]["date"] in rows:
            rows[g["dimensions"]["date"]][kind] += g["sum"]["visits"]
    week = {
        "pages": [{"path": g["dimensions"]["requestPath"], "visits": g["sum"]["visits"]} for g in acct["pages"]],
        "referrers": [{"host": g["dimensions"]["refererHost"] or "(direct)", "visits": g["sum"]["visits"],
                       "kind": source(g["dimensions"]["refererHost"])} for g in acct["topRefs"]],
        "countries": [{"country": g["dimensions"]["countryName"], "visits": g["sum"]["visits"]} for g in acct["countries"]],
    }
    return sorted(rows.values(), key=lambda x: x["day"]), week


def bluesky(now: datetime) -> dict:
    base = "https://public.api.bsky.app/xrpc/"
    who = urllib.parse.quote(BLUESKY)
    prof = _json(f"{base}app.bsky.actor.getProfile?actor={who}")
    feed = _json(f"{base}app.bsky.feed.getAuthorFeed?limit=30&filter=posts_no_replies&actor={who}").get("feed") or []
    since = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")
    week = [f["post"] for f in feed if f["post"]["record"].get("createdAt", "") >= since]
    return {"handle": BLUESKY, "followers": prof.get("followersCount", 0), "posts": prof.get("postsCount", 0),
            "posts_7d": len(week), "likes_7d": sum(p.get("likeCount", 0) for p in week),
            "reposts_7d": sum(p.get("repostCount", 0) for p in week)}


def listings(site_dir: str) -> dict:
    with open(os.path.join(site_dir, "data", "stats.json"), encoding="utf-8") as f:
        s = json.load(f)
    return {"open": s.get("open"), "new_7d": s.get("new"), "generated_at": s.get("generated_at")}


def store_stats(html: str) -> dict:
    """The user count and average rating on a Chrome Web Store listing page. Each is None until the
    store shows it: a new listing has no user count, and an unrated one shows "0 out of 5 stars"
    (a real rating is never under 1)."""
    users = re.search(r">([\d,]+)\+? users?<", html)
    rating = re.search(r'aria-label="([\d.]+) out of 5 stars"', html)
    return {"users": int(users.group(1).replace(",", "")) if users else None,
            "rating": (float(rating.group(1)) or None) if rating else None}


def store() -> dict:
    """The extension's public store listing. The store has no API for these numbers, so this reads the
    page itself, once a day (robots.txt allows /detail/ pages without a query string)."""
    req = urllib.request.Request(STORE_URL, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return store_stats(r.read().decode("utf-8", "replace"))


def page_count() -> int:
    req = urllib.request.Request(f"{SITE}/sitemap.xml", headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace").count("<loc>")


def d1(token: str, sql: str, params: list | None = None) -> None:
    r = _json(f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{D1_DATABASE}/query",
              {"sql": sql, "params": params or []}, token)
    if not r.get("success"):
        raise RuntimeError("D1: " + json.dumps(r.get("errors"))[:300])


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    site_dir = args[0] if args else "docs"
    write = "--write" in argv
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    now = datetime.now(timezone.utc)
    snap: dict = {"taken": now.strftime("%Y-%m-%dT%H:%M:%SZ")}
    days: list[dict] = []
    problems: list[str] = []
    if token:
        try:
            days, snap["week"] = visits(token, now)
        except (urllib.error.URLError, RuntimeError, KeyError, IndexError, TypeError) as e:
            problems.append(f"visits: {e}")
    else:
        problems.append("visits: no CLOUDFLARE_API_TOKEN")
    for key, fn in (("bluesky", lambda: bluesky(now)), ("listings", lambda: listings(site_dir)), ("pages", page_count),
                    ("store", store)):
        try:
            snap[key] = fn()
        except (OSError, urllib.error.URLError, ValueError, KeyError) as e:
            problems.append(f"{key}: {e}")
    snap["problems"] = problems
    print(json.dumps({"days": days[-7:], **snap}, indent=1))
    if not write:
        return 0
    if not token:
        print("[metrics] nothing written: no CLOUDFLARE_API_TOKEN")
        return 1
    try:
        for row in days:
            d1(token, "INSERT OR REPLACE INTO metrics_daily (day, visits, landing, search, social, direct, updated) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?)",
               [row["day"], row["visits"], row["landing"], row["search"], row["social"], row["direct"], snap["taken"]])
        d1(token, "INSERT OR REPLACE INTO metrics_snapshot (taken, data) VALUES (?, ?)", [snap["taken"], json.dumps(snap)])
        # One snapshot a day is plenty; keep the last 120.
        d1(token, "DELETE FROM metrics_snapshot WHERE taken NOT IN "
                  "(SELECT taken FROM metrics_snapshot ORDER BY taken DESC LIMIT 120)")
    except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
        detail = e.read().decode("utf-8", "replace")[:300] if isinstance(e, urllib.error.HTTPError) else str(e)
        print(f"[metrics] write failed: {detail}")
        print("[metrics] The Cloudflare token needs D1: Edit as well as Account Analytics: Read.")
        return 1
    print(f"[metrics] wrote {len(days)} days and a snapshot")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
