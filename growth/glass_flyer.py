"""The double-sided InternScout flyer for glass walls (2026-10-06).

    python growth/glass_flyer.py                      # one generic flyer, tag flyer-campus
    python growth/glass_flyer.py --spots lib,isb,su   # one PDF per posting spot
    python growth/glass_flyer.py --posted "Oct 7, 2026"     # adds a "Posted" date; none by default

Writes output/pdf/internscout-glass-<spot>.pdf (page 1 = front, page 2 = back) and PNG previews of
each side under output/flyer-preview/. Needs `segno` (pip install segno) for the QR codes and Chrome or
Edge to print the HTML to PDF; nothing else.

Why it looks the way it does, from the research behind it (growth/FLYERS.md has the sources):
- One focal element per side, the headline, sized for a reader 8-10 ft away on a wall (about 1 inch of
  cap height per 10 ft), on a saturated yellow that stands apart from white flyers and from the room
  behind the glass. Black on that yellow is about 15:1 contrast.
- A 3-inch QR code on white, with a benefit line beside it and the typed URL as a backup; through glass
  a code needs 2.5 inches or more.
- Mirror registration: on a sheet duplexed with "flip on long edge" the front's bottom-right sits behind
  the back's bottom-left, so the QR tiles and the headline blocks overlap and show little through each
  other when daylight comes through the glass.
- "Free" with its condition beside it (the optional plans), not in a footnote, and the .edu allowance as
  numbers: 25 Auto-Apply runs and 10 tailored resumes a month, against 12 and 5 for any other email
  (worker/src/config.js TASKS, GENERAL_ALLOWANCE_PCT). Never "applies for you": it stops at Submit.
- A non-affiliation line, which campus posting rules ask for (they also ask for a date: --posted adds one).

Each spot's QR code carries ?utm_source=flyer-<spot>&utm_medium=print; the Worker counts those visits
as source "print", one channel per spot (worker/src/visits.js), so the weekly numbers say which wall
worked. A spot is 1-16 lowercase letters or digits.
"""
from __future__ import annotations

import argparse
import html
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import segno

ROOT = Path(__file__).resolve().parents[1]
OUT_PDF = ROOT / "output" / "pdf"
OUT_PNG = ROOT / "output" / "flyer-preview"
SITE = "https://internscout.org/"
SPOT_RE = re.compile(r"^[a-z0-9]{1,16}$")
SLOGAN = "Built by one student, made for all students."
CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome", "chromium", "chromium-browser", "msedge",
]


def facts() -> dict:
    """Open roles and employers as of the last export, rounded down so the flyer stays true for weeks
    while counts move (14,316 -> "14,000+")."""
    stats = json.loads((ROOT / "docs" / "data" / "stats.json").read_text(encoding="utf-8"))
    open_ = int(stats["open"])
    return {"roles": f"{open_ // 1000 * 1000:,}+", "employers": "1,700+"}


def qr_svg(url: str) -> str:
    """The code as inline SVG: black modules on white, level Q, a 4-module quiet zone, scaled by CSS."""
    buf = io.BytesIO()
    segno.make(url, error="q", micro=False).save(buf, kind="svg", border=4, dark="#111111", light="#ffffff",
                                                 xmldecl=False, svgns=True, nl=False, omitsize=True)
    return buf.getvalue().decode("utf-8")


CSS = """
@page { size: 8.5in 11in; margin: 0 }
:root { --yellow: #ffdd1f; --ink: #111111; --green: #1d5c46; --paper: #ffffff; --ink2: #2b2b2b; }
* { box-sizing: border-box; margin: 0; padding: 0 }
html, body { background: var(--paper) }
body { font-family: "IBM Plex Sans", Arial, Helvetica, sans-serif; color: var(--ink);
       -webkit-print-color-adjust: exact; print-color-adjust: exact }
.page { width: 8.5in; height: 11in; padding: 0.3in; page-break-after: always; break-after: page; overflow: hidden }
.page:last-child { page-break-after: auto; break-after: auto }
.panel { width: 100%; height: 100%; background: var(--yellow); padding: 0.42in 0.45in 0.32in;
         display: flex; flex-direction: column }
.eyebrow { align-self: flex-start; background: var(--ink); color: var(--yellow); font-weight: 700;
           font-size: 15pt; letter-spacing: .06em; text-transform: uppercase; padding: .07in .14in .06in }
.big { font-family: "Archivo Black", "Arial Black", Arial, sans-serif; line-height: .92; letter-spacing: -.02em }
.n { font-size: 112pt; margin-top: .12in; white-space: nowrap }
.h2 { font-size: 58pt; margin-top: .02in }
.h3 { font-family: "Archivo Black", "Arial Black", sans-serif; font-size: 30pt; line-height: 1.08; margin-top: .2in }
.lead { font-size: 19pt; line-height: 1.3; font-weight: 500; margin-top: .16in; max-width: 7in }
.spacer { flex: 1 }
.cta { display: flex; gap: .3in; align-items: flex-end }
.cta.flip { flex-direction: row-reverse }
.qr { background: var(--paper); padding: .06in; width: 3.12in; height: 3.12in; flex: none; border: .03in solid var(--ink) }
.qr svg { width: 100%; height: 100%; display: block }
.cta-text { flex: 1; min-width: 0; padding-bottom: .04in }
.scan { font-family: "Archivo Black", "Arial Black", sans-serif; font-size: 25pt; line-height: 1.1 }
.arrow { font-family: "Archivo Black", "Arial Black", sans-serif; white-space: nowrap }
.nw { white-space: nowrap }
.url { font-weight: 700; font-size: 27pt; margin-top: .1in; letter-spacing: -.01em }
.free { font-weight: 700; font-size: 16pt; margin-top: .14in; line-height: 1.3 }
.cond { font-size: 12.5pt; line-height: 1.35; margin-top: .05in; color: var(--ink2) }
.strip { background: var(--green); color: #fff; font-size: 16.5pt; line-height: 1.35; padding: .14in .22in;
         margin-top: .24in }
.strip b { font-family: "Archivo Black", "Arial Black", sans-serif; font-weight: 400; color: var(--yellow) }
.badge { background: var(--green); color: #fff; padding: .18in .24in .2in; margin-top: .24in }
.badge .k { font-family: "Archivo Black", "Arial Black", sans-serif; font-size: 34pt; line-height: 1.05 }
.badge .k em { font-style: normal; color: var(--yellow) }
.badge .d { font-size: 15.5pt; line-height: 1.35; margin-top: .1in }
.foot { border-top: .02in solid var(--ink); margin-top: .22in; padding-top: .1in; font-size: 10.5pt;
        line-height: 1.35; display: flex; justify-content: space-between; gap: .2in }
.foot b { font-weight: 700 }
.foot .date { white-space: nowrap }
.foot .blank { display: inline-block; width: 1.25in; border-bottom: .015in solid var(--ink); margin-left: .05in }
.lead b { font-weight: 700 }
"""

FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black'
         '&family=IBM+Plex+Sans:wght@500;700&display=block">')


def front(f: dict, qr: str, posted: str) -> str:
    return f"""
<section class="page"><div class="panel">
  <div class="eyebrow">Made by a UMass student · every major</div>
  <div class="big n">{f['roles']}</div>
  <div class="big h2">internships.</div>
  <div class="h3">Every major. One free search.</div>
  <p class="lead"><b>No account needed.</b> Stop checking ten job boards: {f['employers']} employers,
    updated several times a day.</p>
  <div class="strip"><b>.edu email = 2&times; free Auto-Apply</b>: the extension that fills
    applications from your resume.</div>
  <div class="spacer"></div>
  <div class="cta">
    <div class="cta-text">
      <div class="scan">Scan to see internships for <u>your</u> <span class="nw">major &#8594;</span></div>
      <div class="url">internscout.org</div>
      <div class="free">Free to use. No&nbsp;credit&nbsp;card.</div>
      <div class="cond">Optional $4 and $8 plans only raise the AI allowance.</div>
    </div>
    <div class="qr" aria-label="QR code to internscout.org">{qr}</div>
  </div>
  <div class="foot"><span><b>{html.escape(SLOGAN)}</b> Independent student project; not affiliated with
    UMass Amherst.</span>{f'<span class="date">Posted {html.escape(posted)}</span>' if posted else ''}</div>
</div></section>"""


def back(f: dict, qr: str, posted: str) -> str:
    # Mirror layout: the QR tile on the left, behind the front's (right-hand) tile on a long-edge flip.
    return f"""
<section class="page"><div class="panel">
  <div class="eyebrow">Free Chrome extension</div>
  <div class="big h2" style="margin-top:.2in">Stop retyping</div>
  <div class="big h2">your resume.</div>
  <p class="lead">Auto-Apply fills internship applications from your resume on Workday, Greenhouse,
    Lever and more. It never submits: you check every answer and press&nbsp;Submit.</p>
  <div class="badge">
    <div class="k">.edu email = <em>2&times;</em> free Auto-Apply</div>
    <div class="d">Sign in with your school email: 25 applications filled and 10 tailored
      resumes a month, free. Other emails get 12&nbsp;and&nbsp;5.</div>
  </div>
  <div class="spacer"></div>
  <div class="cta flip">
    <div class="cta-text">
      <div class="scan">Scan to search {f['roles']} <span class="nw">internships &#8594;</span></div>
      <div class="url">internscout.org</div>
      <div class="free">Free to use. No account to search.</div>
      <div class="cond">Optional $4 and $8 plans only raise the AI allowance.</div>
    </div>
    <div class="qr" aria-label="QR code to internscout.org">{qr}</div>
  </div>
  <div class="foot"><span><b>{html.escape(SLOGAN)}</b> Independent student project; not affiliated with
    UMass Amherst.</span>{f'<span class="date">Posted {html.escape(posted)}</span>' if posted else ''}</div>
</div></section>"""


def document(body: str) -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>InternScout flyer</title>'
            f'{FONTS}<style>{CSS}</style></head><body>{body}</body></html>')


def chrome() -> str:
    for c in CHROMES:
        if Path(c).exists() or shutil.which(c):
            return c
    sys.exit("Chrome or Edge is needed to print the flyer (none found).")


def render(html_text: str, pdf: Path | None = None, png: Path | None = None) -> None:
    exe = chrome()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "flyer.html"
        src.write_text(html_text, encoding="utf-8")
        common = [exe, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
                  "--virtual-time-budget=15000", "--run-all-compositor-stages-before-draw"]
        if pdf:
            subprocess.run(common + ["--no-pdf-header-footer", f"--print-to-pdf={pdf}", src.as_uri()],
                           check=True, capture_output=True)
        if png:
            # 96 px per inch: one Letter page is 816 x 1056.
            subprocess.run(common + ["--window-size=816,1056", "--force-device-scale-factor=1.25",
                                     f"--screenshot={png}", src.as_uri()], check=True, capture_output=True)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spots", default="campus", help="comma-separated posting spots, e.g. lib,isb,su")
    # was: default=today's date, then (2026-10-06) a blank "Posted ____" line. No date unless asked for.
    ap.add_argument("--posted", default="", help='print "Posted <date>" in the footer, e.g. "Oct 7, 2026"; none by default')
    ap.add_argument("--no-preview", action="store_true")
    args = ap.parse_args(argv)
    spots = [s.strip().lower() for s in args.spots.split(",") if s.strip()]
    bad = [s for s in spots if not SPOT_RE.match(s)]
    if bad:
        sys.exit(f"Spots must be 1-16 lowercase letters or digits: {', '.join(bad)}")
    f = facts()
    OUT_PDF.mkdir(parents=True, exist_ok=True)
    OUT_PNG.mkdir(parents=True, exist_ok=True)
    for spot in spots:
        url = f"{SITE}?utm_source=flyer-{spot}&utm_medium=print"
        qr = qr_svg(url)
        pdf = OUT_PDF / f"internscout-glass-{spot}.pdf"
        render(document(front(f, qr, args.posted) + back(f, qr, args.posted)), pdf=pdf)
        print(f"{pdf.relative_to(ROOT)}  ->  {url}")
        if not args.no_preview and spot == spots[0]:
            render(document(front(f, qr, args.posted)), png=OUT_PNG / "front.png")
            render(document(back(f, qr, args.posted)), png=OUT_PNG / "back.png")
            print(f"previews: {(OUT_PNG / 'front.png').relative_to(ROOT)}, {(OUT_PNG / 'back.png').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
