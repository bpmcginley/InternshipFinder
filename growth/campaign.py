"""The weekly campaign pack (added 2026-10-25): the week's images, video and captions for the channels a
person posts to by hand or through a scheduler (Heycatch, Zeely), written from the data and checked
before anyone sees it. It posts nothing.

Why it exists. Heycatch's analytics for Sep 26 to Oct 25 (46 posts, 7.4K views): the posts people
watched were practical slideshows ("how to stop losing hours to internship forms", 911 views, 4.3%
engagement; "signs your internship search is finally finding non-tech roles", 892, 5.2%) and one
relatable Short (1.4K). The count cards ("21 new marketing internships...") drew 1 or 2 views each, and
a hype video ("Unlock Your Dream Internship! 🚀✨") drew 0 engagement on Instagram. So each week this
writes the two kinds that worked, both showing what InternScout does for a student:

  * search  "A real search": one field in one place, the numbers a student would see if they searched
            it this week (open roles, new this week, who is hiring, listed pay, roles that say they
            take first-years and sophomores), ending on the dashboard link that opens that search.
            A different field every week (search_pick).
  * tip     A practical tip from TIPS, written by a person and rotated week by week, whose last step is
            the InternScout page or filter that does it. Nothing in a tip is generated.

Each comes as a 4:5 carousel (Instagram, Facebook), a 9:16 slideshow (TikTok photo mode) and, when
ffmpeg is installed, a 9:16 video of the same slides (YouTube Shorts, Reels, TikTok). captions.json has
each channel's caption, its link tagged utm_source=<channel>&utm_campaign=weekly-<year>w<week> and
utm_content=<piece> (the
Worker's UTM_SOCIAL spellings), and README.md the schedule and the checks before posting.

The AI rules (Bruce, 2026-10-25: "subtle AI usage to not appear as slop"). Every number comes from the
export; every sentence is a template filled with those numbers or a hand-written tip. No stock footage,
no avatar, no invented student, quote or outcome, no hype words or emoji: lint() refuses any of BANNED in
a slide or caption, and the pack is not written when one is found. A scheduler's AI may cut, caption
or set music to these files; it must not change what they say.

Run from the repo root:  python growth/campaign.py [docs] [--out=DIR]
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.path.insert(0, HERE)
from internscout import seo_pages as sp  # noqa: E402

SITE = sp.SITE
SIZES = {"feed": (1080, 1350), "tall": (1080, 1920)}
# Clear of the app's own buttons and caption: Reels and TikTok draw over the top 220 and bottom 420
# pixels of a tall frame (growth/reels.py); a feed carousel only needs a margin.
SAFE = {"feed": (96, 110), "tall": (220, 420)}
MARGIN = 96
SLIDE_SECONDS = 2.6           # the video holds each slide this long; the first and last a little longer
MIN_SEARCH = 15               # open roles a field needs in a place before a week's search can show it
# The places a search is shown for: where InternScout's students are (the Northeast) and remote.
SEARCH_PLACES = ["Boston", "MA", "New York City", "NY", "NJ", "CT", "RI", "Philadelphia", "remote"]
CHANNELS = ("tiktok", "instagram", "facebook", "youtube", "x")

# Words and marks that read as machine-made or as an ad: a slide or caption with any of these is
# refused (lint). Checked as whole words, case-insensitive. Emoji are refused separately.
BANNED = ["unlock", "dream internship", "game-changer", "game changer", "supercharge", "elevate",
          "seamless", "seamlessly", "effortless", "effortlessly", "revolutionize", "revolutionary",
          "unleash", "skyrocket", "level up", "next level", "delve", "journey", "landscape", "embark",
          "in today's", "look no further", "say goodbye", "hack", "secret", "guaranteed", "land your",
          "dream job", "ultimate", "must-have", "magic", "🚀"]
_EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF]")

# Hand-written tips (2026-10-25). Each is a hook, three steps and the InternScout step, and every claim
# about the site is true on that day: the pages exist (checked live) and the extension "fills out
# applications and stops at the submit button" (install.html). Edit freely; lint still applies.
TIPS = [
    {"slug": "check-a-posting", "path": "/internships/",
     "slides": [("Before you apply", "3 things to check on any internship posting"),
                ("1", "When it was posted. A role up for months may already be filled."),
                ("2", "The start term. Summer 2027 and Fall 2026 can look the same at a glance."),
                ("3", "Who it is for. Many say junior or senior only, halfway down the page."),
                ("On InternScout", "Every listing shows its start term, the class years it takes when the posting "
                                   "says, and a link to the employer's own posting.")]},
    {"slug": "first-years", "path": "/internships/for-freshmen/",
     "slides": [("First-year or sophomore?", "Most internship lists aren't written for you. Some roles are."),
                ("1", "Search for postings that name your class year, not ones that leave it out."),
                ("2", "Look at research programs and co-ops too. Some take first and second years."),
                ("3", "Note each deadline when you find it. Many close months before summer."),
                ("On InternScout", "Two pages list only roles whose posting says it takes first-years or "
                                   "sophomores.")]},
    {"slug": "co-ops", "path": "/internships/co-op/",
     "slides": [("Co-ops", "A co-op is a paid, full-time term of work, usually 3 to 6 months."),
                ("1", "They are not only for schools with a co-op program. Many employers take anyone."),
                ("2", "They run in fall and spring too, when fewer students are applying."),
                ("3", "Check the dates against your semester before you apply."),
                ("On InternScout", "One page lists every open co-op we track, by field and place.")]},
    {"slug": "research", "path": "/internships/research/",
     "slides": [("Research counts", "A summer in a lab is an internship too."),
                ("1", "REUs are paid summer research programs for undergraduates, funded by the NSF."),
                ("2", "Most want a short statement and a faculty reference, not a long resume."),
                ("3", "Deadlines are often January to March, earlier than you would think."),
                ("On InternScout", "Research programs are listed alongside internships, with their own page.")]},
    {"slug": "paid-only", "path": "/internships/paid/",
     "slides": [("Pay", "You can filter to roles that say what they pay."),
                ("1", "A posting with no pay listed is not always unpaid. Ask before you rule it out."),
                ("2", "Hourly and yearly figures are hard to compare. Divide yearly pay by 2,080."),
                ("3", "Some states require pay ranges in postings: New York, New Jersey, Massachusetts and more."),
                ("On InternScout", "The paid page lists roles whose posting states pay, with the figure shown.")]},
    {"slug": "summer-tracker", "path": "/internships/summer-2027/open/",
     "slides": [("Summer 2027", "Summer internships open months before summer."),
                ("1", "Large employers in finance, tech and consulting open in August to October."),
                ("2", "Many others open from January to March. Both are normal."),
                ("3", "Checking once a week beats checking every day and burning out."),
                ("On InternScout", "The summer tracker lists every employer that has opened Summer 2027 roles, "
                                   "newest first.")]},
    {"slug": "every-major", "path": "/internships/",
     "slides": [("Not in tech?", "Your major has internships. They are just spread across more sites."),
                ("1", "Nursing, government, arts, education and law post on different boards than tech."),
                ("2", "Search by your major's field, not by the job titles you have seen online."),
                ("3", "Add the places you would actually live, and remote."),
                ("On InternScout", "One free search across 66 fields, with no account needed.")]},
    {"slug": "forms", "path": "/install.html",
     "slides": [("Application forms", "How to stop typing the same answers into every form"),
                ("1", "Keep one document with your answers: work history, coursework, links."),
                ("2", "Tailor the two or three questions that matter. Copy the rest."),
                ("3", "Read every field before you submit, even the ones you filled in fast."),
                ("On InternScout", "The free Auto-Apply extension fills out the form from your profile and "
                                   "stops at the submit button, so you check it first.")]},
    {"slug": "weekly-email", "path": "/digest/",
     "slides": [("Less checking", "You don't need to check job boards every day."),
                ("1", "Most roles stay open for weeks. A weekly look catches nearly all of them."),
                ("2", "Pick one day, and give it 30 minutes."),
                ("3", "Apply to the best few, not to everything."),
                ("On InternScout", "A free email every Monday with the week's new roles in your fields.")]},
]


def lint(text: str) -> list[str]:
    """What in text breaks the rules: a BANNED word or phrase, or an emoji. Empty when it's clean."""
    low = text.lower()
    found = [w for w in BANNED if re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", low)]
    return found + (["emoji"] if _EMOJI.search(text) else [])


def week_tag(now: datetime) -> str:
    year, week, _ = now.isocalendar()
    return f"{year}w{week:02d}"


def tagged(path: str, channel: str, campaign: str, content: str = "post") -> str:
    """SITE+path with the channel's utm tags, keeping a query the path already has."""
    sep = "&" if "?" in path else "?"
    return (f"{SITE}{path}{sep}utm_source={channel}&utm_medium=social&utm_campaign={campaign}"
            f"&utm_content={content}")


def place_words(k: str) -> str:
    return "remote (US)" if k == "remote" else sp.in_place(k).removeprefix("in ")


def search_pick(listings: list[dict], now: datetime) -> dict | None:
    """This week's search: one field in one of SEARCH_PLACES with MIN_SEARCH open roles or more. Each
    field's best place, then a different field each ISO week, so the feed covers every major in turn."""
    count: Counter = Counter()
    for x in listings:
        for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS:
            for k in x["keys"] & set(SEARCH_PLACES):
                count[(t, k)] += 1
    best: dict[str, tuple[str, int]] = {}
    for (t, k), n in sorted(count.items(), key=lambda kv: (-kv[1], SEARCH_PLACES.index(kv[0][1]), kv[0][0])):
        if n >= MIN_SEARCH and t not in best:
            best[t] = (k, n)
    if not best:
        return None
    fields = sorted(best)
    t = fields[now.isocalendar()[1] % len(fields)]
    k = best[t][0]
    items = [x for x in listings if t in (x.get("field_tags") or []) and k in x["keys"]]
    return {"field": t, "place": k, "items": items}


def search_slides(pick: dict, now: datetime, baseline: str | None) -> list[tuple[str, str]]:
    """(kicker, text) slides for a search pick. Each says only what the listings show."""
    items, t, k = pick["items"], pick["field"], pick["place"]
    name = sp.lower_name(sp.field_title(t))
    where = place_words(k)
    new = [x for x in items if sp.fresh(x, now, baseline)]
    out = [("A real search, this week", f"{sp.field_title(t)} internships {('that are ' if k == 'remote' else 'in ')}{where}"),
           ("Open right now", "open roles" + (f", {len(new)} of them found in the last 7 days." if new else "."), f"{len(items)}")]
    employers = [c for c, _ in Counter(x.get("company_name") or "" for x in items).most_common(5) if c]
    if employers:
        out.append(("Who is hiring", ", ".join(employers[:4]) + (" and more." if len(employers) > 4 else ".")))
    pay = sp.hourly_range(items)
    if pay:
        lo, hi, n = pay
        out.append(("Listed pay", f"an hour, on the {n} of {len(items)} postings that state an hourly rate.",
                    sp.money(lo) if lo == hi else f"{sp.money(lo)}-{sp.money(hi)}"))
    early = [x for x in items if {"first_year", "sophomore"} & set(x.get("years") or [])]
    if early:
        out.append(("First-years and sophomores", "of them say they take first-years or sophomores.", f"{len(early)}"))
    out.append(("Search it yourself", f"Free, no account: internscout.org, filtered to {name} {('roles that are ' if k == 'remote' else 'in ')}{where}."))
    return out


def tip_pick(now: datetime) -> dict:
    return TIPS[now.isocalendar()[1] % len(TIPS)]


def search_path(pick: dict) -> str:
    """The dashboard opened on this search (docs/js/app.js reads ?field= and ?state=)."""
    k = pick["place"]
    return f"/?field={quote(pick['field'])}&state={quote(sp._dash_state(k), safe=',')}"


def captions(slides: list[tuple[str, str]], path: str, campaign: str, content: str = "post") -> dict[str, str]:
    """Each channel's caption: the slides' words as plain sentences, the link tagged for that channel."""
    words = [said(slide) for slide in slides]
    head, body, last = words[0], " ".join(words[1:-1]), words[-1]
    tags = "#internships #collegestudents #summerinternship"
    return {
        "tiktok": f"{head}. {body} {last}\n\n{tags}",
        # Instagram doesn't link an address in a caption; the profile's link carries utm_source=instagram.
        "instagram": f"{head}.\n\n{body}\n\n{last} Link in bio.\n\n{tags}",
        "facebook": f"{head}.\n\n{body}\n\n{tagged(path, 'facebook', campaign, content)}",
        "youtube_title": clip(f"{head}", 95),
        "youtube": f"{body} {last}\n\n{tagged(path, 'youtube', campaign, content)}\n\n{tags}",
        "x": clip(f"{head}. {body}", 280 - 25) + f" {tagged(path, 'x', campaign, content)}",
    }


def said(slide: tuple) -> str:
    """A slide as one sentence: its big number, when it has one, read before its words."""
    _, text, big = (tuple(slide) + ("",))[:3]
    return f"{big} {text}" if big else text


def clip(text: str, n: int) -> str:
    """text cut at a word boundary to n characters, with an ellipsis when cut."""
    if len(text) <= n:
        return text
    cut = text[:n]
    end = cut.rfind(". ")
    return cut[:end + 1] if end > n // 2 else cut[: n - 1].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


def draw(slide: tuple, size: str, i: int, n: int):
    """One slide, (kicker, text) or (kicker, text, big): the name and page count at the top, the kicker,
    the big number when there is one, the words, the address at the foot. On a tall slide the words sit
    in the middle of the safe zone. The first and last slides are on the green ground, the rest on
    paper, as the site and card are."""
    from PIL import Image, ImageDraw
    from cards import ACCENT, INK, INK2, PAPER, SOFT, font, wrap
    kicker, text, big = (tuple(slide) + ("",))[:3]
    w, h = SIZES[size]
    top, bottom = SAFE[size]
    tall = size == "tall"
    dark = i in (1, n)
    img = Image.new("RGB", (w, h), ACCENT if dark else PAPER)
    d = ImageDraw.Draw(img)
    fg, sub, mark = (PAPER, SOFT, SOFT) if dark else (INK, INK2, ACCENT)
    inner = w - 2 * MARGIN
    d.text((MARGIN, top), "InternScout", font=font("serif", 46), fill=mark)
    count = f"{i}/{n}"
    small = font("sans", 32)
    d.text((w - MARGIN - d.textlength(count, font=small), top + 10), count, font=small, fill=sub)
    # What goes in the middle, as (font, text, colour, line height) rows, measured before it's drawn.
    rows = []
    numbered = kicker.isdigit()
    if numbered:
        rows.append((font("serif", 170), kicker, mark, 210))
    elif kicker:
        rows.append((font("sans_bold", 36), kicker.upper(), mark, 84))
    if big:
        rows.append((font("serif", 210 if tall else 180), big, mark, 250 if tall else 215))
    px = (96 if tall else 78) if i == 1 else (66 if tall else 56)
    tf = font("serif" if i == 1 else "sans", px)
    rows += [(tf, line, fg, int(px * 1.3)) for line in wrap(d, text, tf, inner, 9)]
    block = sum(r[3] for r in rows)
    zone_top, zone_bottom = top + 140, h - bottom - 120
    y = max(zone_top, zone_top + (zone_bottom - zone_top - block) // 2) if tall else top + 170
    for f, t, c, lh in rows:
        d.text((MARGIN - (6 if f.size >= 170 else 0), y), t, font=f, fill=c)
        y += lh
    d.text((MARGIN, h - bottom - 60), "internscout.org", font=font("sans_bold", 38), fill=mark)
    return img


def write_slides(slides: list[tuple[str, str]], out_dir: str, stem: str) -> dict[str, list[str]]:
    """Both sizes of every slide, as JPEGs: {"feed": [paths], "tall": [paths]}."""
    os.makedirs(out_dir, exist_ok=True)
    paths: dict[str, list[str]] = {}
    for size in SIZES:
        paths[size] = []
        for i, slide in enumerate(slides, 1):
            p = os.path.join(out_dir, f"{stem}-{size}-{i}.jpg")
            draw(slide, size, i, len(slides)).save(p, "JPEG", quality=90, optimize=True)
            paths[size].append(p)
    return paths


def write_video(frames: list[str], out_path: str) -> str | None:
    """The tall slides as an MP4 (growth/reels.py's crossfade and silent track), or None without ffmpeg.
    Music is left to the app it's posted from: only its own library is licensed for the account."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    import reels
    seconds = [SLIDE_SECONDS + (0.8 if i in (0, len(frames) - 1) else 0) for i in range(len(frames))]
    with tempfile.TemporaryDirectory() as tmp:
        pngs = []
        from PIL import Image
        for i, f in enumerate(frames):
            p = os.path.join(tmp, f"{i}.png")
            Image.open(f).save(p)
            pngs.append(p)
        r = subprocess.run(reels.ffmpeg_command(pngs, seconds, out_path, ffmpeg), capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out_path):
        print(f"[campaign] no video ({(r.stderr or '').strip()[-200:]})")
        return None
    return out_path


SCHEDULE = [
    ("Monday", "tip", "TikTok photo slideshow (tall), Instagram and Facebook carousel (feed)"),
    ("Wednesday", "search", "TikTok photo slideshow (tall), Instagram and Facebook carousel (feed)"),
    ("Thursday", "search", "the video: YouTube Short, Instagram and Facebook Reel"),
    ("Saturday", "tip", "the video: YouTube Short and TikTok"),
]


def readme(pack: dict) -> str:
    rows = "\n".join(f"| {day} | {kind} | {where} |" for day, kind, where in SCHEDULE)
    return f"""# InternScout campaign pack, week {pack['week']}

Written {pack['written']} from the listings exported {pack['export']}. Nothing here has been posted.

| Day | Piece | Where |
|---|---|---|
{rows}

- **search**: {pack['search']['title']} ({pack['search']['slides']} slides). Link: {pack['search']['path']}
- **tip**: {pack['tip']['title']} ({pack['tip']['slides']} slides). Link: {pack['tip']['path']}

Captions for each channel are in captions.json, each link tagged for its channel and this week.

## Before posting

1. Open the link and check the numbers still match the slides (the data changes several times a day).
2. One post per channel per day. Skip a day rather than post twice.
3. In Heycatch or Zeely, add the files as they are. Music from the app's own library is fine; an AI
   voiceover, avatar, stock footage, rewritten caption or "enhanced" text is not.
4. Reply to comments yourself, as the person who made InternScout.
"""


def build(site_dir: str, out_dir: str, now: datetime | None = None) -> dict | None:
    """Write the week's pack into out_dir and return its manifest; None when there's nothing to show or
    lint refused something (printed)."""
    d = sp.load(site_dir)
    export = sp._when(d["generated_at"]) or datetime.now(timezone.utc)
    now = now or datetime.now(timezone.utc)
    pick = search_pick(d["listings"], export)
    if not pick:
        print("[campaign] no field has enough open roles in a search place this week")
        return None
    campaign = f"weekly-{week_tag(now)}"
    search = search_slides(pick, export, d["baseline"])
    tip = tip_pick(now)
    pieces = {"search": (search, search_path(pick)), "tip": (tip["slides"], tip["path"])}
    caps = {kind: captions(slides, path, campaign, kind) for kind, (slides, path) in pieces.items()}
    problems = [(kind, where, found) for kind, (slides, _) in pieces.items()
                for where, text in [(f"slide {i}", " ".join(slide)) for i, slide in enumerate(slides, 1)]
                + list(caps[kind].items()) if (found := lint(text))]
    if problems:
        for kind, where, found in problems:
            print(f"[campaign] {kind} {where}: {', '.join(found)}")
        return None
    os.makedirs(out_dir, exist_ok=True)
    pack = {"week": week_tag(now), "written": f"{now:%Y-%m-%d}", "export": f"{export:%Y-%m-%d %H:%M} UTC",
            "campaign": campaign}
    for kind, (slides, path) in pieces.items():
        files = write_slides(slides, out_dir, kind)
        video = write_video(files["tall"], os.path.join(out_dir, f"{kind}.mp4"))
        pack[kind] = {"title": slides[0][1], "slides": len(slides), "path": path,
                      "feed": [os.path.basename(p) for p in files["feed"]],
                      "tall": [os.path.basename(p) for p in files["tall"]],
                      "video": os.path.basename(video) if video else None,
                      "captions": caps[kind]}
    with open(os.path.join(out_dir, "captions.json"), "w", encoding="utf-8") as f:
        json.dump({k: pack[k]["captions"] for k in pieces}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "pack.json"), "w", encoding="utf-8") as f:
        json.dump(pack, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme(pack))
    return pack


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--out=")]
    out = next((a.split("=", 1)[1] for a in argv[1:] if a.startswith("--out=")), "campaign")
    pack = build(args[0] if args else "docs", out)
    if not pack:
        return 1
    print(f"[campaign] {pack['week']}: search '{pack['search']['title']}', tip '{pack['tip']['title']}' -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
