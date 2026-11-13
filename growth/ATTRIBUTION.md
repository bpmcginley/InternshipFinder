# Campaign attribution

InternScout's own counter records anonymous totals. It does not use a visitor ID, cookie or ad
pixel. A tagged visit may carry these bounded slugs:

```text
utm_source=x&utm_medium=social&utm_campaign=weekly-2026w44&utm_content=search_card
```

The page keeps those tags only in the current tab's session storage. That lets an intent event on a
later InternScout page retain the campaign. Closing the tab clears the context. The Worker writes a
second aggregate row only for:

- `install_click`: a Chrome Web Store link was pressed;
- `digest_signup`: a Buttondown form was submitted; and
- `employer_order_submit`: the employer order form was submitted.

These are not provider-confirmed outcomes. Compare them with the Chrome Web Store's install total,
Buttondown's confirmed subscriber total and Stripe's paid employer-order total. Do not label an
intent row as an install, subscriber or sale.

## Weekly read

```sql
SELECT source, channel, campaign, content, event, SUM(n) AS intents
FROM event_attribution
WHERE day >= date('now', '-6 day')
GROUP BY source, channel, campaign, content, event
ORDER BY intents DESC, source, channel, campaign, content, event;
```

Use one `utm_campaign` for the experiment and a non-personal `utm_content` for the creative or
placement. Good content labels are `search_card`, `tip_video` and `pricing_footer`. Never put a
person's name, email address, club name or other identifying value in a UTM tag. The Worker accepts
only lowercase letters, digits, `_` and `-`, at most 48 characters, and limits new attribution rows
per day.

## Confirmed outcomes

Buttondown supports a `subscriber.confirmed` webhook, but correlating that event to the originating
campaign would require retaining a subscriber-level join key. InternScout does not do that. The
existing confirmed-subscriber check remains an aggregate provider total. Stripe-confirmed student
and employer payments remain server-side aggregate events, without campaign correlation. This is a
deliberate privacy boundary, not a missing analytics claim.

To revert, remove `event_attribution` and the tab-scoped context in `docs/js/count.js`. Existing
`visit_counts`, `visit_channels` and `event_counts` continue to work independently.
