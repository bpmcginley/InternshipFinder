"""Local previews and refusal diagnostics with network disabled."""

import json
import urllib.request

import pytest

from growth import digest_send, social, youtube


@pytest.fixture(params=[False, True])
def json_mode(request, monkeypatch):
    if request.param:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    else:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)

    def forbid_network(*args, **kwargs):
        pytest.fail("local logging tests must not call a provider")

    monkeypatch.setattr(urllib.request, "urlopen", forbid_network)
    return request.param


def diagnostic(capsys, json_mode, message):
    captured = capsys.readouterr()
    assert captured.err == ""
    if json_mode:
        assert json.loads(captured.out) == {"level": "INFO", "message": message}
    else:
        assert captured.out == message + "\n"


def test_digest_check_and_send_refusals_keep_existing_output(json_mode, monkeypatch, capsys):
    monkeypatch.delenv(digest_send.KEY_ENV, raising=False)
    monkeypatch.delenv(digest_send.ADDRESS_ENV, raising=False)

    assert digest_send.main(["digest_send", "--check", "--send"]) == digest_send.EXIT_REFUSED
    diagnostic(
        capsys,
        json_mode,
        "[digest] --check only reads, so it can't be combined with --send. Nothing was sent.",
    )
    assert digest_send.main(["digest_send", "--check"]) == digest_send.EXIT_REFUSED
    diagnostic(capsys, json_mode, f"[digest] Check failed: {digest_send.KEY_ENV} is empty.")
    assert digest_send.main(["digest_send", "--send"]) == digest_send.EXIT_REFUSED
    diagnostic(
        capsys,
        json_mode,
        "[digest] Not sent. Missing: BUTTONDOWN_API_KEY (a Buttondown API key with email_access "
        "and sending_access set to write); DIGEST_POSTAL_ADDRESS (the postal address every email "
        "must carry, a PO box)",
    )


def test_social_status_omits_output_path_in_json_and_preserves_raw_preview(
    json_mode, monkeypatch, capsys
):
    monkeypatch.setattr(social, "stale", lambda _site: None)
    monkeypatch.setattr(social, "chosen", lambda _site: None)
    assert social.main(["social"]) == 0
    diagnostic(
        capsys,
        json_mode,
        "[social] no field gained enough new nearby listings this week; nothing to post",
    )

    monkeypatch.setattr(social, "chosen", lambda _site: ("fixture",))
    monkeypatch.setattr(
        social, "compose", lambda *_args, **_kwargs: ("raw preview", "https://example.test")
    )
    monkeypatch.setattr(social, "digest_live", lambda _site: False)
    calls = []

    def write_out(site, out):
        calls.append((site, out))
        return {"fixture": True}

    monkeypatch.setattr(social, "write_out", write_out)
    assert social.main(["social", "local-site", "--out=local-output"]) == 0
    assert calls == [("local-site", "local-output")]
    result = capsys.readouterr()
    assert result.err == ""
    preview, summary = result.out.splitlines()
    assert preview == "raw preview"
    message = "[social] card and captions written"
    if json_mode:
        assert json.loads(summary) == {"level": "INFO", "message": message}
    else:
        assert summary == message + " to local-output"


@pytest.mark.parametrize(
    ("reel", "message"),
    [
        (False, "[youtube] not a Reel day (post.json has no reel); no Short"),
        (
            True,
            "[youtube] post.json asks for a Reel but reel.mp4 wasn't made (see the Post step); no Short",
        ),
    ],
)
def test_youtube_skip_status_keeps_original_text(json_mode, tmp_path, capsys, reel, message):
    post = tmp_path / "post.json"
    post.write_text(json.dumps({"reel": reel}), encoding="utf-8")
    assert youtube.main(["youtube", str(post)]) == 0
    diagnostic(capsys, json_mode, message)


def test_youtube_missing_requirements_keeps_preview_raw(json_mode, monkeypatch, tmp_path, capsys):
    for name in youtube.SECRETS:
        monkeypatch.delenv(name, raising=False)
    post = tmp_path / "post.json"
    post.write_text('{"reel": true}', encoding="utf-8")
    reel = tmp_path / "reel.mp4"
    reel.write_bytes(b"synthetic local preview")
    monkeypatch.setattr(
        youtube,
        "metadata",
        lambda _post: {"snippet": {"title": "Raw title", "description": "Raw description"}},
    )
    assert youtube.main(["youtube", str(post), "--send"]) == 0
    result = capsys.readouterr()
    assert result.err == ""
    title, description, path, summary = result.out.splitlines()
    assert (title, description, path) == (
        "Raw title",
        "Raw description",
        f"[youtube] video: {reel} (0 KB)",
    )
    message = (
        "[youtube] no YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN; "
        "nothing uploaded (growth/README.md, YouTube)"
    )
    if json_mode:
        assert json.loads(summary) == {"level": "INFO", "message": message}
    else:
        assert summary == message
