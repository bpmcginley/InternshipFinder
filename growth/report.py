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
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.path.insert(0, HERE)
from internscout import focus, seo_pages  # noqa: E402
import audience  # noqa: E402

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "d4a5640a67faee275d9df91204c4ec59")
SITE_TAG = os.environ.get("CLOUDFLARE_SITE_TAG", "54f99780d57f4ae2a55182b44b082e0a")

QUERY = """
query($account: string!, $site: string!, $start: Time!, $end: Time!, $prevStart: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    week: rumPageloadEventsAdaptiveGroups(limit: 1,
      filter: {siteTag: $site, datetime_geq: $start, datetime_lt: $end}) { count sum { visits } }
    prev: rumPageloadEventsAdaptiveGroups(limit: 1,
      filter: {siteTag: $site, datetime_geq: $prevStart, datetime_lt: $start}) { count sum { visits } }
    pages: rumPageloadEventsAdaptiveGroups(limit: 15, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { requestPath } }
    refs: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(limit: 6, orderBy: [sum_visits_DESC],
      filter: {siteTag: $site, datetime_geq: $start, datetime_lt: $end}) { sum { visits } dimensions { countryName } }
  } }
}
"""


def _post(url: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
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
        acct = r["data"]["viewer"]["accounts"][0]
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
    landing = sum(p["sum"]["visits"] for p in acct["pages"] if p["dimensions"]["requestPath"].startswith("/internships/"))
    out += [f"Landing pages brought {landing:,} of the visits above.", ""]
    return out


def demand_section() -> list[str]:
    url, token = os.environ.get("INTERNSCOUT_DEMAND_URL"), os.environ.get("INTERNSCOUT_DEMAND_TOKEN")
    out = ["## States students picked"]
    if not (url and token):
        return out + ["Not connected (the ingest's demand secrets are not available to this run).", ""]
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=20) as r:
            states = json.load(r).get("states") or {}
    except Exception as e:
        return out + [f"Could not read demand ({type(e).__name__}).", ""]
    if not states:
        return out + ["No student has picked states yet.", ""]
    top = sorted(states.items(), key=lambda kv: -kv[1])[:15]
    return out + [", ".join(f"{k} {v}" for k, v in top), ""]


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
    kinds = {"field or state": 0, "field in a state": 0, "major": 0}
    for p in pages:
        parts = p["path"].strip("/").split("/")
        if len(parts) == 3 and parts[1] == "for":
            kinds["major"] += 1
        elif len(parts) == 3:
            kinds["field in a state"] += 1
        elif len(parts) == 2 and parts[1] != "for":
            kinds["field or state"] += 1
    return ["## Landing pages",
            f"{len(pages):,} pages from the current data: "
            + ", ".join(f"{n:,} {k}" for k, n in kinds.items()) + ".", ""]


def main():
    site_dir = sys.argv[1] if len(sys.argv) > 1 else "docs"
    now = datetime.now(timezone.utc)
    lines = [f"Week ending {now:%B} {now.day}, {now.year}. Generated by `growth/report.py`.", ""]
    for section in (lambda: visits_section(now), demand_section, lambda: audience_section(site_dir),
                    lambda: targeting_section(site_dir), lambda: pages_section(site_dir)):
        try:
            lines += section()
        except Exception as e:                   # one broken section must not sink the report
            lines += [f"(A section failed: {type(e).__name__}: {e})", ""]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
