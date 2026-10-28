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
                    day, top queries and pages, from Search Console); the same for Bing, from Bing
                    Webmaster Tools, with its indexed page count; open and new listings, the
                    page count, and the extension's Chrome Web Store users and rating

Only totals: no visitor, student or account is ever stored. The dashboard reads these rows, and the
live sign-in, AI and Stripe numbers, through the viewer's own Cloudflare and Stripe connectors.

Needs CLOUDFLARE_API_TOKEN with Account Analytics: Read and D1: Edit. Optional: INSTAGRAM_TOKEN (the
same secret Brand posts uses; the working token it descends from is read from D1 and never refreshed
here), GITHUB_TOKEN (without it, the public API's hourly allowance still covers a run) and
GSC_SERVICE_ACCOUNT (a Google service account's JSON key, added to the Search Console property as a
Restricted user; needs the cryptography package to sign in) and BING_WEBMASTER_KEY (an API key from
Bing Webmaster Tools, Settings, API access).
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
from zoneinfo import ZoneInfo

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
        ("catchup.yml", "Keep schedule"), ("digest.yml", "Weekly email")]
DIGEST_FIRST_DUE = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
DIGEST_SCHEDULE_GRACE = timedelta(hours=2)
DIGEST_EASTERN = ZoneInfo("America/New_York")
# Keep schedule (growth/catchup.py) starts a late Monday email with the workflow's own GITHUB_TOKEN, so
# GitHub records that run's triggering actor as this bot. A person's run, test copy or not, shows the
# person's login. Nothing else in the repo starts digest.yml with the token.
CATCHUP_ACTOR = "github-actions[bot]"
RECENT = 8                                  # recent posts kept per account
GSC_SITE = os.environ.get("GSC_SITE") or "sc-domain:internscout.org"
GSC_DAYS = 28
# 2026-10-28: Google dates are Pacific and newest dates are preliminary. was: UTC today.
# Revert: remove the explicit Pacific/final windows and comparison fields below.
GSC_PACIFIC = ZoneInfo("America/Los_Angeles")
GSC_WEEK_PAGES = 500
GSC_WEEK_QUERIES = 250
GSC_INSPECTION_PAGES = ("under-armour", "medtronic", "lyft", "bose")
# 2026-10-28: unchanged comparators with baseline impressions, not zero-traffic pages.
# was: Sonos/Stryker/Pinterest/URBN. Revert: restore that tuple; collection only, no page selection.
GSC_CONTROL_PAGES = ("shure", "sun-life", "ul-solutions", "capital-one")
# was: 15 queries and 10 pages. With ~1,264 generated pages, the top 10 said nothing about which of
# them Google shows but nobody clicks (2026-10-04). LOW_CTR_* pick those out for the snapshot.
GSC_QUERIES = 100
GSC_PAGES = 200
LOW_CTR_MIN_IMPRESSIONS = 50
LOW_CTR_BELOW = 0.01
LOW_CTR_KEEP = 25
GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
# The site as Bing Webmaster Tools names it (added 2026-10-08 by importing it from Search Console).
BING_SITE = os.environ.get("BING_SITE") or "https://internscout.org/"
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
# 2026-10-28: distinguish Google search from mail/auth and growing Bing traffic.
# was: every Google subdomain joined one search bucket. Revert: restore SEARCH-only classification.
GOOGLE_SEARCH = re.compile(r"^(?:www\.)?google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$")
BING_SEARCH = re.compile(r"^(?:(?:www|cn)\.)?bing\.com$")

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

# 2026-10-28: a bounded referrer query uses the same Pacific week boundaries as Google.
# Revert: remove the optional matched comparison; the legacy daily search total remains combined.
SEARCH_WEEK_QUERY = """
query($account: string!, $site: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    refs: rumPageloadEventsAdaptiveGroups(limit: 5000,
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) {
      sum { visits } dimensions { refererHost } }
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
    if not host or host == "internscout.org" or host.endswith(".internscout.org"):
        return "direct"
    if re.search(r"(^|\.)google\.", host) and not GOOGLE_SEARCH.fullmatch(host):
        return "other"
    if SEARCH.search(host):
        return "search"
    if SOCIAL.search(host):
        return "social"
    return "other"


def search_engine(host: str | None) -> str | None:
    host = (host or "").lower()
    if source(host) != "search":
        return None
    if GOOGLE_SEARCH.fullmatch(host):
        return "google"
    if BING_SEARCH.fullmatch(host):
        return "bing"
    return "other_search"


def visits(token: str, now: datetime) -> tuple[list[dict], dict]:
    """(one row per day, the week's top pages/referrers/countries)."""
    end = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    # 2026-10-28: replace omitted sample dates with labelled estimates instead of leaving stale rows.
    # was: only returned dates were rewritten. Revert: initialize rows from acct['days'] again.
    start = (end - timedelta(days=DAYS - 1 if end.hour else DAYS)).replace(hour=0)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    r = _json("https://api.cloudflare.com/client/v4/graphql",
              {"query": QUERY, "variables": {"account": ACCOUNT, "site": SITE_TAG, "start": iso(start),
                                             "end": iso(end), "weekStart": iso(end - timedelta(days=7))}}, token)
    if not isinstance(r, dict):
        raise RuntimeError("Cloudflare: incomplete analytics response")
    if r.get("errors"):
        raise RuntimeError("Cloudflare: " + r["errors"][0].get("message", "unknown error"))
    acct = r["data"]["viewer"]["accounts"][0]
    if not isinstance(acct, dict) or any(not isinstance(acct.get(key), list)
                                       for key in ("days", "landing", "refs", "pages", "topRefs", "countries")):
        raise RuntimeError("Cloudflare: incomplete analytics response")
    rows: dict[str, dict] = {}
    day = start
    while day < end:
        key = day.date().isoformat()
        rows[key] = {"day": key, "visits": 0, "landing": 0, "search": 0, "social": 0, "direct": 0}
        day += timedelta(days=1)
    engines = {day: {"day": day, "google": 0, "bing": 0, "other_search": 0} for day in rows}
    observed = set()
    for g in acct["days"]:
        key = g["dimensions"]["date"]
        if key in rows:
            observed.add(key)
            rows[key]["visits"] = g["sum"]["visits"]
    for g in acct["landing"]:
        if g["dimensions"]["date"] in rows:
            rows[g["dimensions"]["date"]]["landing"] = g["sum"]["visits"]
    for g in acct["refs"]:
        host, day = g["dimensions"]["refererHost"], g["dimensions"]["date"]
        kind, engine = source(host), search_engine(host)
        if day in rows:
            if kind != "other":
                rows[day][kind] += g["sum"]["visits"]
            if engine:
                engines[day][engine] += g["sum"]["visits"]
    week = {
        "pages": [{"path": g["dimensions"]["requestPath"], "visits": g["sum"]["visits"]} for g in acct["pages"]],
        "referrers": [{"host": g["dimensions"]["refererHost"] or "(direct)", "visits": g["sum"]["visits"],
                       "kind": source(g["dimensions"]["refererHost"])} for g in acct["topRefs"]],
        "countries": [{"country": g["dimensions"]["countryName"], "visits": g["sum"]["visits"]} for g in acct["countries"]],
        "search_engines": {"timezone": "UTC", "days": list(engines.values()),
                           "basis": "referring_host; not confirmed organic clicks"},
        "coverage": {"timezone": "UTC", "start": iso(start), "end_exclusive": iso(end),
                     "measurement": "adaptive_sample_estimates", "omitted_days": sorted(set(rows) - observed),
                     "omitted_day_value": "zero estimate, not proof of zero visitors",
                     "referrer_limit": 5000, "referrers_may_be_truncated": len(acct["refs"]) >= 5000,
                     "partial_days": [end.date().isoformat()] if end.hour else []},
    }
    return sorted(rows.values(), key=lambda x: x["day"]), week


def cloudflare_search_comparison(token: str, weeks: list[dict]) -> dict:
    """Estimated arrivals for Google's two complete Pacific weeks, never mixed with all-source visits."""
    out = []
    for period in weeks[:2]:
        start = datetime.strptime(period["start"], "%Y-%m-%d").replace(tzinfo=GSC_PACIFIC)
        end = datetime.strptime(period["end"], "%Y-%m-%d").replace(tzinfo=GSC_PACIFIC) + timedelta(days=1)
        iso = lambda d: d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        reply = _json("https://api.cloudflare.com/client/v4/graphql",
                      {"query": SEARCH_WEEK_QUERY, "variables": {"account": ACCOUNT, "site": SITE_TAG,
                         "start": iso(start), "end": iso(end)}}, token)
        if not isinstance(reply, dict):
            raise RuntimeError("Cloudflare comparison: incomplete response")
        if reply.get("errors"):
            raise RuntimeError("Cloudflare comparison: " + reply["errors"][0].get("message", "unknown error"))
        refs = reply["data"]["viewer"]["accounts"][0]["refs"]
        if not isinstance(refs, list):
            raise RuntimeError("Cloudflare comparison: incomplete response")
        totals = {"google": 0, "bing": 0, "other_search": 0}
        for row in refs:
            engine = search_engine(row["dimensions"]["refererHost"])
            if engine:
                totals[engine] += row["sum"]["visits"]
        out.append({"start": period["start"], "end": period["end"], "start_utc": iso(start),
                    "end_exclusive_utc": iso(end), "visits": totals, "returned_referrers": len(refs),
                    "at_row_limit": len(refs) >= 5000})
    return {"status": "available", "timezone": "America/Los_Angeles", "measurement": "adaptive_sample_estimates",
            "basis": "referring_host; not confirmed organic clicks", "weeks": out}


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


def _timestamp(value) -> datetime | None:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return stamp.astimezone(timezone.utc) if stamp.tzinfo else None
    except ValueError:
        return None


def subscriber_run(run: dict) -> bool:
    """A run meant for every subscriber: GitHub's schedule, or Keep schedule's catch-up of it
    (2026-10-21; was: the schedule only, so a Monday GitHub dropped read "overdue" after the
    catch-up had sent the email). A person's run never counts: its audience isn't inferred."""
    if run.get("event") == "schedule":
        return True
    return (run.get("event") == "workflow_dispatch" and
            (run.get("triggering_actor") or {}).get("login") == CATCHUP_ACTOR)


def digest_due_times(now: datetime) -> tuple[datetime, datetime]:
    """The most recent and next Monday 8 a.m. Eastern slots around `now`, returned in UTC."""
    local = now.astimezone(DIGEST_EASTERN)
    monday = local.date() - timedelta(days=local.weekday())
    due_local = datetime.combine(monday, datetime.min.time(), DIGEST_EASTERN).replace(hour=8)
    due = due_local.astimezone(timezone.utc)
    if now < due:
        due_local -= timedelta(days=7)
        due = due_local.astimezone(timezone.utc)
    return due, (due_local + timedelta(days=7)).astimezone(timezone.utc)


def step_conclusion(jobs: list[dict], name: str) -> str | None:
    """Conclusion of one named step across a run's jobs, if GitHub has reported it."""
    return next((step.get("conclusion") for job in jobs for step in job.get("steps", [])
                 if step.get("name") == name), None)


def digest_health(runs: list[dict], now: datetime, send_step: str | None = None) -> dict:
    """Weekly schedule health, not delivery confirmation. Manual tests never satisfy a broadcast.

    Allow two hours for GitHub's best-effort scheduler. Never dispatch or retry a send from here.
    A successful subscriber run must also have run its send step (DIGEST_ENABLED can skip it).
    When a Monday has more than one (a catch-up, then GitHub's late scheduled run), the newest that
    succeeded decides: a later run that fails can't hide an email that went.
    """
    now = now.astimezone(timezone.utc)
    # 2026-10-27: compute the wall-clock slot in America/New_York. was: Monday 12:00 UTC.
    # Revert: restore the fixed-UTC monday/due calculation and due + seven days below.
    due, next_due = digest_due_times(now)
    first_pending = due < DIGEST_FIRST_DUE
    due = max(due, DIGEST_FIRST_DUE)
    iso = lambda value: value.strftime("%Y-%m-%dT%H:%M:%SZ")
    result = {"health": "not_due" if first_pending else "waiting", "due_at": iso(due),
              "next_due_at": iso(due if first_pending else next_due),
              "detail": "Scheduled subscriber send not due yet." if first_pending else
                        "Waiting for GitHub's scheduled subscriber send; two-hour scheduling grace.",
              "delivery_confirmed": False}
    if first_pending:
        return result
    eligible = [r for r in runs if subscriber_run(r) and
                (created := _timestamp(r.get("created_at"))) is not None and due <= created <= now]
    # was: the newest scheduled run, whatever its result.
    run = max(eligible, key=lambda r: (r.get("conclusion") == "success", _timestamp(r["created_at"]))) \
        if eligible else None
    if not run:
        if now >= due + DIGEST_SCHEDULE_GRACE:
            result.update(health="overdue", detail="No scheduled or Keep schedule subscriber run for this Monday. Inspect Actions and Buttondown before any manual send.")
        return result
    result.update(run_id=run.get("id"), run_url=run.get("html_url"), event=run.get("event"))
    if run.get("status") != "completed":
        result.update(health="in_progress", detail="Subscriber run is queued or running; do not start another send.")
        if now >= due + DIGEST_SCHEDULE_GRACE:
            result.update(health="overdue", detail="Subscriber run is still queued or running after the grace period. Inspect it; do not start a second send.")
    elif run.get("conclusion") != "success":
        result.update(health="failed", detail="Subscriber run failed or was cancelled. Check Buttondown sent/scheduled status before retrying: delivery may be unknown.")
    elif send_step == "success":
        result.update(health="success", detail="Subscriber send step succeeded: provider handoff, not proof of recipient delivery. Check Buttondown delivery results.")
    elif send_step == "skipped":
        result.update(health="blocked", detail="Workflow succeeded but the subscriber send step was skipped. Check DIGEST_ENABLED; no broadcast is established.")
    else:
        result.update(health="unknown", detail="Successful workflow has no verified successful subscriber send step. Inspect Actions and Buttondown before retrying.")
    return result


def automation(now: datetime | None = None) -> list[dict]:
    """The last finished run on main of each job the dashboard watches."""
    token = os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json", **UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    now = now or datetime.now(timezone.utc)

    def read(path):
        req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/actions/{path}", headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    out = []
    for file, name in JOBS:
        runs = read(f"workflows/{file}/runs?branch=main&status=completed&per_page=1").get("workflow_runs") or []
        run = runs[0] if runs else {}
        row = {"job": name, "file": file, "conclusion": run.get("conclusion"), "at": run.get("updated_at"),
               "event": run.get("event"), "url": run.get("html_url")}
        if file == "digest.yml":
            # Every event, so Keep schedule's catch-up is seen; digest_health keeps only subscriber runs.
            # was: ...&event=schedule&per_page=15
            scheduled = read(f"workflows/{file}/runs?branch=main&per_page=30").get("workflow_runs") or []
            # 2026-10-27: two UTC cron entries bracket 8am Eastern. The local-time guard makes the
            # other run skip "Write the digest". Exclude only that proven inactive run; do not infer
            # from created_at because GitHub can start the active schedule hours late.
            # Revert: remove this filtering when digest.yml returns to one fixed UTC cron.
            due, _ = digest_due_times(now)
            jobs_cache = {}
            active = []
            for candidate in scheduled:
                created = _timestamp(candidate.get("created_at"))
                if (candidate.get("event") == "schedule" and candidate.get("status") == "completed" and
                        candidate.get("conclusion") == "success" and created is not None and
                        due - timedelta(hours=1) <= created <= now):
                    jobs_cache[candidate.get("id")] = read(f"runs/{candidate['id']}/jobs?per_page=100").get("jobs") or []
                    if step_conclusion(jobs_cache[candidate.get("id")], "Write the digest") == "skipped":
                        continue
                active.append(candidate)
            scheduled = active
            health = digest_health(scheduled, now)
            current = next((r for r in scheduled if r.get("id") == health.get("run_id")), {}) if health.get("run_id") else {}
            step = None
            if current.get("status") == "completed" and current.get("conclusion") == "success":
                jobs = jobs_cache.get(current.get("id"))
                if jobs is None:
                    jobs = read(f"runs/{current['id']}/jobs?per_page=100").get("jobs") or []
                step = step_conclusion(jobs, "Send the digest")
                health = digest_health(scheduled, now, step)
            # Existing row fields describe the subscriber run, never the last owner-only test.
            row.update({"conclusion": current.get("conclusion"), "at": current.get("updated_at"),
                        "event": current.get("event"), "url": current.get("html_url"), **health})
            if run.get("event") == "workflow_dispatch" and not subscriber_run(run):   # a person's run
                row["last_manual_run"] = {"at": run.get("updated_at"), "conclusion": run.get("conclusion"),
                                          "url": run.get("html_url"), "audience": "not_inferred_from_manual_run"}
        out.append(row)
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


def _gsc_response(token: str, body: dict) -> dict:
    url = ("https://searchconsole.googleapis.com/webmasters/v3/sites/"
           f"{urllib.parse.quote(GSC_SITE, safe='')}/searchAnalytics/query")
    try:
        reply = _json(url, body, token)
        if not isinstance(reply, dict) or not isinstance(reply.get("rows", []), list):
            raise RuntimeError("Search Console: unexpected response")
        return reply
    except urllib.error.HTTPError as e:
        # 403 here usually means the service account's email isn't a user on the property yet.
        raise RuntimeError("Search Console: " + _google_error(e)) from None


def _gsc_rows(token: str, body: dict) -> list[dict]:
    return _gsc_response(token, body).get("rows") or []


def _gsc_totals(rows: list[dict]) -> dict:
    clicks = sum(r["clicks"] for r in rows)
    impressions = sum(r["impressions"] for r in rows)
    # Google's average position weights each day by its impressions.
    position = sum(r["position"] * r["impressions"] for r in rows) / impressions if impressions else None
    return {"clicks": clicks, "impressions": impressions, "ctr": round(clicks / impressions, 4) if impressions else None,
            "position": round(position, 1) if position is not None else None}


def _gsc_end(now: datetime, metadata: dict):
    """Do not slide a window back merely because its last complete day had no impressions."""
    today = now.astimezone(GSC_PACIFIC).date()
    try:
        incomplete = datetime.strptime(metadata.get("first_incomplete_date"), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        incomplete = None
    if incomplete is not None and incomplete <= today:
        return min(today - timedelta(days=1), incomplete - timedelta(days=1)), "google_first_incomplete_date"
    # Optional metadata absent: an explicit lag, never the last nonzero row, sets the window.
    return today - timedelta(days=3), "conservative_three_day_lag_metadata_unavailable"


def _gsc_cell(row: dict) -> dict:
    return {"clicks": row.get("clicks", 0), "impressions": row.get("impressions", 0),
            "position": round(row.get("position", 0), 1)}


def _gsc_details(token: str, base: dict, dimension: str, limit: int) -> tuple[list[dict], dict]:
    reply = _gsc_response(token, {**base, "dimensions": [dimension], "rowLimit": limit})
    rows = reply.get("rows") or []
    if dimension == "page":
        # 2026-10-28: retain canonical identity beside the old path key. was: discard host/scheme.
        # Revert: remove url while retaining path.
        out = [{"url": r["keys"][0], "path": urllib.parse.urlparse(r["keys"][0]).path or "/", **_gsc_cell(r)}
               for r in rows]
    else:
        out = [{"query": r["keys"][0], **_gsc_cell(r)} for r in rows]
    return out, {"requested_limit": limit, "returned": len(rows), "at_row_limit": len(rows) >= limit,
                 "exhaustive": False, "basis": "Google top rows; privacy/internal limits can omit rows",
                 "aggregation": reply.get("responseAggregationType")}


def inspect_search_pages(token: str, now: datetime) -> dict:
    """Read Google's last observed crawl for four treatment pages; this never requests indexing.

    2026-10-28: bounded 4x10-second read-only requests using the existing token, stop on 403.
    was: no crawl-pickup evidence. Revert: remove this optional snapshot field and calls.
    """
    fields = ("lastCrawlTime", "coverageState", "verdict", "googleCanonical", "userCanonical",
              "indexingState", "pageFetchState")
    results = []
    for slug in GSC_INSPECTION_PAGES:
        url = f"{SITE}/internships/at/{slug}/"
        try:
            reply = _json("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
                          {"inspectionUrl": url, "siteUrl": GSC_SITE, "languageCode": "en-US"}, token, timeout=10)
            index = reply["inspectionResult"]["indexStatusResult"]
            if not isinstance(index, dict) or not any(index.get(field) for field in fields):
                raise ValueError("unexpected response")
            results.append({"url": url, "status": "available", **{f: index.get(f) for f in fields}})
        except urllib.error.HTTPError as e:
            results.append({"url": url, "status": "unavailable", "error": f"HTTP {e.code}"})
            if e.code == 403:
                break  # no permission changes, escalation or repeated rejected requests
        except (OSError, urllib.error.URLError, ValueError, KeyError, IndexError, TypeError, RuntimeError) as e:
            results.append({"url": url, "status": "unavailable", "error": type(e).__name__})
    available = sum(r["status"] == "available" for r in results)
    return {"checked_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "status": "available" if available == len(results) else "partial" if available else "unavailable",
            "operation": "read_only_url_inspection; not an indexing request", "results": results}


def fixed_search_cohort(token: str, weeks: list[dict]) -> dict:
    """One bounded request preserves the same eight page identities across both full weeks.

    2026-10-28: top-page caps must not hide the fixed treatment/control experiment.
    was: no fixed page/date cohort. Revert: remove this optional field/call.
    """
    groups = {"treatment": [f"{SITE}/internships/at/{slug}/" for slug in GSC_INSPECTION_PAGES],
              "control": [f"{SITE}/internships/at/{slug}/" for slug in GSC_CONTROL_PAGES]}
    urls = set(groups["treatment"] + groups["control"])
    expression = "^(?:" + "|".join(re.escape(url) for url in sorted(urls)) + ")$"
    request = {"startDate": weeks[0]["start"], "endDate": weeks[-1]["end"],
               "dataState": "final", "type": "web", "aggregationType": "auto",
               "dimensions": ["date", "page"], "rowLimit": 1000,
               "dimensionFilterGroups": [{"groupType": "and", "filters": [
                   {"dimension": "page", "operator": "includingRegex", "expression": expression}]}]}
    result = {"start": request["startDate"], "end": request["endDate"], "timezone": "America/Los_Angeles",
              "data_state": "final", "search_type": "web", "groups": groups,
              "filters": request["dimensionFilterGroups"], "row_limit": 1000, "max_possible_page_days": 112,
              "exhaustive": False, "omitted_rows": "Google can omit zero-data/privacy-limited rows; not proof of deindexing"}
    try:
        reply = _gsc_response(token, request)
        rows = [{"day": r["keys"][0], "url": r["keys"][1], **_gsc_cell(r)} for r in reply.get("rows") or []]
        if any(r["url"] not in urls or not request["startDate"] <= r["day"] <= request["endDate"] for r in rows):
            raise RuntimeError("unexpected fixed cohort keys")
        if len({(r["day"], r["url"]) for r in rows}) != len(rows) or len(rows) > 112:
            raise RuntimeError("unexpected fixed cohort row count")
        result.update(status="available", rows=rows, returned=len(rows), at_row_limit=len(rows) >= 1000,
                      aggregation=reply.get("responseAggregationType"))
    except (OSError, urllib.error.URLError, ValueError, KeyError, IndexError, TypeError, RuntimeError) as e:
        result.update(status="unavailable", error=str(e))
    return result


def search_console(now: datetime) -> dict:
    """Final-only, explicitly dated Google headlines and private matched-week diagnostics.

    A companion all/date request preserves Google's completeness boundary. If Google omits it,
    a labelled three-day lag is used; a missing impression day never shifts the date window.
    The bounded query/page lists are not exhaustive and never calculate site totals.
    """
    key = os.environ.get("GSC_SERVICE_ACCOUNT")
    if not key:
        raise ValueError("no GSC_SERVICE_ACCOUNT")
    try:
        info = json.loads(key)
        info["client_email"], info["private_key"]           # noqa: B018  (both must be present)
    except (ValueError, KeyError, TypeError):
        raise ValueError("GSC_SERVICE_ACCOUNT is not a service account key file's JSON") from None
    token = _gsc_token(info)
    today = now.astimezone(GSC_PACIFIC).date()
    probe = {"startDate": (today - timedelta(days=34)).isoformat(), "endDate": today.isoformat(),
             "type": "web", "aggregationType": "auto", "dataState": "all", "dimensions": ["date"], "rowLimit": 100}
    preliminary = _gsc_response(token, probe)
    metadata = preliminary.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise RuntimeError("Search Console: unexpected completeness metadata")
    end, boundary = _gsc_end(now, metadata)
    start = end - timedelta(days=GSC_DAYS - 1)
    base = {"startDate": start.isoformat(), "endDate": end.isoformat(), "dataState": "final",
            "type": "web", "aggregationType": "auto"}
    final = _gsc_response(token, {**base, "dimensions": ["date"], "rowLimit": 100})
    days = [{"day": r["keys"][0], **_gsc_cell(r)} for r in final.get("rows") or []
            if start.isoformat() <= r["keys"][0] <= end.isoformat()]
    queries, query_limit = _gsc_details(token, base, "query", GSC_QUERIES)
    pages, page_limit = _gsc_details(token, base, "page", GSC_PAGES)
    since7 = (end - timedelta(days=6)).isoformat()
    # 2026-10-28: collect matched Monday-Sunday cohorts instead of subtracting rolling top lists.
    # Revert: omit comparison; retain final headline keys for existing dashboards.
    sunday = end - timedelta(days=(end.weekday() + 1) % 7)
    weeks = []
    for week_end in (sunday - timedelta(days=7), sunday):
        week_start = week_end - timedelta(days=6)
        request = {**base, "startDate": week_start.isoformat(), "endDate": week_end.isoformat()}
        week = {"start": week_start.isoformat(), "end": week_end.isoformat(),
                "totals": _gsc_totals([d for d in days if week_start.isoformat() <= d["day"] <= week_end.isoformat()])}
        try:
            week_pages, page_bounds = _gsc_details(token, request, "page", GSC_WEEK_PAGES)
            week_queries, query_bounds = _gsc_details(token, request, "query", GSC_WEEK_QUERIES)
            week.update(pages=week_pages, queries=week_queries,
                        limits={"pages": page_bounds, "queries": query_bounds}, status="available")
        except (OSError, urllib.error.URLError, ValueError, KeyError, IndexError, TypeError, RuntimeError) as e:
            # Optional detail failure must not discard successful final site totals or invent zeros.
            week.update(status="unavailable", error=str(e))
        weeks.append(week)
    return {"site": GSC_SITE, "days": sorted(days, key=lambda d: d["day"]), "totals_28d": _gsc_totals(days),
            "totals_7d": _gsc_totals([d for d in days if d["day"] >= since7]), "queries": queries, "pages": pages,
            "low_ctr_pages": low_ctr_pages(pages),
            "reporting": {"timezone": "America/Los_Angeles", "data_state": "final", "search_type": "web",
                          "filters": [], "aggregation": final.get("responseAggregationType"),
                          "start": start.isoformat(), "end": end.isoformat(), "seven_day_start": since7,
                          "boundary_basis": boundary, "completeness_metadata": metadata,
                          "probe_start": probe["startDate"], "probe_end": probe["endDate"],
                          "omitted_days": "Google omits dates without data; no row is not a collection failure",
                          "limits": {"pages": page_limit, "queries": query_limit}},
            "comparison": {"timezone": "America/Los_Angeles", "data_state": "final", "search_type": "web",
                           "filters": [], "weeks": weeks},
            "url_inspection": inspect_search_pages(token, now), "fixed_page_cohort": fixed_search_cohort(token, weeks)}


def low_ctr_pages(pages: list[dict]) -> list[dict]:
    """Pages shown often and rarely clicked, each with its ctr, most impressions first (see above)."""
    out = [{**p, "ctr": round(p["clicks"] / p["impressions"], 4)} for p in pages
           if p["impressions"] >= LOW_CTR_MIN_IMPRESSIONS and p["clicks"] / p["impressions"] < LOW_CTR_BELOW]
    return sorted(out, key=lambda p: -p["impressions"])[:LOW_CTR_KEEP]


def _bing_get(method: str, key: str) -> list[dict]:
    """One Bing Webmaster API call. The key travels in the URL, as the API requires, so neither the URL
    nor the exception that carries it is ever printed: only the method and the HTTP status are."""
    url = (f"https://ssl.bing.com/webmaster/api.svc/json/{method}?"
           + urllib.parse.urlencode({"siteUrl": BING_SITE, "apikey": key}))
    try:
        reply = _json(url)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Bing {method}: HTTP {e.code}") from None
    except urllib.error.URLError:
        raise RuntimeError(f"Bing {method}: no connection") from None
    # was: (_json(url) or {}).get("d") or [], which raised AttributeError (not caught by main(), so the
    # whole run stopped) when Bing answered with anything but an object (2026-10-14 review).
    if reply is None or (isinstance(reply, dict) and reply.get("d") is None):
        return []
    rows = reply.get("d") if isinstance(reply, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError(f"Bing {method}: unexpected reply")
    return [r for r in rows if isinstance(r, dict)]


def _bing_day(stamp: str | None) -> str | None:
    """'/Date(1316156400000-0700)/' -> '2011-09-16', the day in the offset Bing gives."""
    m = re.match(r"/Date\((-?\d+)([+-]\d{4})?\)/", stamp or "")
    if not m:
        return None
    off = m.group(2) or "+0000"
    tz = timezone(timedelta(hours=int(off[:3]), minutes=int(off[0] + off[3:])))
    return datetime.fromtimestamp(int(m.group(1)) / 1000, tz).date().isoformat()


def _bing_sum(rows: list[dict], key: str, since: str) -> list[dict]:
    """Query or page rows (one per key per period, no date filter in the API) summed over the days from
    `since`, most clicks then most impressions first. position is Bing's average impression position,
    weighted by impressions like Search Console's; Bing sends -1 when it has none."""
    acc: dict[str, list] = {}
    for r in rows:
        day = _bing_day(r.get("Date"))
        if not day or day < since or not r.get("Query"):
            continue
        a = acc.setdefault(r["Query"], [0, 0, 0.0, 0])
        imp, pos = r.get("Impressions") or 0, r.get("AvgImpressionPosition")
        a[0] += r.get("Clicks") or 0
        a[1] += imp
        if pos is not None and pos > 0 and imp:
            a[2] += pos * imp
            a[3] += imp
    out = [{key: k, "clicks": c, "impressions": i, "position": round(p / w, 1) if w else None}
           for k, (c, i, p, w) in acc.items()]
    return sorted(out, key=lambda r: (-r["clicks"], -r["impressions"], r[key]))


def bing(now: datetime) -> dict:
    """The last 28 days of Bing searches for the site (2026-10-14), in the same shape as search_console
    where they overlap: clicks and impressions by day and in total, and the top queries and pages. Bing
    gives no daily position for the site, so the day rows and totals carry none. Plus how many pages
    Bing says it has indexed (in_index, from its crawl stats; None when it hasn't said).
    Needs BING_WEBMASTER_KEY, an API key from Bing Webmaster Tools (Settings, API access)."""
    key = os.environ.get("BING_WEBMASTER_KEY")
    if not key:
        raise ValueError("no BING_WEBMASTER_KEY")
    try:
        return _bing_read(now, key)
    except (TypeError, AttributeError) as e:
        # A row with a field of the wrong type: one problem line, not a stopped run.
        raise RuntimeError(f"Bing: unexpected reply ({type(e).__name__})") from None


def _bing_read(now: datetime, key: str) -> dict:
    since = (now.date() - timedelta(days=GSC_DAYS - 1)).isoformat()
    days = {}
    for r in _bing_get("GetRankAndTrafficStats", key):
        day = _bing_day(r.get("Date"))
        if day and day >= since:
            d = days.setdefault(day, {"day": day, "clicks": 0, "impressions": 0})
            d["clicks"] += r.get("Clicks") or 0
            d["impressions"] += r.get("Impressions") or 0
    days = sorted(days.values(), key=lambda d: d["day"])

    def totals(rows):
        c, i = sum(r["clicks"] for r in rows), sum(r["impressions"] for r in rows)
        return {"clicks": c, "impressions": i, "ctr": round(c / i, 4) if i else None}
    since7 = (now.date() - timedelta(days=6)).isoformat()
    queries = _bing_sum(_bing_get("GetQueryStats", key), "query", since)[:GSC_QUERIES]
    pages = [{**p, "path": urllib.parse.urlparse(p["path"]).path or "/"}
             for p in _bing_sum(_bing_get("GetPageStats", key), "path", since)[:GSC_PAGES]]
    crawl = sorted(((_bing_day(r.get("Date")) or "", r) for r in _bing_get("GetCrawlStats", key)), key=lambda t: t[0])
    in_index = crawl[-1][1].get("InIndex") if crawl else None
    return {"site": BING_SITE, "days": days, "totals_28d": totals(days),
            "totals_7d": totals([d for d in days if d["day"] >= since7]), "queries": queries, "pages": pages,
            "in_index": in_index}


def printable(snap: dict) -> dict:
    """The snapshot as the run log shows it. The repository is public, so its Actions logs are too:
    search queries are counted there, never listed (they go only to the private database).
    was: Search Console only; Bing's queries are kept out the same way (2026-10-14)."""
    # 2026-10-28: redact nested weekly queries too. was: only top-level queries were hidden.
    # Revert: restore shallow redaction only if comparison is removed from the collector.
    def redact(value):
        if isinstance(value, dict):
            return {k: (f"{len(v)} queries" if k == "queries" and isinstance(v, list) else redact(v))
                    for k, v in value.items()}
        if isinstance(value, list):
            return [redact(v) for v in value]
        return value
    out = redact(snap)
    for src in ("search_console", "bing"):
        if isinstance(out.get(src), dict) and isinstance(out[src].get("comparison"), dict):
            for week in out[src]["comparison"].get("weeks", []):
                if "pages" in week:
                    week["pages"] = f"{len(week['pages'])} canonical URLs"
        if isinstance(out.get(src), dict):
            for page in out[src].get("pages", []) + out[src].get("low_ctr_pages", []):
                page.pop("url", None)
            if isinstance(out[src].get("url_inspection"), dict):
                inspection = out[src]["url_inspection"]
                out[src]["url_inspection"] = {"checked_at": inspection["checked_at"], "status": inspection["status"],
                                              "checked_pages": len(inspection["results"])}
            if isinstance(out[src].get("fixed_page_cohort"), dict):
                cohort = out[src]["fixed_page_cohort"]
                out[src]["fixed_page_cohort"] = {key: cohort.get(key) for key in
                                                ("status", "start", "end", "returned", "row_limit", "at_row_limit")}
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


def d1(token: str, sql: str, params: list | None = None) -> dict:
    """Execute a query and return D1's response, including rows for schema inspection."""
    r = _json(f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{D1_DATABASE}/query",
              {"sql": sql, "params": params or []}, token)
    if not r.get("success"):
        raise RuntimeError("D1: " + json.dumps(r.get("errors"))[:300])
    return r


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
                    ("mastodon", lambda: mastodon(now)), ("automation", lambda: automation(now)),
                    ("search_console", lambda: search_console(now)), ("bing", lambda: bing(now)),
                    ("listings", lambda: listings(site_dir)), ("pages", page_count), ("store", store)):
        try:
            snap[key] = fn()
        # RuntimeError includes instagram.InstagramError, which carries Meta's message, never the token.
        # ImportError: the cryptography package isn't installed (Search Console only).
        except (OSError, urllib.error.URLError, ValueError, KeyError, IndexError, TypeError, RuntimeError, ImportError) as e:
            problems.append(f"{key}: {e}")
    if token and "week" in snap and "comparison" in snap.get("search_console", {}):
        try:
            snap["week"]["search_engines"]["comparison"] = cloudflare_search_comparison(
                token, snap["search_console"]["comparison"]["weeks"])
        except (OSError, urllib.error.URLError, ValueError, KeyError, IndexError, TypeError, RuntimeError) as e:
            snap["week"]["search_engines"]["comparison"] = {"status": "unavailable", "error": str(e)}
            problems.append(f"search comparison: {e}")
    problems.extend(f"Search Console week {week['start']}: {week['error']}"
                    for week in snap.get("search_console", {}).get("comparison", {}).get("weeks", [])
                    if week.get("status") == "unavailable")
    problems.extend(f"weekly email: {job['detail']}" for job in snap.get("automation", [])
                    if job.get("file") == "digest.yml" and
                    job.get("health") in {"overdue", "failed", "blocked", "unknown"})
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
