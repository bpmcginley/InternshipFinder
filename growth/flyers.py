"""Two low-ink, US Letter InternScout flyers for campus bulletin boards.

Run with the Codex bundled Python (which includes reportlab):
    python growth/flyers.py

Both QR codes lead to the published homepage. Keep the URL in type so the flyer still works when a
camera cannot scan. The PDFs use black type, a little brand green, and vector QR codes; print at
actual size in color or grayscale.
"""
from __future__ import annotations

from pathlib import Path

from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf"
URL = "https://internscout.org/"
BLACK = HexColor("#111111")
GREEN = HexColor("#1d5c46")
GREY = HexColor("#4b4b4b")
LIGHT = HexColor("#bbbbbb")
W, H = letter
FONT_DIR = Path("C:/Windows/Fonts")
LOGO = ROOT / "docs" / "icon512.png"
FONT_REGULAR = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def register_fonts() -> None:
    global FONT_REGULAR, FONT_BOLD
    regular, bold = FONT_DIR / "arial.ttf", FONT_DIR / "arialbd.ttf"
    if regular.exists() and bold.exists():
        pdfmetrics.registerFont(TTFont("FlyerRegular", str(regular)))
        pdfmetrics.registerFont(TTFont("FlyerBold", str(bold)))
        FONT_REGULAR, FONT_BOLD = "FlyerRegular", "FlyerBold"


def text(c: canvas.Canvas, x: float, y: float, value: str, size: float, *,
         bold: bool = False, color=BLACK) -> None:
    c.setFillColor(color)
    c.setFont(FONT_BOLD if bold else FONT_REGULAR, size)
    c.drawString(x, y, value)


def rule(c: canvas.Canvas, y: float, x1: float = 45, x2: float = W - 45, width: float = 1) -> None:
    c.setStrokeColor(GREEN)
    c.setLineWidth(width)
    c.line(x1, y, x2, y)


def qr_code(c: canvas.Canvas, x: float, y: float, size: float = 132) -> None:
    widget = qr.QrCodeWidget(URL)
    bounds = widget.getBounds()
    raw = bounds[2] - bounds[0]
    drawing = Drawing(size, size, transform=[size / raw, 0, 0, size / raw, 0, 0])
    drawing.add(widget)
    c.setFillColor(white)
    c.rect(x - 8, y - 8, size + 16, size + 16, fill=1, stroke=0)
    renderPDF.draw(drawing, c, x, y)


def footer(c: canvas.Canvas) -> None:
    c.setStrokeColor(LIGHT)
    c.setLineWidth(.7)
    c.line(45, 56, W - 45, 56)
    text(c, 45, 39, "Built by a UMass student. Independent of UMass Amherst.", 8.5, color=GREY)


def masthead(c: canvas.Canvas) -> None:
    c.drawImage(str(LOGO), 45, 716, width=43, height=43, mask="auto")
    text(c, 101, 729, "InternScout", 22, bold=True)
    text(c, 466, 733, "FREE SEARCH", 9.5, bold=True, color=GREEN)
    rule(c, 702, width=2)


def first(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=letter, pageCompression=1)
    c.setTitle("InternScout campus flyer - Find your fit")
    c.setAuthor("InternScout")

    masthead(c)

    text(c, 45, 617, "FIND AN", 57, bold=True)
    text(c, 45, 550, "INTERNSHIP", 57, bold=True)
    text(c, 45, 483, "THAT FITS.", 57, bold=True, color=GREEN)
    rule(c, 454, width=1.5)

    text(c, 45, 410, "Your major. Your class year. Your next move.", 17, bold=True)
    text(c, 45, 381, "Browse internships, co-ops, and research roles", 14)
    text(c, 45, 359, "from employer sites and public job boards.", 14)

    rule(c, 320)
    text(c, 45, 263, "SCAN FOR OPEN ROLES", 17, bold=True, color=GREEN)
    text(c, 45, 227, "internscout.org", 22, bold=True)
    text(c, 45, 197, "No account needed to search.", 12, color=GREY)
    qr_code(c, 374, 82, 194)
    footer(c)
    c.showPage()
    c.save()


def second(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=letter, pageCompression=1)
    c.setTitle("InternScout campus flyer - Summer 2027")
    c.setAuthor("InternScout")

    masthead(c)
    text(c, 45, 646, "SUMMER 2027", 49, bold=True, color=GREEN)
    text(c, 45, 578, "STARTS HERE.", 49, bold=True)
    rule(c, 544, width=1.5)

    text(c, 45, 495, "Looking for an internship?", 24, bold=True)
    text(c, 45, 457, "Find roles that match your major and location.", 17)
    text(c, 45, 430, "Search free. Sign in only if you want AI help applying.", 13)

    text(c, 45, 353, "CS  /  FINANCE  /  ENGINEERING", 18, bold=True)
    text(c, 45, 327, "And plenty more fields to explore.", 13, color=GREY)
    rule(c, 291)

    qr_code(c, 45, 83, 195)
    text(c, 282, 247, "SCAN ME", 24, bold=True, color=GREEN)
    text(c, 282, 210, "Or go straight to", 13)
    text(c, 282, 179, "internscout.org", 21, bold=True)
    text(c, 282, 150, "No sign-in to search.", 11.5, color=GREY)
    footer(c)
    c.showPage()
    c.save()


if __name__ == "__main__":
    register_fonts()
    OUT.mkdir(parents=True, exist_ok=True)
    first(OUT / "internscout-flyer-find-your-fit.pdf")
    second(OUT / "internscout-flyer-summer-2027.pdf")
    print(f"Wrote two US Letter flyers to {OUT}")
