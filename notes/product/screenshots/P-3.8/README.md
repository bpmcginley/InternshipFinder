# P-3.8 install instructions for Chrome 0.6.0

The draft updates the public install guide and its HowTo structured data to
match the planned release. Setup opens on **Start with your resume**.
The guide shows **Choose resume**, **Continue to setup**, and then the Google
or Microsoft sign-in choices. It points readers to **Practice Auto-Apply**
after they turn on Auto-Apply. The existing by-hand instructions point to
the same setup flow and keep toolbar pinning optional.

Hold publication until signed 0.6.0 is available in the Chrome Web Store.

| View | Before | After |
| --- | --- | --- |
| 1280px, light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280px, dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375px, light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375px, dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

Chromium rendered the actual install page at device scale 1 with local fonts.
The before page comes from `f3cf022a`. The after page comes from this branch.
The browser verified no horizontal overflow at either width, one primary Store
link, and Enter opening and closing the permissions disclosure. All network
requests were intercepted with local files or blocked.

The offline golden archives both contain 836 files. Only `install.html` changed.
