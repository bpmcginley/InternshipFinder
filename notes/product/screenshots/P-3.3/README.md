# P-3.3 resume-first onboarding

First-run setup opens on Resume. Choosing a file reveals the existing sign-in and reading controls. The reader waits for confirmed sign-in on InternScout's AI, then uses the existing resume request. The imported profile shows contact details and the populated sections before the existing finish button. Contact and full profile corrections use the existing editors. Returning students still start on Review, and explicit step links still work.

The browser evidence uses a clean local Edge context, one synthetic text file and one mock provider response in each flow. The before phase uses onboarding source from `8c352e25`. No profile, real sign-in, application, provider or external request is used. The after flows also exercise Enter for sign-in and both correction controls, edit and reload a contact value, open the existing profile editor, and verify the returning-student entry. The proof checks document width, page errors and unexpected requests.

| Width/theme | Before entry | After entry | Before import | After import |
|---|---|---|---|---|
| 1280 light | [Entry](before-1280-light-entry.png) | [Entry](after-1280-light-entry.png) | [Imported](before-1280-light-imported.png) | [Imported](after-1280-light-imported.png) |
| 1280 dark | [Entry](before-1280-dark-entry.png) | [Entry](after-1280-dark-entry.png) | [Imported](before-1280-dark-imported.png) | [Imported](after-1280-dark-imported.png) |
| 375 light | [Entry](before-375-light-entry.png) | [Entry](after-375-light-entry.png) | [Imported](before-375-light-imported.png) | [Imported](after-375-light-imported.png) |
| 375 dark | [Entry](before-375-dark-entry.png) | [Entry](after-375-dark-entry.png) | [Imported](before-375-dark-imported.png) | [Imported](after-375-dark-imported.png) |

Set `CAPTURE_TOOLS` to local tooling with `playwright-core` and run `node notes/product/screenshots/P-3.3/capture.cjs before` or `after` from the repository root. Node 22 extension suite 348 passed. Both extension packaging tests, targeted ESLint, startup report and diff check passed. Bruce owns extension merge and release.
