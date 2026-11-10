# P-1.7c digest footer evidence

**Email wording is unapproved. PR #202 stays open and needs-bruce.** The proposed link
label is exactly **Internships for every major on GitHub** and its destination is
`https://github.com/bpmcginley/internships-every-major`. HTML contains one footer
anchor; plain text contains the same label followed by `: ` and the URL.

This adds only that link between the existing affiliation paragraph and the existing
subscription-reason/unsubscribe paragraph. No provider, sender, subscriber,
unsubscribe-token, address-handling, subject, role-selection, or tracking logic changes.

## Synthetic previews

The fixture contains three invented roles with explicitly named Fixture employers
and reserved example-domain URLs. It contains no recipient or personal information.
No postal address is supplied: the template's existing
`[POSTAL ADDRESS REQUIRED BEFORE SENDING]` warning remains visible. It is not an
operator address or a claim that sending is configured.

The before renderer is `e009644f:growth/digest.py`; after uses this PR. `render.py`
checks that removing exactly the new footer line from each after output reproduces
the complete corresponding before output byte for byte. Rendered HTML and plain
text are included for inspection. No sender function is called.

| Width | Before | After |
|---|---|---|
| 1280 | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 375 | [Before](before-375-light.png) | [After](after-375-light.png) |

The email template explicitly declares light-only color schemes and contains no
dark-mode variant. Captures use isolated headless Edge contexts at 1280 × 1000 and
375 × 1000, device scale 1, locale en-US, light color scheme. Every browser request
is blocked; zero requests and zero page errors occurred. The preview makes no
claim about rendering in every email client. No link navigation or mail sending
was performed.

Both widths show no horizontal overflow. The new anchor has the exact label and
destination and accepts keyboard focus. Tab proceeds from it to the unchanged
Unsubscribe anchor; the token remains `{{ unsubscribe_url }}`. The original
subscription reason and missing-address warning remain visible.

## Reproduction and validation

```powershell
python notes/product/screenshots/P-1.7c/render.py
$env:CAPTURE_TOOLS = 'C:\path\to\isolated-tools'
node notes/product/screenshots/P-1.7c/capture.cjs
```

The isolated tools directory must contain `node_modules/playwright-core`; the
capture uses the installed Edge executable with a fresh browser context. No
dependency is added to the product.

Baseline digest-rendering and mocked-sender tests: 97 passed. With five focused
footer cases, 102 tests passed. Cases cover HTML/plain-text parity, selected-field
and fallback variants, unchanged input objects, unchanged unsubscribe/reason/address
handling, escaped synthetic HTML, and rejection of unsafe application URLs. Scoped
Ruff checks passed. Final golden and CI outcomes are recorded in the PR.

The site startup report is not applicable: no dashboard, public site asset, or
startup-loading behavior changes. Golden fixtures are not refreshed. No email,
workflow dispatch, production API call, deployment, or extension release occurred.
