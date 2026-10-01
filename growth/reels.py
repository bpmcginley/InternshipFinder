"""The Thursday Reel: a short vertical video (1080x1920, about 15 seconds, no sound) from the same pick
growth/social.py makes for the week's post. Added 2026-10-01; Tuesdays stay a picture card, so the two
can be compared on the analytics page.

Slides, drawn like the card (growth/cards.py: same palette, IBM Plex, same slogan and disclaimer):
  1. the count and the field ("21 new accounting internships"), 3 seconds
  2. one slide per role, up to four: employer, title, place and pay, 2.2 seconds each
  3. where to find them: internscout.org, link in bio, 3 seconds
then stitched with short fades by ffmpeg into an H.264 MP4 with a silent audio track. No music: the
API can't add Instagram's library, and a track we don't hold the rights to can't go on the account.

Text stays inside Instagram's safe zone (clear of the top 220 and bottom 420 pixels, where the Reels
screen draws its own buttons and caption), and the first slide's middle reads as the 3:4 grid tile.

ffmpeg: the Brand posts workflow installs it. Without it render() raises, and the workflow falls back
to the picture post, so a Thursday is never skipped.

Run from the repo root to preview:  python growth/reels.py [docs] [out.mp4]
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cards import ACCENT, INK, INK2, PAPER, SOFT, fit, font, wrap  # noqa: E402

W, H = 1080, 1920
MARGIN = 96
SAFE_TOP, SAFE_BOTTOM = 220, H - 420
FPS = 30
FADE = 0.35                   # seconds of crossfade between slides
TITLE_SECONDS, ROLE_SECONDS, END_SECONDS = 3.0, 2.2, 3.0
MAX_ROLES = 4
SLOGAN = "Built by one student, made for all students."
DISCLAIMER = "Not affiliated with UMass Amherst."


def _band(d: ImageDraw.ImageDraw) -> None:
    """The green band at the top with the name, like the card's."""
    d.rectangle([0, 0, W, SAFE_TOP + 150], fill=ACCENT)
    d.text((MARGIN, SAFE_TOP + 28), "InternScout", font=font("serif", 76), fill=PAPER)


BAND_BOTTOM = SAFE_TOP + 150
INNER = W - 2 * MARGIN


def _slide(bg, body, band: bool = True) -> Image.Image:
    """A slide whose body is centred in the space it has: under the band (or the safe top) and above
    the safe bottom. body(draw, y) draws from y and returns where it ended; it runs once on a scratch
    image to measure, then for real at the offset that centres it."""
    top = BAND_BOTTOM if band else SAFE_TOP
    end = body(ImageDraw.Draw(Image.new("RGB", (W, H))), 0)
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    if band:
        _band(d)
    body(d, top + max(40, (SAFE_BOTTOM - top - end) // 2))
    return img


def title_slide(post: dict) -> Image.Image:
    def body(d, y):
        d.text((MARGIN + 4, y), post["eyebrow"].upper(), font=font("sans_bold", 38), fill=ACCENT)
        y += 70
        d.text((MARGIN - 10, y), str(post["count"]), font=font("serif", 380), fill=ACCENT)
        y += 450
        big = font("sans_bold", 80)
        for line in wrap(d, post["headline"], big, INNER, 3):
            d.text((MARGIN, y), line, font=big, fill=INK)
            y += 100
        d.text((MARGIN, y + 16), post["where"], font=font("sans", 50), fill=INK2)
        return y + 80
    return _slide(PAPER, body)


def role_slide(role: dict, i: int, n: int) -> Image.Image:
    def body(d, y):
        d.text((MARGIN + 4, y), f"HIRING NOW · {i} OF {n}", font=font("sans_bold", 38), fill=ACCENT)
        y += 100
        serif = font("serif", 112)
        for line in wrap(d, role["company"], serif, INNER, 2):
            d.text((MARGIN, y), line, font=serif, fill=ACCENT)
            y += 134
        y += 30
        title = font("sans_bold", 68)
        for line in wrap(d, role["title"], title, INNER, 4):
            d.text((MARGIN, y), line, font=title, fill=INK)
            y += 88
        y += 44
        d.line([MARGIN, y, W - MARGIN, y], fill=SOFT, width=5)
        y += 48
        detail = font("sans", 56)
        for text in (role.get("place"), role.get("pay")):
            if text:
                d.text((MARGIN, y), fit(d, text, detail, INNER), font=detail, fill=INK2)
                y += 80
        return y
    return _slide(PAPER, body)


def end_slide(post: dict) -> Image.Image:
    def body(d, y):
        head = font("sans_bold", 70)
        for line in wrap(d, f"Search all {post['count']} free, filtered to your major", head, INNER, 3):
            d.text((MARGIN, y), line, font=head, fill=PAPER)
            y += 92
        y += 70
        d.text((MARGIN, y), "internscout.org", font=font("serif", 106), fill=PAPER)
        y += 170
        d.text((MARGIN + 2, y), "Link in bio", font=font("sans", 56), fill=SOFT)
        y += 150
        d.line([MARGIN, y, W - MARGIN, y], fill=SOFT, width=4)
        y += 56
        for line in wrap(d, SLOGAN, font("sans", 48), INNER, 2):
            d.text((MARGIN, y), line, font=font("sans", 48), fill=SOFT)
            y += 64
        d.text((MARGIN, y + 12), DISCLAIMER, font=font("sans", 36), fill=SOFT)
        return y + 60
    return _slide(ACCENT, body, band=False)


def slides(post: dict) -> list[tuple[Image.Image, float]]:
    """(picture, seconds on screen) for each slide, in order."""
    roles = (post.get("roles") or [])[:MAX_ROLES]
    out = [(title_slide(post), TITLE_SECONDS)]
    out += [(role_slide(r, i + 1, len(roles)), ROLE_SECONDS) for i, r in enumerate(roles)]
    out.append((end_slide(post), END_SECONDS))
    return out


def ffmpeg_command(frames: list[str], seconds: list[float], out_path: str, ffmpeg: str = "ffmpeg") -> list[str]:
    """One ffmpeg call: each still held for its time, crossfaded into the next, plus silent audio
    (some players and uploaders treat a video with no audio track as broken)."""
    cmd = [ffmpeg, "-y", "-loglevel", "error"]
    for f, s in zip(frames, seconds):
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{s + FADE:.3f}", "-i", f]
    total = sum(seconds) + FADE
    cmd += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    chain, last, offset = [], "[0:v]", 0.0
    for i in range(1, len(frames)):
        offset += seconds[i - 1]
        label = f"[v{i}]"
        chain.append(f"{last}[{i}:v]xfade=transition=fade:duration={FADE}:offset={offset - FADE / 2:.3f}{label}")
        last = label
    graph = ";".join(chain) + ";" if chain else ""
    graph += f"{last}format=yuv420p,fps={FPS}[vout]"
    cmd += ["-filter_complex", graph, "-map", "[vout]", "-map", f"{len(frames)}:a",
            "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out_path]
    return cmd


def render(post: dict, out_path: str) -> str:
    """Draw the slides and write the MP4. Raises RuntimeError without ffmpeg or when it fails."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    with tempfile.TemporaryDirectory() as tmp:
        frames, seconds = [], []
        for i, (img, s) in enumerate(slides(post)):
            path = os.path.join(tmp, f"slide{i}.png")
            img.save(path)
            frames.append(path)
            seconds.append(s)
        r = subprocess.run(ffmpeg_command(frames, seconds, out_path, ffmpeg), capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError("ffmpeg failed: " + (r.stderr or "").strip()[-300:])
    return out_path


if __name__ == "__main__":
    import social  # noqa: E402

    site = sys.argv[1] if len(sys.argv) > 1 else "docs"
    out = sys.argv[2] if len(sys.argv) > 2 else "reel.mp4"
    data = social.card_data(site)
    if not data:
        sys.exit("[reels] nothing to show: no field gained enough new nearby listings this week")
    print(render(data, out))
