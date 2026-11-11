# P-1.8 allowance arrival evidence

PR #211 is based on frozen #210 (`bb315b21`), retaining the #187/#193/#204 approval dependencies. It remains **needs-bruce** for the exact plan/invite wording and new session return flag. No worker or extension deployment, core change, top-up implementation or source cache-tag change is included.

## Behavior and evidence

The page recognizes `?out_of_runs=1` exactly, or an `?upgrade=` value actually present in enabled `/config` payment plans. Recognized keys alone are consumed. Unrelated query values, hash and history state remain intact; existing OAuth nonce checks and token stripping are unchanged. A plan arrival alone never proves exhaustion. A single allowance panel shows current account usage and remaining allowance separately, with distinct unlimited, paused, disabled, loading and failure states.

The worker's displayed limit includes used units and remaining bonus. Its value is not a monthly base. Exact free-tier and paid-edu config tables can additionally prove a disabled base; the paid-edu table is never applied to a paid-general account. A serialized disabled-base example with prior usage and bonus is covered. Unknown base remains neutral, with a per-run/service-limit caveat. Paused and disabled states do not offer an invite as a remedy.

The compact invite block is shared with the Account entry. It has an explicit Copy link action, an input-selection fallback when clipboard access fails, and distinct eligibility/cap, loading and retry copy. Current token and request-generation checks prevent old account, invite, clipboard and billing responses from affecting a newer account. Only an explicit configured plan choice can request checkout. An unanswered billing call clears busy after eight seconds; retry is manual, and a late response cannot redirect.

Loading, failure and ready allowance summaries share one persistent polite atomic status. Delayed configuration does not take focus from an active control. The first insertion compensates only the measured layout shift for the same connected, previously visible focused control. Browser evidence kept the search field at 658.578125px before and 658.953125px after insertion, with typing focus preserved. These are DOM/keyboard checks; no screen-reader execution is claimed.

## New storage for Bruce's review

`sessionStorage["internscout.allowance.return.v1"]` contains only `{show: true, expiresAt: <milliseconds>}`. It is written when a student starts sign-in with the allowance panel open, is valid for ten minutes, and is consumed and deleted on the next page load. An expired record may remain physically in the tab until the next read or tab close, but it cannot reopen the panel. Invalid or expired records are discarded. Dismissal, sign-out and successful data deletion clear it. Storage denial is caught. No URL, query, requested plan, referral, account identifier or credential is stored in this marker. The return intent opens the neutral panel using the current account and configuration.

## Aggregate counter meanings

All three events are named-only, with no payload, and deduplicated in page memory. Their existing P-0.2 disclosure/publication and operator-deployment gate remains unresolved; this PR deploys nothing.

- `out_of_runs_view`: the allowance panel intersects the viewport. It measures interest, including pricing arrivals, not proven monthly depletion.
- `out_of_runs_invite`: the first Get, Retry or Copy invite-link action inside this panel. It does not prove a successful copy, invite or reward. Normal Account actions do not emit it.
- `out_of_runs_plan`: an explicit plan choice inside the panel, after current-auth, loaded-account and configured-upgrade guards pass. It does not prove a checkout completion or payment. No top-up event is emitted.

## Test setup

Headless Microsoft Edge uses isolated contexts at 1280x1000 and 375x1000, light/dark, with synthetic listing, allowance, pricing, email and session fixtures. Every browser request is fulfilled locally. The browser executes the existing OAuth callback logic against synthetic/local auth responses; there are no actual provider, account, session, AI, employer or payment calls. The apparent prices, usage and identities in screenshots are invented test data, not an offer or business figures.

The capture script covers four before/after combinations and bonus, unlimited, pause, disable, disabled-with-prior-bonus, capped inviter, top-plan, failed allowance/invite/config retries, ignored invalid arrival, delayed old-account replies, delayed config while typing, stalled checkout/manual retry, and sign-in return with normal or blocked sessionStorage. Clipboard denial selects the real input. Arrival produces zero checkout requests; one explicitly chosen plan produces one locally intercepted request. Counter assertions check view/invite/plan meanings. There is no horizontal overflow or page error in the main matrix. A final `--config-only` regression verifies that ordinary anonymous browsing stays quiet when account configuration fails, while an unresolved upgrade arrival retains Retry and becomes validated after recovery. Dismissing a combined generic/upgrade arrival keeps the fallback error hidden. These three cases and all eighteen focused tests pass on the final guard; unchanged screenshots are retained.

Run with isolated `CAPTURE_TOOLS` containing playwright-core and React 18.3.1: `node notes/product/screenshots/P-1.8/capture.cjs before` or `after`. The browser never uses the user's profile.

Baseline: 294 site tests passed. Final full suite: 312 passed, including eighteen focused arrival tests and actual callback race/timeout tests. ESLint, pinned Prettier for the new test and the startup report pass. Full-suite and final CI/review outcomes are recorded in the PR. After the explicit #205 fixture-window release, both golden outputs were refreshed with this stacked branch harness. Both golden tests pass (2/2); all 695 archive hashes match the manifest, and only index.html and js/app.js differ from frozen #210. Fresh integration validation against stamped main still follows ancestor acceptance.

## Screenshots

| Width / theme | Before | After |
|---|---|---|
| 1280 / light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 / dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 / light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 / dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

Additional phone states: [bonus](after-bonus-375-light.png), [unlimited](after-unlimited-375-light.png), [paused](after-paused-375-light.png), [disabled](after-disabled-375-light.png), [disabled-prior-bonus](after-disabled-prior-bonus-375-light.png), [capped](after-capped-375-light.png), [top-plan](after-top-plan-375-light.png), [account-switch](after-account-switch-375-dark.png), [delayed-config](after-delayed-config-375-light.png).

## Exact new or revised visible copy

Dynamic braces below name values from the current validated response/config, not fixed promises.

- "Your Auto-Apply allowance" / "No Auto-Apply runs left in your allowance"
- "{used} Auto-Apply runs used this month; {left} runs left in your allowance." / "{used} Auto-Apply runs used this month; no monthly run limit."
- "Loading your allowance…" / "Refreshing your allowance…" / "Couldn't load your allowance." / "Retry allowance"
- "Monthly allowance resets on {resetDay} (UTC)."
- "Includes {bonus} extra runs. Extra runs do not expire."
- "AI use is temporarily paused. Search still works."
- "Auto-Apply is currently unavailable for this account."
- "Per-run and other service limits can still apply."
- "Sign in to see your allowance, invite link and available plans. Searching stays free without sign-in."
- "Loading sign-in options…"; provider buttons retain "Sign in with {provider}".
- "Couldn't load account options." / "Retry account options"
- "Available plans" / "Loading plan options…" / "Plan options could not be loaded." / "No plan upgrade is available for this account."
- Plan buttons: "{configured label} · {configured price}" (price omitted when absent).
- "Optional monthly plans. Checkout opens only when you choose a plan. Cancel any time."
- "Not now"
- "Auto-Apply allowance options are open." (polite, visually hidden announcement)
- "Invite a classmate" / "Invite a classmate: share extra runs"
- "New classmates who join through your link with a verified .edu email in their first week can get extra AI use. Load your link to check your reward eligibility."
- "You each get {bonusWords}." / "Your invite reward limit is reached. Eligible new classmates can still get {bonusWords}; you will not receive more invite rewards."
- "For classmates with a verified .edu email, in their first week. Your rewarded invites: {rewarded} of {max}."
- Bonus words: "{units} extra {task label}", joined with " and " for supported positive bonuses.
- "Your invite link" (input accessible label)
- "Get my invite link" / "Loading invite link…" / "Retry invite link" / "Copy link"
- "Couldn't load your invite link. Try again." / "Link copied" / "Select the link and copy it. Clipboard access is unavailable."
- Account entry description: "New .edu classmates can earn extra AI use. Check your reward eligibility."
- "Couldn't open billing. Try again."
- "Checking your updated plan…" / "You're on the {plan} plan." / "Your plan has not updated yet. Retry your allowance in a minute."

Existing server billing errors may still appear verbatim through the existing error path. Other published plan values and pricing wording are unchanged.
