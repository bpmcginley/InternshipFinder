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

Thursdays it requests a Reel instead. The workflow puts the generated MP4 beside the JPEG on the
existing social-cards branch. A narrow public Worker route serves those videos as video/mp4, and
post.json's reel_url goes to Meta as video_url. This preserves the account's Instagram Login flow;
the former resumable request on graph.instagram.com failed with "video_url is required".
If the video cannot be generated, fetched or prepared before final publication, the card remains the
fallback. An uncertain final publish stops without any retry or fallback, because Meta may already
have posted it. A warning/error, step summary and optional JSON status distinguish these outcomes.

Run from the repo root:
  python growth/instagram.py out/post.json          # print what would be posted
  python growth/instagram.py out/post.json --send   # refresh the token if due, then post
  python growth/instagram.py --send                 # refresh the token only (a week with no post)
Needs INSTAGRAM_TOKEN; CLOUDFLARE_API_TOKEN to keep refreshed tokens.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
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


class InstagramError(RuntimeError):
    """An error Meta answered with. Its text is Meta's message, which never carries the token."""


class PublishOutcomeUnknown(RuntimeError):
    """The final publish may have succeeded. Never retry or publish a fallback automatically."""


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
    _wait_for_media(url, "image/jpeg", "card", timeout, sleep)


def wait_for_video(url: str, timeout: int = IMAGE_WAIT, sleep=time.sleep) -> None:
    """The hosted MP4 must be available before asking Meta to fetch it."""
    _public_video_url(url)
    _wait_for_media(url, "video/mp4", "video", timeout, sleep)


def _wait_for_media(url: str, media_type: str, what: str, timeout: int, sleep) -> None:
    end = time.monotonic() + timeout
    while True:
        try:
            req = urllib.request.Request(url, method="HEAD", headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                if r.status == 200 and (r.headers.get("Content-Type") or "").split(";", 1)[0] == media_type:
                    return
        except urllib.error.URLError:
            pass
        if time.monotonic() > end:
            raise InstagramError(f"the {what} is not being served with the expected content type")
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
    return _publish_container(token, ig_id, container)


def _publish_container(token: str, ig_id: str, container: str) -> str:
    """A lost final response is not proof of failure: Meta may already have published the post."""
    try:
        answer = _request("POST", f"{ig_id}/media_publish", {"creation_id": container, "access_token": token})
    except (InstagramError, urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        # Do not infer success/failure from a timeout, 5xx or an unreadable response. Conservatively
        # stop after any rejected final publish too; only pre-publication failures may use a card.
        raise PublishOutcomeUnknown("Instagram did not confirm the final publishing result") from None
    media_id = answer.get("id") if isinstance(answer, dict) else None
    if not isinstance(media_id, str) or not media_id.strip():
        raise PublishOutcomeUnknown("Instagram did not confirm the final publishing result")
    return media_id


def _public_video_url(video_url: str) -> None:
    url = urllib.parse.urlsplit(video_url)
    name = url.path.removeprefix("/social-video/")
    if (url.scheme != "https" or url.netloc != "internscout-api.bpmcginley.workers.dev" or
            not url.path.startswith("/social-video/") or len(name) > 120 or
            not re.fullmatch(r"\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.mp4", name) or
            url.query or url.fragment):
        raise InstagramError("the Reel needs InternScout's public brand video URL")


def publish_reel(token: str, video_url: str, caption: str, sleep=time.sleep, timeout: int = REEL_WAIT) -> str:
    """Post the video as a Reel (also shown on the profile grid); the new post's media id."""
    _public_video_url(video_url)
    ig_id = _ig_id(token)
    # thumb_offset: the cover is the title slide, a second in, after its fade has settled.
    made = _request("POST", f"{ig_id}/media", {"media_type": "REELS", "video_url": video_url,
                                               "caption": caption, "share_to_feed": "true",
                                               "thumb_offset": "1000", "access_token": token})
    container = made["id"]
    _wait(container, token, "video", timeout, sleep, 5)
    return _publish_container(token, ig_id, container)


def record_status(path: str | None, requested: str, outcome: str, reason: str | None = None) -> None:
    """Finite operational result only: no tokens, captions, provider errors or subscriber data."""
    status = {"channel": "instagram", "checked_at": datetime.now(timezone.utc).isoformat(),
              "requested": requested, "outcome": outcome}
    if reason:
        status["reason"] = reason
    if path:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(status, f, indent=2)
            f.write("\n")
    if outcome == "card_fallback":
        print("::warning title=Instagram Reel unavailable::Posted the picture card instead of the planned Reel. See the Instagram result artifact.")
    if outcome == "unknown":
        print("::error title=Instagram publishing outcome unknown::The final publish may have succeeded. No retry or fallback was attempted. Check the product profile and provider before any manual retry.")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"\n### Instagram publishing result\n\nRequested: {requested}. Result: **{outcome}**.\n")
            if reason:
                f.write(f"Reason: `{reason}`.\n")


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
    status_path = next((a.split("=", 1)[1] for a in argv if a.startswith("--status-file=")), None)
    requested = "reel" if post and post.get("reel") else "card" if post else "none"
    secret = os.environ.get("INSTAGRAM_TOKEN")
    if not secret:
        print("[instagram] no INSTAGRAM_TOKEN; nothing sent")
        record_status(status_path, requested, "not_configured")
        return 0
    try:
        token = token_for_run(secret, os.environ.get("CLOUDFLARE_API_TOKEN"))
        if not post:
            print("[instagram] nothing to post this run; token checked")
            record_status(status_path, requested, "no_post")
            return 0
        fallback_reason = "video_not_generated" if requested == "reel" else None
        if post.get("reel_path") and post.get("reel_url"):
            try:
                wait_for_video(post["reel_url"])
                media_id = publish_reel(token, post["reel_url"], post["instagram_caption"])
            except (InstagramError, urllib.error.URLError, OSError) as e:
                # Final publish uncertainty has its own exception and must bypass this fallback.
                print(f"[instagram] reel failed ({type(e).__name__}: {e}); posting the card instead")
                fallback_reason = "reel_publish_failed"
            else:
                print(f"[instagram] reel posted: {media_id}")
                # Reporting errors after confirmed publication must not trigger another post.
                record_status(status_path, requested, "published_reel")
                return 0
        elif post.get("reel_path"):
            fallback_reason = "missing_public_video_url"
        wait_for_image(post["card_url"])
        print(f"[instagram] posted: {publish(token, post['card_url'], post['instagram_caption'])}")
        record_status(status_path, requested, "card_fallback" if requested == "reel" else "published_card", fallback_reason)
        return 0
    except PublishOutcomeUnknown:
        record_status(status_path, requested, "unknown", "final_publish_unconfirmed")
        return 1
    except (InstagramError, RuntimeError, KeyError, urllib.error.URLError) as e:
        # Meta's message, never the token or a URL carrying it.
        print(f"[instagram] failed: {type(e).__name__}: {e}")
        print(f"[instagram] {advice(str(e))}")
        record_status(status_path, requested, "failed", "publishing_error")
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
