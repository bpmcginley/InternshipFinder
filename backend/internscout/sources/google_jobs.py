"""Tier 3b: Google Jobs search via SerpApi (https://serpapi.com/google-jobs-api).

This is the 'just google search it' layer: it queries Google Jobs for roles matching
free-text queries + location, so companies NOT in our ATS registry still get found
(Walleye, Weiss, and anyone else Google indexes). Requires a SerpApi key (free tier:
250 searches/month) in the SERPAPI_KEY env var. If absent, the source is skipped.
"""
from __future__ import annotations
import json
import os
import httpx
from .base import client
from ..config import DATA_DIR

# Errors are logged by status or type only: httpx puts the request URL in the message, and that URL
# carries api_key. GitHub masks the secret in Actions logs, but a local run's log would not.

URL = "https://serpapi.com/search.json"
ACCOUNT_URL = "https://serpapi.com/account.json"   # free to call; does not use a search
# The UTC day the paid searches last ran, committed with the data. The rule used to be "the first
# run after 00:00 UTC", read off the clock as hour < 6; GitHub starts that run 2 to 3 hours late
# and sometimes not at all, and a run it started after 06:00, or one Keep schedule started for it,
# searched nothing that day.
DAY_PATH = os.path.join(DATA_DIR, "google_jobs_day.json")
# A Google Jobs search can take SerpApi longer than the 25 seconds every other source gets: a third
# of the searches in the week to 2026-09-30 timed out on our side (each one probably still charged).
SEARCH_TIMEOUT = 60.0


def daily_budget(account: dict | None, max_searches: int, monthly_default: int = 100) -> int:
    """Searches to spend today. The cron runs 4x a day and used to spend max_searches every run,
    ~1,400 a month against a free plan of a few hundred: the quota was gone by the 3rd and every
    later search was a 429. Spend one month's plan evenly over 31 days, never more than is left."""
    per_month = (account or {}).get("searches_per_month") or monthly_default
    left = (account or {}).get("total_searches_left")
    budget = min(max_searches, per_month // 31)
    if left is not None:
        budget = min(budget, left)
    return max(0, budget)


def searched_on() -> str | None:
    try:
        with open(DAY_PATH, encoding="utf-8") as f:
            return json.load(f).get("day")
    except (OSError, ValueError, AttributeError):
        return None


def mark_searched(day: str) -> None:
    with open(DAY_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"day": day}, f)
        f.write("\n")


# was: def is_daily_run(hour_utc) -> bool: return hour_utc < 6
def is_daily_run(today: str) -> bool:
    """Google Jobs runs once a day: in the first run of the UTC day that gets this far."""
    return searched_on() != today


def fetch_google_jobs(queries: list[str], locations: list[str], api_key: str | None = None,
                      max_searches: int | None = None, focus_queries: list[str] | None = None,
                      focus_searches: int = 0, fixed: list[tuple[str, str]] | None = None) -> list[dict]:
    """Query Google Jobs. Stays inside the SerpApi quota by capping searches per run and
    rotating which queries are used (day-based offset), so all disciplines get covered
    across runs instead of always hitting the same few."""
    import datetime
    api_key = api_key or os.environ.get("SERPAPI_KEY")
    if not api_key:
        print("[google_jobs] no SERPAPI_KEY set; skipping")
        return []
    if max_searches is None:
        max_searches = int(os.environ.get("SERPAPI_MAX_SEARCHES", "12"))
    now = datetime.datetime.now(datetime.timezone.utc)
    # A push to backend/ starts a full ingest too. Between 00:00 and 06:00 UTC that run passed the
    # once-a-day test below and spent the day's paid searches a second time (and a third, for the
    # next push). The 250-search plan at 8 a day has no room for that, so a push never searches.
    if os.environ.get("GITHUB_EVENT_NAME") == "push" and not os.environ.get("SERPAPI_EVERY_RUN"):
        print("[google_jobs] push-triggered run; paid searches are left to the scheduled run")
        return []
    today = now.date().isoformat()
    if not os.environ.get("SERPAPI_EVERY_RUN") and not is_daily_run(today):
        print("[google_jobs] already searched today (UTC); skipping this run")
        return []
    account = None
    try:
        with client() as c:
            r = c.get(ACCOUNT_URL, params={"api_key": api_key})
            r.raise_for_status()
            account = r.json()
    except Exception as e:
        print(f"[google_jobs] account check failed ({type(e).__name__}); assuming the free plan")
    max_searches = daily_budget(account, max_searches,
                                int(os.environ.get("SERPAPI_MONTHLY_SEARCHES", "100")))
    left = (account or {}).get("total_searches_left")
    print(f"[google_jobs] budget today {max_searches} (searches left this month: {left if left is not None else 'unknown'})")
    if max_searches <= 0:
        return []
    # Before searching, not after: a run that dies halfway has still spent those searches.
    mark_searched(today)
    # rotate the query window each day so coverage spreads over time
    day = datetime.date.today().toordinal()
    # Searches held back every day for the thinnest field. The main list gives one query to every
    # location per run, so a field with five queries in the list came up about one day in six;
    # these run every day, each on a different metro, before the main plan spends the rest.
    # (query, location) pairs searched every day, first, out of the same budget: config.GOOGLE_JOBS_FIXED.
    daily = list(fixed or [])[:max_searches]
    max_searches -= len(daily)
    focus: list[tuple[str, str]] = []
    if focus_queries and focus_searches > 0 and locations:
        n = min(focus_searches, max_searches)
        focus = [(focus_queries[(day * n + i) % len(focus_queries)], locations[(day + i) % len(locations)])
                 for i in range(n)]
        max_searches -= n
    if len(locations) > max_searches:  # more wanted metros than searches: rotate them by day too
        s = day % len(locations)
        locations = (locations[s:] + locations[:s])[:max_searches]
    per_loc = max(1, max_searches // max(1, len(locations)))
    turn = int(os.environ.get("GITHUB_RUN_NUMBER") or day)   # next clusters each run
    start = (turn * per_loc) % max(1, len(queries))
    rotated = queries[start:] + queries[:start]
    picked = rotated[:per_loc]
    pairs = daily + focus + [(q, loc) for loc in locations for q in picked][:max(0, max_searches)]
    print(f"[google_jobs] {len(daily)} daily, {len(focus)} focus search(es), then {len(picked)} quer(ies) x "
          f"{len(locations)} location(s) (cap {max_searches})")
    out: list[dict] = []
    seen = set()
    with client() as c:
        for q, loc in pairs:   # already capped at the day's budget
            params = {"engine": "google_jobs", "q": q, "location": loc, "hl": "en", "api_key": api_key}
            if loc.endswith(", Canada"):
                # Google's Canadian results (2026-10-01): without it a Toronto search leans on US postings.
                params["gl"] = "ca"
            try:
                try:
                    r = c.get(URL, params=params, timeout=SEARCH_TIMEOUT)
                except httpx.TimeoutException:
                    # Asked again once. SerpApi keeps a finished search for an hour and a repeat of
                    # the same search is answered from that for free, so this costs nothing when the
                    # first search finished after we stopped waiting.
                    print(f"[google_jobs] '{q}' @ {loc} timed out; asking once more")
                    r = c.get(URL, params=params, timeout=SEARCH_TIMEOUT)
                r.raise_for_status()
                for j in r.json().get("jobs_results", []):
                    opts = j.get("apply_options") or []
                    link = (opts[0].get("link") if opts else None) or j.get("share_link")
                    key = (j.get("company_name", ""), j.get("title", ""))
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append({
                        "company_name": j.get("company_name", ""),
                        "title": j.get("title", ""),
                        "locations": [j.get("location") or loc],
                        "season": None, "year": None,
                        "url": link, "apply_url": link,
                        "posted_at": None,
                        "description": (j.get("description") or "")[:3000],
                        "active": True,
                        "source": "google_jobs",
                        "source_url": link,
                    })
            except httpx.HTTPStatusError as e:
                print(f"[google_jobs] '{q}' @ {loc} failed: HTTP {e.response.status_code}")
                if e.response.status_code == 429:   # quota gone: the rest will fail the same way
                    print("[google_jobs] out of searches; stopping for this run")
                    return out
            except Exception as e:
                print(f"[google_jobs] '{q}' @ {loc} failed: {type(e).__name__}")
    return out
