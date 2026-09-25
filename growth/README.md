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
| **Employer pages** (`/internships/at/<employer>/`) | Built | Every employer with 10 or more open roles (about 380) gets a page, because "<employer> internships" is one of the commonest searches students make. Company names in every listing link to them. Each says InternScout is not affiliated with the employer. |
| **Term, paid, co-op, research and class-year pages** | Built | The other ways students search, sized with Semrush on 2026-09-24 ("summer internships" 5,400 a month, "paid internships" 3,600, "reu programs" 1,300, "co op jobs" 720, "freshman internships" and "sophomore internships" 390 each): a page per start term (`/internships/summer-2027/`), plus `/internships/paid/`, `/co-op/`, `/research/`, `/for-freshmen/` and `/for-sophomores/`. Each lists only roles whose own data matches (a class-year page only postings that say they take that year), needs 25 open roles, and opens the dashboard on the matching filter. Term pages come and go as seasons roll over. |
| **New this week** (`/internships/new/`) | Built | Roles first found in the last week, Northeast and remote first, with one feed that a club channel can follow for everything. "New" never counts listings from the day first_seen began (2026-09-18), which would make half the site look new. |
| **Sitemap and robots.txt** | Built | Regenerated with the pages. Each page's `lastmod` is the day its newest listing was found, so search engines learn which pages really changed. |
| **Instant indexing** (`growth/indexnow.py`) | Built | After each deploy, the pages it added, removed or changed are sent to IndexNow, so Bing and the engines that use its index (DuckDuckGo, Yahoo, ChatGPT search) recrawl them within hours. Google reads the sitemap. |
| **RSS feeds** (`backend/internscout/feeds.py`) | Built | Every landing page has a `feed.xml` of its newest roles. A club that points a Discord bot (MonitoRSS) or Slack's `/feed` at, say, the computer science in Massachusetts feed gets new roles in its channel as they are found: promotion the club chose, that keeps working with no one posting. |
| **Brand posts** (`growth/social.py`) | Built, waiting for accounts | Tuesdays and Thursdays it writes a post from the data (one field's new roles nearby this week, counted as the digest counts them, linking the field's page, or the dashboard filtered to the field when it has no page) and sends it to InternScout's Bluesky, Mastodon or Discord, whichever has secrets set. It posts nothing when the data export is more than two days old (a stalled ingest would otherwise repeat the same week's post), and the run fails, after trying every account, when any account with secrets could not post. The repository variable `SOCIAL_ENABLED` = `0` stops it altogether. Until the accounts exist the weekly report carries the post as a draft. |
| **Email digest** (`growth/digest.py`, `growth/digest_send.py`) | Built; sending is off until Buttondown and a PO box are set up | Writes the week's new-internships email from the data: the fields that gained the most new roles this week (up to 8, each with at least 3), each showing up to 5 of them, Northeast and remote first, and a link to the field's page. The Email digest workflow builds it and uploads the HTML, text and JSON to read. Once sending is on (see below), `digest_send.py` sends it through Buttondown as one email to every confirmed subscriber: it makes a draft, then sends it. It will not send without the API key and the postal address, or in a week with no field to list. Everyone gets the same email for now. `digest.py` can already narrow it to a subscriber's fields, but sending that needs Buttondown tags. The subscriber list lives with Buttondown, never on InternScout's servers. |
| **Where to scan** | Already running | The ingest adds any state students pick to its detailed scan (`Worker /demand`), so coverage grows where the audience is. |
| **What to search for** (`backend/internscout/focus.py`) | Built | Every ingest reads the last export, finds the fields UMass majors are worst served in (open roles nearby, per major that depends on the field), and spends the daily focus searches there. Today that is languages, arts and social science. What the searches find is kept for two days after they last see it (it used to vanish at the next run), so a field that fills up drops out on its own. A test checks that every search's typical result is tagged with the field it is meant to fill. |
| **Chrome Web Store listing** | Live since 2026-09-22 | The extension installs in one click from [its listing](https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi) and updates itself. The install page leads with it, the dashboard links straight to it on a computer, and every landing page links the install page. Each store link carries a `utm_source` naming the place it sits (the landing pages' link passes `landing-page` through the install page), so the store's own install analytics say which ones work. |
| **Analytics dashboard** (`growth/metrics.py`) | Built | Every morning the day's visits (by source and landing page), top pages, referrers, countries, Bluesky and listing numbers, and the store listing's users and rating, are copied into the app's D1 database. A private Claude page reads them, and the live sign-in, AI and Stripe numbers, through the owner's own Cloudflare and Stripe connectors. Totals only. |
| **Visit counting** | Running | Cloudflare Web Analytics on every page, cookieless. |
| **Weekly growth report** (`growth/report.py`) | Built | Every Monday a GitHub issue labelled `growth-report`: visits without bots, top landing pages and referrers, the share of visits that came in through any landing page (once the Cloudflare token is added), the states students picked (in order, with no counts, because the issue is public), which majors are served and which are thin, where the focus searches are going, and the landing-page count. Last week's issue closes itself. Run it any time with `python growth/report.py`. |

<!-- was: | **Brand posts** (`growth/social.py`) | Built, waiting for accounts | Tuesdays and Thursdays it writes a post from the data (one field's new roles nearby this week, linking its page) and sends it to InternScout's Bluesky, Mastodon or Discord, whichever has secrets set. Until then the weekly report carries the post as a draft. | -->
<!-- The brand posts row now says when a run posts nothing or fails, what it links, and how to
     switch it off. -->
<!-- was: | **Email digest** (`growth/digest.py`) | Built, not sending (needs a PO box and an email provider) | Writes the week's new-internships email from the data: the fields that gained the most new roles this week (up to 8, each with at least 3), each showing up to 5 of them, Northeast and remote first, and a link to the field's page. A subscriber who picked fields gets only those, or every field when theirs had a quiet week. The Email digest preview workflow builds it on demand and uploads the HTML, text and JSON to read. Nothing sends it yet. Every email must carry an unsubscribe link and a postal address, so the preview shows a placeholder for each. The subscriber list would live with the email provider, never on InternScout's servers. | -->
<!-- The digest now has a sender (growth/digest_send.py, through Buttondown), so the row says what
     sends it and what it waits for. The per-field line changed because the sender sends everyone the
     same email for now. -->

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
| ~~Verify internscout.org in Google Search Console~~ (done 2026-09-23) | See which searches find the pages; unlocks the store's Official URL |
| In the Chrome Web Store developer dashboard, Store listing → **Official URL**: internscout.org | The listing then shows the site as verified, which store visitors trust |
| A Cloudflare API token with Analytics read and D1 edit, saved as a repo secret | Lets the weekly report read visits and the daily metrics copy write them |
| Ad accounts and monthly caps, when ready | Paid reach in recruiting season |
| **Email digest 1.** Create a Buttondown account at buttondown.com and fill in its verification form: InternScout, a free opt-in weekly digest of new internships for UMass Amherst students; subscribers come only from the internscout.org form; no imported lists | Buttondown sends the digest and keeps the subscriber list, so InternScout's servers never store an email address. It reviews every new account (usually in 1 to 3 business days) before the account can collect subscribers. Budget $9 a month once per-field emails need tags: tags are a $9 add-on up to 100 subscribers and part of the $9 plan from 101 to 1,000 ($29 a month above that) |
| **Email digest 2.** In Buttondown, Settings → Domains: add internscout.org as the sending domain. In Cloudflare, DNS → Records: add each CNAME and TXT record exactly as Buttondown shows it, with every CNAME set to **DNS only** (grey cloud), then click Check records in Buttondown. If internscout.org already has an SPF record (`v=spf1 ...`), merge Buttondown's into it, since a domain can have only one. Add a DMARC record too: TXT `_dmarc` with `v=DMARC1; p=none; rua=mailto:hello@internscout.org`. Then set the newsletter's From address to hello@internscout.org and check that inbox receives mail | Gmail and Yahoo expect SPF, DKIM and DMARC on the domain mail comes from, and may send mail without them to spam. Students' replies go to the From address |
| **Email digest 3.** In the newsletter's settings in Buttondown: (a) switch **open tracking OFF** and **click tracking OFF**; (b) switch **double opt-in ON**, so a new subscriber gets one confirmation email and nothing else until they click its link. Then confirm both before going on: reopen the settings and check both tracking switches still read off and double opt-in on; subscribe a spare address of your own on Buttondown's subscribe page and check it gets the confirmation email and is listed as unconfirmed until you click it. **Only after both are confirmed**, paste the form address into `CONFIG.digest.formAction` in `docs/index.html` (the comment there says what goes in it). In the first test copy (step 7), check again that the links go straight to internscout.org and the job sites, not through a Buttondown redirect | `docs/privacy.html` promises both: open and click tracking are off for this email, and nothing arrives until the subscriber confirms. The sign-up form stays hidden while `formAction` is empty, so no one can sign up before those promises are true. Tracking would also send every click through Buttondown's servers first |
| **Email digest 4.** A PO box, before any email goes out. Save it as the repo secret `DIGEST_POSTAL_ADDRESS`, on one line (`InternScout · PO Box NNN · Amherst, MA 010xx`) or one line per part | CAN-SPAM requires a postal address in every marketing email, and a USPS PO box counts. The digest prints it in its own footer, and `digest_send.py` refuses to send without it |
| **Email digest 5.** In Buttondown, API → Keys: a key only for GitHub, with email_access and sending_access set to write and everything else none. Save it as the repo secret `BUTTONDOWN_API_KEY` | `digest_send.py` uses it to make each week's draft and send it. The script pins API version 2026-04-01 itself. Never commit the key or put it in site code |
| **Email digest 6.** Repo variables (Settings → Secrets and variables → Actions → Variables): `DIGEST_TEST_TO` = hello@internscout.org, then `DIGEST_ENABLED` = `1` | Nothing is sent until DIGEST_ENABLED is 1. After that, a run started by hand sends one test copy to DIGEST_TEST_TO, and nothing to subscribers |
| **Email digest 7.** Actions → Email digest → Run workflow, with "Send to every subscriber" unticked. In the test copy, check the PO box and the unsubscribe link, and in Gmail's "Show original" check that SPF, DKIM and DMARC say PASS. Then run it once more with the box ticked | The first email to every subscriber should be one a person has read. Each test leaves an unsent draft in Buttondown; delete old ones there |
| **Email digest 8.** Uncomment the two `schedule:` lines in `.github/workflows/digest.yml` | The digest then goes to every subscriber on Mondays at 8am Eastern, with nothing to click. A send to everyone first asks Buttondown whether an email already went out or was scheduled in the last six days, and refuses if so, so a rerun can't send a second copy (`--allow-same-week` overrides it, run by hand, only after checking the dashboard). If a run ever says **Status UNKNOWN**, the send got no answer or a 5xx error and may still be going out: look for that email in Buttondown's sent and scheduled emails before doing anything else, and don't send the draft or rerun until you have |
| **Email digest 9.** Decide whether digests should also appear on Buttondown's public web archive. They don't unless the send step adds `--public-archive`. Keep an eye on complaints (0.1% at most) and failed deliveries (1% at most) | Those are Buttondown's limits for every newsletter. It also contacts the account when opens fall to 10% or clicks to 1% |
| Brand accounts (Bluesky, Mastodon, a Discord server), with their secrets in the repo, when ready | Lets the brand posts go out on their own; see growth/social.py for the secret names |
| **Brand posts off switch**, if ever needed: repo variable `SOCIAL_ENABLED` = `0` (Settings → Secrets and variables → Actions → Variables). Delete it, or set any other value, to turn posting back on | The Brand posts workflow posts on its schedule as soon as an account's secrets exist; with the variable at 0 every run is skipped, scheduled or by hand. Nothing needs setting for today's behaviour |

<!-- was: | A PO box, before any email goes out | Required on every marketing email | -->
<!-- The digest's sender exists now, so the PO box is one of the steps that turn it on, and the row
     became those steps in order. -->
<!-- was (end of Email digest 2): "Also turn off open and click tracking in the newsletter's settings: the
     privacy page says it is off". It became its own step 3, with double opt-in and a check of both before
     the sign-up form goes live, so the steps after it moved down by one. -->
