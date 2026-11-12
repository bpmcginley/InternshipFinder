# Optional employer Follow evidence

The real normal employer model/renderer generates the paired synthetic Fixture Labs page through a test-only selector injection. The source build has no production opt-in. Other fixture pages remain exact; the fixture employer is thin/noindex both before and after. Eight PNGs show the existing list area before and the optional form after at1280/375 light/dark.

```powershell
python notes/product/screenshots/P-2.1cu/build_fixture.py SCRATCH_DIRECTORY
npm exec --offline --package=node@22.23.4 -- node notes/product/screenshots/P-2.1cu/capture.cjs SCRATCH_DIRECTORY
```

Use the existing isolated local Playwright tools and Edge. The capture intercepts every request and uses local checked-in modules/fonts; no dependencies are copied or downloaded. Public facts and email are invented fixtures. No auth/storage reads or real signup occur. The actual employer HTML and browser module are exercised together, not a screenshot mockup.

`report.json` records12 fresh-context scenarios: eight normal width/theme/page pairs and four module-dependency/setup/admission failures. Default page requests no Follow module; enabled module loads only first-party imports. Native Enter/focus, Escape,44px controls, exact anonymous empty202 and malformed200, stale selection/abort are exercised. Failures expose no native email input or submission surface. `artifacts.json` proves847 golden paths and exact unchanged employer/default HTML. Raw dependency coherence must be verified separately at future activation.

Correction: four actual Edge Back returns assert `pageshow.persisted === true`, with a fresh closed/empty form after restore. A separate forced pagehide/pageshow while a synthetic response is held confirms the stale receipt cannot update the new form. All eight PNG bytes remain exact to `be634d5f`. Playwright waits for navigation commit, since BFCache restoration does not emit a new load event.

The pre-populated-host case confirms an initially rejected host cannot gain a form after it is emptied and receives persisted pageshow. Only original successful mounts participate in restoration.
