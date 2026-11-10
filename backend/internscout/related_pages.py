"""Prefer existing indexed destinations in generated related-page recommendations."""
from collections import Counter, defaultdict
from html import escape, unescape
import re
from urllib.parse import urlsplit

SECTIONS = re.compile(r'(<section class="rel"><h2>)(.*?)(</h2><ul>)(.*?)(</ul></section>)', re.S)
ROWS = re.compile(r'<li>.*?</li>', re.S)
HREF = re.compile(r'<a href="([^"]+)"')
# 2026-10-23: these are complete browsing catalogues, not recommendations. Removing entries would
# make their "every employer/field" wording false and hide useful noindex pages from students.
# Revert: remove prefer_indexed() at the end of seo_pages.build(); eligibility is never changed.
CATALOGUES = frozenset({"/internships/at/", "/internships/for/", "/internships/near/"})


def row(page, all_places=False):
    label = page["h1"] + (" (all places)" if all_places else "")
    count = len(page.get("items") or [])
    return (f'<li><a href="{escape(page["path"], quote=True)}">{escape(label)}</a>'
            + (f' <span class="n">{count:,}</span>' if count else '') + '</li>')


def prefer_indexed(pages):
    """2026-10-23: was: recommendations included every candidate, including noindex ones.

    Read the final eligibility decisions; only recommendation HTML changes. In particular, do not
    duplicate thresholds here: PR #140's decisions must work without updating a second rule set.
    """
    by_path = {p["path"]: p for p in pages}
    indexed = {p["path"] for p in pages if p.get("index", True)}
    role_fields = defaultdict(set)
    for field in pages:
        if field.get("kind") == "field" and field["path"] in indexed:
            for item in field.get("items") or []:
                role_fields[str(item["id"])].add(field["path"])
    for page in pages:
        if page["path"] not in indexed or page["path"] in CATALOGUES:
            continue
        page_seen = set()

        def section(match):
            # 2026-10-23: was: one seen set per section, which repeated a field already recommended
            # above. Revert: initialize seen here instead of once per page.
            seen, kept, browse = page_seen, [], []
            for original in ROWS.findall(match[4]):
                anchor = HREF.search(original)
                if not anchor:
                    kept.append(original)
                    continue
                target = urlsplit(unescape(anchor[1])).path
                replacement = original
                if target in by_path and target not in indexed:
                    # Keep the useful page reachable for students, in a separate browsing control.
                    # was: these were primary recommendations. Revert: restore the original row.
                    browse.append(original)
                    # A thin field-in-place recommendation can still offer the relevant field.
                    # Its label and count now explicitly describe all places, not the local subset.
                    parts = target.strip("/").split("/")
                    root = "/" + "/".join(parts[:2]) + "/"
                    field = by_path.get(root)
                    if not field or field.get("kind") != "field" or root not in indexed:
                        continue
                    target, replacement = root, row(field, all_places=True)
                if target == page["path"] or target in seen:
                    continue
                seen.add(target)
                kept.append(replacement)
            recommended = match[1] + match[2] + match[3] + "".join(kept) + match[5] if kept else ""
            more = ('<details class="browse-more"><summary>More ways to browse</summary><ul>'
                    + ''.join(browse) + '</ul></details>') if browse else ''
            return recommended + more

        page["html"] = SECTIONS.sub(section, page["html"])
        if page.get("items") and not SECTIONS.search(page["html"]):
            # Use actual shared role IDs for the fallback, never an invented employer specialty.
            shared = Counter(path for item in page["items"] for path in role_fields[str(item["id"])])
            choices = [by_path[path] for path in sorted(shared, key=lambda p: (-shared[p], p))
                       if path != page["path"]][:3]
            if choices:
                extra = '<section class="rel"><h2>Related fields</h2><ul>' + ''.join(row(p) for p in choices) + '</ul></section>'
            elif "/internships/" in indexed:
                extra = '<section class="rel"><h2>More internships</h2><ul><li><a href="/internships/">Browse internships by field and place</a></li></ul></section>'
            else:
                extra = ""
            page["html"] = page["html"].replace("</main>", extra + "</main>")
    return pages
