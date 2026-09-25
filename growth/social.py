"""Short posts for InternScout's own social accounts, written from the week's data.

Each run picks one field that gained listings in the Northeast or remote this week (a different one
each run), writes a post naming a few of the employers and linking to that field's landing page, and
sends it to whichever brand accounts have credentials in the environment:

  * Bluesky    BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not the account password)
  * Mastodon   MASTODON_URL (the instance, e.g. https://mastodon.social) and MASTODON_TOKEN
  * Discord    DISCORD_WEBHOOK_URL (a channel in InternScout's own server)

With none set it only prints the post, and the weekly growth report carries it as a draft.

It posts nothing when the data export is more than STALE old: "this week" and the field it picks both
come from the export's time, so a stalled ingest would post the same stale text run after run. When a
configured account fails, the others are still tried, and then the run exits 1 so the Actions run
shows red (a revoked app password used to leave it green). A failure prints only the exception's
type, never a URL or token. The Brand posts workflow is skipped altogether while the repository
variable SOCIAL_ENABLED is 0.

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
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.path.insert(0, HERE)
from internscout import seo_pages as sp  # noqa: E402
import digest  # noqa: E402

LIMIT = 300          # Bluesky's limit, in characters; Mastodon's is 500 and Discord's 2,000
MIN_NEW = 5          # a field needs this many new nearby roles to be worth a post
STALE = timedelta(days=2)   # the ingest runs several times a day; an export older than this has stalled


fresh = sp.fresh      # found this week, and not an old posting a scan only just reached


def candidates(site_dir: str) -> tuple[list[tuple[str, list[dict]]], datetime, Counter]:
    """(fields ranked by new nearby roles, the export's time, open roles per field)."""
    d = sp.load(site_dir)
    now = sp._when(d["generated_at"]) or datetime.now(timezone.utc)
    by_field: dict[str, list[dict]] = {}
    # was: for x in d["listings"]: if x["keys"] & sp.HOME_STATES and fresh(x, now, d["baseline"]):
    # New roles are counted as the digest counts them (digest.new_roles: one row per role within each
    # employer), so a post and the week's email never give two numbers for the same thing.
    for x in digest.new_roles(d, now):
        if x["keys"] & sp.HOME_STATES:
            for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS:
                by_field.setdefault(t, []).append(x)
    ranked = sorted(((t, v) for t, v in by_field.items() if len(v) >= MIN_NEW), key=lambda tv: (-len(tv[1]), tv[0]))
    # Open roles per field, counted as seo_pages.build counts them, to know whether the field has a page.
    open_by_field = Counter(t for x in d["listings"] for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS)
    return ranked, now, open_by_field


def link(field: str, open_count: int) -> str:
    """The field's landing page when seo_pages.build makes one (digest.has_page: enough open roles, and
    a slug that isn't a state's), else the dashboard filtered to the field. A post's link can't be
    changed once it's out, so it must never point at a page that isn't there."""
    if digest.has_page(field, open_count):
        return f"{sp.SITE}/internships/{sp.field_slug(field)}/"
    return f"{sp.SITE}/?field={quote(field)}"


def compose(field: str, items: list[dict], open_count: int) -> tuple[str, str]:
    """(text, url). The text ends with the url, and fits in LIMIT."""
    # was: url = f"{sp.SITE}/internships/{sp.field_slug(field)}/", which 404s for a field with no page.
    url = link(field, open_count)
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
    ranked, now, open_by_field = candidates(site_dir)
    chosen = pick(ranked, now)
    return compose(chosen[0], chosen[1], open_by_field[chosen[0]]) if chosen else None


def stale(site_dir: str, now: datetime | None = None) -> str | None:
    """Why the export is too old to post from, or None. An export with no readable time counts as
    stale: candidates would fall back to the clock, and the post would claim a week it can't see."""
    with open(os.path.join(site_dir, "data", "listings", "index.json"), encoding="utf-8") as f:
        stamp = json.load(f).get("generated_at")
    made = sp._when(stamp)
    now = now or datetime.now(timezone.utc)
    if made is None:
        return "the data export has no generated_at time"
    if now - made > STALE:
        return f"the data export is from {made:%Y-%m-%d %H:%M} UTC, more than {STALE.days} days ago"
    return None


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    site_dir = args[0] if args else "docs"
    why = stale(site_dir)
    if why:
        # Nothing is wrong with posting itself, so the run stays green; the ingest's own run is what failed.
        print(f"[social] not posting: {why}. The ingest has probably stalled; a post now would repeat old news.")
        return 0
    post = draft(site_dir)
    if not post:
        print("[social] no field gained enough new nearby listings this week; nothing to post")
        return 0
    text, url = post
    print(text)
    if "--send" not in argv:
        return 0
    failed = []
    for name, needs, send in CHANNELS:
        if not all(os.environ.get(k) for k in needs):
            continue
        try:
            print(f"[social] {name}: {send(text, url)}")
        except Exception as e:          # one account failing must not stop the others
            # Only the type: an HTTPError's text can carry the webhook URL or the instance's answer.
            print(f"[social] {name} failed: {type(e).__name__}")
            failed.append(name)
    # was: return 0, whatever failed, so a revoked app password left the Actions run green for weeks.
    if failed:
        print(f"[social] {len(failed)} account(s) failed: {', '.join(failed)}. Check their secrets.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
