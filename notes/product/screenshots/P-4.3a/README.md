# P-4.3a share and reload evidence

Before: main `8a8fbe74`. After: this package. Both use the same 300 invented listing fixture and actual stamped Pages build; these are not live openings or business measurements. Fresh isolated native Edge contexts at 1280 and 375 pixels, light and dark. React is fulfilled from local installed packages; all other outside requests are blocked (six per context across three page loads). No sign-in, provider request or real submission.

`capture.cjs BEFORE_SITE AFTER_SITE` selects Software, Finance, Mechanical, Biology, Health, Education and Arts with the actual keyboard picker, focuses Share search and presses Enter, opens the copied URL, then reloads. The original shares all seven but restores only six. The fix restores all seven in order. Eight captures show the restored filter control and results. The fixture result count changes from 174 to 203 because Arts survives. No horizontal overflow or page errors in any context. Screenshots were visually reviewed at both widths/themes.

| Width/theme | Before | After |
|---|---|---|
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

No user-visible strings changed. The existing labels reflect the correctly restored fields and fixture counts.
