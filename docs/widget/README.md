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

- Data comes from `/data/widget.json`, generated during each existing Pages build
  by `backend/internscout/widget_data.py` from the complete deduplicated open
  listing set. It contains the newest 12 roles per field plus the global newest
  12, merged into one compact collection. Filtering several fields uses OR, so
  this collection contains the true newest 12 for every supported widget query.
  Closed, expired and unsafe-link records are excluded. It never uses the
  dashboard's 60-row `first.json` preview to decide whether a field is empty.
- Each embed downloads one file, capped at 2 MiB and 12 seconds, instead of
  downloading dozens of state shards. The schema allows at most 128 fields and
  1,548 rows. A malformed, incomplete, oversized or unavailable response shows an
  error with a search link; it never reports a failed download as an empty field.
  The initial loading message is visible and announced. The footer shows the
  actual export date (UTC) and eligible open-role total.
- Field counts are from the full source set. The build and widget verify that
  every nonempty field has its expected top roles, up to 12. In the October 19
  reproduction, civil, chemical and biomedical all had open roles despite having
  none in `first.json`; the full feed fixes those false empty states. `nursing`
  uses the nursing tag, while `healthcare` remains an alias for health.
- Each listing links to its `apply_url` (the site's existing link convention:
  new tab, `rel="noopener"`, http(s) URLs only).
- The page carries `noindex, follow` so it never competes with the site's SEO
  pages; the "Powered by InternScout" attribution links back to internscout.org.
- Iframe, not a script tag: third-party sites can't fetch the static JSON or
  the Worker API cross-origin (CORS is restricted), but an iframe on
  internscout.org fetches its own data with no CORS issues and its styles stay
  fully self-contained.

## Validation and deployment

The generator is wired into the existing site build, so deploy the widget page
and generated feed together with the normal Pages workflow. No API, credentials,
database migration or separate ingest run is needed. Tests cover a field absent
from a 60-row preview, full-corpus per-field and combined-query ordering,
deduplication, closed/expired roles, bounded downloads, timeouts and error states.
The October 19 source produced a 235 KB feed from about 15,000 eligible roles;
these are verification measurements, not permanent size or inventory promises.
