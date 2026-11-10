"""Build the home-screen icons the web app manifest (docs/manifest.webmanifest) points at.

Chrome only offers "Install app" when the manifest lists a 192px and a 512px icon, and iOS wants a
180px apple-touch-icon. The only icon we have is extension/icons/icon128.png, which blurs when
scaled up, so this redraws it from its shapes (measured off that file, in its 128px grid): the
near-black rounded square, the green dot and the cream "i".

The maskable and Apple icons fill the whole square, because Android and iOS cut their own shape out
of it. The glyph already sits inside the 40%-radius safe zone Android keeps, so it is not shrunk.

Run: python scripts/make_app_icons.py
Writes: docs/icon180.png, docs/icon192.png, docs/icon512.png, docs/icon-maskable512.png
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

INK = (23, 25, 28)           # the icon's background
DOT = (124, 195, 161)
CREAM = (246, 244, 239)      # --paper #f6f4ef

RADIUS = 28                  # corner radius of the rounded square, in the 128px grid
GLYPH = [                    # boxes in the 128px grid: top serif, stem, bottom serif
    (47, 53, 74, 59),
    (54, 53, 74, 93),
    (44, 93, 84, 100),
]
DOT_BOX = (53, 23.25, 75, 45.75)
SS = 4                       # drawn this many times larger, then scaled down, for smooth edges


def draw(size: int, full_bleed: bool) -> Image.Image:
    k = size * SS / 128
    big = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    if full_bleed:
        d.rectangle((0, 0, size * SS, size * SS), fill=INK)
    else:
        d.rounded_rectangle((0, 0, size * SS - 1, size * SS - 1), radius=RADIUS * k, fill=INK)
    d.ellipse(tuple(v * k for v in DOT_BOX), fill=DOT)
    for x0, y0, x1, y1 in GLYPH:
        d.rectangle((x0 * k, y0 * k, x1 * k - 1, y1 * k - 1), fill=CREAM)
    img = big.resize((size, size), Image.LANCZOS)
    return img.convert("RGB") if full_bleed else img


def build() -> list[Path]:
    out = []
    for name, size, full in (("icon180.png", 180, True), ("icon192.png", 192, False),
                             ("icon512.png", 512, False), ("icon-maskable512.png", 512, True)):
        p = DOCS / name
        draw(size, full).save(p, "PNG", optimize=True)
        out.append(p)
    return out


if __name__ == "__main__":
    for p in build():
        print(f"{p}  {p.stat().st_size / 1024:.1f} KB  {Image.open(p).size}")
