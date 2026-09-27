# Campus outreach kit

This tool prepares drafts for UMass Amherst majors that InternScout currently serves well. It gives
an officer or advisor useful listings to share instead of a generic product pitch. **It does not find
contacts, send messages, or post to a channel.** A person chooses recipients and reviews every draft.

## Get the drafts

- In GitHub, open **Actions → Campus outreach kit → Run workflow**. It also runs on Mondays after the
  growth report. Download the `campus-outreach-kit` artifact from the run. It contains `drafts.txt`
  for review and `drafts.json` for structured reuse. The artifact expires after 14 days because roles
  may close.
- Locally, from the repository root, run `python growth/outreach.py docs --out outreach-kit`.
  The output folder is ignored by Git. `--limit 4` makes a shorter kit.
- If the output says `status=stale`, refresh the listings first. An export older than two days,
  missing its generation time, or dated more than an hour ahead produces no drafts.

The script takes undergraduate majors from `docs/data/majors.json`. It requires at least 200 open
roles in the Northeast or remote for that major and at least three roles genuinely found in the last
week. It uses the same fresh-role and employer deduplication rules as the weekly digest. Up to eight
majors with the most new roles appear, with three example roles each. Examples favor different
employers. The count is the full current match set, not just the examples. Thin majors receive no
outreach draft.

Each draft has two links to the dashboard filtered to that major's fields. Email and community links
use `utm_source=campus_partner`, their respective `utm_medium`, a month-based campaign, and the major
in `utm_content`. They do not identify an individual club, officer, or student. **[Cloudflare Web
Analytics does not record query strings or UTM parameters](https://developers.cloudflare.com/web-analytics/faq/#does-cloudflare-web-analytics-support-utm-parameters)**, so the current growth report cannot
separate these links by medium. The tags are ready for a future attribution setup; until then, record
which groups shared the link and use overall site visits and feedback as directional signals. The
example job URLs in `drafts.json` link directly
to employer postings for checking. The browse link remains useful if an example closes.

## Review and use

1. Open the example employer postings from `drafts.json` and remove any that closed or do not suit
   the recipient. Check the filtered browse link. The listing export can change between the kit's
   creation and outreach.
2. Pick a relevant group and address a real person. Replace `[Name]` and `[Your name]`, and adjust
   the short request to that group's interests. Ask whether the material would help their members.
   Do not imply an affiliation with UMass, a department, club, or employer.
3. Send the partner email personally. Use the community version only where its members or moderators
   welcome it. Do not automate messages to class lists, scraped addresses, or groups.
4. Compare overall visits in the next growth report and record which groups shared the link, when,
   and any feedback on listing relevance. Do not infer channel conversions from the UTM tags: the
   current analytics cannot read them, and neither visits nor replies prove applications or sales.

This channel sits alongside existing SEO pages, RSS feeds, brand posts, and the opt-in digest. It is
separate from the brand-post workflow, which publishes only to InternScout's own accounts.
