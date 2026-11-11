"""Assemble the selected listing families, catalog hubs and information pages."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Collection, Mapping
from html import escape as esc

from . import build, digest, employer, field, listing
from .render.layout import link_list


def emit_field_pages(
    add: build.AddPage,
    context: field.Context,
    cohorts: build.Cohorts,
    majors: build.Majors,
    by_company: build.Groups,
    digest_by_field: Counter,
    live: build.Live,
    earning: frozenset[str],
    *,
    canada_keys: Collection[str],
    ca_metro_pages: Collection[str],
    digest_min_new: int,
    registry: Mapping[str, str],
    metro_state: Mapping[str, str],
    related: int,
    us_metro_pages: Collection[str],
    field_slug: Callable[..., str],
    slugify: Callable[..., str],
    state_slug: Callable[..., str],
    listing_faq: Callable[..., list[tuple[str, str]]],
    combo_indexed: Callable[..., bool],
    render_combo: Callable[..., dict],
    render_field: Callable[..., dict],
    render_major: Callable[..., dict],
    render_place: Callable[..., dict],
) -> list[tuple[str, str, int]]:
    fields, states, combos, inside = cohorts.fields, cohorts.states, cohorts.combos, cohorts.inside
    fits, updated = majors.fits, context.updated
    page_name = {registry[nm]: nm for nm in by_company}  # employer page -> the name it goes by
    for t, items in sorted(fields.items()):
        path = f"/internships/{field_slug(t)}/"
        top_states = field.counts_by_place(combos, t)
        employers, hiring = field.hiring_links(items, registry, page_name, related)
        fresh_n = digest_by_field[t]
        model = field.Field(
            context=context,
            tag=t,
            path=path,
            items=items,
            states=[entry for entry in top_states if entry[0] not in us_metro_pages],
            cities=[entry for entry in top_states if entry[0] in us_metro_pages],
            employers=employers,
            more_employers=(len(by_company), hiring) if hiring > related else None,
            fits=fits.get(path),
            signup_count=fresh_n if fresh_n >= digest_min_new else None,
            co_ops=field.has_co_ops(items),
            faq=listing_faq(items, t, None, updated),
        )
        add(**render_field(model))

    for k, items in sorted(states.items()):
        path = f"/internships/{state_slug(k)}/"
        parent = metro_state[k] if k in us_metro_pages and metro_state[k] in states else None
        place_model = field.Place(
            context=context,
            key=k,
            path=path,
            items=items,
            fields=field.counts_by_field(combos, k),
            cities=field.city_counts(states, k, us_metro_pages, metro_state),
            parent_state=parent,
            co_ops=field.has_co_ops(items),
            canadian=k in canada_keys or k in ca_metro_pages,
            faq=listing_faq(items, None, k, updated),
            thin=path in inside,
        )
        add(**render_place(place_model))

    for (t, k), items in sorted(combos.items()):
        path = f"/internships/{field_slug(t)}/{state_slug(k)}/"
        others = field.counts_by_place(combos, t, exclude=k)
        combo_model = field.Combo(
            context=context,
            tag=t,
            key=k,
            path=path,
            items=items,
            states=field.other_states(others, us_metro_pages, metro_state.get(k))[:related],
            cities=[entry for entry in others if entry[0] in us_metro_pages][:related],
            co_ops=field.has_co_ops(items),
            faq=listing_faq(items, t, k, updated),
            thin=not combo_indexed(len(items), path, live, earning) or path in inside,
        )
        add(**render_combo(combo_model))

    majors_made = []
    for m, tags, items, path in majors.rows:
        name = m["name"]
        majors_made.append((path, name, len(items)))
        if path != f"/internships/for/{slugify(name)}-majors/":
            continue  # folded into the field or major page with the same listings
        rel_tags = [t for t in (m.get("related") or []) if t in fields]
        major_model = field.Major(
            context=context,
            name=name,
            tags=tags,
            path=path,
            items=items,
            fields=[(t, len(fields[t])) for t in rel_tags[:related]],
            fits=[n for n in fits[path] if n != name],
        )
        add(**render_major(major_model))
    return majors_made


def emit_employer_pages(
    add: build.AddPage,
    site_dir: str,
    context: field.Context,
    cohorts: build.Cohorts,
    employers: build.Employers,
    live: build.Live,
    earning: frozenset[str],
    *,
    registry: dict[str, str],
    skip_fields: set[str],
    load_details: Callable[..., dict],
    cohort_paths: Callable[[], frozenset[str]],
    shown: Callable[..., list],
    top: Callable[..., list],
    select_employer_page: Callable[..., employer.Page],
    render_employer_page: Callable[..., dict],
) -> None:
    by_company, spellings = employers.by_company, employers.spellings
    fields, combos = cohorts.fields, cohorts.combos
    root, now = context.root, context.now
    company_fields = {
        nm: top(Counter(t for x in its for t in set(x.get("field_tags") or []) - skip_fields), 3)
        for nm, its in by_company.items()
    }

    cohort_details = load_details(
        site_dir,
        [x for nm, its in by_company.items() if registry[nm] in cohort_paths() for x in shown(its)],
    )

    directory = employer.Directory(by_company, company_fields, registry, fields, combos)
    for name, items in sorted(by_company.items()):
        path = registry[name]
        model = select_employer_page(
            directory,
            name,
            items,
            path,
            spellings[name],
            root,
            now,
            live,
            earning,
            cohort_details if path in cohort_paths() else None,
        )
        add(**render_employer_page(model))


def emit_kind_and_tracker_pages(
    add: build.AddPage,
    context: field.Context,
    fields: build.Groups,
    kind_made: list[listing.KindSelection],
    term_paths: dict[str, str],
    trackers: list[str],
    by_term: dict,
    baseline: str | None,
    *,
    related: int,
    skip_fields: set[str],
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    slugify: Callable[..., str],
    tracker_path: Callable[..., str],
    opened_rows: Callable[..., list],
    top: Callable[..., list],
    tracker_page: Callable[..., tuple[str, str, str, str]],
    render_kind_page: Callable[..., dict],
) -> None:
    root, now, updated = context.root, context.now, context.updated
    for path, kind, items in kind_made:
        term = term_paths.get(path)
        tracker = (term, tracker_path(term)) if term is not None and term in trackers else None
        model = listing.KindPage(
            path=path,
            kind={key: value for key, value in kind.items() if key != "pick"},
            items=items,
            root=root,
            now=now,
            updated=updated,
            related_fields=listing.related_fields(
                items, fields, skip_fields, top, field_slug, field_title, related
            ),
            related_kinds=listing.related_kinds(kind_made, path),
            tracker=tracker,
        )
        add(**render_kind_page(model))

    # The trackers themselves (tracker_page), each under its term page in the breadcrumb trail.
    for t in trackers:
        term_path, path = f"/internships/{slugify(t)}/", tracker_path(t)
        year = int(t.split()[1])
        items = by_term[t]
        rows = opened_rows(items, year, baseline)
        # The roles of the employers listed, one per role (was: len(unique_roles(items)), which also
        # counted rows whose employer name is not a name, real_company).
        t_, d_, h_, b_ = tracker_page(t, rows, sum(r[4] for r in rows), now, updated, term_path)
        add(path, t_, d_, h_, [root, (term_path, t), (path, "Who’s open now")], b_, dated=items)


def emit_near_and_new_pages(
    add: build.AddPage,
    pages: list[dict],
    context: field.Context,
    listings: build.Listings,
    digest_new: build.Listings,
    baseline: str | None,
    live: build.Live,
    earning: frozenset[str],
    *,
    digest_min_new: int,
    min_open: int,
    near_index: bool,
    near_on: bool,
    near_root: str,
    new_feed: int,
    tracker: tuple[str, str] | None,
    fresh: Callable[..., bool],
    near_hub: Callable[..., tuple[list[str], str, str]],
    near_pages: Callable[..., tuple[list[dict], dict]],
    select_signup_form: Callable[..., digest.Signup | None],
    render_new_page: Callable[..., dict],
) -> build.Listings:
    root, now, updated = context.root, context.now, context.updated
    # "<field> internships near <city>" (2026-10-18, near_pages): all 500 built, the thin ones noindex. Judged
    # against the list pages made so far, so one that repeats a field, place or employer page stays out of search.
    rivals = [frozenset(x["id"] for x in p["items"]) for p in pages if p["index"] and p["items"]]
    if near_on:
        near_specs, near_grid = near_pages(listings, now, updated, live, earning, rivals)
        for spec in near_specs:
            add(**spec)
        t_, d_, b_ = near_hub(near_grid)
        add(
            near_root,
            t_,
            d_,
            "Internships near 50 US cities",
            [root, (near_root, "Near 50 US cities")],
            b_,
            thin=not near_index,
        )  # 2026-10-23: a hub of noindex pages. was: no thin (indexed)

    new = [x for x in listings if fresh(x, now, baseline)]
    if len(new) >= min_open:
        new_model = digest.NewPage(
            items=new,
            root=root,
            now=now,
            updated=updated,
            feed_limit=new_feed,
            tracker=tracker,
            form=select_signup_form(
                digest.new_pitch(len(digest_new), len(new), digest_min_new),
                field=None,
                heading=digest.SIGNUP_HEADING,
                what=True,
                placement="landing",
            ),
        )
        add(**render_new_page(new_model))
        # A single club feed carries more of the week's new listings than a typical feed.
        pages[-1]["feed_limit"] = new_model.feed_limit
    return new


def emit_report_pages(
    add: build.AddPage,
    context: field.Context,
    listings: build.Listings,
    cohorts: build.Cohorts,
    kind_made: list[listing.KindSelection],
    new_count: int,
    enough: build.Enough,
    *,
    min_kind: int,
    min_pay_roles: int,
    numbers_path: str,
    pay_report: Callable[..., dict],
    site_facts: Callable[..., dict],
    pay_page: Callable[..., tuple[str, str, str]],
    numbers_page: Callable[..., tuple[list, str, str, list]],
) -> tuple[dict, str, dict | None, bool]:
    root, now, updated = context.root, context.now, context.updated
    fields, states = cohorts.fields, cohorts.states
    # The highest listed hourly pay (2026-10-02), made before the hubs so the hub can link it. Kept
    # like any other page once live (enough), since its URL is the one a search result points at.
    facts = site_facts(listings)
    pay_path = "/internships/highest-paying/"
    rep = pay_report(listings, fields)
    if enough(len(rep["roles"]), pay_path, min_pay_roles) and rep["top"]:
        t_, d_, b_ = pay_page(
            rep, facts, now, fields, any(p == "/internships/paid/" for p, _, _ in kind_made)
        )
        add(
            pay_path, t_, d_, "Highest-paying internships", [root, (pay_path, "Highest-paying")], b_
        )
    else:
        rep = None

    # The site's figures on one page (2026-10-05, numbers_page), before the hubs so the hub, /about/ and
    # llms.txt can link it. Kept once live like the pay page; min_kind, since five roles make no statistics.
    numbers = enough(len(listings), numbers_path, min_kind)
    if numbers:
        t_, d_, b_, ld_ = numbers_page(
            facts, listings, fields, states, rep, new_count, kind_made, now, updated
        )
        add(
            numbers_path,
            t_,
            d_,
            "InternScout by the numbers",
            [root, (numbers_path, "By the numbers")],
            b_,
            ld=ld_,
        )
    return facts, pay_path, rep, numbers


def emit_hubs(
    add: build.AddPage,
    context: field.Context,
    cohorts: build.Cohorts,
    by_company: build.Groups,
    majors_made: list[tuple[str, str, int]],
    kind_made: list[listing.KindSelection],
    trackers: list[str],
    listing_count: int,
    new_count: int,
    pay_path: str,
    rep: dict | None,
    numbers: bool,
    *,
    canada_keys: Collection[str],
    ca_metro_pages: Collection[str],
    ca_provinces: Collection[str],
    registry: Mapping[str, str],
    hub_top: int,
    min_employer: int,
    min_open: int,
    near_on: bool,
    near_root: str,
    numbers_path: str,
    organization: dict,
    tracker: tuple[str, str] | None,
    place_names: Mapping[str, str],
    website: dict,
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    state_slug: Callable[..., str],
    tracker_path: Callable[..., str],
    top_employers: Callable[..., list],
) -> None:
    root, updated = context.root, context.updated
    fields, states = cohorts.fields, cohorts.states
    # Hubs last, so they only link to pages that exist.
    add(
        "/internships/at/",
        [f"Internships by Employer – {len(by_company):,} Employers", "Internships by Employer"],
        f"Open internships and co-ops at {len(by_company):,} employers hiring college students now, from each "
        "employer's public job board. Free, no sign-up.",
        "Internships by employer",
        [root, ("/internships/at/", "By employer")],
        f"<p class=\"lede\">Employers with about {min_employer} or more open student roles, most of them "
        "internships, co-ops or research. InternScout is not affiliated with any of them.</p>"
        # The ones hiring most first (2026-10-07), then every one by name.
        + link_list("Hiring the most right now", top_employers(by_company, hub_top))
        + (
            f"<p class=\"more\"><a href=\"{tracker[1]}\">{esc(tracker[0])}: who’s open now</a>, the employers "
            f"that have opened {esc(tracker[0])} internships, newest first.</p>"
            if tracker
            else ""
        )
        + link_list(
            "Every employer, A to Z",
            sorted(
                ((registry[n], n, len(v)) for n, v in by_company.items()),
                key=lambda e: (e[1].lower(), e[1]),
            ),
        ),
    )  # was: key=lambda e: e[1].lower()
    add(
        "/internships/for/",
        [f"Internships by Major – {len(majors_made)} Majors", "Internships by Major"],
        "Open internships, co-ops and research roles for every UMass Amherst major, from nursing and "
        "sport management to engineering and finance. Free, no sign-up.",
        "Internships by major",
        [root, ("/internships/for/", "By major")],
        "<p class=\"lede\">Pick your major to see open roles that fit it. Each page counts only what is "
        "open today.</p>" + link_list("Majors", sorted(majors_made, key=lambda p: (p[1], p[0]))),
    )
    hub = (
        f"<p class=\"lede\">{listing_count:,} open internships, co-ops, research positions and "
        "fellowships for college students, collected from employer job boards and public programs. "
        "Browse by field, by state or by major, or open the dashboard to rank them for you.</p>"
        "<p>Every page below has an RSS feed of its new listings (the link at the bottom of the page). "
        "Paste it into a Discord feed bot such as MonitoRSS, or Slack's <code>/feed subscribe</code>, "
        "and new roles appear in your club's channel as they are found.</p>"
        "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
        + link_list(
            "By field",
            sorted(
                (
                    (f"/internships/{field_slug(t)}/", field_title(t), len(v))
                    for t, v in fields.items()
                ),
                key=lambda p: p[1],
            ),
        )
        # was: one "By state" list of every state page
        + link_list(
            "By state",
            sorted(
                (
                    (f"/internships/{state_slug(k)}/", place_names[k], len(v))
                    for k, v in states.items()
                    if k not in canada_keys and k not in ca_metro_pages
                ),
                key=lambda p: p[1],
            ),
        )
        + link_list(
            "Canada",
            [
                (f"/internships/{state_slug(k)}/", place_names[k], len(states[k]))
                for k in ["Canada", *ca_metro_pages, *ca_provinces]
                if k in states
            ],
        )
        + "<section class=\"rel\"><h2>More ways to browse</h2><ul><li><a href=\"/internships/for/\">"
        f"All {len(majors_made)} majors</a></li><li><a href=\"/internships/at/\">All {len(by_company):,} employers"
        "</a></li>"
        + (f"<li><a href=\"{near_root}\">By field near 50 US cities</a></li>" if near_on else "")
        + (
            f"<li><a href=\"/internships/new/\">New this week</a> <span class=\"n\">{new_count:,}</span></li>"
            if new_count >= min_open
            else ""
        )
        + "".join(
            f"<li><a href=\"{p}\">{esc(k['h1'][0].upper() + k['h1'][1:])}</a> "
            f"<span class=\"n\">{len(v):,}</span></li>"
            for p, k, v in kind_made
        )
        + (
            f"<li><a href=\"{pay_path}\">Highest-paying internships</a> <span class=\"n\">{len(rep['roles']):,}</span></li>"
            if rep
            else ""
        )
        + (f"<li><a href=\"{numbers_path}\">InternScout by the numbers</a></li>" if numbers else "")
        + "".join(
            f"<li><a href=\"{tracker_path(t)}\">{esc(t)}: who’s open now</a></li>" for t in trackers
        )
        + "</ul></section>"
    )
    # was: f"Browse {listing_count:,} Open Internships by Field, State and Major | InternScout" (70 characters)
    add(
        "/internships/",
        [
            f"Browse {listing_count:,} Open Internships by Field, State and Major",
            f"{listing_count:,} Internships by Field, State and Major",
            "Browse Internships by Field, State and Major",
        ],
        f"{listing_count:,} open internships, co-ops and research roles for college students, updated "
        f"{updated}. Browse by field, state or major. Free, no sign-up.",
        "Browse internships",
        [root],
        hub,
        ld=[organization, website],
    )


def emit_information_pages(
    add: build.AddPage,
    facts: dict,
    majors_count: int,
    new_count: int,
    rep: dict | None,
    updated: str,
    numbers: bool,
    digest_new: build.Listings,
    digest_by_field: Counter,
    *,
    digest_form: str,
    digest_path: str,
    min_open: int,
    about_answers: Callable[..., list],
    about_page: Callable[..., tuple[str, str, str, list]],
    compare_page: Callable[..., tuple[str, str, str]],
    digest_page: Callable[..., tuple[str, str, str]],
    pricing_page: Callable[..., tuple[str, str, str, list]],
) -> None:
    # What InternScout is, for people and for answer engines (2026-10-02). After the hubs: they link
    # only pages that exist.
    qa = about_answers(facts, majors_count, new_count, rep, updated, numbers)
    # was: qa = about_answers(facts, majors_count, new_count, rep)
    t_, d_, b_, ld_ = about_page(facts, qa, updated)
    add(
        "/about/",
        t_,
        d_,
        "About InternScout",
        [("/", "InternScout"), ("/about/", "About")],
        b_,
        ld=ld_,
    )
    t_, d_, b_ = compare_page(facts)
    add(
        "/compare/",
        t_,
        d_,
        "InternScout vs Simplify vs Jobright",
        [("/", "InternScout"), ("/compare/", "Compare")],
        b_,
    )
    t_, d_, b_, ld_ = pricing_page()
    add(
        "/pricing/",
        t_,
        d_,
        "Plans and prices",
        [("/", "InternScout"), ("/pricing/", "Pricing")],
        b_,
        ld=ld_,
    )
    # The weekly email's own page (2026-10-06), the one address the brand posts, the extension, flyers
    # and clubs link. Indexed only once the form has an address; until then it says sign-ups aren't open.
    t_, d_, b_ = digest_page(digest_new, digest_by_field, new_count >= min_open)
    add(
        digest_path,
        t_,
        d_,
        "New internships in your inbox every Monday. Free.",
        [("/", "InternScout"), (digest_path, "Weekly email")],
        b_,
        index=bool(digest_form),
    )
