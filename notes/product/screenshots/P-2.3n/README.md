# Optional generated posting keys: local evidence

These are synthetic local pages with 30 fake public roles, not live employer data. `prepare.py ABSENT_TEMP_DIRECTORY` uses the actual complete-export stage and page runtime to produce the ordinary build and an explicitly opted-in build. `capture.cjs TEMP_DIRECTORY` opens those files in fresh headless Edge contexts at 1280 and 375 pixels wide, 1000 pixels tall, with light and dark themes. Existing local fonts and scripts are served from disk. Every external request is intercepted and aborted, including keyboard-activated synthetic posting destinations. No provider or production application was contacted.

All eight before/after PNG pairs are byte-identical. The 16 capture cases passed identical visible text, link URLs/rel/target and link geometry checks, with no horizontal overflow or page errors. Every ordinary Open posting link receives the attribute only in the opt-in build; the separate highest-paying path is covered. Auto-Apply anchors remain unmarked and the existing offer script remains included. Enter on the focused first posting link opens its existing target in a new tab; its request is intercepted. This is browser/DOM evidence, not screen-reader execution or live counting. Source and unit tests separately cover paid exclusion, catalog validation, changed posting identity and legacy facade compatibility.

No new visible copy. No golden refresh: the production input remains absent. The public digest examples are outside this slice because their renderer has no role-ID association and is actively owned by #373.

Reproduce using the repository Python test dependencies plus isolated `playwright-core` and Edge. The scripts take a temporary output path; no generated public pages are committed.

| Page, width, theme | Before | After |
|---|---|---|
| field, 1280, light | [Before](before-field-1280-light.png) | [After](after-field-1280-light.png) |
| field, 1280, dark | [Before](before-field-1280-dark.png) | [After](after-field-1280-dark.png) |
| field, 375, light | [Before](before-field-375-light.png) | [After](after-field-375-light.png) |
| field, 375, dark | [Before](before-field-375-dark.png) | [After](after-field-375-dark.png) |
| pay, 1280, light | [Before](before-pay-1280-light.png) | [After](after-pay-1280-light.png) |
| pay, 1280, dark | [Before](before-pay-1280-dark.png) | [After](after-pay-1280-dark.png) |
| pay, 375, light | [Before](before-pay-375-light.png) | [After](after-pay-375-light.png) |
| pay, 375, dark | [Before](before-pay-375-dark.png) | [After](after-pay-375-dark.png) |
