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

from io import BytesIO
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "og-preview.png"
ICON = ROOT / "extension" / "icons" / "icon128.png"

W, H = 1200, 630
ACCENT = (29, 92, 70)  # --accent #1d5c46
PAPER = (246, 244, 239)  # --paper #f6f4ef
SOFT = (227, 238, 232)  # --accent-soft #e3eee8

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
    d.text(
        (350, 252),
        "Internships, co-ops and research, every major",
        font=_font("segoeui.ttf", 36),
        fill=SOFT,
    )

    # was: y=520, which sat 50px below the band's centre line once the band moved up.
    # was: "Search free. Apply faster." The slogan the owner chose on 2026-09-23 for every ad surface,
    # and a link preview is the one every share carries. At 56px it ends at x=1113, a right margin
    # to match the 84px left one.
    d.text(
        (84, 486),
        "Built by one student, made for all students.",
        font=_font("segoeuisl.ttf", 56),
        fill=ACCENT,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    return OUT


def _landing_font(size: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.load_default(size)
    if not isinstance(font, ImageFont.FreeTypeFont):
        raise RuntimeError("Landing previews require Pillow's FreeType font")
    # Pillow selects RAQM when present. Keep the same layout engine across build platforms.
    if font.layout_engine != ImageFont.Layout.BASIC:
        font = font.font_variant(layout_engine=ImageFont.Layout.BASIC)
    return font


def _fit_landing_title(draw: ImageDraw.ImageDraw, heading: str):
    words = heading.split()
    if not words:
        raise ValueError("Landing card title is empty")
    width = W - 168
    for size in range(90, 43, -2):
        font = _landing_font(size)
        lines = [words[0]]
        for word in words[1:]:
            line = f"{lines[-1]} {word}"
            if draw.textlength(line, font=font) <= width:
                lines[-1] = line
            else:
                lines.append(word)
        title = "\n".join(lines)
        left, top, right, bottom = draw.multiline_textbbox((0, 0), title, font=font, spacing=8)
        if len(lines) <= 2 and right - left <= width and bottom - top <= 185:
            return title, font
    raise ValueError("Landing card title does not fit")


def landing_card(icon_path: Path, heading: str, *, term: str | None = None) -> bytes:
    """Render a 1200 by 630 PNG for one generated landing page."""
    card = Image.new("RGB", (W, H), ACCENT)
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 492, W, H), fill=PAPER)
    draw.rounded_rectangle((84, 59, 164, 139), radius=19, fill=PAPER)
    with Image.open(icon_path) as source:
        icon = source.convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)
    card.paste(icon, (92, 67), icon)

    draw.text((186, 74), "InternScout", font=_landing_font(48), fill=PAPER)
    title, font = _fit_landing_title(draw, heading)
    if term is not None:
        term_font = _landing_font(41)
        if (
            not term.strip()
            or term != term.strip()
            or term.splitlines() != [term]
            or draw.textlength(term, font=term_font) > W - 168
        ):
            raise ValueError("Landing card term does not fit")
        draw.text((84, 177), term, font=term_font, fill=SOFT)
    draw.multiline_text((84, 235 if term else 210), title, font=font, spacing=8, fill=PAPER)
    draw.text((84, 533), "internscout.org", font=_landing_font(37), fill=ACCENT)

    output = BytesIO()
    card.save(output, "PNG", optimize=True)
    return output.getvalue()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--site"]:
        from internscout.seo_pages import main

        main([sys.argv[0], *sys.argv[2:]], card_renderer=landing_card)
    else:
        p = build()
        with Image.open(p) as im:
            print(f"{p}  {p.stat().st_size / 1024:.1f} KB  {im.size}")
