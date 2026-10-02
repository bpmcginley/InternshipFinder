# Directory listings kit

Paste-ready copy for free directory and launch-site listings, so a listing takes a few minutes of
pasting and one click on Submit. Researched 2026-10-02 (added 2026-10-02). Nothing here has been
submitted; every submission needs the owner's own account (see "Before you start").

Every block below is already inside that site's limits. Character counts are in brackets after the
heading of each limited field. If a form shows a smaller counter than the one written here, the form
wins: cut from the end of the last sentence, never the slogan.

## Checklist, highest expected value first

Expected value here means: how likely a student (or someone who sends students) finds InternScout
through the listing, plus how much the link helps search, divided by the effort and the risk.

1. [ ] **AlternativeTo** — free, permanent, ranks for "Jobright alternatives" searches. Slow free queue
   (months), so submit first. Email must be verified first.
2. [ ] **SaaSHub** — free, quick review when verified with an `@internscout.org` email. Lists
   InternScout next to Jobright and Simplify on their "alternatives" pages.
3. [ ] **Product Hunt** — free. Biggest one-day spike, but needs a planned day. Do it last of the
   big three, after the listings above exist and the Web Store listing copy is fixed (see "Before you
   start").
4. [ ] **Uneed** — free waiting line (date 30 days to 5 months out). Stays up only if it reaches a
   score of 10 on launch day from real visitors.
5. [ ] **Future Tools** — free, AI-tool directory, hand-reviewed and selective. Two-minute form.
6. [ ] **MicroLaunch** — free, month-long listing, no badge or backlink required.
7. [ ] **Peerlist Launchpad** — free, week-long, opens Mondays. Needs a verified personal profile.
8. [ ] **There's An AI For That** — only free route is a monthly reply thread on X; one tool is picked
   per thread. Low odds; do it only if there's an X account to reply from.

Skipped (paid-only or a requirement we won't meet): **Futurepedia**, **BetaList**, **Fazier**. Reasons
are under "Skipped" at the bottom.

## Do not

These break the sites' rules, and some break ours (`growth/README.md`: no astroturfing, no fake
reviews, no claims we can't source). Any one of them can get the listing removed and the account banned.

- **Do not ask anyone to upvote.** Product Hunt's help centre answers "Can I ask my community/friends/
  family to upvote a product?" with "Please don't", and its community guidelines list mass messaging,
  asking for upvotes, bots and incentives as not acceptable; asking "may trigger the algorithm to drop
  the product in the ranks or remove it from the homepage entirely". Sharing the link is allowed:
  "Feel free to spread the word and bring friends into the discussion." So say "we launched on Product
  Hunt today, feedback welcome", never "please upvote".
- **No vote swaps, vote groups, bought votes, or second accounts.** Uneed removes "votes coming from
  batches of accounts created at once, or from a single IP address" and bans repeat offenders.
- **No fake reviews or ratings**, on any directory or on the Chrome Web Store, including from friends
  who haven't used it. A review from a real student who used it is fine; one we asked for in exchange
  for anything is not.
- **No posting in comment sections as if you were a user.** Comments from the maker account say they
  are from the maker.
- **No superlatives or numbers we can't back.** Not "the best", "the largest", "#1", "thousands of
  students use it". Counts come from `docs/data` (see "Refreshing the numbers").
- **No competitor logos or prices in a listing** unless they carry a source and a date, like
  `growth/internscout-comparison.png` does. Don't upload that card after its prices are more than a
  month old (it says "Prices as of October 1, 2026").
- **Do not name the founder** in any listing text, tagline, or maker comment. Some sites (Product
  Hunt, Peerlist) show the account holder's profile beside the product anyway; that is the site's
  doing, so keep the text itself brand-level.
- **No shortened or tracking links on Product Hunt.** Its launch guide says shortened links and
  tracking links are not accepted. (Other sites: the Web Store link may carry `?utm_source=<site>`.)
- **Do not pay** for faster review or placement without deciding to on purpose. Every listing here has
  a free path.

## Before you start

- [ ] **Fix the Chrome Web Store description first.** On 2026-10-02 the public listing still said
  paid plans start at $5/month; they are $4 (Supporter) and $8 (Pro). Directories and reviewers copy
  from it. The text to paste is in `store/webstore.md` and `growth/STORE_LISTING.md`.
- [ ] **Check `hello@internscout.org` receives mail.** SaaSHub (and some others) verify ownership by
  emailing an address on the product's domain.
- [ ] **Have the files ready** (all already in the repo):

| File | Size | Use for |
|---|---|---|
| `docs/icon512.png` | 512×512 | Logo / thumbnail everywhere. Product Hunt shows it at 240×240. |
| `docs/og-preview.png` | 1200×630 | Banner / cover image; carries the slogan. |
| `store/screenshots/1-dashboard-light.png` (or `1-dashboard.png`, dark) | 1280×800 | Screenshot 1: the ranked list for a CS junior. |
| `store/screenshots/2-setup-light.png` (or `2-setup.png`) | 1280×800 | Screenshot 2: setup (major, fields, class year). |
| `store/screenshots/3-nursing-light.png` (or `3-nursing-dark.png`) | 1280×800 | Screenshot 3: a non-tech major's results. |
| `store/promo-tile-440x280.png` | 440×280 | Small promo tile where a site asks for one. |
| `growth/internscout-comparison.png` | 1080×1350 | Optional, AlternativeTo and SaaSHub only, while its prices are current. |

The screenshots were taken on 2026-09-22 and show that day's counts (12,575 open nationwide). That is
fine for a screenshot; don't quote those numbers in text. None of them shows the extension filling a
form; a 1280×800 screenshot of that (with a made-up test profile, no real personal data) would help
Product Hunt and Future Tools the most.

## Shared facts and copy

Use these in every listing. Numbers are as of 2026-10-02.

- **Name:** InternScout
- **Website:** https://internscout.org
- **Chrome extension:** InternScout Auto-Apply,
  https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi
  (on sites other than Product Hunt, append `?utm_source=<site>`, e.g. `?utm_source=alternativeto`, so
  the Web Store's install analytics show where installs came from, as every other store link does)
- **Install guide:** https://internscout.org/install.html
- **Contact email:** hello@internscout.org
- **Platforms:** Web (any browser, desktop and phone) + Chrome extension (desktop Chrome)
- **Pricing model:** Freemium
- **Licence:** Proprietary (the repository is public but has no open-source licence)
- **Slogan (in every listing):** Built by one student, made for all students.
- **Disclaimer (in every long description):** Not affiliated with UMass Amherst.

Facts the copy relies on (and where they come from):

| Claim | Source |
|---|---|
| About 14,000 open roles (14,366), about 1,700 employers (1,744), 66 fields | `docs/data` on 2026-10-02, see below |
| US and Canada | `docs/data/listings/` has every state and province |
| Refreshed several times a day from employers' own job boards, respecting robots.txt | the ingest workflow (6-hourly) and `backend/` |
| Search is free, no account | `docs/index.html` meta description: "No sign-in" |
| Extension fills applications with AI and never submits | `store/webstore.md`, `extension/manifest.json` description |
| Extension needs a free sign-in (Google or Microsoft) | `docs/install.html` |
| Free monthly AI allowance; a school .edu email doubles it | `docs/install.html`, `worker/src/config.js` |
| Supporter $4/month, Pro $8/month, which "raise your monthly AI allowance and nothing else" | `docs/privacy.html` |

### Refreshing the numbers

Run from the repository root before pasting, and round down (14,366 is "about 14,000"):

```
python -c "import json,glob;s=json.load(open('docs/data/stats.json'));e={r['company_name'] for f in glob.glob('docs/data/listings/*.json') if not f.endswith(('.desc.json','index.json')) for r in json.load(open(f,encoding='utf-8')) if r.get('status')=='open'};print('open',s['open'],'employers',len(e),'fields',len(s['by_field']))"
```

### Taglines (pick per site's limit)

Tagline A [53]:
```
Free internship search for every major, US and Canada
```

Tagline B [58]:
```
Free internship search; the AI fills forms, you hit Submit
```

Headline, 5 to 8 words (Launching Next style) [7 words]:
```
Free internship search for every college major
```

### Short description [212]

```
Free internship search for college students of every major: about 14,000 open roles from employers' own job boards in the US and Canada, refreshed several times a day. Built by one student, made for all students.
```

### Long description [1,252]

```
InternScout is a free internship search for college students of every major in the US and Canada. It lists about 14,000 open internships, co-ops and research roles from about 1,700 employers across 66 fields, read straight from employers' own job boards (Workday, Greenhouse, Lever, iCIMS, Ashby, Oracle and others) several times a day, respecting robots.txt. Every listing links to the employer's own application page.

Search is free and needs no account. Pick your major, class year and the states you want, and listings are ranked for you.

The optional Chrome extension, InternScout Auto-Apply, fills an application from your saved profile with AI and stops at the submit button. It never submits: you review every answer and press Submit yourself. The extension is free to use with a monthly allowance, and a school .edu email doubles it. Optional Supporter ($4/month) and Pro ($8/month) plans raise the allowance and nothing else.

Built by one student, made for all students. Made by a UMass Amherst student; not affiliated with UMass Amherst.

Website: https://internscout.org
Chrome extension: https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi
Install guide: https://internscout.org/install.html
```

### Pricing text [208]

```
Free: search with no account, plus the Chrome extension with a monthly AI allowance (doubled with a school .edu email). Optional Supporter $4/month and Pro $8/month plans raise the allowance and nothing else.
```

### Tags (general pool; each site section picks from these)

internships, internship search, job search, college students, co-op, research internships, career,
students, Chrome extension, autofill, job application, AI, education, free

---

## 1. AlternativeTo

- **Submission page (verified 2026-10-02):** there is no public form URL. Sign in at
  https://alternativeto.net, click the user icon (top right), then **Suggest new application**
  (per https://alternativeto.net/faq/). Guides that link `/manage/new/` are out of date: it returns 404.
- **Cost:** free. (An optional $5 one-time "priority review" exists; not needed.)
- **Requirements:** an account with a **verified email** ("to discourage spammers and bots"). The free
  queue "typically takes at least a few months"; priority review is 1–2 business days. Rejected kinds
  include content rather than software, thin wrappers around AI models, and low-effort clones, so lead
  with the search, not the AI. Its FAQ forbids using a user profile to advertise ("Accounts used for this
  purpose will be blocked for spam"): leave the profile plain.
- **Limits:** not published. The form shows counters; the text below is short enough for the usual
  short-description box.
- **Alternatives to link (checked 2026-10-02):** **Jobright** exists
  (https://alternativeto.net/software/jobright/about/). **Simplify (simplify.jobs) is not on
  AlternativeTo** (searching "Simplify jobs" finds only unrelated apps; `/software/simplify/` is a music
  player). Link InternScout as an alternative to **Jobright**, **Teal**
  (https://alternativeto.net/software/teal/) and **Huntr** (https://alternativeto.net/software/huntr/).
  Optionally, once InternScout is approved, suggest Simplify as a new app of its own and then link the
  two; that's allowed, but it's a second review.

Fields:

- **Name:** `InternScout`
- **Website:** `https://internscout.org`
- **Short description** [139]:
```
Free internship search for college students of every major in the US and Canada, with an optional Chrome extension that fills applications.
```
- **Description:** paste the shared **Long description**, but use the `?utm_source=alternativeto` store
  link in it.
- **Platforms:** Online, Google Chrome
- **License:** Proprietary
- **Pricing:** Freemium
- **Tags:** internships, job search, college students, Chrome extension, autofill, career, education
- **Category:** Job Search (the category Jobright, Teal and Huntr are listed under; pick the closest
  one the form offers)
- **Links:** Chrome Web Store:
  `https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi?utm_source=alternativeto`
- **Images:** `docs/icon512.png` (logo), then screenshots 1, 3, 2 (light). The comparison card is
  optional and only while current.

---

## 2. SaaSHub

- **Submission page (verified 2026-10-02):** https://www.saashub.com/services/submit (rules and the
  link to the form; the form itself needs a free account).
- **Cost:** free.
- **Requirements (from that page):** a released product (no waitlists; "unreleased products" are
  rejected immediately), its own domain (not a free subdomain), an English site, and a list of
  competitors ("submissions lacking them" go to the bottom of the queue). Verifying with **an email on
  the product's domain** raises priority: use hello@internscout.org. Don't submit by email.
- **Limits:** not published. The blocks below are within the shared lengths.
- **Competitors to list (all on SaaSHub, checked 2026-10-02):** Jobright.ai
  (https://www.saashub.com/jobright-ai-alternatives), Simplify Jobs
  (https://www.saashub.com/simplify-jobs-alternatives), Teal, Huntr. Jobright's page shows the
  categories it uses: AI Tools, Job Search.

Fields:

- **Name:** `InternScout`
- **Website:** `https://internscout.org`
- **Tagline** [53]: Tagline A
- **Description:** the shared **Long description** with the `?utm_source=saashub` store link.
- **Categories:** Job Search, Education, Chrome Extensions (pick up to what the form allows)
- **Pricing:** Freemium; paste the shared **Pricing text** if there's a free-text box.
- **Platforms:** Web, Chrome
- **Images:** `docs/icon512.png`, then screenshots 1 and 3.

---

## 3. Product Hunt

- **Submission page (verified 2026-10-02):** https://www.producthunt.com → **Submit** (top right) →
  **New product**, then enter `https://internscout.org`. Steps from
  https://help.producthunt.com/en/articles/479557-how-to-post-a-product.
- **Cost:** free.
- **Requirements:** a **personal** account (company accounts can't post) that has finished onboarding.
  The community guidelines ask for a real name and photo on the profile, so the maker profile will show
  the account holder; the listing text below stays brand-level. Not every launch is featured on the
  homepage; the featuring guidelines say directories or lists are not featured, so the copy leads with
  what InternScout *does* (search ranked for you, a form-filler that stops at Submit), not "a list of
  internships". Unfeatured launches still appear under "See all of today's products".
- **Limits (Product Hunt's launch guide and help centre):** name only, no emoji or description in the
  title; **tagline 60 characters**; **description 260 characters** in the help article (the launch guide
  says 500; this copy fits both); thumbnail 240×240 (GIF under 3 MB); gallery needs **2+ images**,
  1270×760 recommended; a few topics; **no shortened or tracking links**.
- **When to launch:** launches run midnight to midnight Pacific; schedule for **12:01 am PT** so the
  product gets the full 24 hours (Product Hunt's own advice). Day: a 2026 analysis of that year's
  launches (Ziga Potocnik, Databox, posted on Product Hunt about July 2026) found **Saturday** needs the
  fewest points for the top 5 (median 266, about a third as many launches as Tuesday), **Monday** is the
  easiest weekday (322) and **Wednesday** the hardest (360). Tuesday to Thursday bring the most
  visitors. Recommendation: a **Monday in October or November** (students are recruiting then, and
  Monday balances traffic and competition), on a day the maker can answer comments from 12:01 am PT
  through the evening. Pick Saturday instead only if a top-5 badge matters more than visitors.
- **Launch-day sharing that stays inside the rules:** post the link once on InternScout's own
  accounts and in places that already follow it, worded as news ("InternScout launched on Product Hunt
  today; we'd love feedback on which majors look thin"). Never "upvote us", no DMs to strangers, no
  incentives.

Fields:

- **Name:** `InternScout`
- **Tagline** [53]:
```
Free internship search for every major, US and Canada
```
- **Description** [252]:
```
Search about 14,000 open internships, co-ops and research roles from employers' own job boards in the US and Canada, free with no account. An optional Chrome extension fills applications and stops at Submit. Built by one student, made for all students.
```
- **Links:** `https://internscout.org` (main) and the Chrome Web Store link **without** `utm_source`.
- **Topics:** Education, Career, Hiring, Chrome Extensions, Artificial Intelligence (keep 3 to 5;
  School is also a topic if Hiring doesn't fit).
- **Pricing:** Free options (freemium); "Free" with paid plans if that's the wording offered.
- **Thumbnail:** `docs/icon512.png`.
- **Gallery (in this order):** `docs/og-preview.png` (slogan), `store/screenshots/1-dashboard-light.png`,
  `store/screenshots/3-nursing-light.png`, `store/screenshots/2-setup-light.png`. The 1280×800
  screenshots are close to the 1270×760 recommendation; Product Hunt fits them. Add an extension
  screenshot if one is made (see "Before you start").
- **Maker's first comment** (Product Hunt: "Ask for feedback (NOT upvotes)"):
```
Hi Product Hunt. InternScout is a free internship search for college students of every major in the US and Canada.

Internships are posted on thousands of separate employer career sites. InternScout reads employers' own job boards (Workday, Greenhouse, Lever, iCIMS, Ashby, Oracle and more) several times a day, respecting robots.txt, and keeps the internships, co-ops and research roles: about 14,000 open right now from about 1,700 employers, across 66 fields.

What you can do:
- Search free, with no account. Set your major, class year and states, and listings are ranked for you.
- Every listing links to the employer's own application page.
- Optional: the InternScout Auto-Apply Chrome extension fills an application from your saved profile with AI and stops at the submit button. It never submits. You read every answer and press Submit yourself.

Pricing: search is free. The extension is free to use with a monthly AI allowance, doubled for a school .edu email. Supporter ($4/month) and Pro ($8/month) raise that allowance and nothing else.

Feedback I'd really value: which major or field looks thin to you, and any application form the extension gets wrong.

Built by one student, made for all students. (Not affiliated with UMass Amherst.)
```

---

## 4. Uneed

- **Submission page (verified 2026-10-02):** https://www.uneed.best/submit-a-tool ("No account needed
  to start"; an account is needed to save).
- **Cost:** free ("Join the line"). Paid Fast-track ($14.99) and Skip-the-line ($29.99) exist; not
  needed.
- **Requirements and rules:** the free waiting line closed on 2026-08-17 and reopened with new rules on
  2026-09-11 (Uneed changelog). The launch date is assigned automatically, 30 days to 5 months out;
  launches go live at 12:00 am PST with at least 30 free launches a day. A free launch **needs a score
  of 10 on launch day to stay published, and 20 to keep a do-follow link** (votes are weighted per
  voter). Only one product per free account in the line. Vote-ring votes are removed (see "Do not").
- **Limits:** up to **3 tags**; no published character limits for the description.

Fields:

- **Name:** `InternScout`
- **Website:** `https://internscout.org`
- **Tagline** (if asked) [53]: Tagline A
- **Category:** Productivity (or Education, whichever the list offers)
- **Tags (3):** Education, Productivity, AI
- **Description:** the shared **Long description** with the `?utm_source=uneed` store link.
- **Media:** logo `docs/icon512.png`; images: og-preview, then screenshots 1 and 3.
- **On launch day:** share the Uneed page the same way as Product Hunt (news, not a vote request).

---

## 5. Future Tools

- **Submission page (verified 2026-10-02):** https://www.futuretools.io/submit-a-tool
- **Cost:** free.
- **Requirements:** each tool is reviewed by the site's editor before it's added. A third-party
  comparison (aicentralresources.com, 2026) calls it free but selective (over 75% rejected), so the
  description leads with the AI part, which is what this directory lists.
- **Fields on the form:** Tool Name, Tool URL, Short Description, Category (dropdown), Pricing
  (Free / Freemium / Paid / Open Source), Your Email. No published limits.

Fields:

- **Tool Name:** `InternScout`
- **Tool URL:** `https://internscout.org`
- **Short Description** [238]:
```
Free internship search for college students of every major, plus a Chrome extension that fills internship applications with AI and stops at the submit button so the student reviews and submits. Built by one student, made for all students.
```
- **Category:** Productivity (alternative: Education)
- **Pricing:** Freemium
- **Your Email:** hello@internscout.org (leave the newsletter box unticked)

---

## 6. MicroLaunch

- **Submission page (verified 2026-10-02):** https://microlaunch.net → sign in → **New Launch** (top
  navigation). Launches run for a monthly cycle.
- **Cost:** free. Paid Pro Launch and review packages exist; not needed. No badge or backlink is
  required.
- **Limits (third-party guide, ideaproof.io, August 2026; check the form's counters):** every field is
  required; **tagline 60 characters**, **description 250 characters**, square logo 512 px or larger,
  2–3 screenshots, pricing model. The form "rarely saves drafts", so have everything ready.

Fields:

- **Name:** `InternScout`
- **URL:** `https://internscout.org`
- **Tagline** [53]: Tagline A
- **Description** [230]:
```
Free internship search for every major in the US and Canada: about 14,000 open roles from employers' own job boards. An optional Chrome extension fills applications and stops at Submit. Built by one student, made for all students.
```
- **Logo:** `docs/icon512.png`
- **Screenshots:** 1-dashboard-light, 3-nursing-light, 2-setup-light
- **Pricing model:** Freemium

---

## 7. Peerlist Launchpad

- **Submission page (verified 2026-10-02):** https://peerlist.io/launchpad → **Launch** (header) →
  choose the project. How-to:
  https://help.peerlist.io/individual/launchpad/how-to-launch-a-project-on-peerlist-launchpad
- **Cost:** free.
- **Requirements:** a **verified individual Peerlist profile** (a personal profile, so it shows the
  account holder), and the project must be **100% complete** in the profile's Work tab or "your launch
  will fail". The Launchpad opens **every Monday**; you can schedule a later week. A launch runs all
  week.
- **Limits:** not published on the help pages.

Fields (project in the Work tab):

- **Project name:** `InternScout`
- **Tagline** [53]: Tagline A
- **Project link:** `https://internscout.org`
- **Description:** the shared **Long description** with the `?utm_source=peerlist` store link.
- **Category / tags:** Education, Productivity, Chrome Extension, AI
- **Images:** og-preview, screenshots 1 and 3.
- **First comment:** the Product Hunt maker comment, with "Hi Product Hunt." changed to "Hi Peerlist."

---

## 8. There's An AI For That (TAAFT)

- **Submission page (verified 2026-10-02):** https://theresanaiforthat.com/launch/ (paid options) —
  the free path is not on that form.
- **Cost:** the form's options are paid ($49 "Low Traffic", $437 "Maximum Exposure"). The page's free
  option: "We run a thread on X once a month where indie makers can submit their tool for free. We
  choose one tool from each thread and list it for free." Third-party guides say a separate free queue
  exists only for 100% free or open-source tools; InternScout has paid plans and no open-source licence,
  so it doesn't qualify.
- **What to do:** if InternScout has an X account, watch @theresanaiforthat for the monthly thread and
  reply with the text below. Otherwise skip.

Reply for the monthly X thread [217]:
```
InternScout: free internship search for every major (US + Canada), plus a Chrome extension that fills applications with AI and never presses Submit. Built by one student, made for all students. https://internscout.org
```

---

## Skipped

- **Futurepedia — paid only.** Its own pages (as indexed by search on 2026-10-02; the pages
  returned errors to an automated fetch) list a $497 one-time "Verified" listing and a $247 "Basic" listing marked sold out; a
  2026 comparison (aicentralresources.com) says it "has pivoted to a strict pay-to-play model". No
  free path.
- **BetaList — paid only, and aimed at earlier startups.** Its support page (https://betalist.com/support,
  2026-10-02): "All submissions are paid. There is no free submission option." It also targets
  "pre-launch and recently launched startups".
- **Fazier — free tier needs a reciprocal link.** Third-party guides (2026) say the free Basic launch
  requires a Fazier link or badge on our homepage or footer. A link placed as the price of a listing is
  the kind of link exchange search engines discount and our README rules out; paying to remove it
  isn't a free option.

Also free and reasonable for a later round, not written up here: Launching Next
(https://www.launchingnext.com/submit/, no account, headline of 5–8 words, description up to 2,500
characters; it asks for a personal name, so use "InternScout") and an Indie Hackers product page.

## Sources (all checked 2026-10-02)

- AlternativeTo FAQ: https://alternativeto.net/faq/ ; Jobright page:
  https://alternativeto.net/software/jobright/about/
- SaaSHub submit rules: https://www.saashub.com/services/submit
- Product Hunt: https://help.producthunt.com/en/articles/479557-how-to-post-a-product ,
  https://www.producthunt.com/launch/preparing-for-launch ,
  https://help.producthunt.com/en/articles/484935-can-i-ask-my-community-friends-family-to-upvote-a-product ,
  https://help.producthunt.com/en/articles/3615694-community-guidelines ,
  https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines ,
  https://www.producthunt.com/p/databox/i-ve-analyzed-all-2026-ph-launches-to-find-the-best-day-to-launch
- Uneed: https://www.uneed.best/how-it-works , https://www.uneed.best/changelog ,
  https://help.uneed.best/getting-started/how-to-submit-your-first-product
- Future Tools: https://www.futuretools.io/submit-a-tool
- MicroLaunch: https://microlaunch.net , https://ideaproof.io/launch-directories/microlaunch
- Peerlist: https://help.peerlist.io/individual/launchpad/how-to-launch-a-project-on-peerlist-launchpad
- TAAFT: https://theresanaiforthat.com/launch/
- Futurepedia: https://www.futurepedia.io/verified (via search index),
  https://www.aicentralresources.com/best-ai-tool-directories-submission-fees-comparison-list
- BetaList: https://betalist.com/support
- Chrome Web Store listing (for the $5 wording):
  https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi
