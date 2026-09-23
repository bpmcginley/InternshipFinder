# InternScout growth engine

How InternScout finds students, and how that improves itself. This folder is not published: GitHub
Pages serves `docs/` only.

## Who the audience is (measured 2026-09-23)

InternScout is only as good as the listings a student sees on their first visit, so the audience is
defined by where the data is strong, not by who could conceivably use it.

Open roles in the Northeast or remote, per UMass Amherst undergraduate major:

| Tier | Majors | Open nearby |
|---|---|---|
| **Primary: market now** | Informatics, Computer Engineering, Computer Science, Operations and Information Management, Finance, Statistics and Data Science, Management, Industrial Engineering | 200–690 each |
| **Secondary** | Accounting, Marketing, Political Science, Electrical Engineering, Social Thought and Political Economy | 100–140 each |
| **Not yet: fix the data first** | Psychology (3), Nursing, Art History (1), Music, Theater, Dance (0), the language majors (1 each) | under 10 |

So the primary audience is **UMass Amherst sophomores and juniors in Isenberg, CICS and the College
of Engineering, during recruiting season** (September to November for the following summer, and
again January to March). Everyone else is served by the same site, but is not where promotion
starts. A psychology student sent to a page with three listings is a lost student.

Recompute this table with `python growth/audience.py` (it reads `docs/data`).

## What runs by itself

| Loop | Status | How it adapts |
|---|---|---|
| **Landing pages** (`backend/internscout/seo_pages.py`) | Built | Rebuilt on every deploy from the live data (about 500 pages today: every field and state with 5+ open roles, every field in a state with 15+ roles posted in fewer than 10 states, and every UMass major whose list is not identical to another page's). A page that is already live stays until it falls to two thirds of that bar, so pages near the line do not flicker; a page that does go gets a 404 page that links back to the listings. The site's search footprint follows the job market with no one editing it. |
| **Sitemap and robots.txt** | Built | Regenerated with the pages. Each page's `lastmod` is the day its newest listing was found, so search engines learn which pages really changed. |
| **Instant indexing** (`growth/indexnow.py`) | Built | After each deploy, the pages it added, removed or changed are sent to IndexNow, so Bing and the engines that use its index (DuckDuckGo, Yahoo, ChatGPT search) recrawl them within hours. Google reads the sitemap. |
| **RSS feeds** (`backend/internscout/feeds.py`) | Built | Every landing page has a `feed.xml` of its newest roles. A club that points a Discord bot (MonitoRSS) or Slack's `/feed` at, say, the computer science in Massachusetts feed gets new roles in its channel as they are found: promotion the club chose, that keeps working with no one posting. |
| **Brand posts** (`growth/social.py`) | Built, waiting for accounts | Tuesdays and Thursdays it writes a post from the data (one field's new roles nearby this week, linking its page) and sends it to InternScout's Bluesky, Mastodon or Discord, whichever has secrets set. Until then the weekly report carries the post as a draft. |
| **Where to scan** | Already running | The ingest adds any state students pick to its detailed scan (`Worker /demand`), so coverage grows where the audience is. |
| **What to search for** (`backend/internscout/focus.py`) | Built | Every ingest reads the last export, finds the fields UMass majors are worst served in (open roles nearby, per major that depends on the field), and spends the daily focus searches there. Today that is languages, arts and social science. What the searches find is kept for two days after they last see it (it used to vanish at the next run), so a field that fills up drops out on its own. A test checks that every search's typical result is tagged with the field it is meant to fill. |
| **Visit counting** | Running | Cloudflare Web Analytics on every page, cookieless. |
| **Weekly growth report** (`growth/report.py`) | Built | Every Monday a GitHub issue labelled `growth-report`: visits without bots, top landing pages and referrers, the share of visits that came in through any landing page (once the Cloudflare token is added), the states students picked (in order, with no counts, because the issue is public), which majors are served and which are thin, where the focus searches are going, and the landing-page count. Last week's issue closes itself. Run it any time with `python growth/report.py`. |

## Channels, and the rules each follows

These rules are not negotiable: breaking them gets the brand banned from the very places the audience
is, or breaks the law.

1. **Search (the landing pages).** Fully automatic. Content is computed from real listings only;
   nothing is written to fill space. Measure it with Google Search Console once it is verified
   (a DNS record in Cloudflare), which also unlocks the store's verified Official URL.
2. **Communities (Reddit, Discord, class group chats).** Posts are made openly as InternScout, or by
   the founder saying they built it. **Never by accounts posing as students who happen to like it**: that
   breaks every platform's rules and the FTC's endorsement rules. Drafts can be written ahead; a
   person posts them.
3. **Email.** Only to people who ask for it (a "send me new listings for my major" option on the
   dashboard), with an unsubscribe link and a postal address (a PO box keeps a home address off it).
   **No scraped or bought lists**, and no mass mail to university addresses.
4. **Paid ads.** Reddit, Google and Instagram ads aimed at UMass and the primary majors, in recruiting
   season. Always under a monthly cap the owner sets in each ad account. Ad platforms show the verified
   advertiser's legal name publicly, so ads are the one channel that is not anonymous.
5. **Partners.** UMass career center (Career Connect), department advisors, and student clubs
   (consulting, finance, tech, engineering). Personal emails, sent by a person.
6. **Word of mouth.** The share button, link previews and the "send this to your laptop" control
   already exist. Next: a small bonus AI allowance for a friend who signs up through a student's link.

Identity: everything public says "InternScout". The legal pages keep naming the operator, which the
law requires for a paid product.

## Should there be an app?

Not a native one yet. Auto-Apply needs a desktop browser, and the search already works on a phone's
browser. The dashboard is now installable as a web app (a manifest and home-screen icons drawn by
`scripts/make_app_icons.py`): Chrome and Android offer "Install", and iOS "Add to Home Screen" gets a
proper icon. Next would be an optional notification when new listings match the student's major.
Revisit a store app once there are returning users who ask for one.

## What needs the owner

| Step | Why |
|---|---|
| Settings → Pages → Source: **GitHub Actions**, just before the landing-pages PR merges | The landing pages are built at deploy time; the deploy refuses to run until this is set |
| Verify internscout.org in Google Search Console | See which searches find the pages; unlocks the store's Official URL |
| A Cloudflare API token with Analytics read, saved as a repo secret | Lets the weekly report read visits |
| Ad accounts and monthly caps, when ready | Paid reach in recruiting season |
| A PO box, before any email goes out | Required on every marketing email |
| Brand accounts (Bluesky, Mastodon, a Discord server), with their secrets in the repo, when ready | Lets the brand posts go out on their own; see growth/social.py for the secret names |
