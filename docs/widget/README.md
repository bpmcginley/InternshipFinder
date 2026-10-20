# InternScout embeddable widget

A lightweight widget a career center (or anyone) can drop on their site with one
snippet. It shows open internships from InternScout's own listing data and links
each one to its listing. No account, no tracking, no external dependencies.

## Embed snippet

```html
<iframe src="https://internscout.org/widget/?field=swe&limit=8"
        width="100%" height="560" style="border:0" loading="lazy"
        title="Open internships from InternScout"></iframe>
```

## Parameters

- `field` (optional): filter to a field. Accepts listing field tags
  (`swe`, `finance`, `data`, `mechanical`, `electrical`, `civil`, `chemical`,
  `biomedical`, `hardware`, `accounting`, `marketing`, `health`, `law`,
  `sales`, `government`, ...) or friendly aliases (`computer-science`,
  `data-science`, `mechanical-engineering`, ...). Comma-separate for several.
  Omit for all fields, newest first.
- `limit` (optional): how many listings to show. Default 8, max 12.

## Notes

- Data comes from `docs/data/first.json`, the same small first-screen file the
  site paints from. It refreshes with the normal listings pipeline, so the
  widget stays fresh with no extra work.
- Each listing links to its `apply_url` (the site's existing link convention:
  new tab, `rel="noopener"`, http(s) URLs only).
- The page carries `noindex, follow` so it never competes with the site's SEO
  pages; the "Powered by InternScout" attribution links back to internscout.org.
- Iframe, not a script tag: third-party sites can't fetch the static JSON or
  the Worker API cross-origin (CORS is restricted), but an iframe on
  internscout.org fetches its own data with no CORS issues and its styles stay
  fully self-contained.
