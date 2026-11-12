# Advisor signup build browser evidence

Synthetic full-publisher outputs, captured in fresh headless Edge contexts at 1280 and 375 pixels in light/dark themes. `prepare.py` invokes the actual publisher with and without `--advisor-signup`, then copies the generated Computer Science weekly page. The fixture has no recent open roles; its date and count are synthetic, not production measurements. The two weekly-page output changes and content-date records are independently asserted by `test_advisor_signup_build.py`.

`capture.cjs` serves every page/font locally, intercepts the synthetic Buttondown action with a local confirmation, and blocks all other requests. All four contexts passed overflow, page-error, unchecked-by-default, keyboard Space, native FormData, new-tab target, no form analytics placement marker and unchanged storage checks. Eight synthetic submissions verified advisor checked/unchecked behavior; zero external requests were allowed. No actual signup or provider call occurred.

Reproduce with `python notes/product/screenshots/P-4.4c-build/prepare.py TEMP_OUTPUT`, then `node notes/product/screenshots/P-4.4c-build/capture.cjs TEMP_OUTPUT`. The capture uses the isolated temporary playwright-core tools directory; no browser dependencies are committed.

| Width/theme | Before | After |
|---|---|---|
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |
