# P-4.4d paired advisor artifact evidence

Synthetic listing fixture and synthetic Buttondown action only. `prepare.py` invokes the normal `scripts.make_og_image --site` entry, then the existing asset-version pass. The before artifact omits the flag; after uses the single existing `--advisor-signup` flag. The fresh rollback omits it again and matches every before byte. Enabled artifacts differ only in two weekly pages, page-content-dates.json and privacy.html. This package changes no form renderer; form captures document the existing feature's off/on states alongside the newly coupled privacy artifact.

Reproduce from this checkout: `python notes/product/screenshots/P-4.4d-artifact/prepare.py <new-external-temporary-directory>`, then `node notes/product/screenshots/P-4.4d-artifact/capture.cjs <same-directory>`. Playwright Core uses the isolated existing capture-tool directory and installed Edge. No production action is contacted. Every request is fulfilled locally or blocked, including all eight synthetic POSTs. No real email or provider identifiers are used.

Four isolated Edge contexts cover 1280/375 and light/dark. Sixteen fresh captures show form and privacy before/after; no prior images are reused. The unchanged form is initially unchecked, has only the advisor tag, retains native new-tab POST and confirms checked/unchecked FormData. Keyboard Space, unchanged browser storage, no page errors or horizontal overflow, actual Details link to the same artifact's /privacy#digest and fresh rollback absence all pass. The privacy viewport starts at the existing address-custody paragraph so the exact added sentence pair is legible. The phone-dark and desktop-light privacy captures and opposite-theme form captures were inspected directly.

The sole new visible string relative to #479 is: "If you choose Subscribe as an advisor, your email address and an advisor tag go directly to Buttondown. Buttondown stores the tag to identify subscribers who advise students." Exact #328-approved copy; surrounding policy markup/text is byte-preserved. The form retains all #479 words unchanged.

| Width / theme | Form before | Form after | Privacy before | Privacy after |
|---|---|---|---|---|
| 1280 / light | [before](./before-form-1280-light.png) | [after](./after-form-1280-light.png) | [before](./before-privacy-1280-light.png) | [after](./after-privacy-1280-light.png) |
| 1280 / dark | [before](./before-form-1280-dark.png) | [after](./after-form-1280-dark.png) | [before](./before-privacy-1280-dark.png) | [after](./after-privacy-1280-dark.png) |
| 375 / light | [before](./before-form-375-light.png) | [after](./after-form-375-light.png) | [before](./before-privacy-375-light.png) | [after](./after-privacy-375-light.png) |
| 375 / dark | [before](./before-form-375-dark.png) | [after](./after-form-375-dark.png) | [before](./before-privacy-375-dark.png) | [after](./after-privacy-375-dark.png) |

Validation: 115 advisor/build/widget/golden cases pass, including real entry + stamping, malformed anchor rejection before writes, both newline styles, exact surrounding bytes and fresh changed-catalog rollback. Default golden artifacts are unchanged. Provider settings, live signup and post-G3 publication remain unqualified.

Exact parent #479 enabled build versus the new enabled build differs only in privacy.html: every other generated/stamped byte is identical, including both form pages. Both used the same synthetic fixture, actual share-card entry and asset stamping. [Byte proof](parent-parity.json). All 400 serial Node 22 site checks also pass.

The post-review structural/empty-catalog correction preserves every byte of all three valid fixture artifacts (before, after, rollback). Existing sixteen images and native browser evidence therefore remain exact. New negative tests fail before output for invisible headings/items, empty advisor sets and missing/hidden controls on any weekly page.

Native Edge independently verified that wrapping the disclosure in closed details or dialog hides it (adding open restores visibility), and wrapping the advisor checkbox in a disabled fieldset makes it disabled. Five publisher regressions now reject these containers before output. Fresh normal-entry/stamped before/enabled/rollback artifacts remain byte-identical; existing images remain exact.
