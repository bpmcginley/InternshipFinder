# Brand publishing ownership and Reel recovery

Checked October 16, 2026. This records the existing setup and an operating rule; it does not change
account connections, queue posts, run workflows, or grant new permissions.

## One publishing owner for each channel

Updated October 25, 2026: Heycatch's subscription ends November 30, and the weekly campaign pack (`growth/campaign.py`) supplies the material for every channel. See [the social playbook](SOCIAL_PLAYBOOK.md) for the routine and the move to Zeely's Social posting after November 30.

| Channel | Current evidence | Publishing owner / next decision |
|---|---|---|
| Bluesky | The native Brand posts workflow posted on October 15. | Keep the native workflow as publisher. Do not mirror its field posts through Heycatch. |
| Instagram | The native workflow published its picture card on October 15 after a Reel failed. | Keep the native workflow as publisher. The repair below addresses Reel delivery; do not queue the same card in Heycatch. |
| YouTube | Native upload skipped on October 15 because its uploader credentials were absent. Heycatch's account UI now confirms `@internscoutorg`, with posted and already-scheduled videos. | Keep Heycatch as the existing video publisher. Do not add native YouTube credentials or run a second uploader for the same material. Heycatch status alone is not independent verification of every destination post. |
| TikTok / Facebook | Heycatch's account UI confirms the product accounts and shows existing posted/scheduled videos for these channels. | Keep the existing Heycatch queue; this work did not approve, add, edit, cancel or reschedule any post. New campaign copy stays in drafts. |
| X / Reddit | Heycatch's account UI confirms `@useinternscout` and `u/InternScout`. | Connection is verified, not text-post delivery. Review the Catches queue and existing destination posts before approving new content. |
| Threads | No Threads connection appears in the current Heycatch account list. | Do not claim this channel is ready. Completing any account challenge or new publishing permission is a separate owner action. |
| LinkedIn | Native code saves a draft in private analytics; this does not establish a live Page or a post. | Manual review and release only after the destination exists and is approved. |
| Mastodon / Discord | Native workflow supports them, but the October 16 secret inventory lacks their publishing token/webhook. | Do not create accounts or add credentials to fill every available channel. Choose based on actual student use. |

Before releasing a prepared campaign set, compare the native run and recent posts with the Heycatch
queue. `SOCIAL_ENABLED=0` is the native workflow's off switch; when unset, configured native accounts
are already enabled. Its daily guard prevents a second native run, not a duplicate in another app.
Do not use `force` to check whether a previous post succeeded. Read its step log and the destination.
Heycatch also lists Instagram `@internscout` as connected, but no Instagram destination appeared in the
video queue inspected October 16. Keep native Instagram ownership until an explicit handoff is agreed.

## What failed and what changes

[October 15 publishing run](https://github.com/bpmcginley/InternshipFinder/actions/runs/38757092945)
reported `video_url is required` when the Instagram Login integration attempted a resumable upload.
It then published the card, so the workflow stayed green. A later green run skipped publishing as a
duplicate. Neither result establishes a successful Reel.

The repair keeps `graph.instagram.com`, the existing Instagram user ID lookup and token permissions.
It supplies a public `video_url` when creating a REELS container, waits for FINISHED, then publishes
the container. The workflow places the generated MP4 beside its JPEG on the existing `social-cards`
branch. `/social-video/YYYY-MM-DD-field.mp4` on the existing Worker streams only that repository's
dated brand videos as `video/mp4`. It accepts GET/HEAD and a single byte range, refuses redirects and
files above 16 MiB, forwards no browser credentials, records no download analytics, and stores no
second copy. There is no new paid hosting service or account.

Meta's [official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-d34db4fa-de2e-433a-9449-a55a755b5bc0)
documents public video URLs, the REELS container, status polling and publishing. Its
[official Reel sample](https://github.com/fbsamples/reels_publishing_apis/blob/main/insta_reels_publishing_api_sample/README.md)
also documents a resumable flow, but that sample requires Facebook Login and a connected Page.
InternScout uses Instagram Login; this repair does not switch that account flow. The direct
[Instagram Login guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/)
was inaccessible to the research tool on October 16, so the retrieved primary collection/sample and
the actual API error support this focused fix. No claim of live publishing success is made from
mocked tests.

## Result reporting

The Instagram step writes `out/instagram-status.json`, retained as the
`instagram-publishing-result` Actions artifact for 14 days, and a step summary. It contains only the
requested format, timestamp, finite outcome and optional reason code, never tokens, captions or raw
provider errors. Outcomes distinguish `published_reel`, `published_card`, `card_fallback`,
`not_configured`, `no_post`, `unknown` and `failed`. A card replacing a planned Reel produces an Actions warning.
The native workflow can still finish green after a successful fallback; read its result rather than
calling green proof that every channel or format published.

A final `media_publish` request is the ambiguity boundary. If its response is lost, times out,
returns an HTTP error (including 5xx), contains unreadable JSON, or has no usable media ID, Meta may
already have published the post. The step records `unknown` / `final_publish_unconfirmed`, emits an
error and exits unsuccessfully. It makes no second publish attempt and creates no fallback card.
This also applies to a card's final publish. Only failures before the final publish request may
fall back from a Reel to a card. A reporting-file error after confirmed Reel publication cannot
enter the card fallback either.

When the result is unknown, inspect the InternScout product profile and Meta's provider state before
any retry, requeue, cross-post or `force` run. If the post exists, retain it and do not repost. If its
state cannot be established, leave the run unresolved rather than guessing that failure means no
post. The daily native guard still prevents an automatic second run; it does not resolve provider
uncertainty or protect a separate Heycatch queue.

## Deployment and validation

1. Deploy the Worker route before the changed Brand posts workflow can run. No database migration,
   secret, account reconnection, new permission or provider plan is needed for this route.
2. Tests cover the hosted-video request contract, success/fallback distinction, absent or unavailable
   media, invalid URLs, public streaming, byte ranges, safe upstream selection, size limits, HEAD,
   upstream errors and credential isolation. They make no provider calls and publish no test posts.
3. On the next already-approved scheduled Reel day, check the media URL's HEAD response, Instagram
   result artifact and the actual product profile. A successful public MP4 fetch is a hosting check,
   not proof Meta published the Reel. If the card falls back, diagnose from the log; do not force a
   second run that can duplicate the channels already published.

The signup campaign's Weiss fellowship has been removed from reusable copy ahead of its October 16,
5 p.m. Eastern deadline. Its historical source remains under `retired_roles` in the campaign JSON.
Every remaining opportunity still requires a current employer-page check before release.
