# Weekly email signup campaign — drafts for owner review

Prepared 2026-10-15 from `origin/main` at `fbd7c833`. Nothing in this directory has been posted, sent, scheduled, or loaded into a publishing queue. No account connections or paid services were changed.

The first milestone is **25 genuine, confirmed student subscribers**, excluding the owner and test addresses. This is a planning target, not a forecast or existing audience claim. A submitted form is not a confirmed subscription.

## Ready to review

- [October 20–November 2 experiment](EXPERIMENT-2026-10-20.md): the finite next cycle, partner widget and computing roundups, measurement limits, and decision rules. No messages or posts have been sent for it.
- [Student session recording sheet](student-session-recording.csv): blank CSV to copy outside the repository; use the five tasks in the existing pilot kit. Completed notes never belong in Git.
- [Brand drafts](brand-drafts.md): three opportunity-led sets, each with a short X thread and a longer caption. Each role has an official source in [opportunities.json](opportunities.json).
- [UMass club kit](umass-clubs.md): eight organizations, verified public contact routes where available, uncertainty flags, and individual outreach drafts.
- Set C is now Hasbro only: the Weiss fellowship closed October 16, 2026 at 5 p.m. Eastern and was removed on October 18.

The weekly email is free, goes out on Mondays, and requires the subscriber to click the confirmation email. Everyone currently receives the same digest. These drafts do not promise personalized alerts, application success, university endorsement, or continuous availability of any employer's role.

## Fit with the existing brand workflow

Read-only source observations, checked 2026-10-15:

- `growth/social.py` already creates opportunity-led field posts from the latest export and adds the digest signup link after the form is live. It rejects exports older than two days. Its `--send` path can publish to configured Bluesky, Mastodon and InternScout-owned Discord destinations.
- `.github/workflows/social.yml` schedules the existing Brand posts workflow at `15:00 UTC` Tuesday and Thursday. It can also publish Instagram cards/Reels and YouTube Shorts when their credentials and generated media exist. `SOCIAL_ENABLED=0` is its off switch; this review did not inspect or change the live variable, credentials, or queue.
- `growth/social.py:save_drafts` writes the generated LinkedIn draft to `social_drafts` in D1 for the private analytics page. Running the workflow is therefore not a harmless way to preview this kit: it includes external writes and publishing steps.
- These files are **editorial drafts only**, not the `out/post.json` automation schema. Do not rename them into the workflow's output or run `--send` to import them. Review the existing weekly draft/queue before releasing one set so the same opportunities are not posted twice.
- Conversation history identifies X `@useinternscout`, Reddit `u/InternScout`, YouTube `@internscoutorg`, and Meta InternScout product accounts. Current authentication, every connection, and every platform's posting availability have **not** been independently reverified for this kit. LinkedIn copy is optional and does not imply a LinkedIn Page already exists.

The signup URLs use `utm_source=<channel>&utm_medium=social`, matching the allowlist in `worker/src/visits.js` and the convention already in `growth/social.py`. Keep the channel value accurate when adapting copy. Do not use these social labels on club email links; use the untagged digest URL there rather than misclassifying them as social traffic.

## Owner release checklist

1. Review the exact set, destination account, and timing. Obtain explicit approval before posting, scheduling, or contacting a club. Use only InternScout brand accounts.
2. Reopen every official employer page immediately before release. Keep eligibility, location, term, and deadline caveats. Replace any closed or inaccessible item. An application form being visible on October 15 does not guarantee future availability. Do not describe a general application pool or two-day fellowship as a guaranteed internship vacancy.
3. Recheck the existing brand queue and recent posts, then release one relevant set rather than flooding every channel with identical text. For a club, confirm its current officers and rules and ask a leader whether a resource share is welcome; never scrape or subscribe its member list.
4. Check that `/digest/` still has a working signup form and visible confirmation instructions. Test only with an owner-approved address if needed; never count that address toward the student milestone.
5. Keep employer links accessible without subscribing. Link the digest as an optional way to hear about new opportunities. If making a card or video, use readable text, captions, and factual role details; avoid employer logos that suggest a partnership.
6. Record date, channel, approved copy, and aggregate results in the existing private growth report. Use aggregate landing-page visits and submissions to diagnose friction, and Buttondown's confirmed subscriber count for the outcome. Do not join email addresses to visitor counters or infer individual confirmations from anonymous events. Attribution to an individual post remains approximate without an approved confirmation attribution mechanism.

## Small first release, then learn

After approval, start with one role set on an already working brand channel and one or two individually selected clubs with verified contact routes. Keep the remaining drafts for subsequent review and recheck their roles first. Review after the first Monday digest: did confirmed students join, did any fail to find the confirmation email, and was the email useful enough to retain them? Fix the largest observed source of friction before expanding. Do not invent conversion percentages or use fake users/reviews as evidence.

This is a finite launch kit. It does not create a new recurring automation, enable a mailing blast, or change the existing Brand posts schedule.

## Validation performed

The six opportunity IDs, official URLs, and open status matched the MA export used for this kit. Each selected official page was opened through the research tool and contained an application form; no applications were submitted. The nine X draft blocks were checked with URLs counted as 23 characters and each was below 280 characters (177–237). Markdown HTTPS links were parsed, JSON was parsed, and `git diff --check` passed. These checks do not verify live social authentication, club permission, deliverability, or future role availability. No application code changed, so no product test suite was run for this editorial kit.
