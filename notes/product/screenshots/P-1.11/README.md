# P-1.11 screenshots

Captured in fresh headless Edge contexts, 900px high, at 1280px and 375px widths in light and dark schemes. All external requests were blocked. Install captures use the actual local page; offer captures load the actual offer.js into a deterministic listing fixture with an invented employer and no navigable application. Fonts and theme tokens come from local site assets.

`before-*` uses source from c6ef372f. `after-*` uses this PR. All main captures are desktop pointer contexts, including the narrow 375px offer: touch-only/mobile browsers remain ineligible for the offer. The offer copy is one line at 1280px and wraps at 375px.

Each component/scheme/width has before and after captures. Additional `after-offer-expanded-*` captures show keyboard focus and the opened permissions; `after-install-demo-*` shows the explicit unavailable-demo placeholder, not a video or play control.

Browser checks passed: no horizontal overflow at either width, Enter opens native permission disclosures, expanded offer height updates root scroll padding, and Escape dismisses the offer and returns focus to the posting. Existing automated tests cover dismissal/session eligibility and original scroll padding restoration.

No real listing, profile, account, employer request, analytics request or extension installation was used.
