"""Build the link-preview card (1200x630) used by og:image on the docs pages.

Separate from the store tile because the size requirement is not cosmetic. Facebook's scraper
rejects any og:image under 200x200 and X/Twitter's summary card wants at least 144x144, so the
128x128 favicon the pages pointed at produced a title-only card with no thumbnail on both. 1200x630
is the size those scrapers and Slack, Discord and iMessage all render without cropping.

Same palette and type as scripts/make_promo_tile.py, so the tile, the card, the site and the
extension look like one product: the dashboard's own tokens from docs/index.html (--accent, --paper,
--accent-soft), with Georgia standing in for Source Serif 4, which we do not ship as a font file.

Run: python scripts/make_og_image.py
Writes: docs/og-preview.png
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "og-preview.png"
ICON = ROOT / "extension" / "icons" / "icon128.png"

W, H = 1200, 630
ACCENT = (29, 92, 70)        # --accent #1d5c46
PAPER = (246, 244, 239)      # --paper #f6f4ef
SOFT = (227, 238, 232)       # --accent-soft #e3eee8

FONTS = Path("C:/Windows/Fonts")


def _font(name: str, size: int):
    return ImageFont.truetype(str(FONTS / name), size)


def build() -> Path:
    img = Image.new("RGB", (W, H), ACCENT)
    d = ImageDraw.Draw(img)

    # A paper band along the bottom, same horizon as the store tile. A link preview is often shown
    # at a third of this size, so the card has to read as a designed object when shrunk.
    # was: the band started at y=470, which left a 160px empty green gap under the subtitle.
    d.rectangle([0, 430, W, H], fill=PAPER)

    # The icon is a near-black rounded square and disappears against the green; the paper plate is
    # what makes it survive the shrink. Same trick as the store tile, at this card's scale.
    d.rounded_rectangle([80, 96, 296, 312], radius=44, fill=PAPER)
    icon = Image.open(ICON).convert("RGBA").resize((172, 172), Image.LANCZOS)
    img.paste(icon, (102, 118), icon)

    d.text((344, 112), "InternScout", font=_font("georgiab.ttf", 104), fill=PAPER)
    # was: segoeui 40, which ran to x=1151 and left 49px of right margin against 80px on the left.
    d.text((350, 252), "Internships, co-ops and research, every major",
           font=_font("segoeui.ttf", 36), fill=SOFT)

    # was: y=520, which sat 50px below the band's centre line once the band moved up.
    # was: "Search free. Apply faster." The slogan the owner chose on 2026-09-23 for every ad surface,
    # and a link preview is the one every share carries. At 56px it ends at x=1113, a right margin
    # to match the 84px left one.
    d.text((84, 486), "Built by one student, made for all students.", font=_font("segoeuisl.ttf", 56), fill=ACCENT)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    return OUT


if __name__ == "__main__":
    p = build()
    im = Image.open(p)
    print(f"{p}  {p.stat().st_size / 1024:.1f} KB  {im.size}")
