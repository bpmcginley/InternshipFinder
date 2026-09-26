"""The picture that goes with a brand post: one 1080x1350 JPEG card (Instagram's 4:5 portrait, the
largest a feed shows uncropped), drawn from the same pick growth/social.py makes for its text post.

Instagram takes no post without an image, and a card also gives the LinkedIn draft something to
carry. It says what the text says: how many new roles in a field this week, where, and a few of the
employers, with the site's address and the slogan. Same palette as the site, the store tile and the
link-preview card (docs/index.html: --accent, --paper, --accent-soft), with IBM Plex, the site's
own typeface.

Fonts: the Brand posts workflow installs Ubuntu's fonts-ibm-plex. Anywhere else the renderer falls
back to Georgia/Segoe (Windows) or DejaVu, so a card can be previewed on a laptop; only the CI card
is the one that ships.

Run from the repo root to preview:  python growth/cards.py [docs] [out.jpg]
"""
from __future__ import annotations

import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1350
ACCENT = (29, 92, 70)        # --accent #1d5c46
PAPER = (246, 244, 239)      # --paper #f6f4ef
SOFT = (227, 238, 232)       # --accent-soft #e3eee8
INK = (23, 25, 28)           # --ink #17191c
INK2 = (69, 74, 82)          # --ink2 #454a52
MARGIN = 84
FOOT = 190                   # height of the green foot band

# Each role: font files tried in order. Plex first (CI), then what a Windows or Linux laptop has.
FONTS = {
    "serif": ["IBMPlexSerif-SemiBold.otf", "IBMPlexSerif-SemiBold.ttf", "georgiab.ttf", "DejaVuSerif-Bold.ttf"],
    "sans": ["IBMPlexSans-Regular.otf", "IBMPlexSans-Regular.ttf", "segoeui.ttf", "DejaVuSans.ttf"],
    "sans_bold": ["IBMPlexSans-SemiBold.otf", "IBMPlexSans-SemiBold.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf"],
}
FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts"),
             "C:/Windows/Fonts", os.path.expanduser("~/AppData/Local/Microsoft/Windows/Fonts")]


def _find(names: list[str]) -> str | None:
    for name in names:
        for d in FONT_DIRS:
            hits = glob.glob(os.path.join(d, "**", name), recursive=True) if os.path.isdir(d) else []
            if hits:
                return sorted(hits)[0]
    return None


def font(role: str, size: int) -> ImageFont.FreeTypeFont:
    path = _find(FONTS[role])
    if path is None:
        # A card in Pillow's bitmap font would ship looking broken; better to stop and say why.
        raise RuntimeError(f"no {role} font found (tried {', '.join(FONTS[role])}); "
                           "install fonts-ibm-plex or pass a machine that has Georgia/Segoe or DejaVu")
    return ImageFont.truetype(path, size)


def fit(draw: ImageDraw.ImageDraw, text: str, fnt, width: int) -> str:
    """text, cut with an ellipsis if it is wider than width."""
    if draw.textlength(text, font=fnt) <= width:
        return text
    while text and draw.textlength(text + "…", font=fnt) > width:
        text = text[:-1]
    return text.rstrip() + "…"


def wrap(draw: ImageDraw.ImageDraw, text: str, fnt, width: int, lines: int) -> list[str]:
    """Up to `lines` lines of text, word-wrapped to width; the last is cut with an ellipsis if needed."""
    words, out, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=fnt) <= width or not cur:
            cur = trial
        else:
            out.append(cur)
            cur = w
    out.append(cur)
    if len(out) > lines:
        out = out[:lines]
        out[-1] = fit(draw, out[-1] + " …", fnt, width)
    return [fit(draw, line, fnt, width) for line in out]


def render(post: dict, out_path: str) -> str:
    """Draw the card for a post (the dict social.card_data returns) and save it as a JPEG."""
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    inner = W - 2 * MARGIN

    # Top band: the name, and what the card is.
    d.rectangle([0, 0, W, 250], fill=ACCENT)
    d.text((MARGIN, 72), "InternScout", font=font("serif", 76), fill=PAPER)
    d.text((MARGIN + 4, 178), post["eyebrow"].upper(), font=font("sans_bold", 30), fill=SOFT)

    # The number, then what it counts.
    y = 330
    num = font("serif", 230)
    d.text((MARGIN - 8, y - 40), str(post["count"]), font=num, fill=ACCENT)
    y += 250
    for line in wrap(d, post["headline"], font("sans_bold", 58), inner, 2):
        d.text((MARGIN, y), line, font=font("sans_bold", 58), fill=INK)
        y += 72
    d.text((MARGIN, y + 6), post["where"], font=font("sans", 40), fill=INK2)
    y += 90

    # A few of the employers: as many as fit above the foot (a two-line field name leaves room for fewer).
    # The first row starts 92px below here, and each takes 62px (text about 50px tall).
    rows = max(0, min(5, (H - FOOT - 4 - (y + 92)) // 62))
    if post["employers"] and rows:
        d.line([MARGIN, y, W - MARGIN, y], fill=SOFT, width=4)
        y += 34
        d.text((MARGIN, y), "Hiring now", font=font("sans_bold", 32), fill=ACCENT)
        y += 58
        row = font("sans", 42)
        for name in post["employers"][:rows]:
            d.ellipse([MARGIN, y + 20, MARGIN + 14, y + 34], fill=ACCENT)
            d.text((MARGIN + 34, y), fit(d, name, row, inner - 34), font=row, fill=INK)
            y += 62

    # Foot: where to go, and the slogan with its disclaimer beside it.
    d.rectangle([0, H - FOOT, W, H], fill=ACCENT)
    d.text((MARGIN, H - 162), "internscout.org", font=font("serif", 54), fill=PAPER)
    d.text((MARGIN, H - 88), "Built by one student, made for all students.  Not affiliated with UMass Amherst.",
           font=font("sans", 26), fill=SOFT)

    img.save(out_path, "JPEG", quality=90, optimize=True, progressive=True)
    return out_path


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    import social  # noqa: E402

    site = sys.argv[1] if len(sys.argv) > 1 else "docs"
    out = sys.argv[2] if len(sys.argv) > 2 else "card.jpg"
    data = social.card_data(site)
    if not data:
        sys.exit("[cards] nothing to draw: no field gained enough new nearby listings this week")
    print(render(data, out))
