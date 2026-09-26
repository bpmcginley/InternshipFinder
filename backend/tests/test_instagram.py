"""growth/instagram.py: the token that must outlive Meta's 60 days, and the two-step publish."""
import importlib.util
import os
from datetime import datetime, timedelta, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location("instagram", os.path.join(ROOT, "growth", "instagram.py"))
ig = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ig)

NOW = datetime(2026, 9, 29, 15, 0, tzinfo=timezone.utc)


class FakeD1:
    """The social_tokens table, as instagram._d1_rows sees it."""
    def __init__(self, row=None):
        self.row = row
        self.writes = []

    def __call__(self, cf_token, sql, params=None):
        if sql.startswith("SELECT"):
            return [self.row] if self.row else []
        if sql.startswith("INSERT"):
            self.writes.append(params)
            self.row = {"token": params[0], "seed": params[1], "refreshed": params[2]}
        return []


@pytest.fixture
def d1(monkeypatch):
    fake = FakeD1()
    monkeypatch.setattr(ig, "_d1_rows", fake)
    return fake


def refresher(monkeypatch, answer=None, error=None):
    calls = []

    def fake(method, path, params):
        calls.append((method, path, params))
        if error:
            raise ig.InstagramError(error)
        return answer or {"access_token": "tok-2", "expires_in": 5184000}
    monkeypatch.setattr(ig, "_request", fake)
    return calls


def test_a_new_secret_is_refreshed_and_the_result_kept(monkeypatch, d1):
    calls = refresher(monkeypatch)
    assert ig.token_for_run("tok-1", "cf", NOW) == "tok-2"
    assert calls[0][1] == "refresh_access_token" and calls[0][2]["access_token"] == "tok-1"
    assert d1.row["token"] == "tok-2" and d1.row["seed"] == ig._seed("tok-1")


def test_the_kept_token_is_used_and_refreshed_only_when_a_week_old(monkeypatch, d1):
    d1.row = {"token": "tok-2", "seed": ig._seed("tok-1"), "refreshed": (NOW - timedelta(days=3)).isoformat()}
    calls = refresher(monkeypatch)
    assert ig.token_for_run("tok-1", "cf", NOW) == "tok-2" and not calls      # 3 days: not yet
    d1.row["refreshed"] = (NOW - timedelta(days=8)).isoformat()
    assert ig.token_for_run("tok-1", "cf", NOW) == "tok-2" and calls[0][2]["access_token"] == "tok-2"


def test_a_replaced_secret_takes_over_from_the_kept_token(monkeypatch, d1):
    """The owner generated a new token: its hash differs, so the stale kept one is not used."""
    d1.row = {"token": "old-kept", "seed": ig._seed("tok-1"), "refreshed": NOW.isoformat()}
    calls = refresher(monkeypatch)
    ig.token_for_run("tok-new", "cf", NOW)
    assert calls[0][2]["access_token"] == "tok-new"
    assert d1.row["seed"] == ig._seed("tok-new")


def test_a_token_too_new_to_refresh_is_used_as_it_is(monkeypatch, d1):
    refresher(monkeypatch, error="OAuthException 190: token must be at least 24 hours old")
    assert ig.token_for_run("tok-1", "cf", NOW) == "tok-1"
    assert not d1.writes


def test_a_kept_token_that_fails_to_refresh_fails_the_run(monkeypatch, d1):
    d1.row = {"token": "tok-2", "seed": ig._seed("tok-1"), "refreshed": (NOW - timedelta(days=30)).isoformat()}
    refresher(monkeypatch, error="OAuthException 190: Error validating access token")
    with pytest.raises(ig.InstagramError):
        ig.token_for_run("tok-1", "cf", NOW)


def test_without_cloudflare_it_still_posts_but_says_the_token_is_not_kept(monkeypatch, capsys):
    refresher(monkeypatch)
    assert ig.token_for_run("tok-1", None, NOW) == "tok-2"
    assert "NOT kept" in capsys.readouterr().out


def test_publish_creates_waits_for_and_publishes_the_container(monkeypatch):
    calls, statuses = [], iter(["IN_PROGRESS", "FINISHED"])

    def fake(method, path, params):
        calls.append((method, path, dict(params)))
        if path == "me":
            return {"user_id": "1789", "username": "internscout"}
        if path == "1789/media":
            return {"id": "c-1"}
        if path == "c-1":
            return {"status_code": next(statuses)}
        if path == "1789/media_publish":
            return {"id": "m-1"}
        raise AssertionError(path)
    monkeypatch.setattr(ig, "_request", fake)
    assert ig.publish("tok", "https://x/card.jpg", "caption", sleep=lambda s: None) == "m-1"
    paths = [c[1] for c in calls]
    assert paths == ["me", "1789/media", "c-1", "c-1", "1789/media_publish"]
    media = calls[1][2]
    assert media["image_url"] == "https://x/card.jpg" and media["caption"] == "caption"
    assert calls[-1][2]["creation_id"] == "c-1"


def test_publish_stops_on_a_container_error(monkeypatch):
    def fake(method, path, params):
        return {"me": {"user_id": "1"}, "1/media": {"id": "c"}}.get(path, {"status_code": "ERROR"})
    monkeypatch.setattr(ig, "_request", fake)
    with pytest.raises(ig.InstagramError, match="could not take the image"):
        ig.publish("tok", "u", "c", sleep=lambda s: None)


def test_no_secret_means_nothing_is_sent(monkeypatch, capsys):
    monkeypatch.delenv("INSTAGRAM_TOKEN", raising=False)
    assert ig.main(["instagram.py", "--send"]) == 0
    assert "nothing sent" in capsys.readouterr().out


def test_a_failure_prints_meta_message_but_never_the_token(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("INSTAGRAM_TOKEN", "SECRET-TOKEN-VALUE")
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    refresher(monkeypatch, error="OAuthException 190: Error validating access token")
    post = tmp_path / "post.json"
    post.write_text('{"instagram_caption": "c", "card_url": "https://x/card.jpg"}', encoding="utf-8")
    # The secret is new here (no kept row), so a failed refresh is tolerated, and the post then fails.
    monkeypatch.setattr(ig, "wait_for_image", lambda url: None)
    monkeypatch.setattr(ig, "publish", lambda *a, **k: (_ for _ in ()).throw(
        ig.InstagramError("OAuthException 190: Error validating access token")))
    assert ig.main(["instagram.py", str(post), "--send"]) == 1
    out = capsys.readouterr().out
    assert "SECRET-TOKEN-VALUE" not in out
    assert "replace the INSTAGRAM_TOKEN secret" in out
