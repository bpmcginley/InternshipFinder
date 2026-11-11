# Dormant outbound Worker compatibility

The deployed runtime's native Request/fetch rejects `redirect: "error"` before any outbound request. This separate package changes exactly that option to `manual` in the dormant follow archive, top-up payment-evidence, reversal-evidence and checkout readers. Existing non-success response rejection prevents following redirects. The archive reader retains its configured-origin, exact response URL and canonical path checks. Stripe requests continue through the existing fixed API host, pinned version and secret-hiding adapter.

No request paths, methods, authentication, idempotency, read deadlines, byte limits, JSON validation or financial policy change. A redirected Checkout POST remains uncertain and cannot be retried here or produce an attached URL. No router, provider integration, schema, scheduler, workflow, employer/social handler or live binding changes. Exact user-visible strings changed: none. Screenshots and golden updates do not apply.

## Synthetic evidence

The pre-change focused Node baseline passed 41 tests, demonstrating that injected plain Responses did not detect the native option incompatibility. The new four Workers tests construct native Requests from each reader's exact options. They verify successful archive loading, authenticated checkout expiry evidence, complete reversal passes, price/create/open checkout, and redirect rejection. Credentials appear only on the fixed Stripe origin. The archive receives none. A redirected POST is invoked once, returns no URL and is not followed.

A separate network-free native Miniflare probe bundled the exact four modules and supplied an outbound service replacing every external request. An in-memory baseline variant changed only the redirect option back and reproduced all four failures before any outbound call. Corrected native fetch passed all four success paths. Redirect replies caused one request per reader and no request to the redirect destination. Redirected checkout creation made one price GET and one POST, then stopped. No actual provider request, payment, email, production database operation or deployment occurred.

Final validation: all 722 Node tests and 279 actual local Workers tests passed. JavaScript lint reports zero errors and warnings. Generated API check, whitespace and startup payload report passed. The package remains a draft `needs-bruce` for independent review, fresh checks and later coordinated integration. It does not activate dormant capabilities or change existing production configuration.
