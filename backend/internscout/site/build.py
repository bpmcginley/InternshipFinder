"""Named selection and assembly phases for the static page build."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from .. import related_pages
from . import field, listing

Listings = list[dict]
Groups = dict[str, Listings]
Combinations = dict[tuple[str, str], Listings]
MajorRow = tuple[dict, list[str], Listings, str]
Live = Collection[str]
AddPage = Callable[..., None]


class Enough(Protocol):
    def __call__(self, n: int, path: str, need: int = ...) -> bool: ...


@dataclass(frozen=True)
class Cohorts:
    fields: Groups
    states: Groups
    combos: Combinations
    inside: set[str]


@dataclass(frozen=True)
class CombinationRules:
    places: set[str]
    metros: Collection[str]
    metro_state: Mapping[str, str]
    priority_fields: Collection[str]
    priority_places: Collection[str]
    spread: int
    minimum: int
    priority_minimum: int
    min_employers: int


@dataclass(frozen=True)
class Majors:
    rows: list[MajorRow]
    fits: dict[str, list[str]]


@dataclass(frozen=True)
class Employers:
    by_company: Groups
    spellings: dict[str, list[str]]
    registry: dict[str, str]


def digest_summary(
    data: dict,
    now: datetime,
    new_roles: Callable[[dict, datetime], Listings],
    skip_fields: set[str] | frozenset[str],
) -> tuple[Listings, Counter, str]:
    digest_new = new_roles(data, now)
    digest_by_field = Counter(
        tag for row in digest_new for tag in set(row.get("field_tags") or []) - skip_fields
    )
    updated = f"{now:%B} {now.day}, {now.year}"
    return digest_new, digest_by_field, updated


def retention_rule(served: set[str], minimum: int, keep_at: Callable[[int], int]) -> Enough:
    def enough(n: int, path: str, need: int = minimum) -> bool:
        return n >= need or (path in served and n >= keep_at(need))

    return enough


def listing_ids(items: Listings) -> frozenset:
    return frozenset(row["id"] for row in items)


def employer_count(items: Listings, employer_key: Callable[[str], str]) -> int:
    return len({employer_key(row["company_name"]) for row in items if row.get("company_name")})


def select_fields_and_places(
    listings: Listings,
    enough: Enough,
    *,
    skip_fields: set[str] | frozenset[str],
    known_places: Mapping[str, str],
    metros: Collection[str],
    metro_state: Mapping[str, str],
    min_employers: int,
    field_slug: Callable[[str], str],
    state_slug: Callable[[str], str],
    employers_in: Callable[[Listings], int],
    fold_at: Callable[[str], float],
    near_same: Callable[[frozenset, frozenset, float], bool],
) -> tuple[Groups, Groups]:
    by_field: dict[str, list] = {}
    by_state: dict[str, list] = {}
    # Sets are walked in sorted order everywhere below: a set of strings iterates in hash order, which
    # changes from one Python run to the next, and 170 of the pages came out different on two builds
    # of the same data (test_two_builds_are_identical).
    for x in listings:
        for t in sorted(
            set(x.get("field_tags") or []) - skip_fields
        ):  # was: in set(...) - skip_fields
            by_field.setdefault(t, []).append(x)
        for k in sorted(x["keys"]):  # was: for k in x["keys"]:
            if k in known_places:
                by_state.setdefault(k, []).append(x)
    fields = {t: v for t, v in by_field.items() if enough(len(v), f"/internships/{field_slug(t)}/")}
    states = {k: v for k, v in by_state.items() if enough(len(v), f"/internships/{state_slug(k)}/")}
    # A US metro gets a page only when it is its own list (2026-10-07): enough employers, and not most
    # of its state's page under a second name.
    for m in sorted(metros):
        path, parent = f"/internships/{state_slug(m)}/", by_state.get(metro_state[m], [])
        if m in states and (
            employers_in(states[m]) < min_employers
            or near_same(listing_ids(states[m]), listing_ids(parent), fold_at(path))
        ):
            del states[m]
    return fields, states


def select_trackers(
    listings: Listings,
    now: datetime,
    enough: Enough,
    *,
    upcoming_summers: Callable[[Collection, datetime], list[str]],
    slugify: Callable[[str], str],
    tracker_path: Callable[[str], str],
    employers_in: Callable[[Listings], int],
    min_kind: int,
    min_open: int,
) -> tuple[dict, list[str]]:
    by_term = {}
    for x in listings:
        by_term.setdefault(x.get("term"), []).append(x)
    trackers = [
        t
        for t in upcoming_summers(by_term, now)
        if enough(len(by_term[t]), f"/internships/{slugify(t)}/", min_kind)
        and enough(employers_in(by_term[t]), tracker_path(t), min_open)
    ]
    return by_term, trackers


def select_combinations(
    fields: Groups,
    states: Groups,
    rules: CombinationRules,
    enough: Enough,
    *,
    live: Live,
    earning: frozenset[str],
    field_slug: Callable[[str], str],
    state_slug: Callable[[str], str],
    employers_in: Callable[[Listings], int],
    fold_at: Callable[[str], float],
    near_same: Callable[[frozenset, frozenset, float], bool],
    combo_indexed: Callable[[int, str, Live, frozenset[str]], bool],
    duplicates: Callable[[dict[str, frozenset], set[str], frozenset[str], Live], set[str]],
) -> Cohorts:
    # A field slug and a state slug must never name the same folder.
    state_slugs = {state_slug(k) for k in states}
    fields = {t: v for t, v in fields.items() if field_slug(t) not in state_slugs}

    combos: dict[tuple[str, str], list] = {}
    widen = []  # the 2026-10-07 rules' candidates, made after
    for t, items in sorted(fields.items()):  # was: for t, items in fields.items():
        for k in sorted(states):  # was: for k in states:
            hit = [x for x in items if k in x["keys"]]
            local = [x for x in hit if len(x["keys"] & rules.places) < rules.spread]
            path = f"/internships/{field_slug(t)}/{state_slug(k)}/"
            if k not in rules.metros and enough(len(local), path, rules.minimum):
                combos[(t, k)] = hit
                continue
            priority = t in rules.priority_fields and (
                k in rules.priority_places or k in rules.metros
            )
            if (
                (k in rules.metros or priority)
                and hit
                and enough(len(local), path, rules.priority_minimum if priority else rules.minimum)
            ):
                widen.append((t, k, hit, path))
    # The widened pages, biggest first (then by name, so every build agrees), each kept only when it is
    # its own list: rules.min_employers employers, and not near_same as the field's page, the field in the
    # metro's state, or a page already made for another field in the same place ("engineering" and
    # "mechanical" in Houston can be one list). Biggest first, so of two such pages the fuller one stays.
    for t, k, hit, path in sorted(widen, key=lambda w: (-len(w[2]), w[0], w[1])):
        mine = listing_ids(hit)
        rivals = [listing_ids(fields[t])] + [
            listing_ids(v)
            for (tt, kk), v in sorted(combos.items())
            if kk == k or (tt == t and kk == rules.metro_state.get(k))
        ]
        if employers_in(hit) >= rules.min_employers and not any(
            near_same(mine, r, fold_at(path)) for r in rivals
        ):
            combos[(t, k)] = hit
    combos = dict(sorted(combos.items()))
    # Pages that are another page's list under a second name (duplicates, 2026-10-23): each field's
    # places, then the place pages.
    combo_path = {(t, k): f"/internships/{field_slug(t)}/{state_slug(k)}/" for t, k in combos}
    inside = set()
    for t in sorted({t for t, _ in combos}):
        family = {combo_path[(tt, k)]: listing_ids(v) for (tt, k), v in combos.items() if tt == t}
        inside |= duplicates(
            family,
            {
                p
                for (tt, k), p in combo_path.items()
                if tt == t and combo_indexed(len(combos[(tt, k)]), p, live, earning)
            },
            earning,
            live,
        )
    place_lists = {f"/internships/{state_slug(k)}/": listing_ids(v) for k, v in states.items()}
    inside |= duplicates(place_lists, set(place_lists), earning, live)
    return Cohorts(fields, states, combos, inside)


def select_majors(
    listings: Listings,
    majors: list[dict],
    fields: Groups,
    enough: Enough,
    *,
    skip_fields: set[str] | frozenset[str],
    shown_ids: Callable[[Listings], frozenset],
    same_list: Callable[[frozenset, frozenset], bool],
    field_slug: Callable[[str], str],
    slugify: Callable[[str], str],
) -> Majors:
    # A major whose page would show what a field page, or an earlier major's page, already shows would
    # be a second URL for the same list. It gets no page of its own: the majors hub links it to that
    # page, and that page names it. "Shows" is the PER_PAGE listings on the page (shown), not every
    # listing behind it: matching only identical full lists let /internships/health/,
    # /for/nursing-majors/ and /for/nutrition-majors/ all show the same 40 postings, each its own
    # canonical page, because the majors pulled in a few more roles that never made the first 40.
    owners = [(shown_ids(v), f"/internships/{field_slug(t)}/") for t, v in sorted(fields.items())]
    # was: owner = {frozenset(x["id"] for x in v): f"/internships/{field_slug(t)}/" for t, v in fields.items()}
    major_rows, fits = [], {}
    for m in majors:
        tags = [t for t in m.get("tags") or [] if t not in skip_fields]
        items = [x for x in listings if set(x.get("field_tags") or []) & set(tags)]
        if m.get("level") not in (None, "undergrad") or not enough(
            len(items), f"/internships/for/{slugify(m['name'])}-majors/"
        ):
            continue
        name = m["name"]
        mine = shown_ids(items)
        path = next((p for ids, p in owners if same_list(ids, mine)), None)
        if path is None:
            path = f"/internships/for/{slugify(name)}-majors/"
            owners.append((mine, path))
        # was: ids = frozenset(x["id"] for x in items)
        #      path = owner.setdefault(ids, f"/internships/for/{slugify(name)}-majors/")
        major_rows.append((m, tags, items, path))
        fits.setdefault(path, []).append(name)
    return Majors(major_rows, fits)


def group_employers(listings: Listings, employer_key: Callable[[str], str]) -> Groups:
    groups: dict[str, list] = {}
    for x in listings:
        if x.get("company_name"):
            groups.setdefault(employer_key(x["company_name"]), []).append(x)
    return groups


def register_employers(
    groups: Groups,
    employers: dict[str, str],
    enough: Enough,
    *,
    employer_slugs: Mapping[str, str],
    minimum: int,
    slugify: Callable[[str], str],
    real_company: Callable[[str], bool],
    dedupe_roles: Callable[[Listings], Listings],
    student_share: Callable[[Listings], float],
) -> Employers:
    by_company: dict[str, list] = {}  # display name -> its roles, one row each
    spellings: dict[str, list] = {}  # display name -> every name its listings use
    # Ties go to the key and to the name itself, so which spelling names the page, and which of two
    # employers whose names slug alike gets the folder, is the same on every build.
    for key, items in sorted(
        groups.items(), key=lambda kv: (-len(kv[1]), kv[0])
    ):  # was: key=lambda kv: -len(kv[1])
        names = Counter(x["company_name"] for x in items)
        name = min(names, key=lambda n: (-names[n], len(n), n))  # was: (-names[n], len(n))
        items = dedupe_roles(items)
        path = f"/internships/at/{employer_slugs.get(key, slugify(name))}/"  # was: slugify(name)
        # was: if (not slugify(name) or ...   (real_company since 2026-10-07)
        if (
            not slugify(name)
            or not real_company(name)
            or path in employers.values()
            or student_share(items) < 0.5
            or not enough(len(items), path, minimum)
        ):
            continue
        by_company[name], spellings[name] = items, sorted(names)
        employers.update({n: path for n in names})
    return Employers(by_company, spellings, employers)


def page_writer(
    pages: list[dict],
    listings: Listings,
    live: Live,
    updated: str,
    *,
    fit_title: Callable[[object], str],
    fit_description: Callable[[str], str],
    render: Callable[..., str],
    schema_ids: Callable[[], tuple[str, str]],
) -> AddPage:
    # index (2026-10-06): False makes the page noindex and keeps it out of the sitemap (/digest/ until
    # the sign-up form has an address). was: every page was indexed.
    # dated (2026-10-07): the listings a page without a list of its own is about (a tracker's term), which
    # date it and make it a CollectionPage like a listing page, without a feed.
    # thin (2026-10-13, INDEX_COMBO): built and linked, but "noindex, follow" and out of the sitemap.
    # kind (2026-10-14): field, state (a province, city and Remote too), combo (a field in a place), major or
    # employer, for the listing pages a paid listing's box may go on (PLACEMENT_KINDS); None for the rest.
    def add(
        path,
        title,
        desc,
        h1,
        crumbs,
        body,
        items=None,
        state=None,
        ld=(),
        index=True,
        dated=None,
        thin=False,
        kind=None,
    ):
        # lastmod is the day the page's newest listing was found: it moves when the page gains a
        # listing, not on every deploy, which is the only lastmod a search engine keeps trusting.
        about = items if items is not None else dated
        found = [
            str(x.get("first_seen") or "")[:10] for x in (listings if about is None else about)
        ]
        # The live sitemap's lastmod is a floor: when the newest role on a page closes, the newest left
        # is older, and a lastmod that goes backwards is one a search engine stops trusting.
        found.append(live.get(path) or "" if isinstance(live, dict) else "")
        lastmod = max((f for f in found if f), default=None)
        # `title` is one form or several, longest first, without the suffix: fit_title picks the longest
        # that fits and adds " | InternScout" (2026-10-05). The description is clamped the same day.
        # was: every caller passed one title ending in " | InternScout", and the description as written.
        # A Head is fitted already (fit_head, 2026-10-13); fit_title would add a second suffix to a short one.
        title = fit_title(title)
        desc = fit_description(desc)
        if about is not None:  # was: if items is not None:
            site, site_id = schema_ids()
            # A listing page is a CollectionPage of the site (2026-10-05), dated like its sitemap entry.
            ld = [
                *ld,
                {
                    "@context": "https://schema.org",
                    "@type": "CollectionPage",
                    "@id": site + path,
                    "url": site + path,
                    "name": h1,
                    "description": desc,
                    "isPartOf": {"@id": site_id},
                    **({"dateModified": lastmod} if lastmod else {}),
                },
            ]
        pages.append(
            {
                "path": path,
                "html": render(
                    path,
                    title,
                    desc,
                    h1,
                    crumbs,
                    body,
                    updated,
                    index=index,
                    feed=items is not None,
                    ld=ld,
                    thin=thin,
                ),
                "items": items,
                "h1": h1,
                "state": state,
                "lastmod": lastmod,
                "index": index and not thin,
                "thin": thin,
                "kind": kind,
            }
        )
        # 2026-10-23: retain the real live date separately from first_seen for monotonic migration.
        # was: both collapsed into lastmod; revert: remove this metadata with page_dates.
        pages[-1]["lastmod_floor"] = live.get(path) if isinstance(live, dict) else None

    return add


def select_kind_catalog(
    pages: list[dict],
    kinds_for: Callable[[Listings], list[dict]],
    listings: Listings,
    trackers: list[str],
    enough: Enough,
    minimum: int,
    slugify: Callable[[str], str],
) -> tuple[list[listing.KindSelection], dict[str, str], list[str]]:
    taken = {p["path"] for p in pages}
    kind_made = listing.select_kinds(kinds_for(listings), listings, taken, enough, minimum)
    term_paths = {f"/internships/{slugify(t)}/": t for t in trackers}
    trackers = [
        t for t in trackers if any(p == f"/internships/{slugify(t)}/" for p, _, _ in kind_made)
    ]
    return kind_made, term_paths, trackers


def indexable_catalog(pages: list[dict]) -> dict[str, tuple[str, int]]:
    # llms.txt names only pages search engines are asked to index (2026-10-13): not /digest/ before it has a
    # form, nor a thin page. was: every page made.
    return {
        p["path"]: (p["h1"], len(p["items"]) if p["items"] is not None else 0)
        for p in pages
        if p["index"]
    }


@dataclass(frozen=True)
class Result:
    pages: list[dict]
    employer_registry: dict[str, str]


@dataclass(frozen=True)
class Stages:
    """Typed phase boundaries supplied by the compatibility caller."""

    fields: Callable[..., tuple[Groups, Groups]]
    trackers: Callable[..., tuple[dict, list[str]]]
    publish_tracker: Callable[[list[str]], None]
    combinations: Callable[..., Cohorts]
    majors: Callable[..., Majors]
    employers: Callable[..., Employers]
    page_writer: Callable[..., AddPage]
    field_pages: Callable[..., list[tuple[str, str, int]]]
    employer_pages: Callable[..., None]
    kinds: Callable[..., tuple[list[listing.KindSelection], dict[str, str], list[str]]]
    kind_pages: Callable[..., None]
    near_and_new_pages: Callable[..., Listings]
    reports: Callable[..., tuple[dict, str, dict | None, bool]]
    hubs: Callable[..., None]
    information: Callable[..., None]
    finish: Callable[..., None]


def assemble(
    site_dir: str,
    data: dict,
    live: Live,
    earning: frozenset[str],
    context: field.Context,
    digest_new: Listings,
    digest_by_field: Counter,
    enough: Enough,
    employers_in: Callable[[Listings], int],
    fold_at: Callable[[str], float],
    stages: Stages,
) -> Result:
    """Assemble pages in the order their links and membership decisions depend on."""
    listings = data["listings"]
    baseline = data["baseline"]
    fields, states = stages.fields(listings, enough, employers_in, fold_at)
    by_term, trackers = stages.trackers(listings, context.now, enough, employers_in)
    stages.publish_tracker(trackers)
    cohorts = stages.combinations(fields, states, enough, live, earning, employers_in, fold_at)
    majors = stages.majors(listings, data["majors"], cohorts, enough)
    employers = stages.employers(listings, enough)

    pages: list[dict] = []
    add = stages.page_writer(pages, listings, live, context.updated)
    by_company = employers.by_company
    majors_made = stages.field_pages(
        add, context, cohorts, majors, by_company, digest_by_field, live, earning
    )
    stages.employer_pages(add, site_dir, context, cohorts, employers, live, earning)
    kind_made, term_paths, trackers = stages.kinds(pages, listings, trackers, enough)
    stages.kind_pages(
        add, context, cohorts.fields, kind_made, term_paths, trackers, by_term, baseline
    )
    new = stages.near_and_new_pages(
        add, pages, context, listings, digest_new, baseline, live, earning
    )
    facts, pay_path, rep, numbers = stages.reports(
        add, context, listings, cohorts, kind_made, len(new), enough
    )
    stages.hubs(
        add,
        context,
        cohorts,
        by_company,
        majors_made,
        kind_made,
        trackers,
        len(listings),
        len(new),
        pay_path,
        rep,
        numbers,
    )
    stages.information(
        add,
        facts,
        len(majors_made),
        len(new),
        rep,
        context.updated,
        numbers,
        digest_new,
        digest_by_field,
    )
    related_pages.prefer_indexed(pages)
    stages.finish(
        pages, live, by_company, cohorts, trackers, new, majors_made, facts, rep, context.updated
    )
    return Result(pages, employers.registry)
