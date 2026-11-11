# P-3.3 resume-first onboarding

First-run setup opens on Resume. Choosing a file reveals the existing sign-in and reading controls. The reader waits for the in-page sign-in and restore flow to finish, then uses the existing resume request. An import result is discarded if the local store was restored or the resume changed in the meantime. The imported profile shows contact details and the populated sections before the existing finish button. Contact and full profile corrections use the existing editors. Returning students still start on Review, and explicit step links still work.

The browser evidence uses a clean local Edge context, a synthetic text file and profile, and mocked sign-in, resume reading and account restore. The before phase uses onboarding source from `8c352e25`. The after flows exercise Enter for sign-in and both correction controls, with a held sign-in response to verify that session notification alone cannot start a read. They edit and reload a contact value, open the existing profile editor, and verify the returning-student entry. One narrow dark run holds an AI reply across a synthetic restore and verifies that the older reply does not touch the restored profile. It also switches from Setup to Resume during sign-in and checks that the read button enables once the reply arrives. The proof checks document width, page errors and unexpected requests.

| Width/theme | Before entry | After entry | Before import | After import |
|---|---|---|---|---|
| 1280 light | [Entry](before-1280-light-entry.png) | [Entry](after-1280-light-entry.png) | [Imported](before-1280-light-imported.png) | [Imported](after-1280-light-imported.png) |
| 1280 dark | [Entry](before-1280-dark-entry.png) | [Entry](after-1280-dark-entry.png) | [Imported](before-1280-dark-imported.png) | [Imported](after-1280-dark-imported.png) |
| 375 light | [Entry](before-375-light-entry.png) | [Entry](after-375-light-entry.png) | [Imported](before-375-light-imported.png) | [Imported](after-375-light-imported.png) |
| 375 dark | [Entry](before-375-dark-entry.png) | [Entry](after-375-dark-entry.png) | [Imported](before-375-dark-imported.png) | [Imported](after-375-dark-imported.png) |

Set `CAPTURE_TOOLS` to local tooling with `playwright-core` and run `node notes/product/screenshots/P-3.3/capture.cjs before` or `after` from the repository root. Node 22 extension suite 348 passed. Both extension packaging tests, targeted ESLint, startup report and diff check passed. Bruce owns extension merge and release.
