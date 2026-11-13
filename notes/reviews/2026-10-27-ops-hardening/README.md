# October 27 operational hardening

This change set fixes three source-controlled readiness gaps and records the boundary around the
fifth. It does not claim that an external service or installed browser extension was exercised.

## Fixed in source

- `/privacy` and `/terms` now declare the clean URLs already present in `sitemap.xml` as their
  canonical and Open Graph URLs. A site test prevents the `.html` aliases from returning.
- The weekly digest has noon and 1 p.m. UTC Monday triggers. A standard-library guard runs only the
  trigger that is 8 a.m. in `America/New_York`, including after daylight-saving changes. Catch-up
  and automation-health calculations now use the same local-time rule.
- A rejected or unreachable IndexNow batch now fails the post-deploy notification job while leaving
  the already-successful Pages deployment intact. HTTP 200 and 202 remain accepted.

## Response-header boundary

The live site returned `Server: GitHub.com` on October 27, 2026, and the apex resolved directly to
GitHub Pages addresses. GitHub Pages does not apply a repository `_headers` file. Committing one
would therefore look fixed in source while changing no live response.

HSTS, CSP, `X-Content-Type-Options`, framing protection and `Referrer-Policy` remain a hosting or
edge-configuration task. A real implementation needs one of these before it can be verified:

1. proxy `internscout.org` through an edge that adds and tests the headers; or
2. move the static deployment to a host that supports response-header configuration.

Do not enable a strict CSP by guesswork. First collect every required first- and third-party script,
image, font, form and API origin, then stage the policy in report-only mode if the chosen edge
supports it. Verify headers on representative HTML, JavaScript, JSON and font responses after the
hosting change.

## External acceptance gates still open

These require controlled, owner-observed checks and are not made true by unit tests:

- install the exact public Chrome package, sign in with Google and a personal Microsoft account,
  then confirm an ordinary update preserves the account and local profile;
- run Stripe's controlled test-mode checkout, asynchronous payment, dispute, cancellation and
  recovery paths with the production key permissions mirrored safely;
- restore an isolated Worker/D1 backup and compare schema and representative records;
- measure repeat mobile and desktop Core Web Vitals, including cold and throttled loads;
- confirm the weekly digest reaches a real inbox with SPF, DKIM and DMARC passing.

No real application, charge, refund, email broadcast, account permission or production setting was
changed by this work.
