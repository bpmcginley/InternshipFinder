"""growth/youtube.py: the Thursday Reel as a YouTube Short (added 2026-10-02). Every test fakes
urllib.request.urlopen, so nothing reaches Google; the fake records each request as it was sent."""
import importlib.util
import io
import json
import os
import sys
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location("youtube", os.path.join(ROOT, "growth", "youtube.py"))
yt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(yt)
sys.modules.setdefault("youtube", yt)       # youtube_auth imports it by name
_aspec = importlib.util.spec_from_file_location("youtube_auth", os.path.join(ROOT, "growth", "youtube_auth.py"))
auth = importlib.util.module_from_spec(_aspec)
_aspec.loader.exec_module(auth)

NOW = datetime(2026, 10, 8, 15, 30, tzinfo=timezone.utc)
SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION-ID"
SECRETS = {"YOUTUBE_CLIENT_ID": "client-id.apps.googleusercontent.com",
           "YOUTUBE_CLIENT_SECRET": "CLIENT-SECRET-VALUE", "YOUTUBE_REFRESH_TOKEN": "REFRESH-TOKEN-VALUE"}
POST = {"count": 18, "headline": "new data science and analytics internships",
        "where": "in the Northeast and remote", "url": "https://internscout.org/internships/data-science/",
        "employers": ["MFS", "Fidelity Investments", "Wayfair", "HubSpot", "Moderna"],
        "hashtags": ["#DataScience", "#internships", "#summerinternship", "#collegestudents", "#studentjobs"],
        "reel": True}


class Resp:
    """What urlopen returns: a context manager with status, headers and a body."""
    def __init__(self, status=200, body=b"{}", headers=None):
        self.status, self._body, self.headers = status, body, headers or {}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, body, headers=None):
    return urllib.error.HTTPError("https://example.invalid", code, "error", headers or {}, io.BytesIO(body))


class FakeGoogle:
    """Answers each request from a list of (method, url start) -> answer, in order, and keeps the
    requests. An answer is a Resp, an exception to raise, or a function of the request."""
    def __init__(self, *routes):
        self.routes = list(routes)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        for i, (method, start, answer) in enumerate(self.routes):
            if req.get_method() == method and req.full_url.startswith(start):
                del self.routes[i]
                if callable(answer) and not isinstance(answer, Resp):
                    answer = answer(req)
                if isinstance(answer, Exception):
                    raise answer
                return answer
        raise AssertionError(f"unexpected {req.get_method()} {req.full_url}")


def token_ok():
    return ("POST", yt.TOKEN_URL, Resp(body=json.dumps({"access_token": "ACCESS-TOKEN", "expires_in": 3599}).encode()))


def channel(uploads=()):
    """The two reads already_posted makes: the channel's uploads playlist, then its last items."""
    items = [{"snippet": {"title": t, "publishedAt": w.strftime("%Y-%m-%dT%H:%M:%SZ"),
                          "resourceId": {"videoId": v}}} for t, w, v in uploads]
    return [("GET", f"{yt.API}/channels", Resp(body=json.dumps(
                {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": "UU123"}}}]}).encode())),
            ("GET", f"{yt.API}/playlistItems", Resp(body=json.dumps({"items": items}).encode()))]


def session_ok():
    return ("POST", yt.UPLOAD_URL, Resp(headers={"Location": SESSION}))


def upload_ok(privacy="public"):
    return ("PUT", SESSION, Resp(status=201, body=json.dumps(
        {"id": "VID123", "status": {"privacyStatus": privacy, "uploadStatus": "uploaded"}}).encode()))


@pytest.fixture
def run(monkeypatch, tmp_path):
    """A post.json and reel.mp4 in tmp_path, the secrets set; returns (install routes, post path)."""
    (tmp_path / "post.json").write_text(json.dumps(POST), encoding="utf-8")
    (tmp_path / "reel.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"v" * 1000)
    for k, v in SECRETS.items():
        monkeypatch.setenv(k, v)

    def install(*routes):
        fake = FakeGoogle(*routes)
        monkeypatch.setattr(yt.urllib.request, "urlopen", fake)
        return fake
    return install, str(tmp_path / "post.json")


# ---- the token -----------------------------------------------------------------------------------

def test_the_refresh_token_is_exchanged_in_the_post_body(monkeypatch):
    fake = FakeGoogle(token_ok())
    monkeypatch.setattr(yt.urllib.request, "urlopen", fake)
    assert yt.access_token("cid", "csecret", "rtok") == "ACCESS-TOKEN"
    req = fake.requests[0]
    assert req.full_url == "https://oauth2.googleapis.com/token"          # nothing secret in the URL
    form = urllib.parse.parse_qs(req.data.decode())
    assert form == {"client_id": ["cid"], "client_secret": ["csecret"], "refresh_token": ["rtok"],
                    "grant_type": ["refresh_token"]}
    assert req.get_header("Content-type") == "application/x-www-form-urlencoded"


# ---- what the Short says -------------------------------------------------------------------------

def test_the_title_is_a_short_title_within_100_characters():
    assert yt.title_for(POST) == "18 new data science and analytics internships this week #Shorts"
    long = {**POST, "headline": "new " + "very long field name " * 8 + "internships"}
    title = yt.title_for(long)
    assert len(title) <= yt.TITLE_MAX and title.endswith("#Shorts")
    middling = {**POST, "headline": "new " + "x" * 70 + " internships"}     # fits only without "this week"
    assert yt.title_for(middling).endswith(" internships #Shorts") and len(yt.title_for(middling)) <= 100


def test_the_metadata_is_public_education_not_for_kids_and_not_synthetic():
    meta = yt.metadata(POST)
    assert meta["snippet"]["categoryId"] == "27"
    assert meta["status"] == {**meta["status"], "privacyStatus": "public", "selfDeclaredMadeForKids": False,
                              "containsSyntheticMedia": False}
    assert "data science and analytics internships" in meta["snippet"]["tags"]


def test_the_description_says_what_the_other_channels_say():
    text = yt.description_for(POST)
    assert text.startswith("18 new data science and analytics internships in the Northeast and remote this week, "
                           "from MFS, Fidelity Investments, Wayfair, HubSpot and more.")
    assert "Moderna" not in text                                   # four employers, like the captions
    assert "Search them free at internscout.org" in text and POST["url"] in text
    assert yt.SLOGAN in text and yt.DISCLAIMER in text
    tags = text.splitlines()[-1].split()
    assert tags[0] == "#Shorts" and "#DataScience" in tags and len(tags) <= yt.HASHTAGS_MAX
    assert len(text.encode()) <= yt.DESCRIPTION_MAX
    assert "Bruce" not in text


def test_angle_brackets_never_reach_youtube():
    """YouTube rejects a title or description containing < or >."""
    meta = yt.metadata({**POST, "employers": ["<Acme>"], "headline": "new a<b internships"})
    assert "<" not in meta["snippet"]["title"] + meta["snippet"]["description"]
    assert ">" not in meta["snippet"]["title"] + meta["snippet"]["description"]


def test_social_card_data_feeds_the_short(monkeypatch):
    """The real post.json fields, from growth/social.py, make a valid Short."""
    sys.path.insert(0, os.path.join(ROOT, "growth"))
    sys.path.insert(0, os.path.join(ROOT, "backend"))
    import social
    items = [{"company_name": c} for c in ["Baker Tilly"] * 3 + ["Crowe", "MFS", "Vialto Partners"]]
    monkeypatch.setattr(social, "candidates", lambda site: ([("accounting", items)], NOW, {"accounting": 200}))
    data = social.card_data("docs", today=NOW)
    meta = yt.metadata(data)
    assert meta["snippet"]["title"] == "6 new accounting internships this week #Shorts"
    assert "#Accounting" in meta["snippet"]["description"]
    assert data["url"] in meta["snippet"]["description"]


# ---- uploading -----------------------------------------------------------------------------------

def test_a_reel_day_uploads_through_a_resumable_session(run, capsys):
    install, post = run
    fake = install(token_ok(), *channel(), session_ok(), upload_ok())
    assert yt.main(["youtube.py", post, "--send"]) == 0
    out = capsys.readouterr().out
    assert "https://youtube.com/shorts/VID123" in out and "locked private" not in out
    start, put = fake.requests[3], fake.requests[4]
    # The session: snippet and status, the file's size and type announced, the token in a header only.
    q = urllib.parse.parse_qs(urllib.parse.urlparse(start.full_url).query)
    assert q == {"uploadType": ["resumable"], "part": ["snippet,status"]}
    assert start.get_header("Authorization") == "Bearer ACCESS-TOKEN"
    assert start.get_header("X-upload-content-length") == str(os.path.getsize(post.replace("post.json", "reel.mp4")))
    assert start.get_header("X-upload-content-type") == "video/mp4"
    assert json.loads(start.data)["snippet"]["title"].endswith("#Shorts")
    # The bytes go, whole, to the session URI YouTube gave.
    assert put.full_url == SESSION and put.data.startswith(b"\x00\x00\x00\x18ftyp")
    assert put.get_header("Authorization") == "Bearer ACCESS-TOKEN"
    for req in fake.requests:
        assert "ACCESS-TOKEN" not in req.full_url and "REFRESH-TOKEN-VALUE" not in req.full_url
    assert "SESSION-ID" not in out                                  # the session URI is a capability


def test_a_short_youtube_locked_private_says_why(run, capsys):
    install, post = run
    install(token_ok(), *channel(), session_ok(), upload_ok(privacy="private"))
    assert yt.main(["youtube.py", post, "--send"]) == 0
    assert "locked private" in capsys.readouterr().out


def test_a_forced_rerun_does_not_upload_the_same_short_twice(run, capsys):
    install, post = run
    title = yt.title_for(POST)
    fake = install(token_ok(), *channel([(title, datetime.now(timezone.utc) - timedelta(hours=2), "OLD1")]))
    assert yt.main(["youtube.py", post, "--send"]) == 0
    assert "already up" in capsys.readouterr().out
    assert not any(r.get_method() == "PUT" for r in fake.requests)


def test_last_weeks_short_with_the_same_title_is_no_reason_to_skip(monkeypatch):
    title = yt.title_for(POST)
    fake = FakeGoogle(*channel([(title, NOW - timedelta(days=7), "LASTWEEK"), ("Another Short", NOW, "OTHER")]))
    monkeypatch.setattr(yt.urllib.request, "urlopen", fake)
    assert yt.already_posted("ACCESS-TOKEN", title, NOW) is None
    q = urllib.parse.parse_qs(urllib.parse.urlparse(fake.requests[1].full_url).query)
    assert q["playlistId"] == ["UU123"]                       # the channel's own uploads


def test_a_dropped_upload_resumes_from_where_youtube_got_to(monkeypatch):
    data = b"0123456789" * 10
    fake = FakeGoogle(("PUT", SESSION, http_error(503, b'{"error": {"code": 503, "message": "Backend Error"}}')),
                      ("PUT", SESSION, http_error(308, b"", {"Range": "bytes=0-39"})),
                      ("PUT", SESSION, Resp(status=200, body=b'{"id": "VID9"}')))
    monkeypatch.setattr(yt.urllib.request, "urlopen", fake)
    assert yt.send_file(SESSION, "ACCESS-TOKEN", data, sleep=lambda s: None)["id"] == "VID9"
    status_query, rest = fake.requests[1], fake.requests[2]
    assert status_query.get_header("Content-range") == "bytes */100" and status_query.data == b""
    assert rest.get_header("Content-range") == "bytes 40-99/100" and rest.data == data[40:]


def test_a_client_error_is_not_retried(monkeypatch):
    fake = FakeGoogle(("PUT", SESSION, http_error(400, b'{"error": {"code": 400, "message": "Bad video", '
                                                       b'"errors": [{"reason": "invalidVideoMetadata"}]}}')))
    monkeypatch.setattr(yt.urllib.request, "urlopen", fake)
    with pytest.raises(yt.YouTubeError, match="invalidVideoMetadata"):
        yt.send_file(SESSION, "ACCESS-TOKEN", b"x", sleep=lambda s: None)
    assert len(fake.requests) == 1


# ---- when there is nothing to do -----------------------------------------------------------------

def test_missing_secrets_upload_nothing_and_stay_green(run, monkeypatch, capsys):
    install, post = run
    monkeypatch.delenv("YOUTUBE_REFRESH_TOKEN")
    fake = install()
    assert yt.main(["youtube.py", post, "--send"]) == 0
    assert "no YOUTUBE_REFRESH_TOKEN; nothing uploaded" in capsys.readouterr().out
    assert not fake.requests


def test_a_day_without_a_reel_uploads_nothing(run, tmp_path, capsys):
    install, post = run
    fake = install()
    (tmp_path / "post.json").write_text(json.dumps({**POST, "reel": False}), encoding="utf-8")
    assert yt.main(["youtube.py", post, "--send"]) == 0
    assert "not a Reel day" in capsys.readouterr().out
    (tmp_path / "post.json").write_text(json.dumps(POST), encoding="utf-8")
    (tmp_path / "reel.mp4").unlink()
    assert yt.main(["youtube.py", post, "--send"]) == 0
    assert "reel.mp4 wasn't made" in capsys.readouterr().out
    assert yt.main(["youtube.py", str(tmp_path / "nothing.json"), "--send"]) == 0
    assert not fake.requests


# ---- failures ------------------------------------------------------------------------------------

def test_a_revoked_token_fails_with_googles_message_and_never_the_secrets(run, capsys):
    install, post = run
    install(("POST", yt.TOKEN_URL, http_error(400, b'{"error": "invalid_grant", '
                                                   b'"error_description": "Token has been expired or revoked."}')))
    assert yt.main(["youtube.py", post, "--send"]) == 1
    out = capsys.readouterr().out
    assert "invalid_grant: Token has been expired or revoked." in out
    assert "run growth/youtube_auth.py again" in out
    for secret in [*SECRETS.values(), "ACCESS-TOKEN"]:
        assert secret not in out


def test_an_upload_error_fails_the_step_without_leaking_the_access_token(run, capsys):
    install, post = run
    quota = b'{"error": {"code": 403, "message": "The request cannot be completed because you have exceeded your quota.", ' \
            b'"errors": [{"reason": "quotaExceeded"}]}}'
    install(token_ok(), *channel(), ("POST", yt.UPLOAD_URL, http_error(403, quota)))
    assert yt.main(["youtube.py", post, "--send"]) == 1
    out = capsys.readouterr().out
    assert "403 quotaExceeded: The request cannot be completed" in out and "next Thursday" in out
    for secret in [*SECRETS.values(), "ACCESS-TOKEN", "Bearer"]:
        assert secret not in out


def test_a_channel_check_that_fails_still_uploads(run, capsys):
    """The duplicate check is a courtesy: a token without youtube.readonly can still upload."""
    install, post = run
    install(token_ok(), ("GET", f"{yt.API}/channels", http_error(403, b'{"error": {"code": 403, "message": '
                                                                     b'"Insufficient Permission", "errors": '
                                                                     b'[{"reason": "insufficientPermissions"}]}}')),
            session_ok(), upload_ok())
    assert yt.main(["youtube.py", post, "--send"]) == 0
    out = capsys.readouterr().out
    assert "couldn't check" in out and "VID123" in out


def test_an_unreadable_error_body_becomes_its_status_code():
    assert yt._google_message(b"<html>oops</html>", 502) == "HTTP 502"


# ---- the owner's one-time sign-in helper ---------------------------------------------------------

def test_the_sign_in_asks_for_offline_access_with_pkce_on_a_loopback_address():
    verifier, challenge = auth.pkce()
    assert 43 <= len(verifier) <= 128 and "=" not in challenge
    url = auth.consent_url("cid", "http://127.0.0.1:8765", challenge, "st")
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"]
    assert q["code_challenge_method"] == ["S256"] and q["code_challenge"] == [challenge]
    assert q["redirect_uri"] == ["http://127.0.0.1:8765"] and q["state"] == ["st"]
    assert set(q["scope"][0].split()) == {"https://www.googleapis.com/auth/youtube.upload",
                                          "https://www.googleapis.com/auth/youtube.readonly"}


def test_the_loopback_server_takes_the_code_only_with_the_right_state():
    import http.server
    import threading
    import urllib.request as real
    opener = real.urlopen      # the real one: this request goes to 127.0.0.1 only

    def browser_returns(query):
        server = http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
        url = f"http://127.0.0.1:{server.server_port}/?{query}"
        t = threading.Thread(target=lambda: opener(url, timeout=5).read())
        t.start()
        try:
            return auth.wait_for_code(server, "good-state")
        finally:
            t.join()
            server.server_close()

    assert browser_returns("state=good-state&code=4%2Fabc") == "4/abc"
    with pytest.raises(SystemExit):
        browser_returns("state=someone-else&code=4%2Fabc")
