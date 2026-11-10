# InternScout link discovery and measurement

Updated November 4, 2026. Status is evidence, not a ranking prediction. Never send outreach or
submit a contribution without a person reviewing the recipient, rules and current examples.

## Directory ledger

The October 22 account ledger in Bruce's separate uncommitted checkout and November 1 growth audit
are the evidence for the historical states below. A successful submission is not publication.

| Site | Last verified status | Next action |
|---|---|---|
| [SaaSHub](https://www.saashub.com/internscout) | Public listing and direct HTML link checked November 4 | Monitor listing; account verification was quarterly in the October ledger. |
| [Indie Hackers](https://www.indiehackers.com/product/internscout) | Public page and direct HTML link checked November 4 | Monitor; no reader reach is established. |
| [Peerlist](https://peerlist.io/brucepmcginley/project/internscout) | Public project and direct HTML link checked November 4 | Keep project. Bruce declined ID verification for Launchpad; do not resume it. |
| AlternativeTo | Submitted, pending October 22 | Check account for decision before resubmitting. |
| Future Tools | Submitted, pending October 22 | Check account for decision before resubmitting. |
| Uneed | Free queue dated February 2, 2027, per October 22 ledger | Check the actual queue before that date. |
| Launching Next | Submitted October 22, free editorial queue; roughly four-month estimate | Check status; estimate is not a commitment. |
| Product Hunt | Scheduled October 26; publication unverified November 1 | Check actual launch record, not just the scheduled date. |
| MicroLaunch | Free submission unavailable at last check | No paid launch or duplicate submission. |
| There's An AI For That | Site blocked in prior browser check | No bypass; no submission confirmed. |

`python growth/directory_monitor.py` checks the three known public URLs. A weekly GitHub Actions
run saves `directory-status.json` for 30 days, once this workflow is merged. A blocked response,
robots prohibition, JavaScript link, or unrecognized page means **unknown**, not a failed listing.
A direct HTML link is not proof of indexing, ranking value, endorsement or traffic. Review a missing
link manually; redirects through a directory's own tracking service may also be legitimate.

## University resource shortlist

These pages list internship resources. They have not agreed to list InternScout. Check each page's
current contact route and content policy before making an individual request; do not guess recipients.
Never use UTM labels that identify a person, club or school.

| Candidate | Evidence | Fit and next step |
|---|---|---|
| [UMass Lowell Career & Co-op Center](https://career.uml.edu/resources/internships-and-co-ops/) | Official internship/co-op search resources. | Nearby public career resource; find the current career office's general contact route. |
| [UNCW internship search resources](https://www.uncw.edu/seahawk-life/support-success/career-center/find-job/internships/search-resources) | Official page lists multiple internship search sources. | General internship search; verify current resource submission policy. |
| [Saint Mary's online internship resources](https://www.saintmarys.edu/career-center/students/internships/onlineresources) | Official page lists multiple general and industry sites. | General and major-specific fit; verify a current career-office contact route. |
| [West Chester University internship preparation](https://www.wcupa.edu/business-publicmanagement/business-internship-knowledge-center/how-to-prepare-for-internship.aspx) | Official business internship guide includes Simplify. | Business students; check current business listing relevance and resource policy. |

### Individual draft (not sent)

Subject: A free internship search resource for students

Hello Career Center team,

I'm Bruce, the student who built InternScout. I saw your internship search resources and thought
our free search across majors might be useful alongside the resources you already provide.
Students can browse at https://internscout.org/ and follow links to employer postings. Would you
be open to taking a look and deciding whether it belongs among your student resources?

Thank you for considering it,
Bruce McGinley

Choose one accurate opening and recheck the page before use:

- UMass Lowell: "I found your internship and co-op search resources and thought this free
  multi-major search might complement them."
- UNCW: "I found your internship search resources and thought students might also find this free
  multi-major search useful."
- Saint Mary's: "I found your online internship resources, including your industry-specific lists,
  and thought this search across majors might be useful."
- West Chester: "I found your business internship preparation guide and thought your students might
  find our free internship search useful alongside its existing resources."

Confirm current contacts, data freshness,
posting links, pricing and accessibility before sending. The major-specific campus kit is generated
by `python growth/outreach.py docs --out outreach-kit`; old example roles can expire.

## GitHub contribution candidate

[internship-hub](https://github.com/gavinwunz/internship-hub) invites curated internship-resource
contributions. Its CONTRIBUTING.md checked November 4 calls for a free, maintained and useful
resource with a specific one-line description. Review whether a multi-major list fits the tech focus.
Draft addition (not submitted): `[Summer 2027 internships across majors](https://github.com/bpmcginley/internships-every-major) — automatically refreshed list maintained by InternScout; links to employer postings.`
Disclose that Bruce maintains InternScout. No claims of endorsement, artificial stars or bulk PRs.

## Weekly scorecard

On November 4 Bing displayed **4 referring domains and 9 referring pages** for internscout.org.
Its sample listed lnkd.in (4 pages), extensionauditor.com (3), job1agency.com (1), and
chrome-stats.com (1). The same view showed 892 referring domains for simplify.jobs and 349 for
internships.com. These are Bing's detected samples, not a full census, quality score or Google data.

Each week record: checked date; Bing referring domains/pages; newly detected relevant domains;
which partner pages were verified live; and aggregate referral traffic by source where available.
Use complete, equally bounded periods. The [attribution guide](ATTRIBUTION.md) has a read-only
aggregate query for campaign-tagged install clicks, email form submits and employer order attempts.
These are intents, not confirmed installs, subscribers, paid orders or linked individual journeys.
For the campus kit, filter `campaign` for its `campus_YYYY_MM` value: `source` is a broad category
such as email or other, not necessarily the literal `campus_partner` tag. Directory visits without
campaign tags are not identifiable by name in this event table. Use Cloudflare's referrer-host report
for those, subject to sampling, limited top rows and missing referrers.
Cloudflare Web Analytics does not report UTM query strings; the first-party counter has separate
bounded aggregate tags and opt-out limits. No additional identifiers, pixels or privacy changes.

Review after four complete weeks: ask whether relevant links actually went live, whether referrals
show useful engagement, and whether any manual work should stop. Do not infer causation from a
backlink change or combine differing periods as a conversion funnel.
