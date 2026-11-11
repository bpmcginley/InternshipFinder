"""Offline checks for fixed growth status diagnostics and adjacent payloads."""

import json
import urllib.request
from datetime import datetime, timezone

import pytest

from growth import digest_send, instagram, metrics, social


@pytest.fixture(params=[False, True])
def json_mode(request, monkeypatch):
    if request.param:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    else:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)

    def no_network(*args, **kwargs):
        pytest.fail("provider access is outside this test")

    monkeypatch.setattr(urllib.request, "urlopen", no_network)
    return request.param


def status(line, json_mode, message, exception_type=None):
    if json_mode:
        record = {"level": "INFO", "message": message}
        if exception_type:
            record.update(level="WARNING", exception_type=exception_type)
        assert json.loads(line) == record
    else:
        assert line == message


def test_digest_check_statuses_do_not_include_provider_values(monkeypatch, capsys, json_mode):
    calls = []

    def same_week(key, subject):
        calls.append((key, subject))
        return None

    monkeypatch.setattr(digest_send, "same_week", same_week)
    assert digest_send.check("synthetic key", False) == 0
    assert calls == [("synthetic key", "")]
    out = capsys.readouterr()
    assert out.err == ""
    checked, clear = out.out.splitlines()
    status(
        checked,
        json_mode,
        f"[digest] {digest_send.KEY_ENV} works: Buttondown answered the same-week check "
        f"(API version {digest_send.API_VERSION}). Nothing was sent.",
    )
    status(clear, json_mode, "[digest] No email was sent or scheduled in the last six days.")


def test_digest_unprintable_address_refusal_keeps_exit_and_message(monkeypatch, capsys, json_mode):
    monkeypatch.setenv(digest_send.KEY_ENV, "synthetic key")
    monkeypatch.setenv(digest_send.ADDRESS_ENV, "synthetic address")
    monkeypatch.setattr(digest_send, "export_issue", lambda _site: None)
    monkeypatch.setattr(digest_send.digest, "build", lambda _site: {"sections": [{}]})
    monkeypatch.setattr(
        digest_send, "payload", lambda *_args: {"body": digest_send.digest.NO_ADDRESS}
    )
    assert digest_send.main(["digest_send", "--send"]) == digest_send.EXIT_REFUSED
    out = capsys.readouterr()
    assert out.err == ""
    status(
        out.out.rstrip("\n"),
        json_mode,
        f"[digest] Not sent: {digest_send.ADDRESS_ENV} has no printable lines, so the email has no postal address.",
    )


@pytest.mark.parametrize("save_failed", [False, True])
def test_social_class_only_outcomes_keep_preview_raw(monkeypatch, capsys, json_mode, save_failed):
    monkeypatch.setattr(social, "stale", lambda _site: None)
    monkeypatch.setattr(social, "chosen", lambda _site: ("fixture",))
    monkeypatch.setattr(
        social, "compose", lambda *_args, **_kwargs: ("raw preview", "https://example.test")
    )
    monkeypatch.setattr(social, "digest_live", lambda _site: False)
    monkeypatch.setattr(social, "write_out", lambda *_args: {"fixture": True})
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "synthetic value")

    def save(*_args):
        if save_failed:
            raise ValueError("private draft detail")

    def send(*_args):
        raise TimeoutError("private channel detail")

    monkeypatch.setattr(social, "save_drafts", save)
    monkeypatch.setattr(social, "CHANNELS", [("Bluesky", (), send)])
    assert social.main(["social", "local-site", "--out=local-output", "--send"]) == 1
    out = capsys.readouterr()
    assert out.err == ""
    preview, _rendered, draft, channel, aggregate = out.out.splitlines()
    assert preview == "raw preview"
    if save_failed:
        status(draft, json_mode, "[social] LinkedIn draft failed: ValueError", "ValueError")
        status(
            aggregate,
            json_mode,
            "[social] 2 account(s) failed: LinkedIn draft, Bluesky. Check their secrets.",
        )
    else:
        status(draft, json_mode, "[social] LinkedIn draft saved for the analytics page")
        status(aggregate, json_mode, "[social] 1 account(s) failed: Bluesky. Check their secrets.")
    status(channel, json_mode, "[social] Bluesky failed: TimeoutError", "TimeoutError")


@pytest.mark.parametrize("configured", [False, True])
def test_instagram_skip_keeps_status_artifact(monkeypatch, tmp_path, capsys, json_mode, configured):
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    if configured:
        monkeypatch.setenv("INSTAGRAM_TOKEN", "synthetic value")
    else:
        monkeypatch.delenv("INSTAGRAM_TOKEN", raising=False)
    calls = []

    def checked(*_args):
        calls.append("checked")
        return "synthetic value"

    monkeypatch.setattr(instagram, "token_for_run", checked)
    path = tmp_path / "status.json"
    assert instagram.main(["instagram", "--send", f"--status-file={path}"]) == 0
    out = capsys.readouterr()
    assert out.err == ""
    message = (
        "[instagram] nothing to post this run; token checked"
        if configured
        else "[instagram] no INSTAGRAM_TOKEN; nothing sent"
    )
    status(out.out.rstrip("\n"), json_mode, message)
    artifact = json.loads(path.read_text(encoding="utf-8"))
    assert artifact["requested"] == "none"
    assert artifact["outcome"] == ("no_post" if configured else "not_configured")
    assert calls == (["checked"] if configured else [])


@pytest.mark.parametrize("write_outcome", ["missing", "error", "written"])
def test_metrics_keeps_raw_snapshot_first(monkeypatch, capsys, json_mode, write_outcome):
    class Clock(datetime):
        @classmethod
        def now(cls, _tz=None):
            return datetime(2026, 11, 10, tzinfo=timezone.utc)

    monkeypatch.setattr(metrics, "datetime", Clock)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    if write_outcome != "missing":
        monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "synthetic value")
    monkeypatch.setattr(metrics, "visits", lambda *_args: ([], {}))
    for name in (
        "bluesky",
        "instagram",
        "mastodon",
        "search_console",
        "bing",
        "listings",
        "page_count",
        "store",
    ):
        monkeypatch.setattr(metrics, name, lambda *_args: {})
    monkeypatch.setattr(metrics, "automation", lambda _now: [])
    writes = []

    def d1(_token, sql, _params):
        writes.append(sql)
        if write_outcome == "error":
            raise RuntimeError("fixture write failure")

    monkeypatch.setattr(metrics, "d1", d1)
    assert metrics.main(["metrics"]) == 0
    read_only = capsys.readouterr()
    assert read_only.err == "" and not writes
    assert json.loads(read_only.out)["taken"] == "2026-11-10T00:00:00Z"

    assert metrics.main(["metrics", "--write"]) == (0 if write_outcome == "written" else 1)
    out = capsys.readouterr()
    assert out.err == "" and out.out.startswith(read_only.out)
    tail = out.out.removeprefix(read_only.out).splitlines()
    if write_outcome == "missing":
        assert not writes and len(tail) == 1
        status(tail[0], json_mode, "[metrics] nothing written: no CLOUDFLARE_API_TOKEN")
    elif write_outcome == "error":
        assert len(writes) == 1 and len(tail) == 2
        status(tail[0], json_mode, "[metrics] write failed: RuntimeError", "RuntimeError")
        status(
            tail[1],
            json_mode,
            "[metrics] The Cloudflare token needs D1: Edit as well as Account Analytics: Read.",
        )
    else:
        assert writes and len(tail) == 1
        status(tail[0], json_mode, "[metrics] wrote 0 days and a snapshot")
