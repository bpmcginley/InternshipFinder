"""Short posts for InternScout's own social accounts, written from the week's data.

Each run picks one field that gained listings in the Northeast or remote this week (a different one
each run), writes a post naming a few of the employers and linking to that field's landing page, and
sends it to whichever brand accounts have credentials in the environment:

  * Bluesky    BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not the account password)
  * Mastodon   MASTODON_URL (the instance, e.g. https://mastodon.social) and MASTODON_TOKEN
  * Discord    DISCORD_WEBHOOK_URL (a channel in InternScout's own server)

With none set it only prints the post, and the weekly growth report carries it as a draft.

With --out=DIR it also writes what the picture channels need, from the same pick: DIR/post.json (the
card's numbers, an Instagram caption and a LinkedIn draft) and DIR/card.jpg (growth/cards.py). The
Brand posts workflow then puts the card where Instagram can fetch it and runs growth/instagram.py.
LinkedIn has no posting API open to a page this size, so its text is saved as a draft for a person
to post (save_drafts), and the private analytics page shows it ready to copy.

It posts nothing when the data export is more than STALE old: "this week" and the field it picks both
come from the export's time, so a stalled ingest would post the same stale text run after run. When a
configured account fails, the others are still tried, and then the run exits 1 so the Actions run
shows red (a revoked app password used to leave it green). A failure prints only the exception's
type, never a URL or token. The Brand posts workflow is skipped altogether while the repository
variable SOCIAL_ENABLED is 0.

These are posts by InternScout, on InternScout's accounts, saying what the data says. Nothing here
posts as a person, replies to anyone or posts into other people's spaces.

Run from the repo root:  python growth/social.py [docs] [--out=DIR] [--send]
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


# Where growth/cards.py's JPEGs are served from: a branch of their own, so a card every few days never
# lands in main's history, and raw.githubusercontent.com serves each one as image/jpeg as soon as it
# is pushed (Instagram fetches a post's image from a public URL; it takes no upload).
CARD_BRANCH = "social-cards"
CARD_BASE = f"https://raw.githubusercontent.com/bpmcginley/InternshipFinder/{CARD_BRANCH}/"
IG_CAPTION_MAX = 2200     # Instagram's caption limit, in characters
LINKEDIN_MAX = 3000       # a LinkedIn post's limit
# Thursdays post a Reel instead of the picture card (growth/reels.py, added 2026-10-01); Tuesdays stay a
# card, so the two can be compared. Monday is 0.
REEL_WEEKDAY = 3
REELS_FROM = "2026-10-08"   # the first Reel Thursday: 2026-10-01 stays a card, the first post since Meta's block
SLOGAN = "Built by one student, made for all students."
DISCLAIMER = "Not affiliated with UMass Amherst."


def hashtag(field_title: str) -> str:
    """A field's name as one hashtag from its first two words: 'Data science and analytics' -> #DataScience."""
    words = [w for w in "".join(c if c.isalnum() else " " for c in field_title).split()
             if w.lower() not in ("and", "of", "the", "or")]
    return "#" + "".join(w[:1].upper() + w[1:] for w in words[:2]) if words else ""


def card_data(site_dir: str, today: datetime | None = None) -> dict | None:
    """Everything the picture channels need for this run's pick, or None when there is nothing to post.
    The same field, count and employers as the text post, so every channel says the same thing."""
    ranked, now, open_by_field = candidates(site_dir)
    chosen = pick(ranked, now)
    if not chosen:
        return None
    field, items = chosen
    text, url = compose(field, items, open_by_field[field])
    title = sp.field_title(field)
    name = sp.lower_name(title)
    employers = [c for c, _ in Counter(x.get("company_name") or "" for x in items).most_common(6) if c]
    today = today or datetime.now(timezone.utc)
    slug = sp.field_slug(field)
    tags = " ".join(t for t in (hashtag(title), "#internships", "#summerinternship", "#collegestudents",
                                "#studentjobs", "#careers") if t)
    named = ", ".join(employers[:4])
    # Instagram doesn't make a caption's address a link, so it points at the one in the profile.
    ig = (f"{len(items)} new {name} internships in the Northeast and remote this week"
          + (f", from {named} and more" if named else "") + ".\n\n"
          "Search every one free at internscout.org (link in bio), filtered to your major and the states you pick.\n\n"
          f"{SLOGAN} {DISCLAIMER}\n\n{tags}")
    li = (f"{len(items)} new {name} internships opened in the Northeast and remote this week."
          + (f"\n\nEmployers hiring include {named}." if named else "") + "\n\n"
          "InternScout lists internships, co-ops and research programs for every major, refreshed several "
          "times a day. Searching is free and needs no account.\n\n"
          f"{url}\n\n{SLOGAN} {DISCLAIMER}\n\n{tags}")
    card_name = f"{today:%Y-%m-%d}-{slug}.jpg"
    # The Reel's role slides: one role per employer first, so four slides show four employers.
    roles, seen = [], set()
    for x in items:
        if len(roles) == 4:
            break
        co = x.get("company_name") or ""
        if co and co not in seen and x.get("title"):
            seen.add(co)
            roles.append({"company": co, "title": x["title"], "place": sp.place(x), "pay": sp.pay_text(x)})
    return {
        "field": field, "slug": slug, "url": url, "text": text, "count": len(items),
        "eyebrow": f"New this week · {now:%b} {now.day}",
        "headline": f"new {name} internships",
        "where": "in the Northeast and remote",
        "employers": employers[:5],
        "card_name": card_name,
        "card_url": CARD_BASE + card_name,
        "instagram_caption": ig[:IG_CAPTION_MAX],
        "linkedin_text": li[:LINKEDIN_MAX],
        "roles": roles,
        # The same tags as the captions, for channels that build their own text from post.json
        # (growth/youtube.py's Short description, added 2026-10-02), so every channel tags alike.
        "hashtags": tags.split(),
        "reel":today.weekday() == REEL_WEEKDAY and f"{today:%Y-%m-%d}" >= REELS_FROM,
    }


def write_out(site_dir: str, out_dir: str) -> dict | None:
    """post.json and card.jpg into out_dir, for the workflow's picture steps."""
    data = card_data(site_dir)
    if not data:
        return None
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "post.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    import cards      # imported here: only the card needs Pillow, the text posts don't
    cards.render(data, os.path.join(out_dir, "card.jpg"))
    # On a Reel day the video goes beside the card. The card is still made: LinkedIn's draft carries
    # it, and Instagram falls back to it if the video can't be made or published.
    if data.get("reel"):
        try:
            import reels
            reels.render(data, os.path.join(out_dir, "reel.mp4"))
        except Exception as e:      # a missing ffmpeg or font must not stop the text posts
            print(f"[social] no reel this time ({type(e).__name__}: {e}); Instagram gets the card")
    return data


def save_drafts(data: dict, token: str) -> None:
    """The LinkedIn draft, into the app's D1 (table social_drafts), where the private analytics page
    shows it ready to copy. Brand text only, like everything else growth/ writes there."""
    import metrics    # the same D1 helper and database the analytics copy uses
    metrics.d1(token, "CREATE TABLE IF NOT EXISTS social_drafts (taken TEXT NOT NULL, channel TEXT NOT NULL, "
                      "text TEXT NOT NULL, image_url TEXT, url TEXT, PRIMARY KEY (taken, channel))")
    taken = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    metrics.d1(token, "INSERT OR REPLACE INTO social_drafts (taken, channel, text, image_url, url) VALUES (?, ?, ?, ?, ?)",
               [taken, "linkedin", data["linkedin_text"], data["card_url"], data["url"]])
    # A draft is only worth posting for a week or two; keep the last 20.
    metrics.d1(token, "DELETE FROM social_drafts WHERE taken NOT IN "
                      "(SELECT taken FROM social_drafts ORDER BY taken DESC LIMIT 20)")


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
    out_dir = next((a.split("=", 1)[1] for a in argv if a.startswith("--out=")), None)
    data, failed = None, []
    if out_dir:
        # A card that can't be drawn (no Pillow, no font) must not stop the text posts below.
        try:
            data = write_out(site_dir, out_dir)
            if data:
                print(f"[social] card and captions written to {out_dir}")
        except Exception as e:
            print(f"[social] card failed: {type(e).__name__}: {e}")
            failed.append("card")
            for leftover in ("card.jpg", "post.json"):     # half a card must not reach Instagram
                try:
                    os.remove(os.path.join(out_dir, leftover))
                except OSError:
                    pass
    if "--send" not in argv:
        return 1 if failed else 0
    if data and os.environ.get("CLOUDFLARE_API_TOKEN"):
        try:
            save_drafts(data, os.environ["CLOUDFLARE_API_TOKEN"])
            print("[social] LinkedIn draft saved for the analytics page")
        except Exception as e:
            print(f"[social] LinkedIn draft failed: {type(e).__name__}")
            failed.append("LinkedIn draft")
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
