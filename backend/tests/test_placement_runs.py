"""The site build's record of each live paid listing (added 2026-10-14).

seo_pages --placements-report writes what one build kept and dropped (placements.report); the pages
workflow then runs `python -m internscout.placements record FILE`, which adds it to the Worker's
placement_runs table over the D1 HTTP API (placements.record_runs), so refunds for days a paid box was
not on the site can be worked out. That step can never fail or block a deploy. Tested against the real
table (worker/schema.sql) behind a fake HTTP layer. The reading side is worker/test/placement-runs.test.js.
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
from datetime import datetime, timezone

import pytest

from internscout import placements, seo_pages
from internscout.placements import resolve
from tests.test_seo_pages import _files, _placement_site, _pl as _site_pl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
PKG = os.path.join(HERE, "..", "internscout")
DAY = "2026-11-03"
NOW_UTC = datetime(2026, 11, 3, 14, 5, tzinfo=timezone.utc)
URL = "https://jobs.example.com/acme/1"


def _listing(**over):
    x = {"id": "3f9c0a1b2c3d4e5f", "company_name": "Acme Robotics", "title": "Robotics Intern",
         "apply_url": URL, "status": "open", "insights": None, "restrictions": []}
    x.update(over)
    return x


def _pl(**over):
    p = {"id": "p-2026-11-acme-1", "listing_id": "3f9c0a1b2c3d4e5f", "apply_url": URL,
         "employer": "Acme Robotics", "start": "2026-11-01", "end": "2026-12-01", "page_cap": 1}
    p.update(over)
    return p


def _runs_table():
    with open(os.path.join(ROOT, "worker", "schema.sql"), encoding="utf-8") as f:
        schema = f.read()
    create = re.search(r"CREATE TABLE IF NOT EXISTS placement_runs \(.*?\);", schema, re.S).group(0)
    db = sqlite3.connect(":memory:")
    db.execute(create)
    return db


class FakeD1:
    """Answers like D1's /query endpoint by running each statement on a real placement_runs table."""

    def __init__(self, answer=None):
        self.db, self.calls, self.answer = _runs_table(), [], answer

    def __call__(self, url, body, token):
        self.calls.append((url, body, token))
        if self.answer is not None:
            return self.answer(url, body, token)
        assert body["sql"].count("?") == len(body["params"]) <= 100
        self.db.execute(body["sql"], body["params"])
        return {"success": True, "result": [{"results": [], "success": True}]}

    def rows(self):
        return self.db.execute("SELECT placement_id, day, shown, dropped, reason, updated FROM placement_runs "
                               "ORDER BY placement_id, day").fetchall()


def _write(tmp_path, rep, name="report.json"):
    f = tmp_path / name
    f.write_text(json.dumps(rep), encoding="utf-8")
    return str(f)


# ---------------------------------------------------------------- the report

def test_report_lists_kept_ids_and_dropped_ids_with_reasons_and_skips_unreadable_ones():
    gone = _pl(id="p-gone", listing_id="0000000000000000", apply_url="https://jobs.example.com/acme/404")
    kept, dropped = resolve([_pl(), gone, {"id": "bad\nid"}], {"3f9c0a1b2c3d4e5f": _listing()}, DAY)
    assert placements.report(kept, dropped, DAY) == {
        "day": DAY, "kept": ["p-2026-11-acme-1"], "dropped": [{"id": "p-gone", "reason": "listing_gone"}]}


def test_the_build_writes_its_placements_report_outside_the_site(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(seo_pages, "today_utc", lambda: "2026-09-23")
    site = _placement_site(tmp_path, "rep")
    f = tmp_path / "placements.json"
    f.write_text(json.dumps({"placements": [
        _site_pl(), _site_pl(id="p-gone", listing_id="nope", apply_url="https://x.example/1"),
        _site_pl(id="p-late", start="2026-10-01", end="2026-11-01"), {"id": "bad\nid"}]}), encoding="utf-8")
    report = tmp_path / "placements-report.json"
    seo_pages.main(["seo_pages", site, "--placements-report", str(report), "--placements", str(f)])
    assert json.loads(report.read_text(encoding="utf-8")) == {
        "day": "2026-09-23", "kept": ["p-2026-09-tie-1"],
        "dropped": [{"id": "p-gone", "reason": "listing_gone"}, {"id": "p-late", "reason": "dates"}]}
    files = _files(site)
    assert not any("report" in name for name in files)
    assert [p["id"] for p in json.loads(files["data/placements.json"])["placements"]] == ["p-2026-09-tie-1"]
    # The existing warnings are still printed.
    out = capsys.readouterr().out
    assert "::warning::placement p-gone dropped: listing_gone (listing nope)" in out
    # Without --placements there is no report.
    plain = tmp_path / "plain-report.json"
    seo_pages.main(["seo_pages", _placement_site(tmp_path, "plain"), "--placements-report", str(plain)])
    assert not plain.exists()
    # A report that cannot be written (here a folder) is a warning, and the site is still built.
    capsys.readouterr()
    site2 = _placement_site(tmp_path, "nowrite")
    seo_pages.main(["seo_pages", site2, "--placements", str(f), "--placements-report", str(tmp_path)])
    assert "::warning::placements report not written" in capsys.readouterr().out
    assert "data/placements.json" in _files(site2)


def test_the_report_changes_no_page(tmp_path, monkeypatch):
    monkeypatch.setattr(seo_pages, "today_utc", lambda: "2026-09-23")
    f = tmp_path / "placements.json"
    f.write_text(json.dumps({"placements": [_site_pl()]}), encoding="utf-8")
    a, b = _placement_site(tmp_path, "a"), _placement_site(tmp_path, "b")
    seo_pages.main(["seo_pages", a, "--placements", str(f)])
    seo_pages.main(["seo_pages", b, "--placements", str(f), "--placements-report", str(tmp_path / "r.json")])
    assert _files(a) == _files(b)


# ---------------------------------------------------------------- record_runs

def test_record_runs_adds_shown_and_dropped_per_day_with_the_reason(tmp_path):
    d1 = FakeD1()
    rep = {"day": DAY, "kept": ["p-a", "p-b"], "dropped": [{"id": "p-c", "reason": "closed"}]}
    assert placements.record_runs(_write(tmp_path, rep), "tok", post=d1, now=NOW_UTC) == 3
    # A second build the same day: p-a kept again, p-b now dropped, p-c still dropped for a new reason.
    rep2 = {"day": DAY, "kept": ["p-a"],
            "dropped": [{"id": "p-b", "reason": "url_changed"}, {"id": "p-c", "reason": "deadline"}]}
    later = datetime(2026, 11, 3, 20, 0, tzinfo=timezone.utc)
    placements.record_runs(_write(tmp_path, rep2, "r2.json"), "tok", post=d1, now=later)
    assert d1.rows() == [
        ("p-a", DAY, 2, 0, None, "2026-11-03T20:00:00Z"),
        ("p-b", DAY, 1, 1, "url_changed", "2026-11-03T20:00:00Z"),
        ("p-c", DAY, 0, 2, "deadline", "2026-11-03T20:00:00Z"),
    ]
    url, body, token = d1.calls[0]
    assert url == ("https://api.cloudflare.com/client/v4/accounts/d4a5640a67faee275d9df91204c4ec59"
                   "/d1/database/ef477808-f94c-4dce-a0b3-1198f00e5c39/query")
    assert token == "tok" and set(body) == {"sql", "params"}
    assert body["sql"].startswith("INSERT INTO placement_runs (placement_id, day, shown, dropped, reason, updated) VALUES ")
    assert len(d1.calls) == 2, "one statement per build while there are few placements"


def test_record_runs_leaves_out_drops_that_are_not_paid_days_and_anything_malformed(tmp_path):
    d1 = FakeD1()
    rep = {"day": DAY, "kept": ["p-a", "p-a", "bad id", 7],
           "dropped": [{"id": "p-a", "reason": "duplicate"}, {"id": "p-later", "reason": "dates"},
                       {"id": "p-x", "reason": "made_up"}, {"id": None, "reason": "malformed"}, "junk",
                       {"id": "p-m", "reason": "malformed"}]}
    assert placements.record_runs(_write(tmp_path, rep), "tok", post=d1, now=NOW_UTC) == 2
    assert [r[:5] for r in d1.rows()] == [("p-a", DAY, 1, 0, None), ("p-m", DAY, 0, 1, "malformed")]
    # Nothing to record: no request at all.
    empty = FakeD1()
    assert placements.record_runs(_write(tmp_path, {"day": DAY, "kept": [], "dropped": []}, "e.json"), "tok",
                                  post=empty, now=NOW_UTC) == 0
    assert empty.calls == []


def test_record_runs_splits_many_placements_under_the_d1_parameter_limit(tmp_path):
    d1 = FakeD1()
    rep = {"day": DAY, "kept": [f"p-{i}" for i in range(40)], "dropped": []}
    assert placements.record_runs(_write(tmp_path, rep), "tok", post=d1, now=NOW_UTC) == 40
    assert len(d1.calls) == 3 and len(d1.rows()) == 40


def _http_error(*_):
    raise urllib.error.HTTPError("https://api.cloudflare.com/x?token=secret-tok", 403, "Forbidden", {}, None)


def _url_error(*_):
    raise urllib.error.URLError("api.cloudflare.com: secret-tok")


@pytest.mark.parametrize("answer,why", [
    (_http_error, "Cloudflare answered HTTP 403"),
    (_url_error, "Cloudflare could not be reached"),
    (lambda *_: {"success": False, "errors": [{"message": "no such table: placement_runs secret-tok"}]},
     "D1 did not accept the write"),
    (lambda *_: "not json", "D1 did not accept the write"),
])
def test_a_failed_write_is_one_warning_that_names_no_secret_or_address(tmp_path, monkeypatch, capsys, answer, why):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "secret-tok")
    monkeypatch.setattr(placements.record_runs, "__defaults__", (FakeD1(answer), NOW_UTC))
    path = _write(tmp_path, {"day": DAY, "kept": ["p-a"], "dropped": []})
    assert placements.main(["placements", "record", path]) == 0
    out = capsys.readouterr()
    assert out.out == f"::warning::paid listing runs not recorded: {why}\n"
    assert "secret-tok" not in out.out + out.err and "https://" not in out.out + out.err


def test_record_never_fails_without_a_token_or_a_report(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    assert placements.main(["placements", "record", str(tmp_path / "none.json")]) == 0
    assert capsys.readouterr().out == "::warning::paid listing runs not recorded: no Cloudflare token in this run\n"
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "secret-tok")
    assert placements.main(["placements", "record", str(tmp_path / "none.json")]) == 0
    assert capsys.readouterr().out == "::warning::paid listing runs not recorded: no report file\n"
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert placements.main(["placements", "record", str(bad)]) == 0
    assert capsys.readouterr().out == "::warning::paid listing runs not recorded: the report could not be read\n"
    assert placements.main(["placements"]) == 2


def test_record_as_the_workflow_runs_it_exits_0_when_cloudflare_is_unreachable(tmp_path):
    path = _write(tmp_path, {"day": DAY, "kept": ["p-a"], "dropped": []})
    # A proxy nothing answers on, so no request can reach Cloudflare from a test.
    env = dict(os.environ, CLOUDFLARE_API_TOKEN="secret-tok", HTTPS_PROXY="http://127.0.0.1:9",
               https_proxy="http://127.0.0.1:9")
    out = subprocess.run([sys.executable, "-m", "internscout.placements", "record", path],
                         cwd=os.path.join(HERE, ".."), capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0
    assert out.stdout.startswith("::warning::paid listing runs not recorded: ")
    assert "secret-tok" not in out.stdout + out.stderr


def test_record_runs_uses_the_same_account_and_database_as_growth_metrics():
    with open(os.path.join(ROOT, "growth", "metrics.py"), encoding="utf-8") as f:
        text = f.read()
    account = re.search(r'^ACCOUNT = os\.environ\.get\("CLOUDFLARE_ACCOUNT_ID", "([0-9a-f]+)"\)', text, re.M).group(1)
    database = re.search(r'^D1_DATABASE = os\.environ\.get\("INTERNSCOUT_D1_ID", "([0-9a-f-]+)"\)', text, re.M).group(1)
    with open(os.path.join(PKG, "placements.py"), encoding="utf-8") as f:
        src = f.read()
    assert f'ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "{account}")' in src
    assert f'D1_DATABASE = os.environ.get("INTERNSCOUT_D1_ID", "{database}")' in src


# ---------------------------------------------------------------- the workflow step

def test_the_deploy_records_paid_listing_runs_without_ever_blocking():
    with open(os.path.join(ROOT, ".github", "workflows", "pages.yml"), encoding="utf-8") as f:
        wf = f.read()
    assert "--placements ../placements.json --placements-report ../placements-report.json" in wf
    steps = wf.split("\n      - ")
    rec = next(s for s in steps if s.startswith("name: Record which paid listings this build kept or dropped"))
    assert "\n        continue-on-error: true\n" in rec
    assert "\n        if: ${{ vars.INTERNSCOUT_PLACEMENTS_URL != '' }}\n" in rec
    assert "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}" in rec
    assert "python -m internscout.placements record ../placements-report.json" in rec
    assert "timeout-minutes:" in rec
    # Right after the build that writes the report, in the build job (before the deploy job).
    build = next(i for i, s in enumerate(steps) if s.startswith("name: Build the site and its landing pages"))
    assert steps.index(rec) == build + 1
    assert wf.index(rec) < wf.index("\n  deploy:\n")
    assert "_site/placements-report" not in wf
