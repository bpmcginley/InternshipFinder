"""growth/social.py: brand posts written from the data, short enough for every account."""
import importlib.util
import io
import json
import os
import sys
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
_spec = importlib.util.spec_from_file_location("social", os.path.join(ROOT, "growth", "social.py"))
social = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(social)

NOW = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)


def _x(i, company, first_seen="2026-09-21T00:00:00", posted_at=None):
    return {"id": str(i), "company_name": company, "first_seen": first_seen, "posted_at": posted_at}


def test_post_fits_bluesky_and_ends_with_the_landing_page():
    items = [_x(i, "A Very Long Employer Name Incorporated %d" % i) for i in range(40)]
    text, url = social.compose("ml", items, 40)
    assert len(text) <= social.LIMIT
    assert text.endswith(url) and url == "https://internscout.org/internships/machine-learning-ai/"
    assert text.startswith("40 new machine learning and AI internships")


def test_old_postings_a_scan_just_reached_are_not_new():
    assert social.fresh(_x(1, "A"), NOW)
    assert not social.fresh(_x(2, "A", posted_at="2024-09-01T00:00:00"), NOW)
    assert not social.fresh(_x(3, "A", first_seen="2026-09-01T00:00:00"), NOW)


# ---------------------------------------------------------------- links only to pages that exist

def test_a_field_without_a_page_links_the_dashboard_instead(monkeypatch):
    items = [_x(i, f"Co {i}") for i in range(6)]
    # Below seo_pages.MIN_OPEN open roles the field has no landing page.
    text, url = social.compose("ml", items, social.sp.MIN_OPEN - 1)
    assert url == "https://internscout.org/?field=ml" and text.endswith(url)
    # A field whose slug is a state's gets no page either: the state's page has that path.
    monkeypatch.setattr(social.digest, "STATE_SLUGS", {"machine-learning-ai"})
    assert social.compose("ml", items, 500)[1] == "https://internscout.org/?field=ml"
    monkeypatch.undo()
    assert social.compose("ml", items, 500)[1] == "https://internscout.org/internships/machine-learning-ai/"


def test_the_link_rule_is_the_digests():
    for tag, n in (("ml", 0), ("ml", 5), ("ml", 4), ("data", 99)):
        assert (social.link(tag, n).startswith("https://internscout.org/internships/")
                == social.digest.has_page(tag, n))


# ---------------------------------------------------------------- the run

def _site(tmp_path, made, rows=None):
    """A site whose export was made at made, with six new roles in one field nearby."""
    seen = ((made or _now()) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    rows = rows if rows is not None else [
        {"id": f"n{i}", "company_name": f"Company {i}", "title": f"Data Intern {i}", "field_tags": ["data"],
         "first_seen": seen, "posted_at": None, "status": "open", "is_remote": False,
         "regions": [{"loc": "Boston, MA", "kind": "x", "state": "MA"}], "apply_url": f"https://jobs.example.com/{i}"}
        for i in range(6)]
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    (data / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    index = {"files": {"MA": {"file": "listings/MA.json"}}}
    if made is not None:
        index["generated_at"] = made.isoformat()
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


@pytest.fixture
def no_accounts(monkeypatch):
    for k in ("BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD", "MASTODON_URL", "MASTODON_TOKEN", "DISCORD_WEBHOOK_URL"):
        monkeypatch.delenv(k, raising=False)


def _now():
    return datetime.now(timezone.utc)


def test_a_fresh_export_is_posted(tmp_path, no_accounts, capsys):
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=3)), "--send"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("6 new ") and "in the Northeast and remote this week" in out
    assert "not posting" not in out


@pytest.mark.parametrize("age", [timedelta(days=2, hours=1), timedelta(days=9)])
def test_a_stale_export_posts_nothing_and_says_why(tmp_path, monkeypatch, capsys, age):
    """A stalled ingest leaves the same export behind, and every scheduled run would post its week again."""
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/secret")
    monkeypatch.setattr(social, "to_discord", lambda t: pytest.fail("posted from a stale export"))
    assert social.main(["social.py", _site(tmp_path, _now() - age), "--send"]) == 0
    out = capsys.readouterr().out
    assert "not posting: the data export is from" in out and "stalled" in out
    assert "internships" not in out                                    # no post text either


def test_an_export_with_no_time_counts_as_stale(tmp_path, no_accounts, capsys):
    assert social.main(["social.py", _site(tmp_path, None), "--send"]) == 0
    assert "no generated_at" in capsys.readouterr().out


def _hook_refused(*_a, **_k):
    raise urllib.error.HTTPError("https://discord.com/api/webhooks/1/secret-token", 401, "Unauthorized", {},
                                 io.BytesIO(b'{"message": "Invalid Webhook Token"}'))


def test_a_failed_account_fails_the_run_after_trying_the_others(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MASTODON_URL", "https://mastodon.example")
    monkeypatch.setenv("MASTODON_TOKEN", "mastodon-secret-token")
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/secret-token")
    monkeypatch.delenv("BLUESKY_HANDLE", raising=False)
    tried = []
    monkeypatch.setattr(social, "to_mastodon", lambda t: _hook_refused())
    monkeypatch.setattr(social, "to_discord", lambda t: tried.append("Discord") or "sent")
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=1)), "--send"]) == 1
    out = capsys.readouterr().out
    assert tried == ["Discord"]                                        # the next account was still tried
    assert "[social] Mastodon failed: HTTPError" in out and "[social] Discord: sent" in out
    for secret in ("secret-token", "mastodon-secret-token", "discord.com/api", "Invalid Webhook Token"):
        assert secret not in out


def test_every_account_posting_is_a_green_run(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/x")
    for k in ("BLUESKY_HANDLE", "MASTODON_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(social, "to_discord", lambda t: "sent")
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=1)), "--send"]) == 0


def test_a_post_links_the_dashboard_when_the_field_has_too_few_open_roles(tmp_path, no_accounts, capsys,
                                                                         monkeypatch):
    monkeypatch.setattr(social.sp, "MIN_OPEN", 50)                     # six open roles: no page
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=1))]) == 0
    assert capsys.readouterr().out.rstrip().endswith("https://internscout.org/?field=data")


def test_new_roles_are_counted_once_per_employer(tmp_path, no_accounts):
    """The same role on two of one employer's boards is one role, as in the digest."""
    made = _now() - timedelta(hours=1)
    seen = (made - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    row = lambda i, co: {"id": f"r{i}", "company_name": co, "title": "Data Intern", "field_tags": ["data"],  # noqa: E731
                         "first_seen": seen, "posted_at": None, "status": "open", "is_remote": False,
                         "regions": [{"loc": "Boston, MA", "kind": "x", "state": "MA"}],
                         "apply_url": f"https://jobs.example.com/{i}"}
    rows = [row(i, f"Co {i}") for i in range(5)] + [row(9, "Co 0 Inc.")]
    ranked, _, _ = social.candidates(_site(tmp_path, made, rows))
    assert [(t, len(v)) for t, v in ranked] == [("data", 5)]
