# Native dashboard annotation evidence

Synthetic local Edge capture for [#419](https://github.com/bpmcginley/InternshipFinder/pull/419). `prepare.py` runs the existing frozen public export fixture and actual employer-key staging once, then copies that same export into both trees. Before uses native rows from `f73efa65`; after uses the claimed source change. The local saved-only fixture deliberately contains a forged key, which the existing tracker drops. The paid fixture uses an actual synthetic current row.

`capture.cjs` fulfills local assets/config and locally installed React, aborts other destinations, and blocks all external posting navigation. No production request, provider account, real profile, AI invocation or submission is involved. Run preparation into a new absent temporary directory, then pass that directory to the capture script. No repository fixture or golden files are written.

Measured: native Browse has 150 annotated organic anchors after and zero before. My list has two current-export annotations after, including a known Closed row, and no annotation on the unavailable saved-only row. Every before/after visible-text, href/target/rel and geometry comparison passes; there is no horizontal overflow. All eight PNG pairs are byte-identical. Keyboard Enter opens the same posting target into a blocked popup, Space unsaves and restores listing focus. A separate search exercises one visible paid placement and the keyboard-opened Auto-Apply install explainer: neither gains an employer annotation. The capture flag is absent and `/hit` is never called. No screen-reader execution is claimed. `report.json` records the cases.

| View | Width/theme | Before | After |
| --- | --- | --- | --- |
| browse | 1280 / light | [Before](before-browse-1280-light.png) | [After](after-browse-1280-light.png) |
| browse | 1280 / dark | [Before](before-browse-1280-dark.png) | [After](after-browse-1280-dark.png) |
| browse | 375 / light | [Before](before-browse-375-light.png) | [After](after-browse-375-light.png) |
| browse | 375 / dark | [Before](before-browse-375-dark.png) | [After](after-browse-375-dark.png) |
| my-list | 1280 / light | [Before](before-my-list-1280-light.png) | [After](after-my-list-1280-light.png) |
| my-list | 1280 / dark | [Before](before-my-list-1280-dark.png) | [After](after-my-list-1280-dark.png) |
| my-list | 375 / light | [Before](before-my-list-375-light.png) | [After](after-my-list-375-light.png) |
| my-list | 375 / dark | [Before](before-my-list-375-dark.png) | [After](after-my-list-375-dark.png) |
