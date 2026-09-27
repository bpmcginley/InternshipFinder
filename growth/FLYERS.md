# Print flyers

The two one-page PDFs under `output/pdf/` are US Letter (8.5 × 11 inches), with black type,
InternScout green accents, the site logo, and large vector QR codes. Print in color at **actual size /
100%**, single-sided; grayscale also remains legible. Leave the printer's normal margins on; all
content is at least 0.6 inch from the paper edge. Render checks at 120 DPI showed less than 9% dark
pixel coverage per page, including the logo and QR code. The background is unprinted white paper.

- `internscout-flyer-find-your-fit.pdf` is evergreen. Use it where students of several majors will
  see it.
- `internscout-flyer-summer-2027.pdf` is for the current recruiting season. Use it in spaces serving
  CS, finance and engineering students, where InternScout has strong coverage. Stop using it after
  Summer 2027 recruitment.

Both QR codes and the printed address lead to `https://internscout.org/`. They do not use a third-party
shortener. The current Cloudflare Web Analytics setup does not record query-string campaign tags, so
these flyers do not claim channel-level attribution. If measurement is needed, create and publish a
dedicated page path before changing the QR target and reprinting.

To regenerate the PDFs, install `reportlab` for Python and run `python growth/flyers.py` from the
repository root. The script uses Arial when Windows fonts are available and Helvetica elsewhere.
The generated PDFs are committed so printing does not require running Python.

Post only where allowed. [UMass Amherst's posting guidance](https://www.umass.edu/news/key-issues/free-speech-and-expression-faq)
specifies designated boards, a named sponsoring organization and no unapproved surfaces. Individual
buildings can add rules; [residence halls require prior approval](https://www.umass.edu/living/your-residential-experience/policies).
The flyers identify InternScout as an independent student project rather than a university service.
