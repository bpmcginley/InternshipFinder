# Top-up public disclosure evidence

Base: `6827576b64790afc2a4a659a316a5a983beb29bb`. `capture.cjs` loads the exact baseline HTML via Git for before images and the owned working HTML for after images. It uses fresh unauthenticated Edge contexts, locally fulfilled resources and blocked external requests. Nothing is submitted or sent. The existing anonymous counter attempts are blocked.

Each pair has a 1280- or 375-pixel viewport width and a 1100-pixel viewport height. The image is a full-height section crop at that width, so long mobile copy is readable. Before shows the adjacent existing paid-plan section, since the top-up section did not exist. After shows the entire added top-up section. Light and dark use the existing media query. All 16 renders have no horizontal overflow or page errors. Representative mobile dark privacy and desktop light terms were visually inspected.

| Page | Width | Light before / after | Dark before / after |
|---|---|---|---|
| Terms | 1280 | [Before](before-terms-1280-light.png) / [After](after-terms-1280-light.png) | [Before](before-terms-1280-dark.png) / [After](after-terms-1280-dark.png) |
| Terms | 375 | [Before](before-terms-375-light.png) / [After](after-terms-375-light.png) | [Before](before-terms-375-dark.png) / [After](after-terms-375-dark.png) |
| Privacy | 1280 | [Before](before-privacy-1280-light.png) / [After](after-privacy-1280-light.png) | [Before](before-privacy-1280-dark.png) / [After](after-privacy-1280-dark.png) |
| Privacy | 375 | [Before](before-privacy-375-light.png) / [After](after-privacy-375-light.png) | [Before](before-privacy-375-dark.png) / [After](after-privacy-375-dark.png) |

Run `node notes/product/screenshots/P-2.2al/capture.cjs` with isolated Playwright tooling available in the same temporary directory used by earlier product captures. `build-proof.py` runs the actual offline synthetic publisher twice and writes `build-results.json`, without refreshing the shared golden pair. The report proves that only the two intended policy pages change across all 836 output files. No production listing data or credentials enter the fixture.
