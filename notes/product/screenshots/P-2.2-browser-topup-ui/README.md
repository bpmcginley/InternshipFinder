# Native top-up purchase evidence

Eight real Edge screenshots pair the `baf163d8` native allowance/dashboard modules with this package at 1280 and 375 pixels wide, light and dark, in isolated browser contexts. The viewport is 1100 pixels high and positioned at the allowance panel. All resources are fulfilled from local source/fixtures; even the verified Stripe URL is intercepted and fulfilled locally. No payment, provider or production account/API is contacted. The pre-existing Cloudflare beacon attempt is blocked and recorded rather than represented as an outgoing successful request.

`capture.cjs` serves the repository's synthetic P-1.3 role fixture and local React/ReactDOM builds, with synthetic Worker config/session/allowance/offer/checkout responses. A local message responder reports no installed extension so the unrelated extension probe settles consistently in both phases. To reproduce, pass a temporary directory containing exact `git show baf163d8:docs/js/app/allowance.mjs` and `dashboard.mjs` baseline bytes. Playwright Core and Edge are external local tooling, not repository dependencies. Static public summary assets remain the checked-in source baseline; synthetic role rows and Worker values are not measurements of production.

`report.json` records 17 scenarios: eight width/theme/phase captures, capability absent, allowance remaining, paused, anonymous, offer error, late checkout after panel dismissal, late checkout after sign-out, invalid checkout URL and verified locally intercepted navigation. Every after matrix case uses Enter to activate Buy, receives synthetic HTTP 202, verifies only the approved unavailable text, retains keyboard focus on the same action, and retries a new offer. The action has a 44-pixel minimum height. No horizontal overflow or browser JS errors were observed. Automated checks inspect DOM live-region semantics; no screen reader execution is claimed.

| View | Before | After |
| --- | --- | --- |
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

Normal integration uses main `54b9aa16`. The paired images were recaptured from that tree; baseline allowance/dashboard bytes remain `baf163d8`, which match main for those modules. The separate tagged-lock correction is covered by the actual dashboard callback regression, preserving legacy request supersession.
