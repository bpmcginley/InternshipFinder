"""Publish a brand post's card to InternScout's Instagram (@internscout), through Meta's official
Instagram API with Instagram Login (graph.instagram.com). No Facebook Page is involved.

Instagram takes no upload: it fetches the image from a public URL. growth/social.py --out=DIR writes
DIR/post.json and DIR/card.jpg, the Brand posts workflow pushes the card to the social-cards branch
(served by raw.githubusercontent.com), and this script then:

  1. waits until that URL answers with a JPEG,
  2. creates a media container with the image URL and the caption (POST /<IG user id>/media),
  3. waits until Instagram has fetched it (status_code FINISHED),
  4. publishes it (POST /<IG user id>/media_publish).

The token. Meta's long-lived tokens last 60 days, and refreshing one returns a new token string, so
a token kept only as a GitHub secret would stop working after two months with nobody touching it.
The owner generates one token (Meta's app dashboard) and stores it as INSTAGRAM_TOKEN. Every run,
this refreshes the working token once it is REFRESH_EVERY old and keeps the result in the app's D1
(table social_tokens), keyed to a hash of the secret it descends from. A new INSTAGRAM_TOKEN secret
(the owner generated a fresh one) has a different hash, so it takes over at once. Without
CLOUDFLARE_API_TOKEN nothing can be kept, and every run says so.

Thursdays (since 2026-10-01) it posts a Reel instead: post.json says "reel": true and DIR/reel.mp4 is
beside it (growth/reels.py). A video can't be fetched from raw.githubusercontent.com (it serves no
video type), so the Reel uses Meta's resumable upload: create a REELS container, send the file's bytes
to the upload URI it returns, wait for processing, publish. If any of that fails, the run posts the
picture card instead, so the day still gets its post.

Run from the repo root:
  python growth/instagram.py out/post.json          # print what would be posted
  python growth/instagram.py out/post.json --send   # refresh the token if due, then post
  python growth/instagram.py --send                 # refresh the token only (a week with no post)
Needs INSTAGRAM_TOKEN; CLOUDFLARE_API_TOKEN to keep refreshed tokens.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import metrics  # noqa: E402  (the D1 database, account and API helper the analytics copy uses)

GRAPH = "https://graph.instagram.com"
UA = {"User-Agent": "InternScout-brand-posts/1.0 (+https://internscout.org)"}
REFRESH_EVERY = timedelta(days=7)       # well inside the 60-day life, and a refresh needs a day-old token
IMAGE_WAIT = 120                        # seconds to wait for the pushed card to be served
CONTAINER_WAIT = 90                     # seconds to wait for Instagram to fetch it
REEL_WAIT = 300                         # seconds to wait for Instagram to process a Reel
# Where a Reel's bytes go when the container's answer has no `uri` (it normally does).
RUPLOAD = "https://rupload.facebook.com/ig-api-upload/v23.0"


class InstagramError(RuntimeError):
    """An error Meta answered with. Its text is Meta's message, which never carries the token."""


def _request(method: str, path: str, params: dict) -> dict:
    """A Graph API call. The token travels in the POST body, or the query string for a GET; it is
    never printed, and an error keeps only Meta's own message."""
    data = urllib.parse.urlencode(params).encode()
    url = f"{GRAPH}/{path}" + (f"?{data.decode()}" if method == "GET" else "")
    req = urllib.request.Request(url, data=None if method == "GET" else data, method=method, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", {})
            msg = f"{err.get('type', 'error')} {err.get('code', e.code)}: {err.get('message', '')}"
        except (ValueError, AttributeError):
            msg = f"HTTP {e.code}"
        raise InstagramError(msg) from None


# ---- the token -------------------------------------------------------------------------------------

def _d1_rows(cf_token: str, sql: str, params: list | None = None) -> list[dict]:
    r = metrics._json(f"https://api.cloudflare.com/client/v4/accounts/{metrics.ACCOUNT}/d1/database/"
                      f"{metrics.D1_DATABASE}/query", {"sql": sql, "params": params or []}, cf_token)
    if not r.get("success"):
        raise RuntimeError("D1: " + json.dumps(r.get("errors"))[:300])
    return (r.get("result") or [{}])[0].get("results") or []


def _seed(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def working_token(secret: str, cf_token: str | None) -> tuple[str, datetime | None]:
    """(the token to use, when it was last refreshed or None if unknown)."""
    if not cf_token:
        return secret, None
    _d1_rows(cf_token, "CREATE TABLE IF NOT EXISTS social_tokens (name TEXT PRIMARY KEY, token TEXT NOT NULL, "
                       "seed TEXT NOT NULL, refreshed TEXT NOT NULL, expires TEXT)")
    rows = _d1_rows(cf_token, "SELECT token, seed, refreshed FROM social_tokens WHERE name = 'instagram'")
    if rows and rows[0]["seed"] == _seed(secret):
        return rows[0]["token"], datetime.fromisoformat(rows[0]["refreshed"].replace("Z", "+00:00"))
    return secret, None     # no row yet, or the owner put a new token in the secret: start from it


def refresh(token: str, refreshed: datetime | None, now: datetime) -> tuple[str, int] | None:
    """(new token, seconds it lasts) when a refresh is due and Meta allows it, else None."""
    if refreshed is not None and now - refreshed < REFRESH_EVERY:
        return None
    try:
        r = _request("GET", "refresh_access_token", {"grant_type": "ig_refresh_token", "access_token": token})
    except InstagramError as e:
        if refreshed is None:
            # A token generated less than a day ago can't be refreshed yet; it is good as it is.
            print(f"[instagram] token not refreshed yet ({e}); using it as it is")
            return None
        raise
    return r["access_token"], int(r.get("expires_in") or 0)


def keep(cf_token: str, secret: str, token: str, lasts: int, now: datetime) -> None:
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    _d1_rows(cf_token, "INSERT OR REPLACE INTO social_tokens (name, token, seed, refreshed, expires) "
                       "VALUES ('instagram', ?, ?, ?, ?)",
             [token, _seed(secret), iso(now), iso(now + timedelta(seconds=lasts)) if lasts else None])


def token_for_run(secret: str, cf_token: str | None, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    token, refreshed = working_token(secret, cf_token)
    fresh = refresh(token, refreshed, now)
    if fresh:
        token, lasts = fresh
        if cf_token:
            keep(cf_token, secret, token, lasts, now)
            print(f"[instagram] token refreshed; good for {lasts // 86400} more days")
        else:
            print("[instagram] token refreshed but NOT kept: set CLOUDFLARE_API_TOKEN, or the "
                  "INSTAGRAM_TOKEN secret will stop working 60 days after it was made")
    return token


# ---- posting ---------------------------------------------------------------------------------------

def wait_for_image(url: str, timeout: int = IMAGE_WAIT, sleep=time.sleep) -> None:
    """Until url answers 200 with a JPEG. A card pushed seconds ago can take a moment to be served."""
    end = time.monotonic() + timeout
    while True:
        try:
            req = urllib.request.Request(url, method="HEAD", headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                if r.status == 200 and "jpeg" in (r.headers.get("Content-Type") or ""):
                    return
        except urllib.error.URLError:
            pass
        if time.monotonic() > end:
            raise InstagramError(f"the card is not being served at {url}")
        sleep(5)


def _ig_id(token: str) -> str:
    me = _request("GET", "me", {"fields": "user_id,username", "access_token": token})
    return me.get("user_id") or me.get("id")


def _wait(container: str, token: str, what: str, timeout: int, sleep, every: int) -> None:
    """Until Instagram has the container's media ready (status_code FINISHED)."""
    end = time.monotonic() + timeout
    while True:
        status = _request("GET", container, {"fields": "status_code", "access_token": token}).get("status_code")
        if status == "FINISHED":
            return
        if status in ("ERROR", "EXPIRED"):
            raise InstagramError(f"Instagram could not take the {what} (container {status})")
        if time.monotonic() > end:
            raise InstagramError(f"Instagram took too long to process the {what}")
        sleep(every)


def publish(token: str, image_url: str, caption: str, sleep=time.sleep, timeout: int = CONTAINER_WAIT) -> str:
    """The new post's media id."""
    ig_id = _ig_id(token)
    container = _request("POST", f"{ig_id}/media", {"image_url": image_url, "caption": caption,
                                                    "access_token": token})["id"]
    _wait(container, token, "image", timeout, sleep, 3)
    return _request("POST", f"{ig_id}/media_publish", {"creation_id": container, "access_token": token})["id"]


def _upload(uri: str, token: str, data: bytes) -> dict:
    """Send a Reel's bytes in one piece. The token goes in the Authorization header, never printed."""
    req = urllib.request.Request(uri, data=data, method="POST",
                                 headers={**UA, "Authorization": f"OAuth {token}", "offset": "0",
                                          "file_size": str(len(data)), "Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read())
            msg = (err.get("debug_info") or err.get("error") or {}).get("message") or f"HTTP {e.code}"
        except (ValueError, AttributeError):
            msg = f"HTTP {e.code}"
        raise InstagramError(f"the video upload failed: {msg}") from None


def publish_reel(token: str, video_path: str, caption: str, sleep=time.sleep, timeout: int = REEL_WAIT,
                 upload=None) -> str:
    """Post the video as a Reel (also shown on the profile grid); the new post's media id."""
    with open(video_path, "rb") as f:
        data = f.read()
    ig_id = _ig_id(token)
    # thumb_offset: the cover is the title slide, a second in, after its fade has settled.
    made = _request("POST", f"{ig_id}/media", {"media_type": "REELS", "upload_type": "resumable",
                                               "caption": caption, "share_to_feed": "true",
                                               "thumb_offset": "1000", "access_token": token})
    container = made["id"]
    (upload or _upload)(made.get("uri") or f"{RUPLOAD}/{container}", token, data)
    _wait(container, token, "video", timeout, sleep, 5)
    return _request("POST", f"{ig_id}/media_publish", {"creation_id": container, "access_token": token})["id"]


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    post = None
    if args and os.path.exists(args[0]):
        with open(args[0], encoding="utf-8") as f:
            post = json.load(f)
        print(post["instagram_caption"])
        print(f"[instagram] image: {post['card_url']}")
        reel = os.path.join(os.path.dirname(os.path.abspath(args[0])), "reel.mp4")
        post["reel_path"] = reel if post.get("reel") and os.path.exists(reel) else None
        if post["reel_path"]:
            print(f"[instagram] reel: {reel} ({os.path.getsize(reel) // 1024} KB)")
    if "--send" not in argv:
        return 0
    secret = os.environ.get("INSTAGRAM_TOKEN")
    if not secret:
        print("[instagram] no INSTAGRAM_TOKEN; nothing sent")
        return 0
    try:
        token = token_for_run(secret, os.environ.get("CLOUDFLARE_API_TOKEN"))
        if not post:
            print("[instagram] nothing to post this run; token checked")
            return 0
        if post.get("reel_path"):
            try:
                print(f"[instagram] reel posted: {publish_reel(token, post['reel_path'], post['instagram_caption'])}")
                return 0
            except (InstagramError, urllib.error.URLError, OSError) as e:
                # The day still gets its post: the card, the way every other day posts.
                print(f"[instagram] reel failed ({type(e).__name__}: {e}); posting the card instead")
        wait_for_image(post["card_url"])
        print(f"[instagram] posted: {publish(token, post['card_url'], post['instagram_caption'])}")
        return 0
    except (InstagramError, RuntimeError, KeyError, urllib.error.URLError) as e:
        # Meta's message, never the token or a URL carrying it.
        print(f"[instagram] failed: {type(e).__name__}: {e}")
        print(f"[instagram] {advice(str(e))}")
        return 1


def advice(error: str) -> str:
    """What to do about Meta's answer. Every Graph API error is an OAuthException, so the type alone
    says nothing (was: any OAuthException was reported as an expired token). Code 190 is the token;
    code 200 with "API access blocked" (every run since 2026-09-29) is Meta restricting the app, and
    a new token will not fix that."""
    if "API access blocked" in error:
        return ("Meta has blocked this app's API access; a new token will not help. Open the app at "
                "developers.facebook.com: check its Alerts, that it is Live (not Development), and that "
                "the Instagram account is still connected to it (growth/README.md, Instagram)")
    if " 190" in error or "expired" in error.lower() or ("invalid" in error.lower() and "token" in error.lower()):
        return ("the token is invalid or expired: generate a new one in Meta's app dashboard and replace "
                "the INSTAGRAM_TOKEN secret (growth/README.md, Instagram)")
    return "see Meta's message above (growth/README.md, Instagram)"


if __name__ == "__main__":
    sys.exit(main(sys.argv))
