# Social playbook: Heycatch, Zeely and the weekly campaign pack

Written October 25, 2026 from the accounts and the site's own numbers. It records how each tool is
used and the rules every post follows. It does not change an account, a queue, a budget or a schedule;
each of those is the owner's decision, listed under [Decisions](#decisions-for-the-owner).

## What the numbers say

**Heycatch analytics, Sep 26 to Oct 25** (46 posts, 7.4K views, 6 followers across Instagram, TikTok,
YouTube and Facebook):

| Kind of post | Example | Views | Engagement |
|---|---|---:|---:|
| Practical slideshow, TikTok | "how to stop losing hours to internship forms" | 911 | 4.3% |
| Practical slideshow, TikTok | "signs your internship search is finally finding non-tech roles" | 892 | 5.2% |
| Relatable Short, YouTube | "me spotting the 11th job board after checking 10 tabs" | 1.4K | 0.7% |
| Count card, Instagram | "21 new marketing internships in the Northeast..." | 1 | 0% |
| Hype video, Instagram | "Unlock Your Dream Internship! 🚀✨" | 179 | 0% |

Practical, specific posts get watched and saved. Count cards and ad-style copy do not.

**Site visits by channel** (the Worker's `visit_channels`):

| Channel | Oct 5 to Oct 25 | Oct 18 to Oct 25 |
|---|---:|---:|
| Flyers, all spots | 182 | 76 |
| Facebook | 117 | 111 |
| Instagram | 106 | 102 |
| LinkedIn | 29 | 6 |
| Bluesky | 3 | 0 |

The Facebook and Instagram visits came almost entirely on Oct 22 to Oct 24, from Zeely's paid Meta
campaign (below). Clicks to postings, installs and new accounts did not move on those days (posting
clicks stayed near 40 a day), so those visitors looked and left.

**Zeely, Meta campaign "InternScout2"** (active, $100 budget over 10 days): $12.73 spent, 1,960
impressions, 59 clicks (1.95% CTR). Two of its seven ads did most of the work: `InternScout2_0` (4.37%
CTR, $0.22 a result) and `InternScout2_6` (3.83%, $0.23). Three ran under 1%. The ads run from the
"Zeely Marketplace" page, not InternScout's, with no audience set, and link to the home page with no
utm tag.

## The weekly routine

| Day | What | Where | Made by |
|---|---|---|---|
| Monday | Tip slideshow (pack: `tip`) | TikTok photo mode, Instagram and Facebook carousel | `growth/campaign.py` |
| Tuesday | Count post | Bluesky; Instagram card | `growth/social.py` (Brand posts) |
| Wednesday | Real-search slideshow (pack: `search`) | TikTok photo mode, Instagram and Facebook carousel | `growth/campaign.py` |
| Thursday | Real-search video (pack: `search.mp4`) | YouTube Short, Instagram and Facebook Reel | `growth/campaign.py` |
| Thursday | Count Reel | Bluesky; Instagram | `growth/social.py` |
| Saturday | Tip video (pack: `tip.mp4`) | YouTube Short, TikTok | `growth/campaign.py` |
| Daily, 10 minutes | Swipe Heycatch's video ideas (rules below); answer comments | Heycatch queue | the owner |

The pack is written every Monday at 12:00 UTC by the Campaign pack workflow and kept for 30 days as the
run's `campaign-pack` artifact. Its README has the week's schedule and the checks before posting. One
post per channel per day: when a channel already has the native post, skip the pack piece there.

Every link in the pack carries `utm_source=<channel>&utm_medium=social&utm_campaign=weekly-<year>w<week>`,
so the weekly scorecard can say which piece sent people, not only which site.

## Rules for every post

These keep AI's part small and out of sight, so nothing reads as machine-made.

1. **Real numbers, real product.** Every figure comes from the listings that week; every screen is the
   real site. No stock footage of students, no AI avatar, no AI voice.
2. **Nothing invented.** No student stories, quotes, testimonials or outcomes ("landed an offer").
   Heycatch's ideas that open with "just watched a nursing major..." are invented observations: reject.
3. **Plain words.** No hype words or emoji (`growth/campaign.py` BANNED refuses them in the pack);
   no em dashes. Say what InternScout does: one free search across 66 fields, no account needed.
4. **AI is a tool, not the author.** Fine: trimming, captions timed to the words, the app's own music,
   resizing. Not fine: rewriting what a slide says, "enhanced" text, generated people.
5. **The owner answers.** Comments and replies come from the person who made InternScout, in his own
   words. Reddit stays paused until the profile's visibility is checked (notes, Oct 7).

## Heycatch until November 30

The subscription ends November 30 (the account says so; it will not renew). Until then:

- **Videos (20 swipes a day):** accept slideshows and relatable formats that make no claim about a
  person; reject anything with stock footage of an invented student or an invented observation.
  Accepting schedules straight to YouTube, TikTok and Facebook, so read the caption first.
- **Blog content (one AI article a day): leave it off.** Google cut the site's impressions by about 93%
  from Oct 19, most likely for mass-produced pages. Daily AI articles are the riskiest thing to add now.
- **Catches (X and Reddit threads):** useful for finding students asking where to look. Reply yourself,
  briefly, and only where InternScout answers the question.
- **Short links:** needs the site connected to Heycatch; skip it, the pack's utm tags do the same job.
- **After November 30:** TikTok, YouTube and Facebook videos move to Zeely's Social posting (TikTok and
  Instagram) and a hand upload to YouTube, from the same pack.

## Zeely

The plan is active with 12,420 credits.

- **Social posting:** schedule the pack's slideshows and videos to TikTok and Instagram from here. It is
  the one tool that keeps working after November 30.
- **Meta ads:** worth continuing only once they can be judged (below). Use the pack's slides as the ad
  images instead of generated ones; they already outperform the generic copy.
- **Not for InternScout:** AI avatar videos and "AI twin" creators (rule 1), and competitor ad copying.

## Decisions for the owner

1. **The active Meta campaign.** Recommended: pause the five ads under 2% CTR, keep `InternScout2_0` and
   `InternScout2_6`; set the audience to the US and Canada, ages 18 to 24; run it from the InternScout
   Facebook page and Instagram account instead of "Zeely Marketplace"; link to
   `https://internscout.org/?utm_source=facebook&utm_medium=paid&utm_campaign=zeely-meta`. Judge it by
   posting clicks and new accounts per dollar, not visits.
2. **Instagram's Tuesday count card.** Recommended: replace it with the pack's carousel (count cards draw
   1 or 2 views). That is a change to `growth/social.py`, made only after the first two packs are posted.
3. **Approve the first pack** before anything from it is scheduled (the October 5 policy: the owner
   reviews the first queue).
