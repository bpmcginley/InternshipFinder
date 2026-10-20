# Two-week student activation experiment

Execution window: October 20–November 2, 2026. Decision: November 3. Owner: Bruce.
This extends the existing [campaign kit](README.md), [campus kit](../OUTREACH.md),
[signup measurement procedure](../SIGNUP_MEASUREMENT.md) and five-student pilot in
`reviews/2026-10-16-post-release/student-pilot.md` (prepared in PR #124). It creates no
new signup service, publishing schedule or recurring automation. No recruitment, partner
contact, post, or email has been sent for this experiment.

## Starting evidence and outcome

[Report #129](https://github.com/bpmcginley/InternshipFinder/issues/129) reports 990 visits
for its seven-day window, including 640 on `/internships/` pages (64%, rounded down).
These are Cloudflare visit estimates, not 990 students or unique visitors. Its report
date alone does not establish midnight-to-midnight coverage. Future reports print the
exact UTC interval. Do not combine Cloudflare estimates with Worker visit counts.

The existing outcome target is **25 active confirmed non-test subscribers** by the
November 3 review. This is a target, not a forecast or current total. Confirmed addresses
alone do not prove student identity. Use the fresh aggregate provider baseline, subtract
active owner/test accounts, and record net change in private notes using
[SIGNUP_MEASUREMENT.md](../SIGNUP_MEASUREMENT.md). Keep addresses outside the repository.

Capture the anonymous baseline for complete UTC days October 13–19 and compare complete
days October 20–26 and October 27–November 2. Record which counters were available for
each period. Fresh production aggregates belong in the owner's existing private report;
do not publish sparse event totals in a GitHub issue. No recorded event is evidence of no
recorded event, not proof that nobody attempted a signup.

## Execute in order

| Date | Deliverable | Completion / decision rule |
|---|---|---|
| October 20 | Read-only provider baseline; anonymous funnel snapshot; check current digest and support journey | Timestamp each source. Provider count is unknown until checked; never infer it from forms. |
| October 20–23 | Five consented student sessions using the existing pilot tasks and attached recording sheet | Five completed sessions or an explicit recruitment shortfall; no invented participant results. |
| October 23–26 | Fix repeated observed usability problems and verify the fix | Any blocker first; otherwise the same failure in at least two sessions. Retest with synthetic data, then a willing participant. |
| October 20–26 | Prepare / seek approval for two partner invitations and two opportunity roundups | Verify current recipients, destinations and example roles before seeking approval for the concrete messages. |
| October 27 | First review after the normal Monday digest | Fresh provider aggregate; complete-week anonymous totals; observed feedback. Stop broken journeys immediately. |
| November 3 | Decide whether to continue either experiment | Use the success/stop rules below; if exposure is insufficient, label inconclusive rather than failed or successful. |

For the five sessions, recruit a mix of first-year, non-software/finance, returning,
phone and desktop Chrome students (categories may overlap). Follow the existing pilot's
neutral prompts: find two eligible roles; save and recover one; explain Auto-Apply and
its final-submit boundary; find and explain the optional Monday digest; find help for
a pretend sign-in failure. Use a fictional profile and synthetic offline form for an
extension demonstration; never submit a real application. Copy
[the blank sheet](student-session-recording.csv) to private owner notes, create five
rows per consenting participant, and use anonymous labels P01–P05. Record declined tasks
separately rather than counting a voluntary refusal as product failure. Seek optional
notes/recording consent before starting; default to no recording. Retain only consented
quotes and behavior, with no resume, login, email address or application-answer data.
Aim for independent completion by four of five participants on each core task; that is
a usability decision threshold for this cohort, not a population success rate. A critical
application-safety or data-loss failure stops that task for everyone until fixed.

## Experiment A: two partner widget placements

Hypothesis: a computing student organization or career-resource owner will find an
always-current internship resource useful enough to keep on an existing page.

Scope: at most two individually selected organizations for this first cycle. Start with
the computing candidates already listed in [umass-clubs.md](umass-clubs.md); their October
15 contact checks are historical, so verify current leadership and resource-sharing rules.
Choose one software/computing audience with strong current inventory. Do not promote thin
fields just to broaden reach. Offer the existing iframe, plus a browse link if embedding
is unavailable. A listed public contact is not permission to message its members.

Ready-to-review resource blurb (adapt the greeting only after recipient verification):

> Would a current internship resource be useful on your student resources page? InternScout
> offers a free embeddable list of open software internships and a link to browse more.
> Students should check each employer's eligibility and deadlines. It requires no signup;
> the optional Monday email is the same roundup for everyone and requires confirmation.
> I can send a short embed for your review if this fits your resource-sharing policy.

```html
<iframe src="https://internscout.org/widget/?field=swe&limit=8"
        width="100%" height="560" style="border:0" loading="lazy"
        title="Open software internships from InternScout"></iframe>
```

Browse link for a leader-approved resource page:
<https://internscout.org/internships/software-engineering/?utm_source=campus_partner&utm_medium=referral&utm_campaign=activation_2026_10&utm_content=widget_pilot>

Optional email link:
<https://internscout.org/digest/?utm_source=campus_partner&utm_medium=referral&utm_campaign=activation_2026_10&utm_content=widget_pilot>

Do not add tracking to the iframe or its employer links. The widget is intentionally
untracked and no account is required. UTM values label the approved links; current
analytics do not isolate this campaign or tie a visit to a confirmation. `campus_partner`
is not a distinct Worker channel. Overall referral/other visits are directional only.

Success: at least one of the two organizations explicitly approves and publishes the
resource, it remains usable seven days later, and its owner says it is worth keeping.
Record invites approved, replies, placements and that feedback, including the denominator
of two. This is partner acceptance, not student conversion. Stop immediately on a decline,
policy conflict or broken/irrelevant feed. One invitation and, only if welcomed, one
follow-up per organization; silence is not approval. No placement after the window is
inconclusive about student demand, and a reason to revise the partner offer before scaling.

## Experiment B: two computing opportunity roundups

Hypothesis: two useful, specific role roundups will help computing students understand
the product and voluntarily choose the digest. Use one already connected InternScout
brand channel with a verified working queue; do not launch a new channel for this test.

Prepare one roundup in each week, containing three genuinely open examples from different
employers. Generate fresh candidates with the existing draft-only command:

```powershell
python growth/outreach.py docs --out outreach-kit --limit 2
```

It writes ignored local drafts and sends nothing. If stale or no suitable computing major
qualifies, hold the roundup; do not fill it with expired October 15 examples. Open the
official employer pages, record term/location/eligibility caveats, and omit unverifiable
pay. Use the existing draft format, with the following optional closing copy:

> Browse these roles without an account. Want next Monday's new openings? The free
> InternScout email requires confirmation and currently sends the same roundup to everyone.

Example links if X is the selected owner-approved channel (replace `x` with the actual
allowed social source for another channel; do not leave inaccurate source labels):

- Browse: <https://internscout.org/internships/software-engineering/?utm_source=x&utm_medium=social&utm_campaign=activation_2026_10&utm_content=computing_roundup>
- Optional digest: <https://internscout.org/digest/?utm_source=x&utm_medium=social&utm_campaign=activation_2026_10&utm_content=computing_roundup>

Success for another small cycle: both approved roundups were published once, the selected
social channel recorded at least 20 visits over the two complete weeks, and at least three
consented feedback responses describe a relevant role they found. Channel visits include
other posts; they cannot be attributed exclusively to these two roundups. Ask for feedback
in the approved post; do not privately message people who clicked. The overall 25-subscriber
target remains separate and cannot be attributed to a post from these counters.

Stop for stale roles, duplicate scheduling, incorrect account, misleading copy or a broken
confirmation journey. Fewer than 20 channel visits is insufficient exposure, not evidence
that students reject the product. If exposure is adequate but feedback identifies irrelevant
roles or confusing setup, fix those problems before repeating the same promotion. No paid
boosts, unapproved recurring posts or extra provider permissions are part of this cycle.

## Scorecard and privacy

Keep one row per complete week in the existing private scorecard. Record:

- Cloudflare report interval and visits; separately, Worker visits by source/channel.
- `posting_click`, `install_click`, `apply_offer_shown` and `apply_offer_click` event totals.
- Each finite digest placement's exposures, link clicks and submissions. Never add legacy
  `digest_signup` to placement submissions, or call any of them confirmed subscriptions.
- Provider active confirmed, active owner/test, active non-test, pending, unsubscribe and
  failure aggregates; timestamp and net non-test change from the same definition.
- Sessions completed; independent/prompted/failure counts for each of the five tasks.
- Two partner decisions, resource publication status, two roundup publication URLs and
  consented feedback themes. Keep contact details and session notes outside the repo.

No email open/click tracking, visitor identity joins, browser fingerprints, subscriber
exports or automatic confirmation attribution. Do not add keys or upgrade a provider plan
to fill a measurement gap. A participant may decline installation, signup, feedback or
recording without losing participation. Anonymous events do not measure weekly returning
people: repeat-use evidence must come from optional consented follow-up feedback.
