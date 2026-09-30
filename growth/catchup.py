"""Start the scheduled jobs GitHub started late or not at all, and stop the duplicates that follows.

GitHub's scheduler is best effort, and on this repository it is mostly effort. Measured over
2026-09-22 to 09-30: the ingest's "every 6 hours" started 2 to 5 hours late, and skipped a run on
the 28th; the dashboard copy's "every hour" started 3 to 6 times a day; the Tuesday and Thursday
brand posts went out near 4pm Eastern instead of 11am. A run started with workflow_dispatch has no
such queue, and the workflow's own GITHUB_TOKEN may start one (the one event it is allowed to).

Two halves:

  python growth/catchup.py            the Keep schedule workflow, every half hour: start each job
                                      below that is overdue and not already running
  python growth/catchup.py --guard ingest.yml
                                      the first step of a job: say skip=true (to GITHUB_OUTPUT)
                                      when another run already did this slot's work, so the late
                                      scheduled run that turns up after a catch-up does nothing

Needs GITHUB_TOKEN (actions: write to start runs, actions: read to guard) and GITHUB_REPOSITORY.
Standard library only.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = os.environ.get("GITHUB_REPOSITORY") or "bpmcginley/InternshipFinder"
API = f"https://api.github.com/repos/{REPO}/actions"
UA = {"User-Agent": "InternScout-schedule/1.0 (+https://internscout.org)"}

# file -> (the job that does the work, how long after the last one the next is overdue)
EVERY = {
    "ingest.yml": ("ingest", timedelta(hours=6, minutes=10)),
    "metrics.yml": ("metrics", timedelta(minutes=70)),
}
# A scheduled ingest that arrives this soon after one that ran does nothing: the catch-up already
# took its slot. Under the 6-hour period, so a punctual schedule is never skipped.
INGEST_GUARD = timedelta(hours=4)
# Brand posts: Tuesdays and Thursdays (weekday 1 and 3), from 15:00 UTC, once that day.
POST_DAYS, POST_HOUR = (1, 3), 15
BUSY = ("queued", "in_progress", "waiting", "pending", "requested")


def _call(method: str, path: str, body: dict | None = None) -> dict:
    headers = {"Accept": "application/vnd.github+json", **UA}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    req = urllib.request.Request(f"{API}/{path}", method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def _when(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def runs(file: str) -> list[dict]:
    """The workflow's recent runs on main, newest first."""
    return _call("GET", f"workflows/{file}/runs?branch=main&per_page=15").get("workflow_runs") or []


def job_ran(run: dict, job: str, jobs_of=None) -> bool:
    """Whether the run's working job ran (or is running), rather than being skipped by a guard or
    a kill switch. A run that is still queued counts: it is about to."""
    if run.get("status") in BUSY:
        return True
    if run.get("conclusion") in ("skipped", "cancelled"):
        return False
    jobs_of = jobs_of or (lambda r: _call("GET", f"runs/{r['id']}/jobs").get("jobs") or [])
    return any(j.get("name") == job and j.get("conclusion") not in ("skipped", "cancelled")
               for j in jobs_of(run))


def last_worked(rs: list[dict], job: str, jobs_of=None, skip_id=None) -> dict | None:
    """The newest run whose working job ran, looking at no more than the 15 given."""
    for r in rs:
        if r.get("id") != skip_id and job_ran(r, job, jobs_of):
            return r
    return None


def overdue(rs: list[dict], job: str, every: timedelta, now: datetime, jobs_of=None) -> bool:
    if any(r.get("status") in BUSY for r in rs):
        return False
    last = last_worked(rs, job, jobs_of)
    return last is None or now - _when(last["created_at"]) > every


def post_due(rs: list[dict], now: datetime) -> bool:
    """A brand-post day, past the hour, and no run of any kind started since the hour: one catch-up
    per day at most, however the day's runs ended (a post that failed is not retried by this)."""
    if now.weekday() not in POST_DAYS or now.hour < POST_HOUR:
        return False
    since = now.replace(hour=POST_HOUR, minute=0, second=0, microsecond=0) - timedelta(minutes=5)
    return not any(_when(r["created_at"]) >= since for r in rs)


def post_done_today(rs: list[dict], now: datetime, this_id, jobs_of=None) -> bool:
    """Another run today already got as far as posting (or is posting). Failed runs count: Bluesky
    may have posted before Instagram failed, and posting it twice is worse than once."""
    today = [r for r in rs if r.get("id") != this_id and _when(r["created_at"]).date() == now.date()]
    return last_worked(today, "post", jobs_of) is not None


def recent_ingest(rs: list[dict], now: datetime, this_id, jobs_of=None) -> bool:
    """Another ingest ran to success, or is running, inside INGEST_GUARD."""
    for r in rs:
        if r.get("id") == this_id or now - _when(r["created_at"]) > INGEST_GUARD:
            continue
        if (r.get("status") in BUSY or r.get("conclusion") == "success") and job_ran(r, "ingest", jobs_of):
            return True
    return False


# Workflows with a "force" input. GitHub fills an input left out of a dispatch with its default, and
# the ingest's default is true (so a person's click always runs), so a catch-up says false outright.
FORCE_INPUT = ("ingest.yml", "social.yml")


def dispatch(file: str) -> None:
    body = {"ref": "main"}
    if file in FORCE_INPUT:
        body["inputs"] = {"force": "false"}
    _call("POST", f"workflows/{file}/dispatches", body)


def guard(file: str, now: datetime) -> bool:
    """True when this run should skip its work. A person's "Run workflow" click never skips."""
    event = os.environ.get("GITHUB_EVENT_NAME")
    this = int(os.environ.get("GITHUB_RUN_ID") or 0)
    if event == "workflow_dispatch" and os.environ.get("CATCHUP_FORCE") == "true":
        return False
    rs = runs(file)
    if file == "social.yml":
        return post_done_today(rs, now, this)
    if file == "ingest.yml":
        return event != "push" and recent_ingest(rs, now, this)
    return False


def main(argv: list[str]) -> int:
    now = datetime.now(timezone.utc)
    if "--guard" in argv:
        file = argv[argv.index("--guard") + 1]
        skip = guard(file, now)
        print(f"[catchup] {file}: " + ("another run already did this slot's work; skipping" if skip else "go"))
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
                f.write(f"skip={'true' if skip else 'false'}\n")
        return 0
    failed = False
    for file, (job, every) in EVERY.items():
        try:
            if overdue(runs(file), job, every, now):
                dispatch(file)
                print(f"[catchup] {file}: overdue, started")
            else:
                print(f"[catchup] {file}: on time")
        except Exception as e:            # one API hiccup must not stop the other jobs' checks
            failed = True
            print(f"[catchup] {file}: check failed ({type(e).__name__})")
    try:
        if post_due(runs("social.yml"), now):
            dispatch("social.yml")
            print("[catchup] social.yml: today's post had not started, started")
    except Exception as e:
        failed = True
        print(f"[catchup] social.yml: check failed ({type(e).__name__})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
