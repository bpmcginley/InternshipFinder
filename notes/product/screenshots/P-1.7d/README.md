# P-1.7d README opening evidence

These are local rendered Markdown previews, **not GitHub UI or live listing counts**. They use the repository's synthetic golden listing fixture, a frozen November 10, 2026 clock, Mistune 3.1.4, local CSS and system fonts. Fresh headless Edge contexts use 1280×1000 and 375×1000 viewports, light and dark preferences, locale en-US and America/New_York. Requests outside the single local preview route are blocked; none occurred. Screenshots show the first screen rather than the entire long README.

| Width / theme | Before (`e009644f`) | After |
|---|---|---|
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

Measured in this fixture: at 375 px the Contents heading moves from y=725 to y=637, and the star prompt appears at y=429. At 1280 px Contents moves from y=375 to y=383 because the shorter opening uses separate paragraphs and includes the new star line. Both widths have no document overflow; unchanged wide tables scroll within their own bounds. These measurements describe this local renderer, not GitHub's layout.

Both builds are deterministic. The ten field Markdown files are byte-identical; the README from `## Contents` onward is byte-identical. The README shrinks from 67,001 to 66,713 bytes, below its unchanged 450,000-byte budget. Counts here come only from synthetic data. Existing tests also exercise budget shrinking with larger data, routes and escaping. The site golden checker still matches all 695 files; neither golden artifact changed.

Reproduce with Mistune 3.1.4 in a separate temporary Python target and playwright-core in the isolated `internscout-product-capture-tools` temporary directory (no repository dependency changes):

```powershell
$env:PYTHONPATH="$env:TEMP/internscout-product-markdown-preview"
python notes/product/screenshots/P-1.7d/render_preview.py before "$env:TEMP/internscout-product-capture-tools/p17d-preview" e009644f
python notes/product/screenshots/P-1.7d/render_preview.py after "$env:TEMP/internscout-product-capture-tools/p17d-preview"
node notes/product/screenshots/P-1.7d/capture.cjs "$env:TEMP/internscout-product-capture-tools" "$env:TEMP/internscout-product-capture-tools/p17d-preview" 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

[Machine measurements](measurements.json) contain no live data. Rendering and browser capture do not publish files or contact GitHub/employers. The generator's separate repository publication remains needs-bruce.
