"""The weekly growth report: what brought students in, and where the next gains are.

Writes Markdown to stdout; .github/workflows/growth-report.yml posts it as a GitHub issue each week.
Each section runs on whatever it can reach and says plainly when it can't:

  * Visits      Cloudflare Web Analytics, when CLOUDFLARE_API_TOKEN (Account Analytics: Read) is set
  * Demand      the states students picked, from the Worker, when INTERNSCOUT_DEMAND_URL/_TOKEN are set
  * Audience    growth/audience.py over docs/data: which majors are served, which are thin
  * Targeting   backend/internscout/focus.py: the fields the focus searches are chasing
  * Pages       how many landing pages the current data makes

Run from the repo root:  python growth/report.py [docs]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.path.insert(0, HERE)
from internscout import focus, seo_pages  # noqa: E402
import audience  # noqa: E402
import social  # noqa: E402

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "d4a5640a67faee275d9df91204c4ec59")
# Cloudflare turns away Python's default user agent ("Python-urllib/3.12") with a 403 at the edge,
# which is how the first report's demand section failed; every request here names itself.
UA = {"User-Agent": "InternScout-growth-report/1.0 (+https://internscout.org)"}
BLUESKY = os.environ.get("BLUESKY_HANDLE") or "internscout.org"
SITE_TAG = os.environ.get("CLOUDFLARE_SITE_TAG", "54f99780d57f4ae2a55182b44b082e0a")

# bot: 0 is the dashboard's "Exclude bots": crawlers that run JavaScript, Googlebot's renderer among
# them, load the landing pages too, and on a young site they would be a real share of the count.
QUERY = """
query($account: string!, $site: string!, $start: Time!, $end: Time!, $prevStart: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    week: rumPageloadEventsAdaptiveGroups(limit: 1,
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) { count sum { visits } }
    prev: rumPageloadEventsAdaptiveGroups(limit: 1,
      filter: {siteTag: $site, bot: 0, datetime_geq: $prevStart, datetime_lt: $start}) { count sum { visits } }
    pages: rumPageloadEventsAdaptiveGroups(limit: 15, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { requestPath } }
    refs: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(limit: 6, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { countryName } }
  } }
}
"""


# Asked on its own, so a schema change here cannot take the rest of the Visits section with it.
LANDING_QUERY = """
query($account: string!, $site: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    landing: rumPageloadEventsAdaptiveGroups(limit: 1,
      filter: {siteTag: $site, bot: 0, datetime_geq: $start, datetime_lt: $end, requestPath_like: "/internships/%"}) { sum { visits } }
  } }
}
"""


def _post(url: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", **UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def visits_section(now: datetime) -> list[str]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    out = ["## Visits (last 7 days)"]
    if not token:
        return out + ["Not connected: add a Cloudflare API token with *Account Analytics: Read* as the repo "
                      "secret `CLOUDFLARE_API_TOKEN`.", ""]
    end = now.replace(minute=0, second=0, microsecond=0)
    start, prev = end - timedelta(days=7), end - timedelta(days=14)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    try:
        r = _post("https://api.cloudflare.com/client/v4/graphql",
                  {"query": QUERY, "variables": {"account": ACCOUNT, "site": SITE_TAG, "start": iso(start),
                                                 "end": iso(end), "prevStart": iso(prev)}}, token)
        # A wrong token, account or site tag comes back as HTTP 200 with "errors" and no data; say
        # what Cloudflare said rather than failing on the missing data.
        if r.get("errors"):
            return out + [f"Cloudflare answered: {r['errors'][0].get('message', 'unknown error')}", ""]
        accounts = (r.get("data") or {}).get("viewer", {}).get("accounts") or []
        if not accounts:
            return out + [f"Cloudflare returned no account {ACCOUNT}; check CLOUDFLARE_ACCOUNT_ID and the token's scope.", ""]
        acct = accounts[0]
    except Exception as e:                       # the rest of the report still has value
        return out + [f"Could not read Cloudflare ({type(e).__name__}).", ""]
    total = lambda rows: (rows[0]["sum"]["visits"] if rows else 0)  # noqa: E731
    week, before = total(acct["week"]), total(acct["prev"])
    change = f" ({'+' if week >= before else ''}{week - before} on the week before)" if before else ""
    out += [f"**{week:,} visits**{change}.", "", "| Page | Visits |", "|---|---|"]
    out += [f"| `{p['dimensions']['requestPath']}` | {p['sum']['visits']:,} |" for p in acct["pages"]]
    out += ["", "| Came from | Visits |", "|---|---|"]
    out += [f"| {r['dimensions']['refererHost'] or '(direct or unknown)'} | {r['sum']['visits']:,} |" for r in acct["refs"]]
    out += ["", "Countries: " + ", ".join(f"{c['dimensions']['countryName']} {c['sum']['visits']:,}"
                                          for c in acct["countries"]), ""]
    # Counted over every landing page, not just the ones in the top-15 table: most search traffic
    # arrives spread thin across hundreds of them.
    try:
        r = _post("https://api.cloudflare.com/client/v4/graphql",
                  {"query": LANDING_QUERY, "variables": {"account": ACCOUNT, "site": SITE_TAG,
                                                         "start": iso(start), "end": iso(end)}}, token)
        landing, floor = total(r["data"]["viewer"]["accounts"][0]["landing"]), ""
    except Exception:
        landing = sum(p["sum"]["visits"] for p in acct["pages"] if p["dimensions"]["requestPath"].startswith("/internships/"))
        floor = "at least "
    share = f" ({landing * 100 // week}%)" if week else ""
    out += [f"Landing pages under /internships/ brought {floor}{landing:,} of the {week:,} visits{share}.", ""]
    return out


def demand_section() -> list[str]:
    url, token = os.environ.get("INTERNSCOUT_DEMAND_URL"), os.environ.get("INTERNSCOUT_DEMAND_TOKEN")
    out = ["## States students picked"]
    if not (url and token):
        return out + ["Not connected (the ingest's demand secrets are not available to this run).", ""]
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", **UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            states = json.load(r).get("states") or {}
    except urllib.error.HTTPError as e:
        return out + [f"Could not read demand (HTTP {e.code}).", ""]
    except Exception as e:
        return out + [f"Could not read demand ({type(e).__name__}).", ""]
    if not states:
        return out + ["No student has picked states yet.", ""]
    # The issue is public, and while there are few students a count is close to a person (and the top
    # one is a floor on the number of users). So: the states, most picked first, and no numbers. The
    # ingest log already lists the same codes.
    top = [k for k, _ in sorted(states.items(), key=lambda kv: -kv[1])]
    return out + ["Most picked first: " + ", ".join(top), ""]


def audience_section(site_dir: str) -> list[str]:
    rows, _ = audience.tiers(site_dir)
    primary = [r for r in rows if r["near"] >= audience.PRIMARY]
    thin = [r for r in rows if r["near"] < audience.THIN]
    return ["## Audience",
            f"**Market to ({len(primary)} majors):** " + ", ".join(f"{r['major']} ({r['near']})" for r in primary),
            "",
            f"**Too thin to market yet ({len(thin)} majors):** " + ", ".join(f"{r['major']} ({r['near']})" for r in thin),
            "",
            "Numbers are open roles in the Northeast or remote that fit the major.", ""]


def targeting_section(site_dir: str) -> list[str]:
    d = seo_pages.load(site_dir)
    picks = focus.thinnest(d["listings"], d["majors"])
    if not picks:
        return ["## Search targeting", "No field is thin enough to need focus searches.", ""]
    return ["## Search targeting",
            "The daily focus searches are going to: "
            + "; ".join(f"**{t}** ({n} open nearby, {m} majors depend on it)" for t, n, m in picks) + ".", ""]


def pages_section(site_dir: str) -> list[str]:
    pages = seo_pages.build(site_dir)
    kinds = {"field or state": 0, "field in a state": 0, "major": 0, "employer": 0}
    for p in pages:
        parts = p["path"].strip("/").split("/")
        if len(parts) == 3 and parts[1] == "for":
            kinds["major"] += 1
        elif len(parts) == 3 and parts[1] == "at":
            kinds["employer"] += 1
        elif len(parts) == 3:
            kinds["field in a state"] += 1
        elif len(parts) == 2 and parts[1] not in ("for", "at", "new"):
            kinds["field or state"] += 1
    return ["## Landing pages",
            f"{len(pages):,} pages from the current data: "
            + ", ".join(f"{n:,} {k}" for k, n in kinds.items()) + ".", ""]


def social_section(site_dir: str, now: datetime) -> list[str]:
    """What the brand account posted this week (read from Bluesky's public API, so it needs no
    secret), and the post the data suggests next."""
    out = ["## Brand posts"]
    try:
        url = ("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?limit=20&filter=posts_no_replies&actor="
               + urllib.parse.quote(BLUESKY))
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            feed = json.load(r).get("feed") or []
        week = [f["post"] for f in feed
                if f["post"]["record"].get("createdAt", "") >= (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")]
        if week:
            latest = week[0]
            link = f"https://bsky.app/profile/{BLUESKY}/post/{latest['uri'].rsplit('/', 1)[-1]}"
            likes = sum(p.get("likeCount", 0) for p in week)
            reposts = sum(p.get("repostCount", 0) for p in week)
            out += [f"{seo_pages.plural(len(week), 'post')} on Bluesky ([@{BLUESKY}](https://bsky.app/profile/{BLUESKY})) "
                    f"this week, with {seo_pages.plural(likes, 'like')} and {seo_pages.plural(reposts, 'repost')}. "
                    f"[Latest]({link}).", ""]
        else:
            out += [f"Nothing on Bluesky (@{BLUESKY}) this week.", ""]
    except Exception as e:
        out += [f"Could not read Bluesky ({type(e).__name__}).", ""]
    post = social.draft(site_dir)
    if post:
        out += ["A post drafted from this week's data (the Brand posts workflow sends one like it on Tuesdays "
                "and Thursdays):",
                "", "```text", post[0], "```", ""]
    return out


def main():
    site_dir = sys.argv[1] if len(sys.argv) > 1 else "docs"
    now = datetime.now(timezone.utc)
    lines = [f"Week ending {now:%B} {now.day}, {now.year}. Generated by `growth/report.py`.", ""]
    for section in (lambda: visits_section(now), demand_section, lambda: audience_section(site_dir),
                    lambda: targeting_section(site_dir), lambda: pages_section(site_dir),
                    lambda: social_section(site_dir, now)):
        try:
            lines += section()
        except Exception as e:                   # one broken section must not sink the report
            lines += [f"(A section failed: {type(e).__name__}: {e})", ""]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
