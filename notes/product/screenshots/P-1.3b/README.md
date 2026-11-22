# P-1.3b native dashboard evidence

The before archive is exact main `7b7c1617` (byte-identical to the previously qualified #557 archive). After is this package's stamped golden output. Listings, counts and responses are synthetic fixtures. The shipped Follow flag remains absent. Fresh isolated Edge contexts use local pinned React packages, local fonts/assets and intercepted API/analytics responses; all other network destinations are blocked.

Run `node capture.cjs BEFORE_DIR AFTER_DIR` with Node 22 and the existing isolated Playwright installation. Each capture centers the actual empty-results sentence, without changing its DOM or CSS. Both known `swe` and normal unknown `future_field` controls retain their labels. All 32 checks pass, with no page errors or new external traffic; corrected phone layouts have no horizontal overflow.

| Key / size / theme | Before | After |
|---|---|---|
| `constructor` / 1280 / light | [Before](before-constructor-1280-light.png) | [After](after-constructor-1280-light.png) |
| `constructor` / 1280 / dark | [Before](before-constructor-1280-dark.png) | [After](after-constructor-1280-dark.png) |
| `constructor` / 375 / light | [Before](before-constructor-375-light.png) | [After](after-constructor-375-light.png) |
| `constructor` / 375 / dark | [Before](before-constructor-375-dark.png) | [After](after-constructor-375-dark.png) |
| `__proto__` / 1280 / light | [Before](before-__proto__-1280-light.png) | [After](after-__proto__-1280-light.png) |
| `__proto__` / 1280 / dark | [Before](before-__proto__-1280-dark.png) | [After](after-__proto__-1280-dark.png) |
| `__proto__` / 375 / light | [Before](before-__proto__-375-light.png) | [After](after-__proto__-375-light.png) |
| `__proto__` / 375 / dark | [Before](before-__proto__-375-dark.png) | [After](after-__proto__-375-dark.png) |

Only the erroneous field label changes: the constructor function string becomes `constructor`, and `[object Object]` becomes `__proto__`. Surrounding copy and controls are unchanged.
