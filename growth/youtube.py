"""Cross-post the Thursday Reel to InternScout's YouTube channel as a Short, through the official
YouTube Data API v3. Added 2026-10-02.

growth/social.py --out=DIR writes DIR/post.json and, on a Reel day, DIR/reel.mp4 (growth/reels.py:
1080x1920, about 15 seconds, so YouTube files it as a Short). The Brand posts workflow runs this
after the Instagram step, only when out/reel.mp4 exists, and this:

  1. trades the stored refresh token for an hour's access token (https://oauth2.googleapis.com/token),
  2. checks the channel's last few uploads for one with today's title (a forced rerun of the
     workflow must not post the same Short twice),
  3. opens a resumable upload session (videos.insert, uploadType=resumable, part=snippet,status)
     with the title, description and status,
  4. sends the file's bytes to the session, resuming from where YouTube says it got to if the
     connection drops or YouTube answers 5xx.

The token. YouTube has no long-lived token to paste: the owner runs growth/youtube_auth.py once on
his own machine, signs in as the InternScout channel, and saves the refresh token it prints as the
YOUTUBE_REFRESH_TOKEN secret, beside YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET (the "Desktop app"
OAuth client). A refresh token keeps working while it is used (Google drops one unused for six
months, and one from an app left in "Testing" after 7 days: growth/README.md, YouTube).

Quota (checked 2026-10-02 against developers.google.com/youtube/v3/getting-started, updated
2026-09-14): since 2026-06-01 videos.insert has a bucket of its own, 100 uploads a day by default, and
an upload costs 1 of them. (Before that it cost about 1,600 of the 10,000 daily units.) The duplicate
check costs 2 units of the 10,000 shared by everything else. One Short a week is far inside both.

Uploads from an API project that has not passed YouTube's compliance audit are locked private
(videos.insert docs, updated 2026-09-14). This asks for public every time; when YouTube's answer
says otherwise, the run log says why.

Run from the repo root:
  python growth/youtube.py out/post.json          # print the title and description
  python growth/youtube.py out/post.json --send   # upload out/reel.mp4 as a Short
Needs YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN; without them, or on a day
with no Reel, it says why and exits 0. It exits 1 only when an upload was tried and failed, and the
workflow step runs whatever Instagram did, so neither channel stops the other.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
UA = {"User-Agent": "InternScout-brand-posts/1.0 (+https://internscout.org)"}
SECRETS = ("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN")

TITLE_MAX = 100           # YouTube's limit, in characters
DESCRIPTION_MAX = 5000    # YouTube's limit, in bytes
HASHTAGS_MAX = 5          # YouTube ignores every hashtag on a video with more than 15; a few read better
CATEGORY = "27"           # Education
VIDEO_TYPE = "video/mp4"
SAME_POST = timedelta(hours=20)   # an upload with today's title this recent is today's Short
UPLOAD_TRIES = 3
UPLOAD_TIMEOUT = 120      # seconds per attempt; a Reel is a few MB
SLOGAN = "Built by one student, made for all students."
DISCLAIMER = "Not affiliated with UMass Amherst."


class YouTubeError(RuntimeError):
    """An error Google answered with. Its text is Google's own message, which never carries a token."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status

    @property
    def retryable(self) -> bool:
        return self.status in (500, 502, 503, 504)


def _google_message(body: bytes, code: int) -> str:
    """Google's message from an error body: the token endpoint answers {"error": "invalid_grant",
    "error_description": ...}, the API {"error": {"code", "message", "errors": [{"reason"}]}}."""
    try:
        j = json.loads(body)
        err = j.get("error")
        if isinstance(err, dict):
            reasons = ", ".join(x.get("reason") for x in err.get("errors") or [] if x.get("reason"))
            return f"{err.get('code', code)} {reasons or err.get('status') or 'error'}: {err.get('message', '')}".strip()
        if isinstance(err, str):
            return f"{code} {err}: {j.get('error_description', '')}".strip().rstrip(":")
    except (ValueError, AttributeError, TypeError):
        pass
    return f"HTTP {code}"


def _call(method: str, url: str, *, token: str | None = None, data: bytes | None = None,
          headers: dict | None = None, timeout: int = 60, allow: tuple = ()) -> tuple[int, object, bytes]:
    """(status, headers, body). The token travels only in the Authorization header (or, for the token
    exchange, the POST body), never in a URL, and is never printed. An HTTP error whose code is in
    allow is returned like a success (308 means "upload incomplete"); any other raises YouTubeError
    with Google's message only."""
    h = {**UA, **(headers or {})}
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        body = e.read() or b""
        if e.code in allow:
            return e.code, e.headers, body
        raise YouTubeError(_google_message(body, e.code), e.code) from None


# ---- the token -------------------------------------------------------------------------------------

def access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    """An access token (good for an hour) for the refresh token growth/youtube_auth.py printed."""
    form = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret,
                                   "refresh_token": refresh_token, "grant_type": "refresh_token"}).encode()
    _, _, body = _call("POST", TOKEN_URL, data=form,
                       headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    token = json.loads(body or b"{}").get("access_token")
    if not token:
        raise YouTubeError("the token endpoint answered without an access token")
    return token


# ---- what the Short says ---------------------------------------------------------------------------

def _clean(text: str) -> str:
    """YouTube refuses a title or description with < or > in it (invalidTitle, invalidDescription)."""
    return text.replace("<", "").replace(">", "")


def title_for(post: dict) -> str:
    """"18 new data science internships this week #Shorts", within 100 characters. #Shorts in the
    title is not what makes it a Short (a vertical video under three minutes is), but it is where
    viewers and search look for it."""
    base = _clean(f"{post['count']} {post['headline']}")
    for tail in (" this week #Shorts", " #Shorts"):
        if len(base + tail) <= TITLE_MAX:
            return base + tail
    return base[:TITLE_MAX - len(" #Shorts") - 1].rstrip() + "…" + " #Shorts"


def hashtags_for(post: dict) -> list[str]:
    """#Shorts first, then the captions' own tags (the field's first), HASHTAGS_MAX in all."""
    tags = ["#Shorts"] + [t for t in post.get("hashtags") or ["#internships"] if t.lower() != "#shorts"]
    return tags[:HASHTAGS_MAX]


def description_for(post: dict) -> str:
    """The same facts as the other channels' posts: the count, the field, a few employers, where to
    search them, the slogan and the disclaimer. The link is the post's own (the field's landing page);
    YouTube makes it clickable on the watch page."""
    employers = ", ".join((post.get("employers") or [])[:4])
    lines = [f"{post['count']} {post['headline']} {post.get('where') or ''} this week".replace("  ", " ")
             + (f", from {employers} and more" if employers else "") + ".",
             "",
             "Search them free at internscout.org: every major, filtered to the states you pick, no account needed.",
             post.get("url") or "https://internscout.org",
             "",
             f"{SLOGAN} {DISCLAIMER}",
             "",
             " ".join(hashtags_for(post))]
    # Today's text is a few hundred bytes; the cut is a guard, not a plan.
    return _clean("\n".join(lines)).encode()[:DESCRIPTION_MAX].decode(errors="ignore")


def metadata(post: dict) -> dict:
    """The video resource sent with the upload (part=snippet,status)."""
    name = post["headline"].removeprefix("new ").removesuffix(" internships")
    return {
        "snippet": {
            "title": title_for(post),
            "description": description_for(post),
            "categoryId": CATEGORY,
            "tags": ["internships", f"{name} internships", "college students", "summer internships", "InternScout"],
            "defaultLanguage": "en",
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": False,
            # Slides of text drawn from the listings (growth/reels.py): not realistic altered or
            # synthetic media, which is what YouTube asks creators to label.
            "containsSyntheticMedia": False,
            "embeddable": True,
            "license": "youtube",
        },
    }


# ---- uploading -------------------------------------------------------------------------------------

def _parse_time(s: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def already_posted(token: str, title: str, now: datetime | None = None) -> str | None:
    """The id of an upload from the last SAME_POST with this exact title, if the channel has one.
    The guard job lets a person force a second Brand posts run on one day (to retry Instagram, say),
    and that run must not put the same Short up twice."""
    now = now or datetime.now(timezone.utc)
    _, _, body = _call("GET", f"{API}/channels?part=contentDetails&mine=true", token=token)
    items = json.loads(body or b"{}").get("items") or []
    if not items:
        return None
    uploads = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
    q = urllib.parse.urlencode({"part": "snippet", "playlistId": uploads, "maxResults": 10})
    _, _, body = _call("GET", f"{API}/playlistItems?{q}", token=token)
    for it in json.loads(body or b"{}").get("items") or []:
        sn = it.get("snippet") or {}
        when = _parse_time(sn.get("publishedAt"))
        if sn.get("title") == title and when and now - when < SAME_POST:
            return (sn.get("resourceId") or {}).get("videoId") or "?"
    return None


def start_session(token: str, meta: dict, size: int) -> str:
    """The resumable session's URI (the Location header). It is a capability URL, so it's not printed."""
    q = urllib.parse.urlencode({"uploadType": "resumable", "part": "snippet,status"})
    _, headers, _ = _call("POST", f"{UPLOAD_URL}?{q}", token=token, data=json.dumps(meta).encode(),
                          headers={"Content-Type": "application/json; charset=UTF-8",
                                   "X-Upload-Content-Length": str(size), "X-Upload-Content-Type": VIDEO_TYPE})
    uri = headers.get("Location") if headers else None
    if not uri:
        raise YouTubeError("YouTube opened no upload session (no Location header)")
    return uri


def _resume_point(session: str, token: str, size: int) -> tuple[dict | None, int]:
    """(the video, if YouTube already has the whole file; else the byte to resume from)."""
    status, headers, body = _call("PUT", session, token=token, data=b"",
                                  headers={"Content-Range": f"bytes */{size}"}, allow=(308,))
    if status in (200, 201):
        return json.loads(body or b"{}"), size
    rng = headers.get("Range") if headers else None      # "bytes=0-524287": what YouTube has
    return None, (int(rng.rsplit("-", 1)[1]) + 1 if rng else 0)


def send_file(session: str, token: str, data: bytes, sleep=time.sleep, tries: int = UPLOAD_TRIES) -> dict:
    """Send the bytes; on a dropped connection or a 5xx, ask YouTube how much it has and send the rest.
    The video resource YouTube made."""
    size, start = len(data), 0
    for attempt in range(1, tries + 1):
        headers = {"Content-Type": VIDEO_TYPE}
        if start:
            headers["Content-Range"] = f"bytes {start}-{size - 1}/{size}"
        try:
            _, _, body = _call("PUT", session, token=token, data=data[start:], headers=headers,
                               timeout=UPLOAD_TIMEOUT)
            return json.loads(body or b"{}")
        except (YouTubeError, OSError) as e:        # URLError and timeouts are OSErrors
            if (isinstance(e, YouTubeError) and not e.retryable) or attempt == tries:
                raise
            print(f"[youtube] upload interrupted ({type(e).__name__}: {e}); resuming, try {attempt + 1} of {tries}")
            sleep(2 ** attempt)
            try:
                done, start = _resume_point(session, token, size)
                if done is not None:
                    return done
            except (YouTubeError, OSError):
                pass        # no answer about the offset: the next try sends from where it was
    raise YouTubeError("the upload did not finish")    # not reached: the last try returns or raises


def publish_short(token: str, video_path: str, post: dict, sleep=time.sleep) -> dict:
    """Upload the Reel as a Short; the video resource YouTube made (id, status...)."""
    with open(video_path, "rb") as f:
        data = f.read()
    session = start_session(token, metadata(post), len(data))
    return send_file(session, token, data, sleep=sleep)


# ---- the run ---------------------------------------------------------------------------------------

def advice(error: str) -> str:
    """What to do about Google's answer."""
    e = error.lower()
    if "invalid_grant" in e:
        return ("the refresh token was revoked or has expired (an app left in Testing gets 7-day tokens): "
                "check the OAuth app is In production, run growth/youtube_auth.py again and replace "
                "the YOUTUBE_REFRESH_TOKEN secret (growth/README.md, YouTube)")
    if "invalid_client" in e or "unauthorized_client" in e:
        return "YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET is wrong: copy them again from the Desktop app client"
    if "quotaexceeded" in e or "uploadlimitexceeded" in e:
        return "the day's upload quota or the channel's upload limit is used up; the next Thursday will try again"
    if "youtubesignuprequired" in e:
        return "the account the refresh token belongs to has no YouTube channel: sign in as the InternScout channel in growth/youtube_auth.py"
    if "insufficient" in e or "forbidden" in e or "accessnotconfigured" in e:
        return ("the token can't upload: check the YouTube Data API v3 is enabled in the Google Cloud project "
                "and that growth/youtube_auth.py was run with its scopes (growth/README.md, YouTube)")
    return "see Google's message above (growth/README.md, YouTube)"


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    path = args[0] if args else os.path.join("out", "post.json")
    if not os.path.exists(path):
        print(f"[youtube] no {path}: nothing was picked this run, so no Short")
        return 0
    with open(path, encoding="utf-8") as f:
        post = json.load(f)
    reel = os.path.join(os.path.dirname(os.path.abspath(path)), "reel.mp4")
    if not post.get("reel"):
        print("[youtube] not a Reel day (post.json has no reel); no Short")
        return 0
    if not os.path.exists(reel):
        print("[youtube] post.json asks for a Reel but reel.mp4 wasn't made (see the Post step); no Short")
        return 0
    meta = metadata(post)
    print(meta["snippet"]["title"])
    print(meta["snippet"]["description"])
    print(f"[youtube] video: {reel} ({os.path.getsize(reel) // 1024} KB)")
    if "--send" not in argv:
        return 0
    missing = [k for k in SECRETS if not os.environ.get(k)]
    if missing:
        print(f"[youtube] no {', '.join(missing)}; nothing uploaded (growth/README.md, YouTube)")
        return 0
    try:
        token = access_token(*(os.environ[k] for k in SECRETS))
        try:
            done = already_posted(token, meta["snippet"]["title"])
        except (YouTubeError, OSError, KeyError, ValueError) as e:
            # The check is a courtesy; a token that can't read the channel may still upload.
            print(f"[youtube] couldn't check the channel's recent uploads ({type(e).__name__}: {e}); uploading")
            done = None
        if done:
            print(f"[youtube] today's Short is already up (https://youtube.com/shorts/{done}); not uploading again")
            return 0
        video = publish_short(token, reel, post)
        vid = video.get("id") or "?"
        print(f"[youtube] Short uploaded: https://youtube.com/shorts/{vid}")
        privacy = (video.get("status") or {}).get("privacyStatus")
        if privacy and privacy != "public":
            print(f"[youtube] YouTube made it {privacy}, not public. Uploads from an API project that hasn't "
                  "passed YouTube's compliance audit are locked private (growth/README.md, YouTube)")
        return 0
    except (YouTubeError, OSError, KeyError, ValueError) as e:
        # Google's message only: never a token, a header or the session URI.
        print(f"[youtube] failed: {type(e).__name__}: {e}")
        print(f"[youtube] {advice(str(e))}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
