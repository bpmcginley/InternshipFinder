"""growth/metrics.py: where each visit is counted as coming from."""
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

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


NOW = datetime(2026, 9, 29, 15, 0, tzinfo=timezone.utc)
sys.path.insert(0, os.path.join(ROOT, "growth"))           # metrics.instagram imports growth/instagram.py


def test_bluesky_keeps_our_recent_posts_and_sums_the_week(monkeypatch):
    def post(rkey, when, likes, text="x"):
        return {"post": {"uri": f"at://did:plc:a/app.bsky.feed.post/{rkey}", "likeCount": likes, "repostCount": 1,
                         "replyCount": 0, "author": {"handle": "internscout.org"},
                         "record": {"createdAt": when, "text": text}}}
    feed = [post("a", "2026-09-28T18:00:00.000Z", 4, "word " * 40),
            {**post("b", "2026-09-27T18:00:00.000Z", 50), "reason": {"$type": "repost"}},   # someone else's
            post("c", "2026-09-10T18:00:00.000Z", 9)]                                         # last month
    answers = {"getProfile": {"followersCount": 7, "postsCount": 3}, "getAuthorFeed": {"feed": feed}}
    monkeypatch.setattr(metrics, "_json", lambda url, *a, **k: next(v for key, v in answers.items() if key in url))
    got = metrics.bluesky(NOW)
    assert got["followers"] == 7 and got["posts_7d"] == 1 and got["likes_7d"] == 4 and got["reposts_7d"] == 1
    assert [p["url"].rsplit("/", 1)[-1] for p in got["recent"]] == ["a", "c"]
    assert len(got["recent"][0]["text"]) <= 110 and got["recent"][0]["text"].endswith("…")


def test_mastodon_reads_the_public_account_and_strips_markup(monkeypatch):
    answers = {"lookup": {"id": "1", "acct": "internscout", "followers_count": 3, "statuses_count": 1},
               "statuses": [{"created_at": "2026-09-28T12:00:00.000Z", "content": "<p>New <a href='x'>roles</a></p>",
                             "favourites_count": 2, "reblogs_count": 1, "replies_count": 0, "url": "https://m/1"}]}
    monkeypatch.setattr(metrics, "_json", lambda url, *a, **k: next(v for key, v in answers.items() if key in url))
    got = metrics.mastodon(NOW)
    assert got["handle"] == "@internscout@mastodon.social" and got["followers"] == 3
    assert got["recent"][0]["text"] == "New roles" and got["likes_7d"] == 2


def test_instagram_needs_the_secret_and_reads_counts_without_refreshing(monkeypatch):
    monkeypatch.delenv("INSTAGRAM_TOKEN", raising=False)
    with pytest.raises(ValueError):
        metrics.instagram("cf", NOW)
    import instagram as ig                                  # the module metrics.instagram imports
    monkeypatch.setenv("INSTAGRAM_TOKEN", "secret")
    monkeypatch.setattr(ig, "working_token", lambda secret, cf: ("kept-token", None))
    monkeypatch.setattr(ig, "_d1_rows", lambda cf, sql, params=None: [{"expires": "2026-11-24T18:00:00Z"}])
    calls = []

    def fake(method, path, params):
        calls.append((method, path, params["access_token"]))
        if path == "me":
            return {"username": "internscout", "followers_count": 12, "follows_count": 0, "media_count": 2}
        return {"data": [{"caption": "Hi", "timestamp": "2026-09-28T15:00:00+0000", "like_count": 5,
                          "comments_count": 1, "permalink": "https://www.instagram.com/p/x/"}]}
    monkeypatch.setattr(ig, "_request", fake)
    got = metrics.instagram("cf", NOW)
    assert got["followers"] == 12 and got["likes_7d"] == 5 and got["comments_7d"] == 1
    assert got["token_expires"] == "2026-11-24T18:00:00Z"
    assert all(m == "GET" and tok == "kept-token" for m, _, tok in calls)     # never refresh_access_token
    assert "refresh_access_token" not in [p for _, p, _ in calls]


def test_automation_reports_each_jobs_last_run(monkeypatch):
    class Resp:
        def __init__(self, body): self.body = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps(self.body).encode()
    seen = []

    def fake_open(req, timeout=30):
        seen.append(req.full_url)
        run = [] if "growth-report" in req.full_url else [{"conclusion": "success", "updated_at": "t",
                                                           "event": "schedule", "html_url": "u"}]
        return Resp({"workflow_runs": run})
    monkeypatch.setattr(metrics.urllib.request, "urlopen", fake_open)
    got = metrics.automation()
    assert [j["job"] for j in got] == [name for _, name in metrics.JOBS]
    assert all("branch=main" in u for u in seen)
    assert next(j for j in got if j["file"] == "growth-report.yml")["conclusion"] is None


def _email_run(**changes):
    return {"id": 123, "event": "schedule", "status": "completed", "conclusion": "success",
            "created_at": "2026-10-19T12:10:00Z", "updated_at": "2026-10-19T12:12:00Z",
            "html_url": "https://github.com/example/actions/runs/123", **changes}


@pytest.mark.parametrize("now,health", [
    ("2026-10-16T17:00:00Z", "not_due"),
    ("2026-10-19T11:59:59Z", "not_due"),
    ("2026-10-19T12:00:00Z", "waiting"),
    ("2026-10-19T13:59:59Z", "waiting"),
    ("2026-10-19T14:00:00Z", "overdue"),
    ("2026-10-20T12:00:00Z", "overdue"),
])
def test_digest_health_respects_first_monday_and_scheduler_grace(now, health):
    got = metrics.digest_health([], metrics._timestamp(now))
    assert got["health"] == health
    assert got["due_at"] == "2026-10-19T12:00:00Z"
    assert got["delivery_confirmed"] is False


def test_owner_tests_prior_week_and_future_runs_do_not_satisfy_this_weeks_send():
    now = metrics._timestamp("2026-10-26T15:00:00Z")
    runs = [_email_run(), _email_run(id=124, event="workflow_dispatch", created_at="2026-10-26T12:00:00Z"),
            _email_run(id=125, created_at="2026-10-27T12:00:00Z")]
    got = metrics.digest_health(runs, now, "success")
    assert got["health"] == "overdue"
    assert got["due_at"] == "2026-10-26T12:00:00Z"


@pytest.mark.parametrize("status,conclusion,step,health", [
    ("completed", "success", "success", "success"),
    ("completed", "success", "skipped", "blocked"),
    ("completed", "success", None, "unknown"),
    ("completed", "failure", None, "failed"),
    ("completed", "cancelled", None, "failed"),
    ("in_progress", None, None, "in_progress"),
    ("queued", None, None, "in_progress"),
])
def test_digest_health_needs_a_successful_subscriber_send_step(status, conclusion, step, health):
    now = metrics._timestamp("2026-10-19T13:00:00Z")
    got = metrics.digest_health([_email_run(status=status, conclusion=conclusion)], now, step)
    assert got["health"] == health
    assert got["delivery_confirmed"] is False


def test_digest_health_flags_stuck_run_without_proposing_another_broadcast():
    got = metrics.digest_health([_email_run(status="in_progress", conclusion=None)],
                               metrics._timestamp("2026-10-19T14:00:00Z"))
    assert got["health"] == "overdue"
    assert "do not start a second send" in got["detail"]


def test_digest_schedule_is_utc_and_accepts_timezone_offsets():
    # November's Monday slot remains 12 UTC (7am EST), not an invented 8am local promise.
    run = _email_run(created_at="2026-11-02T07:10:00-05:00")
    got = metrics.digest_health([run], metrics._timestamp("2026-11-02T08:00:00-05:00"), "success")
    assert got["health"] == "success" and got["due_at"] == "2026-11-02T12:00:00Z"
    assert got["next_due_at"] == "2026-11-09T12:00:00Z"


@pytest.mark.parametrize("step,conclusion,expected", [("success", "success", "success"),
                                                     ("skipped", "success", "blocked"),
                                                     (None, "success", "unknown"),
                                                     (None, "failure", "failed")])
def test_automation_separates_manual_tests_and_checks_scheduled_send_step(monkeypatch, step, conclusion, expected):
    class Resp:
        def __init__(self, body): self.body = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps(self.body).encode()
    manual = _email_run(id=124, event="workflow_dispatch", updated_at="2026-10-19T12:30:00Z")
    seen = []

    def fake(req, timeout=30):
        seen.append(req.full_url)
        if "/runs/123/jobs?" in req.full_url:
            return Resp({"jobs": [{"steps": [{"name": "Send the digest", "conclusion": step}]}]})
        return Resp({"workflow_runs": [_email_run(conclusion=conclusion)] if "event=schedule" in req.full_url else [manual]})
    monkeypatch.setattr(metrics.urllib.request, "urlopen", fake)
    got = next(r for r in metrics.automation(metrics._timestamp("2026-10-19T13:00:00Z"))
               if r["file"] == "digest.yml")
    assert got["health"] == expected
    assert got["conclusion"] == conclusion  # a successful owner test cannot hide a failed subscriber run
    assert got["event"] == "schedule" and got["url"].endswith("/123")
    assert got["last_manual_run"]["audience"] == "not_inferred_from_manual_run"
    assert any("/runs/123/jobs?" in u for u in seen) == (conclusion == "success")


def test_overdue_email_is_reported_in_snapshot_problems(monkeypatch, capsys):
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    for name in ("bluesky", "instagram", "mastodon", "search_console", "bing", "listings", "page_count", "store"):
        monkeypatch.setattr(metrics, name, lambda *args: {})
    for name in ("search_console", "bing"):
        monkeypatch.setattr(metrics, name, lambda *args: {"queries": []})
    monkeypatch.setattr(metrics, "automation", lambda now: [{"file": "digest.yml", "health": "overdue",
                                                             "detail": "No scheduled subscriber run."}])
    assert metrics.main(["metrics.py"]) == 0
    assert "weekly email: No scheduled subscriber run." in json.loads(capsys.readouterr().out)["problems"]


GSC_ROWS = {
    "date": [{"keys": ["2026-09-27"], "clicks": 2, "impressions": 100, "position": 10.0},
             {"keys": ["2026-09-10"], "clicks": 1, "impressions": 300, "position": 30.0}],
    "query": [{"keys": ["finance internships boston"], "clicks": 2, "impressions": 40, "position": 8.25}],
    "page": [{"keys": ["https://internscout.org/internships/finance/"], "clicks": 2, "impressions": 90, "position": 9.0}],
}


def test_search_console_needs_a_key_file(monkeypatch):
    monkeypatch.delenv("GSC_SERVICE_ACCOUNT", raising=False)
    with pytest.raises(ValueError):
        metrics.search_console(NOW)
    monkeypatch.setenv("GSC_SERVICE_ACCOUNT", "not json")
    with pytest.raises(ValueError, match="key file"):
        metrics.search_console(NOW)


def test_search_console_reads_days_queries_and_pages(monkeypatch):
    monkeypatch.setenv("GSC_SERVICE_ACCOUNT", json.dumps({"client_email": "bot@x.iam.gserviceaccount.com",
                                                          "private_key": "k"}))
    monkeypatch.setattr(metrics, "_gsc_token", lambda info: "tok")
    bodies = []

    def fake_json(url, body=None, token=None, timeout=30):
        assert token == "tok" and "sc-domain%3Ainternscout.org" in url
        bodies.append(body)
        return {"rows": GSC_ROWS[body["dimensions"][0]]}
    monkeypatch.setattr(metrics, "_json", fake_json)
    got = metrics.search_console(NOW)
    assert bodies[0]["startDate"] == "2026-09-02" and bodies[0]["endDate"] == "2026-09-29"
    assert [d["day"] for d in got["days"]] == ["2026-09-10", "2026-09-27"]
    # Position is averaged by impressions, as Search Console does: (10*100 + 30*300) / 400.
    assert got["totals_28d"] == {"clicks": 3, "impressions": 400, "ctr": 0.0075, "position": 25.0}
    assert got["totals_7d"]["clicks"] == 2 and got["totals_7d"]["position"] == 10.0
    assert got["queries"][0] == {"query": "finance internships boston", "clicks": 2, "impressions": 40, "position": 8.2}
    assert got["pages"][0]["path"] == "/internships/finance/"
    # 2026-10-04: more rows asked for, and 2 clicks in 90 is not a low click-through page.
    assert [b["rowLimit"] for b in bodies[1:]] == [100, 200]
    assert got["low_ctr_pages"] == []


def test_low_ctr_pages_are_shown_often_and_rarely_clicked_most_shown_first():
    page = lambda path, clicks, impressions: {"path": path, "clicks": clicks, "impressions": impressions, "position": 9.0}  # noqa: E731
    pages = [page("/a/", 0, 49), page("/b/", 1, 60), page("/c/", 0, 500), page("/d/", 5, 400),
             page("/e/", 1, 150), page("/f/", 1, 100)]
    got = metrics.low_ctr_pages(pages)
    # /a/ is shown too rarely to judge; /b/ (1.7%), /d/ (1.25%) and /f/ (exactly 1%) are clicked enough.
    assert [(p["path"], p["ctr"]) for p in got] == [("/c/", 0.0), ("/e/", 0.0067)]
    many = [page(f"/p{i}/", 0, 100 + i) for i in range(40)]
    assert len(metrics.low_ctr_pages(many)) == 25 and metrics.low_ctr_pages(many)[0]["path"] == "/p39/"


def test_search_queries_stay_out_of_the_public_run_log():
    snap = {"search_console": {"queries": [{"query": "jane doe internship"}], "pages": []}, "pages": 9}
    shown = metrics.printable(snap)
    assert "jane" not in json.dumps(shown) and shown["search_console"]["queries"] == "1 queries"
    assert snap["search_console"]["queries"][0]["query"] == "jane doe internship"     # the copy is untouched


def test_the_sign_in_assertion_is_a_valid_rs256_jwt():
    pytest.importorskip("cryptography")             # CI installs it; skipped where it won't build
    import base64
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    token = metrics._jwt({"client_email": "bot@x", "private_key": pem, "private_key_id": "k1"}, 1000)
    head, claims, sig = token.split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    body = json.loads(base64.urlsafe_b64decode(pad(claims)))
    assert body == {"iss": "bot@x", "scope": metrics.GSC_SCOPE, "iat": 1000, "exp": 4600,
                    "aud": "https://oauth2.googleapis.com/token"}
    assert json.loads(base64.urlsafe_b64decode(pad(head)))["alg"] == "RS256"
    key.public_key().verify(base64.urlsafe_b64decode(pad(sig)), f"{head}.{claims}".encode(),
                            padding.PKCS1v15(), hashes.SHA256())                          # raises if wrong


# ---- Bing Webmaster Tools (2026-10-14)
def _ms(day: str) -> str:
    """A day as Bing's JSON writes it, at midnight US Pacific daylight time."""
    t = datetime.fromisoformat(day + "T00:00:00-07:00")
    return f"/Date({int(t.timestamp() * 1000)}-0700)/"


BING = {
    "GetRankAndTrafficStats": [{"Date": _ms("2026-08-01"), "Clicks": 50, "Impressions": 500},   # before the 28 days
                               {"Date": _ms("2026-09-10"), "Clicks": 1, "Impressions": 40},
                               {"Date": _ms("2026-09-27"), "Clicks": 3, "Impressions": 60}],
    "GetQueryStats": [{"Date": _ms("2026-09-14"), "Query": "nursing internships", "Clicks": 1, "Impressions": 10, "AvgImpressionPosition": 4},
                      {"Date": _ms("2026-09-21"), "Query": "nursing internships", "Clicks": 1, "Impressions": 30, "AvgImpressionPosition": 8},
                      {"Date": _ms("2026-09-21"), "Query": "co-op boston", "Clicks": 0, "Impressions": 5, "AvgImpressionPosition": -1},
                      {"Date": _ms("2026-07-01"), "Query": "old query", "Clicks": 9, "Impressions": 9, "AvgImpressionPosition": 1}],
    "GetPageStats": [{"Date": _ms("2026-09-21"), "Query": "https://internscout.org/internships/nursing/", "Clicks": 2, "Impressions": 20, "AvgImpressionPosition": 6}],
    "GetCrawlStats": [{"Date": _ms("2026-09-27"), "InIndex": 412}, {"Date": _ms("2026-09-20"), "InIndex": 380}],
}


def test_bing_needs_its_key(monkeypatch):
    monkeypatch.delenv("BING_WEBMASTER_KEY", raising=False)
    with pytest.raises(ValueError, match="BING_WEBMASTER_KEY"):
        metrics.bing(NOW)


def test_bing_reads_the_last_28_days_queries_pages_and_index_count(monkeypatch):
    monkeypatch.setenv("BING_WEBMASTER_KEY", "secret-key-123")
    seen = []

    def fake_json(url, body=None, token=None, timeout=30):
        seen.append(url)
        assert "siteUrl=https%3A%2F%2Finternscout.org%2F" in url and "apikey=secret-key-123" in url
        return {"d": BING[url.split("/json/")[1].split("?")[0]]}
    monkeypatch.setattr(metrics, "_json", fake_json)
    got = metrics.bing(NOW)
    assert [d["day"] for d in got["days"]] == ["2026-09-10", "2026-09-27"]
    assert got["totals_28d"] == {"clicks": 4, "impressions": 100, "ctr": 0.04}
    assert got["totals_7d"] == {"clicks": 3, "impressions": 60, "ctr": 0.05}
    # Summed across weeks; position weighted by impressions, (4*10 + 8*30) / 40; Bing's -1 is "none".
    assert got["queries"] == [{"query": "nursing internships", "clicks": 2, "impressions": 40, "position": 7.0},
                              {"query": "co-op boston", "clicks": 0, "impressions": 5, "position": None}]
    assert got["pages"] == [{"path": "/internships/nursing/", "clicks": 2, "impressions": 20, "position": 6.0}]
    assert got["in_index"] == 412


def test_bing_errors_never_carry_the_key(monkeypatch):
    monkeypatch.setenv("BING_WEBMASTER_KEY", "secret-key-123")

    def refuse(url, *a, **k):
        raise metrics.urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)
    monkeypatch.setattr(metrics, "_json", refuse)
    with pytest.raises(RuntimeError) as e:
        metrics.bing(NOW)
    assert str(e.value) == "Bing GetRankAndTrafficStats: HTTP 401"
    assert "secret-key-123" not in repr(e.value) and e.value.__cause__ is None


def test_bing_dates_read_in_their_own_offset():
    assert metrics._bing_day("/Date(1316156400000-0700)/") == "2011-09-16"
    assert metrics._bing_day("/Date(1316156400000)/") == "2011-09-16"
    assert metrics._bing_day("2011-09-16") is None


def test_bing_queries_stay_out_of_the_public_run_log():
    snap = {"bing": {"queries": [{"query": "a private search"}], "pages": []}}
    assert metrics.printable(snap)["bing"]["queries"] == "1 queries"


def test_bing_odd_replies_become_one_problem_line_not_a_crash(monkeypatch):
    """An answer that isn't {"d": [...]}, or a row with a field of the wrong type, is reported as a
    RuntimeError, which main() turns into a "bing: ..." problem while the other sources still save."""
    monkeypatch.setenv("BING_WEBMASTER_KEY", "secret-key-123")
    for reply in ([1, 2], "oops", {"d": "nope"}):
        monkeypatch.setattr(metrics, "_json", lambda url, *a, reply=reply, **k: reply)
        with pytest.raises(RuntimeError, match="unexpected reply"):
            metrics.bing(NOW)
    bad = {**BING, "GetRankAndTrafficStats": [{"Date": _ms("2026-09-27"), "Clicks": "3", "Impressions": 60}]}
    monkeypatch.setattr(metrics, "_json", lambda url, *a, **k: {"d": bad[url.split("/json/")[1].split("?")[0]]})
    with pytest.raises(RuntimeError) as e:
        metrics.bing(NOW)
    assert "secret-key-123" not in str(e.value)
    monkeypatch.setattr(metrics, "_json", lambda url, *a, **k: {"d": None})
    assert metrics.bing(NOW)["days"] == []
