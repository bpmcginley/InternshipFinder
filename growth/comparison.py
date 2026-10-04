"""A price and feature comparison card: InternScout, Simplify and Jobright (1080x1350, the 4:5 portrait
Instagram and LinkedIn show uncropped), in the brand card's palette and type (growth/cards.py).

Made 2026-10-01; the result is growth/internscout-comparison.png. Every competitor fact below has a
source, printed on the card with its date, because prices change and a comparison is only fair while
it is current. To refresh: check the sources, update ROWS, SOURCES and AS_OF, and run

    python growth/comparison.py [out.png]

Sources as of 2026-10-01:
  Simplify+  $19.99/week, $39.99/month, $89.99/3 months; autofill (Copilot), tracker and resume builder
             free; resume tailoring and cover letters are Simplify+; the user submits.
             help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing
  Jobright   publishes no student prices. Turbo $39.99/month ($17.99/week; $89.99 for 3 months, read
             2026-10-04), free tier with daily credits; its AI Agent can submit applications
             (supervised or fully automatic).
             jobscan.co/blog/jobscan-vs-jobright (July 30, 2026). Jobright's own blog said $29.99/month
             in July 2025, so check the checkout price before paying to promote this.
  InternScout  worker/src/config.js: .edu free 25 Auto-Apply + 10 tailored resumes a month, other
             emails 12 and 5 (GENERAL_ALLOWANCE_PCT 50, rounded down); Supporter $4 (2x), Pro $8 (4x).
             The extension never presses Submit.

No competitor logos, and the card says InternScout is not affiliated with either.
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cards import ACCENT, INK, INK2, PAPER, SOFT, font, wrap  # noqa: E402

W, H = 1080, 1350
M = 60
RULE = (226, 222, 212)        # --rule #e2ded4
AS_OF = "October 1, 2026"
HEADLINE = ("Paid plans: $4 a month", "vs $39.99 a month")
COLS = [("", 250), ("InternScout", 270), ("Simplify", 230), ("Jobright", 230)]
# The free monthly allowance. Must match worker/src/config.js: TASKS[task].allowance for a school .edu
# account, and GENERAL_ALLOWANCE_PCT (50, rounded down) of it for any other email; the same numbers as
# backend/internscout/seo_pages.py FREE_EDU and FREE_GENERAL (2026-10-04).
FREE_EDU = {"autofill": 25, "resume_tailor": 10}
FREE_GENERAL = {"autofill": 12, "resume_tailor": 5}
ROWS = [
    ("Paid plan", ["$4 or $8 / month", "$39.99 / month", "$39.99 / month"]),
    ("Free AI-filled applications", [f"{FREE_EDU['autofill']} a month*", "Basic autofill, free", "Daily credits"]),
    ("Free AI-tailored resumes", [f"{FREE_EDU['resume_tailor']} a month*", "Paid plan only", "Daily credits"]),
    ("Who presses Submit", ["Always you", "You", "You, or its AI agent"]),
    ("Built for", ["Internships, co-ops, research", "All job levels", "All job levels"]),
]
NOTES = [
    f"* With a school .edu email; other emails get {FREE_GENERAL['autofill']} and {FREE_GENERAL['resume_tailor']}. "
    "Supporter $4 doubles it, Pro $8 quadruples it.",
    # was: "* With a school .edu email; other emails get half. ..." (25 is not twice 12; 2026-10-04)
    "Simplify+ price from help.simplify.jobs. Jobright doesn't publish student prices: Turbo price as",
    f"reported by Jobscan, July 2026. Prices as of {AS_OF}. Not affiliated with Simplify or Jobright.",
]
LINE = 36                     # line height in the table


def _table(d: ImageDraw.ImageDraw, y: int, highlight_to: int | None) -> int:
    """Draw the table from y (the InternScout column shaded down to highlight_to) and return where it
    ends. Run once without a highlight to measure, then for real."""
    xs, x = [], M
    for _, w in COLS:
        xs.append(x)
        x += w
    right = x - 14
    if highlight_to is not None:
        d.rounded_rectangle([xs[1] - 12, y - 14, xs[1] + COLS[1][1] - 14, highlight_to], radius=18, fill=SOFT)
    for (name, _), x in zip(COLS, xs):
        if name:
            d.text((x, y), name, font=font("sans_bold", 30), fill=ACCENT if name == "InternScout" else INK)
    y += 58
    d.line([M, y, right, y], fill=ACCENT, width=3)
    label_f, ours_f, cell_f = font("sans_bold", 28), font("sans_bold", 28), font("sans", 28)
    for label, cells in ROWS:
        top = y + 22
        lines = wrap(d, label, label_f, COLS[0][1] - 24, 2)
        for i, line in enumerate(lines):
            d.text((xs[0], top + i * LINE), line, font=label_f, fill=INK)
        h = len(lines) * LINE
        for j, text in enumerate(cells):
            f = ours_f if j == 0 else cell_f
            cl = wrap(d, text, f, COLS[j + 1][1] - 30, 2)
            for i, line in enumerate(cl):
                d.text((xs[j + 1], top + i * LINE), line, font=f, fill=ACCENT if j == 0 else INK2)
            h = max(h, len(cl) * LINE)
        y = top + h + 22
        d.line([M, y, right, y], fill=RULE, width=2)
    return y


def render(out_path: str) -> str:
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 200], fill=ACCENT)
    d.text((M, 46), "InternScout", font=font("serif", 64), fill=PAPER)
    d.text((M + 2, 132), "AI JOB TOOLS FOR STUDENTS, COMPARED", font=font("sans_bold", 28), fill=SOFT)

    y = 236
    d.text((M, y), HEADLINE[0], font=font("serif", 60), fill=ACCENT)
    d.text((M, y + 78), HEADLINE[1], font=font("serif", 60), fill=INK)
    y += 182

    end = _table(ImageDraw.Draw(Image.new("RGB", (W, H))), y, None)
    y = _table(d, y, end)

    y += 26
    for line in NOTES:
        d.text((M, y), line, font=font("sans", 21), fill=INK2)
        y += 30
    foot = 150
    if y > H - foot - 10:
        raise RuntimeError("the notes run into the foot band; shorten them or the rows")

    d.rectangle([0, H - foot, W, H], fill=ACCENT)
    d.text((M, H - 128), "internscout.org", font=font("serif", 50), fill=PAPER)
    d.text((M, H - 56), "Built by one student, made for all students.  Not affiliated with UMass Amherst.",
           font=font("sans", 25), fill=SOFT)
    img.save(out_path, "PNG", optimize=True)
    return out_path


if __name__ == "__main__":
    print(render(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "internscout-comparison.png")))
