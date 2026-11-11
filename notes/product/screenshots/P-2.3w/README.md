# P-2.3w local publisher capture evidence

Synthetic golden export only. Two real full publisher builds use `--employer-postings`; only the after build adds `--employer-posting-capture`. Both then use the ordinary asset and link stages. No golden baseline is refreshed. No live catalog, employer or provider is contacted.

Fresh isolated Edge contexts render the dashboard, Software Engineering and highest-paying pages at 1280 and 375 pixels, light and dark. All requests are intercepted: local files replace site/CDN assets, API responses are synthetic, posting destinations are blocked, and all counter bodies are collected locally. The harness explicitly overrides automated-browser exclusion solely to test trusted synthetic keyboard clicks against the real counter. It waits for the existing extension-absence handshake before comparing settled dashboard layout.

All 24 captures passed: 12 before/after PNG pairs are byte-identical, as are visible text, link semantics/bounds and the set of initial request URLs. No horizontal overflow or page error. On each surface, two keyboard Enter activations produce zero employer events before and exactly one `{e: "employer_posting_open", c: <synthetic public key>}` afterward. Paid posting activation leaves that count unchanged; paid links remain unannotated. An actual `?nocount=1` navigation suppresses the event in every context. These are browser/protocol tests, not real submissions, screen-reader results or production traffic.

[Browser report](report.json) · [Exact output delta](output-report.json)

| Surface / width / theme | Before | After |
|---|---|---|
| dashboard, 1280, light | [Before](before-dashboard-1280-light.png) | [After](after-dashboard-1280-light.png) |
| dashboard, 1280, dark | [Before](before-dashboard-1280-dark.png) | [After](after-dashboard-1280-dark.png) |
| dashboard, 375, light | [Before](before-dashboard-375-light.png) | [After](after-dashboard-375-light.png) |
| dashboard, 375, dark | [Before](before-dashboard-375-dark.png) | [After](after-dashboard-375-dark.png) |
| field, 1280, light | [Before](before-field-1280-light.png) | [After](after-field-1280-light.png) |
| field, 1280, dark | [Before](before-field-1280-dark.png) | [After](after-field-1280-dark.png) |
| field, 375, light | [Before](before-field-375-light.png) | [After](after-field-375-light.png) |
| field, 375, dark | [Before](before-field-375-dark.png) | [After](after-field-375-dark.png) |
| pay, 1280, light | [Before](before-pay-1280-light.png) | [After](after-pay-1280-light.png) |
| pay, 1280, dark | [Before](before-pay-1280-dark.png) | [After](after-pay-1280-dark.png) |
| pay, 375, light | [Before](before-pay-375-light.png) | [After](after-pay-375-light.png) |
| pay, 375, dark | [Before](before-pay-375-dark.png) | [After](after-pay-375-dark.png) |

Reproduction: run `python -m pytest backend/tests/test_employer_capture.py -q --basetemp <new-temporary-directory>`, then Node 22 `capture.cjs <temporary-directory>/test_actual_capture_changes_on0`. Use the established isolated `internscout-product-capture-tools` dependencies and installed Edge. The screenshot harness writes only this package evidence. Never point its input at production data or allow network passthrough.

Validation: baseline publication/staging tests 18 passed; final capture suite 35 passed; the broader publisher/default-golden run passed 37 tests (before the last additional conservative negative case). Both default golden checks passed without refreshing either artifact. The earlier Node 22 serial site suite passed 351 tests; public JavaScript and valid output bytes remain unchanged. Both 837-file before/after trees match the prior reviewed evidence exactly. Against annotation-only output, exactly 577 HTML files differ by one script attribute; all other files match. The allowlist reports 837 checked / zero problems. Scoped Ruff lint/format and Git diff checks pass. The synthetic startup payload report is a byte estimate, not field performance.

The second independent review reproduced browser authority aliases that Python URL parsing classified differently. The correction uses a fail-closed lexical counter-filename check without trusting authority parsing. [Six native Edge regressions](alias-report.json) prove each exact reported alias resolves to the canonical URL and executes two harmless intercepted script doubles beside the canonical script, while the actual Python guard rejects every pair. Run `node notes/product/screenshots/P-2.3w/aliases.cjs` from this checkout. The mock HTML explicitly declares UTF-8 so the fullwidth-host case exercises the intended Unicode input. No network traffic is allowed.
