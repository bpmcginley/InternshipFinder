"""growth/metrics.py: where each visit is counted as coming from."""
import importlib.util
import json
import os

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location("metrics", os.path.join(ROOT, "growth", "metrics.py"))
metrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(metrics)


def test_referrers_sort_into_search_social_and_direct():
    assert metrics.source("www.google.com") == "search"
    assert metrics.source("duckduckgo.com") == "search"
    assert metrics.source("chatgpt.com") == "search"
    assert metrics.source("bsky.app") == "social"
    assert metrics.source("old.reddit.com") == "social"
    assert metrics.source("l.instagram.com") == "social"
    assert metrics.source("") == "direct" and metrics.source(None) == "direct"
    assert metrics.source("internscout.org") == "direct"
    assert metrics.source("umass.edu") == "other"
    assert metrics.source("notgoogle.co") == "other"


def test_listings_fall_back_to_the_exported_stats(tmp_path):
    # The Dashboard metrics workflow checks out stats.json alone, with no listings to count.
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "stats.json").write_text(json.dumps({"open": 12823, "new": 1422, "generated_at": "x"}))
    assert metrics.listings(str(tmp_path)) == {"open": 12823, "new_7d": 1422, "new_7d_basis": "stats.json",
                                               "generated_at": "x"}


def _row(i, company, title="Data Intern", first_seen="2026-09-22T00:00:00"):
    return {"id": f"id{i}", "company_name": company, "title": title, "field_tags": ["data"],
            "first_seen": first_seen, "posted_at": "2026-09-21T00:00:00", "status": "open",
            "regions": [{"loc": "Boston, MA", "kind": "x", "state": "MA"}],
            "apply_url": f"https://jobs.example.com/{i}", "is_remote": False}


def test_new_listings_are_counted_as_the_digest_counts_them(tmp_path):
    """One number for "new this week" across the email, the posts and the dashboard: the digest's."""
    rows = [_row(0, "Acme"), _row(1, "Acme Inc."),                      # one role on two boards
            _row(2, "Beta"), _row(3, "Gamma", title="Finance Intern"),
            _row(4, "Old", first_seen="2026-09-01T00:00:00")]           # not new
    data = tmp_path / "data"
    (data / "listings").mkdir(parents=True)
    (data / "listings" / "MA.json").write_text(json.dumps(rows))
    (data / "listings" / "index.json").write_text(json.dumps(
        {"generated_at": "2026-09-23T10:00:00+00:00", "files": {"MA": {"file": "listings/MA.json"}}}))
    (data / "majors.json").write_text(json.dumps({"majors": []}))
    (data / "stats.json").write_text(json.dumps({"open": 5, "new": 4, "generated_at": "x"}))  # is_new: not deduped
    got = metrics.listings(str(tmp_path))
    import digest                                                       # metrics.listings put it on the path
    assert got["new_7d"] == 3 and got["new_7d_basis"] == "digest"
    assert got["new_7d"] == digest.build(str(tmp_path))["totals"]["new"]
    assert got["open"] == 5


def test_store_listing_numbers_read_from_the_page_and_absent_until_shown():
    page = ('<a href="/category/extensions/productivity">Tools</a>1,234 users</div>'
            '<span aria-label="4.5 out of 5 stars" title="4.5 out of 5 stars"></span>')
    unrated = '<span aria-label="0 out of 5 stars"></span>'
    assert metrics.store_stats(page) == {"users": 1234, "rating": 4.5}
    assert metrics.store_stats("<div>Add to Chrome</div>" + unrated) == {"users": None, "rating": None}
    # A page that isn't a listing (a consent page, new markup) is a problem to report, not "no users".
    with pytest.raises(ValueError):
        metrics.store_stats("<html>Before you continue to Google</html>")


def test_hourly_snapshots_thin_to_one_a_day_and_expire():
    """Run hourly, the snapshot table keeps every run from the last two days, the day's last run
    before that, and nothing past 120 days (it used to keep only the newest 120 rows)."""
    import sqlite3
    from datetime import datetime, timedelta, timezone
    now = datetime(2026, 9, 25, 15, 23, tzinfo=timezone.utc)
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE metrics_snapshot (taken TEXT PRIMARY KEY, data TEXT NOT NULL)")
    t = now - timedelta(days=130)
    while t <= now:
        db.execute("INSERT INTO metrics_snapshot VALUES (?, '{}')", [t.strftime("%Y-%m-%dT%H:%M:%SZ")])
        t += timedelta(hours=1)
    for sql, params in metrics.prune_sql(now):
        db.execute(sql, params)
    taken = [r[0] for r in db.execute("SELECT taken FROM metrics_snapshot ORDER BY taken")]
    cut = (now - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = [x for x in taken if x >= cut]
    older = [x for x in taken if x < cut]
    assert len(recent) == 49                                   # every hourly run of the last 48 hours
    assert len({x[:10] for x in older}) == len(older)          # at most one per day before that
    assert all(x.endswith("T23:23:00Z") for x in older[:-1])   # and it is the day's last run
    assert older[0] >= (now - timedelta(days=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert taken[-1] == now.strftime("%Y-%m-%dT%H:%M:%SZ")     # the newest, which the dashboard reads
