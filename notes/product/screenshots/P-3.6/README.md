# P-3.6 Deep Dive interview evidence

The paired captures show the Interview step immediately after leaving for Voice and returning while an answer is pending. The exact baseline is `628a960f`. Each pair uses synthetic content in an isolated Chrome context at 1280 or 375 pixels in light or dark mode.

| Width | Light | Dark |
| --- | --- | --- |
| 1280 | [Before](before-1280-light.png) Â· [After](after-1280-light.png) | [Before](before-1280-dark.png) Â· [After](after-1280-dark.png) |
| 375 | [Before](before-375-light.png) Â· [After](after-375-light.png) | [Before](before-375-dark.png) Â· [After](after-375-dark.png) |

The second set shows Finish & save stories while its profile write is held. Start over remains available until that write begins and is available again once the save settles.

| Width | Light | Dark |
| --- | --- | --- |
| 1280 | [Before](before-1280-light-finish-saving.png) · [After](after-1280-light-finish-saving.png) | [Before](before-1280-dark-finish-saving.png) · [After](after-1280-dark-finish-saving.png) |
| 375 | [Before](before-375-light-finish-saving.png) · [After](after-375-light-finish-saving.png) | [Before](before-375-dark-finish-saving.png) · [After](after-375-dark-finish-saving.png) |

The browser ran the actual onboarding modules and AI client. The harness intercepted every request, including the Worker POSTs, and supplied synthetic storage and replies. Each baseline replay sent two identical 3,273-byte bodies. The candidate sent one byte-identical 3,273-byte body. The original reply updates the current view and saved transcript. The pending keyboard attempts leave the next draft intact. The same replay checks a terminal request failure, an explicit retry of that exact body, the next answer, Start over while a prior reply write is held, and a profile restore during another held write. Returning after restore retains the saved answer and waits for Retry. Successful replies return focus to the current textarea. The held profile-save replay verifies that Start over is blocked across Voice and Interview navigation until the save settles. A separate replay starts over while the Finish model response is pending and verifies that its late result does not write stories.

The normal Deep Dive entry point focuses an existing matching tab. This proof covers one onboarding document. Concurrent first opens and manually opened tabs can produce separate documents. No live or paid calls occurred.

Set `CAPTURE_TOOLS` to a local directory with `node_modules/playwright-core`. Run `node notes/product/screenshots/P-3.6/capture.cjs before` and the same command with `after`. Set `VERIFY_ONLY=1` to run without writing screenshots. Set `INTERVIEW_BROWSER` to override the Chrome executable.
