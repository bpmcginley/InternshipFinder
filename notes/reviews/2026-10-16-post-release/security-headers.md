# Response-header rollout candidate

Prepared for review, not deployed. The October 16 homepage HEAD response had no HSTS, CSP,
nosniff, framing or referrer-policy header. The origin identified itself as GitHub.com. DNS nameservers
are Cloudflare's; this does not establish whether the web records are proxied or whether the account
has a response-header rule available. Do not change DNS, proxying, certificates or existing rules
merely to clear an audit score.

The adjacent JSON is **one rule candidate**, not a complete ruleset to overwrite. If the website is
already proxied, inspect its existing response-header rules and add/merge this one for the apex host
only. Otherwise review the traffic-routing and TLS change with the owner before enabling a proxy.
Leave mail, API and other subdomains alone. No new paid service or reporting collector is proposed.

Initial enforced headers: nosniff, strict-origin-when-cross-origin, SAMEORIGIN framing and five-minute
HSTS without includeSubDomains or preload. CSP starts Report-Only, so its incomplete allowlist cannot
break the site. There is no report endpoint and no request/identity logging added by this candidate.
Do not claim CSP is enforced or the live headers are fixed until actual response checks pass.

Before applying, verify Cloudflare's current rule shape and existing configuration. After applying,
check HTTPS and HTTP redirect behavior on the home, install, digest and generated pages; script/font
content types; search and filters; Google and personal Microsoft sign-in; Buttondown form navigation;
voice/file features; and extension-to-dashboard communication. Review report-only console violations,
then tighten the allowlist and separately review enforcement. Increase HSTS duration only after the
HTTPS paths are verified. Remove the new rule to roll back; the initial HSTS lifetime is five minutes.

Primary references:
- https://developers.cloudflare.com/rules/transform/response-header-modification/
- https://developers.cloudflare.com/rules/transform/response-header-modification/create-api/

This is independent of the paid-placement launch; PRs #119 and #132 are now merged.
