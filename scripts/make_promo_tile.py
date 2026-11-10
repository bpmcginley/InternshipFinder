"""Build the Chrome Web Store small promo tile (440x280, required to submit).

scripts/make_og_image.py names this script as its twin, but it was never committed. Same palette
and type as the link-preview card: the dashboard's tokens from docs/index.html (--accent, --paper,
--accent-soft), with Georgia standing in for Source Serif 4. The store shows the tile small in
search and category rows, so it carries only the name, one line and the icon on a paper plate.

Run: python scripts/make_promo_tile.py
Writes: store/promo-tile-440x280.png (outside docs/, so Pages does not publish it)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "store" / "promo-tile-440x280.png"
ICON = ROOT / "extension" / "icons" / "icon128.png"

W, H = 440, 280
ACCENT = (29, 92, 70)        # --accent #1d5c46
PAPER = (246, 244, 239)      # --paper #f6f4ef
SOFT = (227, 238, 232)       # --accent-soft #e3eee8

FONTS = Path("C:/Windows/Fonts")


def _font(name: str, size: int):
    return ImageFont.truetype(str(FONTS / name), size)


def _centered(d: ImageDraw.ImageDraw, y: int, text: str, font, fill):
    w = d.textlength(text, font=font)
    d.text(((W - w) / 2, y), text, font=font, fill=fill)


def build() -> Path:
    img = Image.new("RGB", (W, H), ACCENT)
    d = ImageDraw.Draw(img)

    # The same paper band as the link-preview card, so the two read as one product.
    d.rectangle([0, 206, W, H], fill=PAPER)

    # The icon is a near-black rounded square and vanishes on the green without its paper plate.
    d.rounded_rectangle([W // 2 - 44, 26, W // 2 + 44, 114], radius=18, fill=PAPER)
    icon = Image.open(ICON).convert("RGBA").resize((72, 72), Image.LANCZOS)
    img.paste(icon, (W // 2 - 36, 34), icon)

    _centered(d, 124, "InternScout", _font("georgiab.ttf", 44), PAPER)
    _centered(d, 176, "Internships for every major", _font("segoeui.ttf", 19), SOFT)
    _centered(d, 224, "Fills the form. You press Submit.", _font("segoeuisl.ttf", 22), ACCENT)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    return OUT


if __name__ == "__main__":
    p = build()
    im = Image.open(p)
    print(f"{p}  {p.stat().st_size / 1024:.1f} KB  {im.size}")
