"""Numbers for the private analytics dashboard, stored in the app's own database (D1).

Cloudflare Web Analytics has no connector a dashboard page can call, so every hour this reads it
(and the brand accounts, the automated jobs and the listings data) and writes two tables in the
internscout D1 database:
(was: "once a day". Each run rewrites the last 30 days through the current hour, today's partial
day included, so running hourly keeps the dashboard within the hour at no extra cost.)

  metrics_daily     one row per day for the last 30 days: visits, and how many came in through a
                    landing page, from a search engine, from social sites, or directly
  metrics_snapshot  one row per run: the week's top pages, referrers and countries; followers and
                    each recent post's engagement on Bluesky, Instagram and Mastodon; the last run
                    of each GitHub Actions job; Google searches (clicks, impressions, position by
                    day, top queries and pages, from Search Console); open and new listings, the
                    page count, and the extension's Chrome Web Store users and rating

Only totals: no visitor, student or account is ever stored. The dashboard reads these rows, and the
live sign-in, AI and Stripe numbers, through the viewer's own Cloudflare and Stripe connectors.

Needs CLOUDFLARE_API_TOKEN with Account Analytics: Read and D1: Edit. Optional: INSTAGRAM_TOKEN (the
same secret Brand posts uses; the working token it descends from is read from D1 and never refreshed
here), GITHUB_TOKEN (without it, the public API's hourly allowance still covers a run) and
GSC_SERVICE_ACCOUNT (a Google service account's JSON key, added to the Search Console property as a
Restricted user; needs the cryptography package to sign in).
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
MASTODON = os.environ.get("MASTODON_URL") or "https://mastodon.social"
MASTODON_ACCT = os.environ.get("MASTODON_ACCT") or "internscout"
REPO = os.environ.get("GITHUB_REPOSITORY") or "bpmcginley/InternshipFinder"
# The jobs the dashboard watches, by workflow file: a failed or overdue one is something to look at.
JOBS = [("ingest.yml", "Listings refresh"), ("pages.yml", "Site deploy"), ("metrics.yml", "Dashboard copy"),
        ("social.yml", "Brand posts"), ("growth-report.yml", "Growth report"), ("test.yml", "Tests"),
        ("catchup.yml", "Keep schedule")]
RECENT = 8                                  # recent posts kept per account
GSC_SITE = os.environ.get("GSC_SITE") or "sc-domain:internscout.org"
GSC_DAYS = 28
# was: 15 queries and 10 pages. With ~1,264 generated pages, the top 10 said nothing about which of
# them Google shows but nobody clicks (2026-10-04). LOW_CTR_* pick those out for the snapshot.
GSC_QUERIES = 100
GSC_PAGES = 200
LOW_CTR_MIN_IMPRESSIONS = 50
LOW_CTR_BELOW = 0.01
LOW_CTR_KEEP = 25
GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
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


def _clip(text: str | None, n: int = 110) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[:n - 1].rstrip() + "\u2026"


def _week(posts: list[dict], now: datetime, *keys: str) -> dict:
    """posts_7d, and each key summed over the posts made in the last 7 days."""
    since = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")
    week = [p for p in posts if (p.get("when") or "") >= since]
    return {"posts_7d": len(week), **{f"{k}_7d": sum(p.get(k) or 0 for p in week) for k in keys}}


def bluesky(now: datetime) -> dict:
    base = "https://public.api.bsky.app/xrpc/"
    who = urllib.parse.quote(BLUESKY)
    prof = _json(f"{base}app.bsky.actor.getProfile?actor={who}")
    feed = _json(f"{base}app.bsky.feed.getAuthorFeed?limit=30&filter=posts_no_replies&actor={who}").get("feed") or []
    # was: every feed item counted, reposts of other accounts included. Now our own posts only.
    posts = [{"when": f["post"]["record"].get("createdAt", "")[:19] + "Z",
              "text": _clip(f["post"]["record"].get("text")),
              "likes": f["post"].get("likeCount", 0), "reposts": f["post"].get("repostCount", 0),
              "replies": f["post"].get("replyCount", 0),
              "url": f"https://bsky.app/profile/{BLUESKY}/post/{f['post']['uri'].rsplit('/', 1)[-1]}"}
             for f in feed if not f.get("reason")]
    return {"handle": BLUESKY, "followers": prof.get("followersCount", 0), "posts": prof.get("postsCount", 0),
            **_week(posts, now, "likes", "reposts", "replies"), "recent": posts[:RECENT]}


def mastodon(now: datetime) -> dict:
    """The brand's Mastodon account, from the server's public API (reading needs no token)."""
    acct = _json(f"{MASTODON}/api/v1/accounts/lookup?acct={urllib.parse.quote(MASTODON_ACCT)}")
    statuses = _json(f"{MASTODON}/api/v1/accounts/{acct['id']}/statuses?limit=20&exclude_replies=true"
                     "&exclude_reblogs=true")
    tag = re.compile(r"<[^>]+>")
    posts = [{"when": st["created_at"][:19] + "Z", "text": _clip(tag.sub(" ", st.get("content") or "")),
              "likes": st.get("favourites_count", 0), "reposts": st.get("reblogs_count", 0),
              "replies": st.get("replies_count", 0), "url": st.get("url")} for st in statuses]
    return {"handle": f"@{acct['acct']}@{urllib.parse.urlparse(MASTODON).netloc}",
            "followers": acct.get("followers_count", 0), "posts": acct.get("statuses_count", 0),
            **_week(posts, now, "likes", "reposts", "replies"), "recent": posts[:RECENT]}


def instagram(cf_token: str | None, now: datetime) -> dict:
    """@internscout's followers and each recent post's likes and comments (instagram_business_basic;
    reach and views would need the insights permission, which the app doesn't ask for). The token is
    the one Brand posts keeps refreshed in D1; this only reads it, so the two jobs never both refresh.
    token_expires is when that token lapses if Brand posts stops running."""
    secret = os.environ.get("INSTAGRAM_TOKEN")
    if not secret:
        raise ValueError("no INSTAGRAM_TOKEN")
    import instagram as ig                              # imported here: it imports this module
    token = ig.working_token(secret, cf_token)[0]
    expires = None
    if cf_token:
        rows = ig._d1_rows(cf_token, "SELECT expires FROM social_tokens WHERE name = 'instagram' AND seed = ?",
                           [ig._seed(secret)])
        expires = rows[0]["expires"] if rows else None
    me = ig._request("GET", "me", {"fields": "username,followers_count,follows_count,media_count",
                                   "access_token": token})
    media = ig._request("GET", "me/media", {"fields": "caption,timestamp,like_count,comments_count,permalink",
                                            "limit": 20, "access_token": token}).get("data") or []
    posts = [{"when": (m.get("timestamp") or "")[:19] + "Z", "text": _clip(m.get("caption")),
              "likes": m.get("like_count", 0), "comments": m.get("comments_count", 0), "url": m.get("permalink")}
             for m in media]
    return {"handle": "@" + (me.get("username") or "internscout"), "followers": me.get("followers_count"),
            "following": me.get("follows_count"), "posts": me.get("media_count"), "token_expires": expires,
            **_week(posts, now, "likes", "comments"), "recent": posts[:RECENT]}


def automation() -> list[dict]:
    """The last finished run on main of each job the dashboard watches."""
    token = os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json", **UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    out = []
    for file, name in JOBS:
        req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/actions/workflows/{file}/runs"
                                     "?branch=main&status=completed&per_page=1", headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            runs = json.load(r).get("workflow_runs") or []
        run = runs[0] if runs else {}
        out.append({"job": name, "file": file, "conclusion": run.get("conclusion"), "at": run.get("updated_at"),
                    "event": run.get("event"), "url": run.get("html_url")})
    return out


def _jwt(info: dict, now: int) -> str:
    """The signed assertion Google trades for an access token (RS256 over the service account's key,
    signed with the cryptography package). The key never leaves this process."""
    import base64
    from cryptography.hazmat.primitives import hashes, serialization     # imported here: only this source
    from cryptography.hazmat.primitives.asymmetric import padding       # needs a package outside stdlib
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")  # noqa: E731
    head = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": info.get("private_key_id")}).encode())
    claims = b64(json.dumps({"iss": info["client_email"], "scope": GSC_SCOPE, "iat": now, "exp": now + 3600,
                             "aud": info.get("token_uri") or "https://oauth2.googleapis.com/token"}).encode())
    key = serialization.load_pem_private_key(info["private_key"].encode(), password=None)
    return (head + b"." + claims + b"." + b64(key.sign(head + b"." + claims, padding.PKCS1v15(), hashes.SHA256()))).decode()


def _gsc_token(info: dict) -> str:
    import time
    uri = info.get("token_uri") or "https://oauth2.googleapis.com/token"
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": _jwt(info, int(time.time()))})
    req = urllib.request.Request(uri, data=body.encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded", **UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        raise RuntimeError("Google sign-in: " + _google_error(e)) from None


def _google_error(e: urllib.error.HTTPError) -> str:
    try:
        err = json.loads(e.read()).get("error")
        return (err.get("message") if isinstance(err, dict) else str(err)) or f"HTTP {e.code}"
    except (ValueError, AttributeError):
        return f"HTTP {e.code}"


def _gsc_rows(token: str, body: dict) -> list[dict]:
    url = ("https://searchconsole.googleapis.com/webmasters/v3/sites/"
           f"{urllib.parse.quote(GSC_SITE, safe='')}/searchAnalytics/query")
    try:
        return _json(url, body, token).get("rows") or []
    except urllib.error.HTTPError as e:
        # 403 here usually means the service account's email isn't a user on the property yet.
        raise RuntimeError("Search Console: " + _google_error(e)) from None


def _gsc_totals(rows: list[dict]) -> dict:
    clicks = sum(r["clicks"] for r in rows)
    impressions = sum(r["impressions"] for r in rows)
    # Google's average position weights each day by its impressions.
    position = sum(r["position"] * r["impressions"] for r in rows) / impressions if impressions else None
    return {"clicks": clicks, "impressions": impressions, "ctr": round(clicks / impressions, 4) if impressions else None,
            "position": round(position, 1) if position is not None else None}


def search_console(now: datetime) -> dict:
    """The last 28 days of Google searches for the site: clicks, impressions and average position by
    day, and the top queries and pages. dataState "all" includes the last two days, which Google
    finalises later, so the newest days can still move a little.
    low_ctr_pages (2026-10-04): pages Google showed at least LOW_CTR_MIN_IMPRESSIONS times that were
    clicked under LOW_CTR_BELOW of the time, most shown first, at most LOW_CTR_KEEP: the titles and
    descriptions most worth rewriting."""
    key = os.environ.get("GSC_SERVICE_ACCOUNT")
    if not key:
        raise ValueError("no GSC_SERVICE_ACCOUNT")
    try:
        info = json.loads(key)
        info["client_email"], info["private_key"]           # noqa: B018  (both must be present)
    except (ValueError, KeyError, TypeError):
        raise ValueError("GSC_SERVICE_ACCOUNT is not a service account key file's JSON") from None
    token = _gsc_token(info)
    end = now.date()
    base = {"startDate": (end - timedelta(days=GSC_DAYS - 1)).isoformat(), "endDate": end.isoformat(), "dataState": "all"}
    cell = lambda r: {"clicks": r.get("clicks", 0), "impressions": r.get("impressions", 0),  # noqa: E731
                      "position": round(r.get("position", 0), 1)}
    days = [{"day": r["keys"][0], **cell(r)} for r in _gsc_rows(token, {**base, "dimensions": ["date"], "rowLimit": 100})]
    queries = [{"query": r["keys"][0], **cell(r)}
               for r in _gsc_rows(token, {**base, "dimensions": ["query"], "rowLimit": GSC_QUERIES})]   # was: 15
    pages = [{"path": urllib.parse.urlparse(r["keys"][0]).path or "/", **cell(r)}
             for r in _gsc_rows(token, {**base, "dimensions": ["page"], "rowLimit": GSC_PAGES})]    # was: 10
    since7 = (end - timedelta(days=6)).isoformat()
    # was: return {..., "queries": queries, "pages": pages}
    return {"site": GSC_SITE, "days": sorted(days, key=lambda d: d["day"]), "totals_28d": _gsc_totals(days),
            "totals_7d": _gsc_totals([d for d in days if d["day"] >= since7]), "queries": queries, "pages": pages,
            "low_ctr_pages": low_ctr_pages(pages)}


def low_ctr_pages(pages: list[dict]) -> list[dict]:
    """Pages shown often and rarely clicked, each with its ctr, most impressions first (see above)."""
    out = [{**p, "ctr": round(p["clicks"] / p["impressions"], 4)} for p in pages
           if p["impressions"] >= LOW_CTR_MIN_IMPRESSIONS and p["clicks"] / p["impressions"] < LOW_CTR_BELOW]
    return sorted(out, key=lambda p: -p["impressions"])[:LOW_CTR_KEEP]


def printable(snap: dict) -> dict:
    """The snapshot as the run log shows it. The repository is public, so its Actions logs are too:
    search queries are counted there, never listed (they go only to the private database)."""
    out = dict(snap)
    if isinstance(out.get("search_console"), dict):
        out["search_console"] = {**out["search_console"], "queries": f"{len(out['search_console']['queries'])} queries"}
    return out


def listings(site_dir: str) -> dict:
    """Open and new listings. new_7d is counted as the weekly digest and the brand posts count it
    (digest.new_roles: found this week by the /internships/new/ rule, one row per role within each
    employer), so the dashboard, the email and the posts agree. That needs the listings and
    backend/internscout (the Dashboard metrics workflow checks out both); where either is missing, it
    falls back to stats.json's own "new", which counts before deduplication and runs a little higher.
    new_7d_basis says which one a snapshot holds."""
    with open(os.path.join(site_dir, "data", "stats.json"), encoding="utf-8") as f:
        s = json.load(f)
    # was: return {"open": s.get("open"), "new_7d": s.get("new"), "generated_at": s.get("generated_at")}
    out = {"open": s.get("open"), "new_7d": s.get("new"), "new_7d_basis": "stats.json",
           "generated_at": s.get("generated_at")}
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        for p in (os.path.join(here, "..", "backend"), here):
            if p not in sys.path:
                sys.path.insert(0, p)
        import digest                                   # imported here: it needs backend/internscout
        d = digest.sp.load(site_dir)
        now = digest.sp._when(d["generated_at"]) or datetime.now(timezone.utc)
        out.update(new_7d=len(digest.new_roles(d, now)), new_7d_basis="digest")
    except (ImportError, OSError, ValueError, KeyError):
        pass
    return out


def store_stats(html: str) -> dict:
    """The user count and average rating on a Chrome Web Store listing page. Each is None until the
    store shows it: a new listing has no user count, and an unrated one shows "0 out of 5 stars"
    (a real rating is never under 1). Every listing shows that rating element, so a page without it
    isn't one the parser understands, and it says so rather than report "no users yet"."""
    users = re.search(r">([\d,]+)\+? users?<", html)
    rating = re.search(r'aria-label="([\d.]+) out of 5 stars"', html)
    if not rating:
        raise ValueError("store listing not recognised")
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


# Every snapshot from the last KEEP_ALL_DAYS, then the day's last one for KEEP_DAYS, then nothing.
KEEP_ALL_DAYS = 2
KEEP_DAYS = 120


def prune_sql(now: datetime) -> list[tuple[str, list]]:
    """The statements that thin metrics_snapshot after a run. `taken` is an ISO timestamp, so a
    string comparison orders it and its first 10 characters are the UTC day."""
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    return [
        ("DELETE FROM metrics_snapshot WHERE taken < ? AND taken NOT IN "
         "(SELECT MAX(taken) FROM metrics_snapshot GROUP BY substr(taken, 1, 10))",
         [iso(now - timedelta(days=KEEP_ALL_DAYS))]),
        ("DELETE FROM metrics_snapshot WHERE taken < ?", [iso(now - timedelta(days=KEEP_DAYS))]),
    ]


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
    for key, fn in (("bluesky", lambda: bluesky(now)), ("instagram", lambda: instagram(token, now)),
                    ("mastodon", lambda: mastodon(now)), ("automation", automation),
                    ("search_console", lambda: search_console(now)),
                    ("listings", lambda: listings(site_dir)), ("pages", page_count), ("store", store)):
        try:
            snap[key] = fn()
        # RuntimeError includes instagram.InstagramError, which carries Meta's message, never the token.
        # ImportError: the cryptography package isn't installed (Search Console only).
        except (OSError, urllib.error.URLError, ValueError, KeyError, RuntimeError, ImportError) as e:
            problems.append(f"{key}: {e}")
    snap["problems"] = problems
    print(json.dumps({"days": days[-7:], **printable(snap)}, indent=1))
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
        # was: keep the last 120 snapshots, which was 120 days at one run a day but only five days at
        # one an hour. The dashboard reads the newest snapshot only; the older ones are the history
        # (store users, Bluesky followers, listings over time), so thin them rather than drop them.
        for sql, params in prune_sql(now):
            d1(token, sql, params)
    except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
        detail = e.read().decode("utf-8", "replace")[:300] if isinstance(e, urllib.error.HTTPError) else str(e)
        print(f"[metrics] write failed: {detail}")
        print("[metrics] The Cloudflare token needs D1: Edit as well as Account Analytics: Read.")
        return 1
    print(f"[metrics] wrote {len(days)} days and a snapshot")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
