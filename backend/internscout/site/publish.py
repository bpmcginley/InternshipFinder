"""Build and publish site artifacts from a fresh build state."""

from __future__ import annotations

from datetime import datetime, timezone
from functools import partial
import hashlib
from html import escape as esc
import json
import os
from pathlib import Path
import sys

from .. import page_dates, role_index, widget_data
from ..console_log import console
from ..feeds import ITEMS, _rfc822, _x
from . import feeds, llms, paid, runtime, share_cards, sitemap, source
from .runtime import (
    HELD_FILE,
    HOME_START,
    HOME_END,
    PLACEMENTS_FILE,
    PLACEMENT_AFTER,
    PLACEMENT_END,
    PLACEMENT_KINDS,
    PLACEMENT_START,
    SITE_PATH,
    _DAY_RE,
    row_meta,
)
from .text import safe_url


def _placement_box(x: dict, pl: dict, state: str | None = None) -> str:
    """One paid listing's box, between the markers, as B2 6.2 fixes it: "Paid listing", then "Ad" before
    the company name; the row's own title and grey line (row_meta); a posting link marked
    rel="sponsored noopener" with no data-aa (so the Auto-Apply offer never fires for it) and no company
    link; data-nosnippet to keep it out of search snippets. The inline script takes the box out once its
    end date (exclusive) has come, even if no deploy has run since. data-placement (2026-10-14, S9) carries
    the placement's id, for js/count.js: "shown" once the box is half on screen and "open" when its link
    is pressed, once per page load each; the id and the page's path are all it sends."""
    end = str(pl.get("end") or "")
    href = esc(safe_url(x.get("apply_url")) or "")
    if not _DAY_RE.match(end) or not href:
        return ""
    return (
        f'{PLACEMENT_START}<li class="paid" data-placement="{esc(pl.get("id") or "")}" data-nosnippet '
        'aria-label="Paid listing, not part of this page\'s list">\n'
        '<p class="paid-h">Paid listing <a href="/privacy.html#paid-listings">Why am I seeing this?</a></p>\n'
        f'<div class="co"><span class="ad">Ad</span> {esc(x.get("company_name") or "")}</div>\n'
        f'<div class="role">{esc(x.get("title") or "")}</div>\n'
        f'<div class="meta">{row_meta(x, state)}</div>\n'
        f'<a class="go" href="{href}" rel="sponsored noopener" target="_blank">Open posting</a>\n'
        f'</li><script>if(new Date().toISOString().slice(0,10)>="{end}")'
        f'document.currentScript.previousElementSibling.remove()</script>{PLACEMENT_END}'
    )


def _after_row(text: str) -> int:
    """Where a box goes in a page: after row PLACEMENT_AFTER of its list, or after its last row; -1
    when the page has no list or the list no rows."""
    start = text.find('<ul class="jobs">')
    if start < 0:
        return -1
    end = text.find("</ul>", start)
    at, n = start, 0
    while n < PLACEMENT_AFTER:
        nxt = text.find("</li>", at, end)
        if nxt < 0:
            break
        at, n = nxt + len("</li>"), n + 1
    return at if n else -1


def _add_paid_boxes(pages: list[dict], kept: list[dict], today: str) -> list[dict]:
    """pages with at most one paid listing's box each (MAX_PER_PAGE), on the listing pages
    (PLACEMENT_KINDS) whose own items include its listing. kept: placements.resolve's. When two or more
    fit one page, a hash of the path and the day picks one, so two builds on the same day are the same
    and price never matters. Only "html" changes; a page with no box is the same dict."""
    max_per_page = paid.placement_services().MAX_PER_PAGE

    if not kept or max_per_page < 1:
        return pages
    out = []
    for p in pages:
        if p.get("kind") not in PLACEMENT_KINDS or not p.get("items"):
            out.append(p)
            continue
        here = {str(x.get("id")): x for x in p["items"]}
        fits = sorted((pl for pl in kept if pl["listing_id"] in here), key=lambda pl: pl["id"])
        at = _after_row(p["html"]) if fits else -1
        if at < 0:
            out.append(p)
            continue
        pl = fits[int(hashlib.sha256((p["path"] + today).encode()).hexdigest(), 16) % len(fits)]
        box = _placement_box(here[pl["listing_id"]], pl, p.get("state"))
        out.append(dict(p, html=p["html"][:at] + box + p["html"][at:]) if box else p)
    return out


def _write_placements(site_dir: str, kept: list[dict], today: str) -> None:
    """<site_dir>/data/placements.json: the placements kept today, public fields only."""
    public = paid.placement_services().public

    folder = os.path.join(site_dir, "data")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, PLACEMENTS_FILE), "w", encoding="utf-8", newline="\n") as f:
        json.dump(
            {"day": today, "placements": public(kept)}, f, ensure_ascii=False, separators=(",", ":")
        )
        f.write("\n")


def _today_utc() -> str:
    """Today's UTC day. A placement's dates are UTC days, start inclusive and end exclusive."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _write_site(
    site_dir: str,
    pages: list[dict],
    state: runtime.BuildState,
    hooks: runtime.BuildHooks,
    *,
    share_views: str = "",
) -> None:
    home_body = state.home + share_views
    # 2026-10-23: date real visible changes, including corrections and closures, after all page
    # decisions. was: only max(first_seen, live lastmod); see page_dates for the one-line revert.
    now = state.generated or datetime.now(timezone.utc)
    content_dates, home_lastmod = page_dates.refresh(
        site_dir,
        pages,
        now,
        home_body,
        HOME_START,
        HOME_END,
        state.listings,
        home_floor=state.home_live_date,
    )
    for p in pages:
        folder = os.path.join(site_dir, p["path"].strip("/").replace("/", os.sep))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "index.html"), "w", encoding="utf-8", newline="\n") as f:
            f.write(p["html"])
    # 2026-11-02: GitHub Pages serves static files; was: the retired URL returned 404.
    # A zero-second meta refresh preserves the retired Altera
    # link without creating another listing page or changing sitemap/indexing eligibility.
    # Emit it only when the real destination survived the existing page-generation rules.
    if any(p["path"] == "/internships/at/altera/" for p in pages):
        folder = os.path.join(site_dir, "internships", "at", "altera-corporation")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "index.html"), "w", encoding="utf-8", newline="\n") as f:
            f.write(
                '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<title>Altera internships | InternScout</title>'
                '<meta http-equiv="refresh" content="0;url=https://internscout.org/internships/at/altera/">'
                '<link rel="canonical" href="https://internscout.org/internships/at/altera/">'
                '</head><body><p>Altera internships have moved to '
                '<a href="/internships/at/altera/">Altera internships</a>.</p></body></html>\n'
            )
    now = state.generated or datetime.now(timezone.utc)  # was: now = datetime.now(timezone.utc)
    with open(os.path.join(site_dir, "404.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(runtime.invoke(state, hooks, runtime.not_found, f"{now:%B} {now.day}, {now.year}"))
    sitemap.write_sitemap(site_dir, pages, home_lastmod, state.site, esc)
    sitemap.write_robots(site_dir, state.site)
    llms.write(site_dir, state.texts)
    page_dates.write(site_dir, content_dates)  # 2026-10-23: persist hashes, not page membership.
    # The thin pages this deploy serves (INDEX_COMBO), for the next deploy's held_paths (2026-10-13).
    with open(os.path.join(site_dir, HELD_FILE), "w", encoding="utf-8", newline="\n") as f:
        # was: "...(too few roles to ask search engines to index)." and EMPLOYER_MARK's line (2026-10-24)
        f.write(
            "# InternScout pages served with noindex, follow: too few roles, a near page, or another page's "
            "list under a second name.\n"
            + "".join(
                p["path"] + "\n" for p in sorted(pages, key=lambda p: p["path"]) if p.get("thin")
            )
        )
    # The dashboard's Browse section (home_browse), between its two markers. Only what is between them
    # changes, so writing it twice gives the same file.
    home = os.path.join(site_dir, "index.html")
    if state.home and os.path.isfile(home):
        with open(home, encoding="utf-8", newline="") as f:
            text = f.read()
        start, end = text.find(HOME_START), text.find(HOME_END)
        if 0 <= start < end:
            text = text[: start + len(HOME_START)] + home_body + text[end:]
            with open(home, "w", encoding="utf-8", newline="") as f:
                f.write(text)


def _live_paths(sitemap_path: str) -> dict[str, str]:
    """path -> lastmod ("" if none) for every page in the sitemap the site was serving before this
    build; empty if there was none."""
    return sitemap.live_paths(sitemap_path, SITE_PATH)


def _held_paths(listing: str) -> frozenset[str]:
    """The noindex pages the site was serving before this build (HELD_FILE); empty if there was none."""
    try:
        with open(listing, encoding="utf-8") as f:
            return frozenset(
                s for s in (line.strip() for line in f) if s.startswith("/internships/")
            )
    except (OSError, UnicodeDecodeError):
        return frozenset()


def main(
    argv: list[str], *, card_renderer: share_cards.Renderer | None = None, _follow=None
) -> None:
    """python -m internscout.site.publish SITE_DIR [LIVE_SITEMAP [LIVE_NOINDEX_LIST]] [--placements PATH]
    [--placements-report PATH] [--employer-postings] [--employer-posting-capture]

    --placements PATH (2026-10-14): the Worker's GET /placements answer, which the pages workflow
    fetches only when the repo variable INTERNSCOUT_PLACEMENTS_URL is set and otherwise writes as
    {"placements":[]}. With it, the build writes <site_dir>/data/placements.json (an empty list when the
    file is missing or malformed), prints a ::warning:: for each placement it drops, and adds the boxes.
    Without it, nothing about placements is written or changed.

    --placements-report PATH (2026-10-14), with --placements: also writes PATH, the build's report for
    placements.record_runs (placements.report: the UTC day, the ids kept and the ids dropped with their
    reasons). The pages workflow writes it outside the site, so it is never published.

    --employer-postings explicitly stages the already-selected export and its matching catalog
    before rendering organic annotations from that same captured data. Off by default; it does
    not enable browser capture or Worker collection. Use a fresh staged export for each build.
    --employer-posting-capture additionally marks supported count scripts, only with that staging.
    It does not configure Worker intake or change any production workflow."""
    argv = list(argv)
    capture = "--employer-posting-capture" in argv
    if capture:
        if argv.count("--employer-posting-capture") != 1 or argv.count("--employer-postings") != 1:
            raise ValueError("Capture requires exactly one employer publication option")
        argv.remove("--employer-posting-capture")
    employer_postings = "--employer-postings" in argv
    if _follow is not None and (employer_postings or capture):
        raise ValueError("Follow publication supplies its own paired stage")
    if employer_postings:
        if argv.count("--employer-postings") != 1:
            raise ValueError("Duplicate employer publication option")
        argv.remove("--employer-postings")
    placements_path = None
    report_path = None
    if "--placements-report" in argv:
        i = argv.index("--placements-report")
        report_path = argv[i + 1] if i + 1 < len(argv) else ""
        del argv[i : i + 2]
    if "--placements" in argv:
        i = argv.index("--placements")
        placements_path = argv[i + 1] if i + 1 < len(argv) else ""
        del argv[i : i + 2]
    if _follow is not None and report_path is not None:
        raise ValueError("Private Follow publication forbids external report sidecars")
    site_dir = argv[1] if len(argv) > 1 else "docs"
    from .employer_capture import require_unmarked

    require_unmarked(Path(site_dir))
    state = runtime.BuildState()
    hooks = runtime.BuildHooks()
    if _follow is not None and (employer_postings or capture):
        raise ValueError("Follow publication supplies its own paired stage")
    if employer_postings:
        from .employer_publication import prepare

        data, state.posting_links = prepare(site_dir)
        hooks = runtime.BuildHooks(load=lambda _site: data)
    if _follow is not None:
        hooks = _follow.configure(state)
    pages = runtime.invoke(
        state,
        hooks,
        runtime.build_result,
        site_dir,
        _live_paths(argv[2]) if len(argv) > 2 else {},
        _held_paths(argv[3]) if len(argv) > 3 else frozenset(),
    ).pages
    if _follow is not None:
        _follow.write(Path(site_dir))
    built = pages  # as build() made them, before any paid box, for the feeds
    today = _today_utc()
    if placements_path is not None:
        placements = paid.placement_services()

        kept, dropped = placements.resolve(
            placements.read(placements_path), {str(x["id"]): x for x in state.listings}, today
        )
        # GitHub Actions annotations must remain raw even in JSON log mode.
        for line in placements.warnings(kept, dropped):
            print(line)
        _write_placements(site_dir, kept, today)
        if report_path:
            # Only a record for refunds: a report that cannot be written never stops the build.
            try:
                with open(report_path, "w", encoding="utf-8", newline="\n") as f:
                    json.dump(placements.report(kept, dropped, today), f, separators=(",", ":"))
                    f.write("\n")
            except OSError:
                print("::warning::placements report not written")
        pages = runtime.invoke(state, hooks, _add_paid_boxes, pages, kept, today)
        console(f"[seo] placements: {len(kept)} kept, {len(dropped)} dropped")
    share_views = ""
    if card_renderer is not None:
        pages = share_cards.publish(Path(site_dir), pages, state.site, card_renderer)
        share_views = share_cards.dashboard_views(pages)
    _write_site(site_dir, pages, state, hooks, share_views=share_views)
    # The role index the employer buy page searches and the Worker checks orders against (2026-10-19,
    # role_index). Here and not in build(), which writes nothing: growth/report.py calls build() on docs/.
    shards = role_index.write(
        site_dir, state.listings, state.generated or datetime.now(timezone.utc), today
    )
    console(f"[seo] role index: {sum(shards.values())} roles in {len(shards)} shards")
    # Feeds use the same snapshot date and the pages before the paid-placement pass.
    render_feed = partial(
        feeds.rss,
        site=state.site,
        place=source.place,
        pay_text=source.pay_text,
        safe_url=safe_url,
        xml_text=_x,
        rfc822=_rfc822,
    )
    feeds.write_all(
        site_dir, built, state.generated or datetime.now(timezone.utc), render_feed, ITEMS
    )
    # The embedded widget needs real per-field coverage, not the dashboard's 60-row preview.
    widget_data.write(site_dir, state.listings, state.generated, _today_utc())
    if capture:
        from .employer_capture import stamp

        stamp(Path(site_dir), pages)
    message = f"[seo] wrote {len(pages)} pages, sitemap.xml and robots.txt"
    if os.environ.get("INTERNSCOUT_LOG_FORMAT") != "json":
        message += f" into {site_dir}"
    console(message)


if __name__ == "__main__":
    main(sys.argv)
