"""Short posts for InternScout's own social accounts, written from the week's data.

Each run picks one field that gained listings in the Northeast or remote this week (a different one
each run), writes a post naming a few of the employers and linking to that field's landing page, and
sends it to whichever brand accounts have credentials in the environment:

  * Bluesky    BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not the account password)
  * Mastodon   MASTODON_URL (the instance, e.g. https://mastodon.social) and MASTODON_TOKEN
  * Discord    DISCORD_WEBHOOK_URL (a channel in InternScout's own server)

With none set it only prints the post, and the weekly growth report carries it as a draft.

These are posts by InternScout, on InternScout's accounts, saying what the data says. Nothing here
posts as a person, replies to anyone or posts into other people's spaces.

Run from the repo root:  python growth/social.py [docs] [--send]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
from internscout import seo_pages as sp  # noqa: E402

LIMIT = 300          # Bluesky's limit, in characters; Mastodon's is 500 and Discord's 2,000
MIN_NEW = 5          # a field needs this many new nearby roles to be worth a post


fresh = sp.fresh      # found this week, and not an old posting a scan only just reached


def candidates(site_dir: str) -> tuple[list[tuple[str, list[dict]]], datetime]:
    d = sp.load(site_dir)
    now = sp._when(d["generated_at"]) or datetime.now(timezone.utc)
    by_field: dict[str, list[dict]] = {}
    for x in d["listings"]:
        if x["keys"] & sp.HOME_STATES and fresh(x, now, d["baseline"]):
            for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS:
                by_field.setdefault(t, []).append(x)
    ranked = sorted(((t, v) for t, v in by_field.items() if len(v) >= MIN_NEW), key=lambda tv: (-len(tv[1]), tv[0]))
    return ranked, now


def compose(field: str, items: list[dict]) -> tuple[str, str]:
    """(text, url). The text ends with the url, and fits in LIMIT."""
    url = f"{sp.SITE}/internships/{sp.field_slug(field)}/"
    name = sp.lower_name(sp.field_title(field))
    head = f"{len(items)} new {name} internships in the Northeast and remote this week"
    employers = [c for c, _ in Counter(x.get("company_name") or "" for x in items).most_common(6) if c]
    for n in range(min(4, len(employers)), -1, -1):
        body = head + (f", from {', '.join(employers[:n])} and more" if n else "") + f".\n\n{url}"
        if len(body) <= LIMIT:
            return body, url
    return f"{head}.\n\n{url}", url


def pick(ranked: list[tuple[str, list[dict]]], now: datetime) -> tuple[str, list[dict]] | None:
    """Rotate through the top fields run by run (runs are days apart), so the feed is not one field."""
    top = ranked[:6]
    return top[now.timetuple().tm_yday % len(top)] if top else None


def _post_json(url: str, body: dict, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          # Cloudflare-fronted APIs (Discord among them) refuse Python's default agent.
                                          "User-Agent": "InternScout-brand-posts/1.0 (+https://internscout.org)",
                                          **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def to_bluesky(text: str, url: str) -> str:
    handle, password = os.environ["BLUESKY_HANDLE"], os.environ["BLUESKY_APP_PASSWORD"]
    s = _post_json("https://bsky.social/xrpc/com.atproto.server.createSession",
                   {"identifier": handle, "password": password})
    raw = text.encode("utf-8")
    start = raw.index(url.encode("utf-8"))
    record = {"$type": "app.bsky.feed.post", "text": text,
              "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "langs": ["en"],
              # Without a facet the address shows as plain text: Bluesky links only what it is told to.
              "facets": [{"index": {"byteStart": start, "byteEnd": start + len(url.encode("utf-8"))},
                          "features": [{"$type": "app.bsky.richtext.facet#link", "uri": url}]}]}
    r = _post_json("https://bsky.social/xrpc/com.atproto.repo.createRecord",
                   {"repo": s["did"], "collection": "app.bsky.feed.post", "record": record},
                   {"Authorization": f"Bearer {s['accessJwt']}"})
    return r.get("uri", "sent")


def to_mastodon(text: str) -> str:
    base = os.environ["MASTODON_URL"].rstrip("/")
    r = _post_json(f"{base}/api/v1/statuses", {"status": text, "visibility": "public", "language": "en"},
                   {"Authorization": f"Bearer {os.environ['MASTODON_TOKEN']}"})
    return r.get("url", "sent")


def to_discord(text: str) -> str:
    _post_json(os.environ["DISCORD_WEBHOOK_URL"], {"content": text, "allowed_mentions": {"parse": []}})
    return "sent"


CHANNELS = [
    ("Bluesky", ("BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"), lambda t, u: to_bluesky(t, u)),
    ("Mastodon", ("MASTODON_URL", "MASTODON_TOKEN"), lambda t, u: to_mastodon(t)),
    ("Discord", ("DISCORD_WEBHOOK_URL",), lambda t, u: to_discord(t)),
]


def draft(site_dir: str) -> tuple[str, str] | None:
    ranked, now = candidates(site_dir)
    chosen = pick(ranked, now)
    return compose(*chosen) if chosen else None


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    post = draft(args[0] if args else "docs")
    if not post:
        print("[social] no field gained enough new nearby listings this week; nothing to post")
        return 0
    text, url = post
    print(text)
    if "--send" not in argv:
        return 0
    for name, needs, send in CHANNELS:
        if not all(os.environ.get(k) for k in needs):
            continue
        try:
            print(f"[social] {name}: {send(text, url)}")
        except Exception as e:          # one account failing must not stop the others
            print(f"[social] {name} failed: {type(e).__name__}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
