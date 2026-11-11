"""Static, crawlable landing pages built from the exported listings.

The dashboard is a client-rendered app: a search engine that fetches internscout.org sees a shell and
no internships. These pages give every field, state, field-in-a-state and UMass major its own plain
HTML page listing the open postings, so a student searching "nursing internships massachusetts" can
land on one. They are rebuilt from docs/data on every deploy (see .github/workflows/pages.yml), so
they are always as fresh as the data and are never committed.

Quality rules, because mass-produced pages that say nothing are exactly what search engines demote:
  * a page exists only when it has at least MIN_OPEN open listings;
  * a field-in-a-place page listing fewer than INDEX_COMBO is built and linked, but kept out of search
    (noindex and out of the sitemap) unless Search Console shows people finding it (2026-10-13);
  * every sentence on it is computed from its own listings (counts, employers, pay, terms), never
    filler text, so two pages only read alike when their data is alike;
  * everything that came from a job board is HTML-escaped, and only http(s) links are ever emitted.

Run:  python -m internscout.seo_pages <site_dir>
      where <site_dir> is a copy of docs/ (it reads <site_dir>/data and writes into <site_dir>).
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import os
import re
import sys
from collections import Counter
from statistics import median
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

from . import feeds, near_metros, page_dates, role_index, seo_role_details, widget_data
from . import pay as _salary_pay
from .console_log import console
from .site import build as _build
from .site import catalog as _catalog
from .site import digest as _digest
from .site import sitemap as _discovery
from .site import employer as _employer
from .site import facts as _facts
from .site import field as _field
from .site.render import layout as _layout
from .site import listing as _listing
from .site import llms as _llms
from .site import near as _near
from .site import numbers as _numbers
from .site import paid as _paid
from .site import pay as _pay
from .site import source as _source
from .site import taxonomy as _taxonomy
from .site.render import digest as _render_digest_module
from .site.render import employer as _render_employer_module
from .site.render import field as _render_field_module
from .site.render import listing as _render_listing_module
from .site.render import near as _render_near_module
from .site.render import numbers as _render_numbers_module
from .site.render import pay as _render_pay_module
from .site.render.layout import (
    faq_ld as faq_ld,
    faq_section as faq_section,
    fits_line as fits_line,
    ld_script as ld_script,
    link_list as link_list,
    short_day as short_day,
    table as table,
    tablewrap as tablewrap,
)
from .site.assets import CSS as CSS, SITE as SITE
from .site.digest import DIGEST_MIN_NEW as DIGEST_MIN_NEW, DIGEST_PATH as DIGEST_PATH, digest_archive as digest_archive, digest_form_action as digest_form_action
from .site.facts import boards_line as boards_line, canada_only as canada_only, coverage_line as coverage_line, top as top, word_list as word_list
from .site.rules import (
    MIN_COMBO as MIN_COMBO,
    MIN_COMBO_PRIORITY as MIN_COMBO_PRIORITY,
    MIN_EMPLOYERS_NEW as MIN_EMPLOYERS_NEW,
    MIN_OPEN as MIN_OPEN,
    NEAR_SAME as NEAR_SAME,
    PRIORITY_FIELDS as PRIORITY_FIELDS,
    PRIORITY_PLACES as PRIORITY_PLACES,
    SPREAD as SPREAD,
    keep_at as keep_at,
    near_same as near_same,
)
from .site.source import (
    well_formed as well_formed,
    _when as _when,
    newest_first as newest_first,
    place as place,
    real_company as real_company,
    FIRST_SEEN_SINCE as FIRST_SEEN_SINCE,
    CANADA_SINCE as CANADA_SINCE,
    NEW_DAYS as NEW_DAYS,
    HOME_STATES as HOME_STATES,
    PER_PAGE as PER_PAGE,
    STUDENT_STAGES as STUDENT_STAGES,
    _SUFFIX as _SUFFIX,
    EMPLOYER_ALIASES as EMPLOYER_ALIASES,
)
from .site.taxonomy import (
    US_STATES as US_STATES,
    CA_PROVINCES as CA_PROVINCES,
    CA_METRO_PAGES as CA_METRO_PAGES,
    US_METRO_PAGES as US_METRO_PAGES,
    _US_METRO_TOWNS as _US_METRO_TOWNS,
    METRO_STATE as METRO_STATE,
    CANADA_KEYS as CANADA_KEYS,
    PLACES as PLACES,
    PLACE_THE as PLACE_THE,
    FIELD_TITLES as FIELD_TITLES,
    SKIP_FIELDS as SKIP_FIELDS,
    FIELD_SHORT as FIELD_SHORT,
    SLUG_MAX as SLUG_MAX,
)
from .site.text import (
    join_words as join_words,
    lower_name as lower_name,
    money as money,
    pct as pct,
    plural as plural,
    possessive as possessive,
    safe_url as safe_url,
)

from .site.digest import _BUTTONDOWN_FORM as _BUTTONDOWN_FORM, _DIGEST_ACTION as _DIGEST_ACTION
from .site import runtime as _runtime
from typing import cast


SLOGAN = _runtime.SLOGAN
STORE_URL = _runtime.STORE_URL
SUPPORTED_ATS = _runtime.SUPPORTED_ATS
AUTOFILL_HOSTS = _runtime.AUTOFILL_HOSTS
FREE_EDU = _runtime.FREE_EDU
FREE_GENERAL = _runtime.FREE_GENERAL
INDEX_COMBO = _runtime.INDEX_COMBO
INDEX_SLACK = _runtime.INDEX_SLACK
SEARCH_KEEP_IMPRESSIONS = _runtime.SEARCH_KEEP_IMPRESSIONS
SEARCH_PAGES = _runtime.SEARCH_PAGES
HELD_FILE = _runtime.HELD_FILE
INDEX_EMPLOYER = _runtime.INDEX_EMPLOYER
MIN_EMPLOYER = _runtime.MIN_EMPLOYER
MIN_KIND = _runtime.MIN_KIND
RELATED = _runtime.RELATED
NEW_FEED = _runtime.NEW_FEED
TAIL = _runtime.TAIL
TITLE_MAX = _runtime.TITLE_MAX
TITLE_SUFFIX = _runtime.TITLE_SUFFIX
DESC_MIN = _runtime.DESC_MIN
DESC_MAX = _runtime.DESC_MAX
esc = _runtime.esc
_AMOUNT = _runtime._AMOUNT
_SENTENCE_END = _runtime._SENTENCE_END
_ABBREVIATION = _runtime._ABBREVIATION
DESC_PADS = _runtime.DESC_PADS
COUNT_STEPS = _runtime.COUNT_STEPS
DESC_AIM = _runtime.DESC_AIM
JOB_SITE_HOSTS = _runtime.JOB_SITE_HOSTS
EMPLOYERS = {}
EMPLOYER_SLUGS = _runtime.EMPLOYER_SLUGS
TERM = _runtime.TERM
SEASONS = _runtime.SEASONS
SAME_SHARE = _runtime.SAME_SHARE
OFFER_TAG = _runtime.OFFER_TAG
OFFER_MARK = _runtime.OFFER_MARK
EMPLOYER_PLACES = _runtime.EMPLOYER_PLACES
PLACE_SHORT = _runtime.PLACE_SHORT
BEACON = _runtime.BEACON
DIGEST_FORM = _runtime.DIGEST_FORM
BASELINE = _runtime.BASELINE
GENERATED = _runtime.GENERATED
TEXTS = {}
TRACKER = _runtime.TRACKER
HOME = _runtime.HOME
HOME_LIVE_DATE = _runtime.HOME_LIVE_DATE
CHART_BARS = _runtime.CHART_BARS
_STATE_NAMES = _runtime._STATE_NAMES
_COUNTRY = _runtime._COUNTRY
_COUNTRY_ONLY = _runtime._COUNTRY_ONLY
CITY_ALIASES = _runtime.CITY_ALIASES
FAQ_ANSWER_MAX = _runtime.FAQ_ANSWER_MAX
FAQ_NAMES = _runtime.FAQ_NAMES
ORG_ID = _runtime.ORG_ID
SITE_ID = _runtime.SITE_ID
ORGANIZATION = _runtime.ORGANIZATION
WEBSITE = _runtime.WEBSITE
PLAN_PRICES = _runtime.PLAN_PRICES
FREE_WORDS = _runtime.FREE_WORDS
PLAN_MULTIPLIER = _runtime.PLAN_MULTIPLIER
PLAN_SHORT = _runtime.PLAN_SHORT
RECOMMENDED_PLAN = _runtime.RECOMMENDED_PLAN
PRODUCT = _runtime.PRODUCT
ATS_NAMES = _runtime.ATS_NAMES
MIN_PAY_ROLES = _runtime.MIN_PAY_ROLES
MIN_PAY_FIELD = _runtime.MIN_PAY_FIELD
MIN_PAY_EMPLOYER = _runtime.MIN_PAY_EMPLOYER
PAY_TOP = _runtime.PAY_TOP
PAY_PER_EMPLOYER = _runtime.PAY_PER_EMPLOYER
PAY_EMPLOYERS = _runtime.PAY_EMPLOYERS
_GRADUATE = _runtime._GRADUATE
NUMBERS_PATH = _runtime.NUMBERS_PATH
NUMBERS_TOP = _runtime.NUMBERS_TOP
COMPARE_AS_OF = _runtime.COMPARE_AS_OF
COMPARE_SOURCES = _runtime.COMPARE_SOURCES
COMPARE_ROWS = _runtime.COMPARE_ROWS
NEAR_ROOT = _runtime.NEAR_ROOT
NEAR_ON = _runtime.NEAR_ON
NEAR_INDEX_MIN = _runtime.NEAR_INDEX_MIN
NEAR_INDEX = _runtime.NEAR_INDEX
NEAR_INDEX_SLACK = _runtime.NEAR_INDEX_SLACK
NEAR_REMOTE_SHOWN = _runtime.NEAR_REMOTE_SHOWN
HUB_TOP = _runtime.HUB_TOP
HOME_EMPLOYERS = _runtime.HOME_EMPLOYERS
HOME_STATES_MORE = _runtime.HOME_STATES_MORE
HOME_START = _runtime.HOME_START
HOME_END = _runtime.HOME_END
LISTINGS = []
PLACEMENT_KINDS = _runtime.PLACEMENT_KINDS
PLACEMENT_START = _runtime.PLACEMENT_START
PLACEMENT_END = _runtime.PLACEMENT_END
PLACEMENT_AFTER = _runtime.PLACEMENT_AFTER
PLACEMENTS_FILE = _runtime.PLACEMENTS_FILE
_DAY_RE = _runtime._DAY_RE
SITE_PATH = _runtime.SITE_PATH
Head = _runtime.Head


class _LegacyState:
    """Expose legacy settings and mutable slots at their original write points."""

    @property
    def beacon(self):
        return BEACON

    @beacon.setter
    def beacon(self, value):
        global BEACON
        BEACON = value

    @property
    def baseline(self):
        return BASELINE

    @baseline.setter
    def baseline(self, value):
        global BASELINE
        BASELINE = value

    @property
    def generated(self):
        return GENERATED

    @generated.setter
    def generated(self, value):
        global GENERATED
        GENERATED = value

    @property
    def digest_form(self):
        return DIGEST_FORM

    @digest_form.setter
    def digest_form(self, value):
        global DIGEST_FORM
        DIGEST_FORM = value

    @property
    def tracker(self):
        return TRACKER

    @tracker.setter
    def tracker(self, value):
        global TRACKER
        TRACKER = value

    @property
    def employers(self):
        return EMPLOYERS

    @employers.setter
    def employers(self, value):
        global EMPLOYERS
        EMPLOYERS = value

    @property
    def texts(self):
        return TEXTS

    @texts.setter
    def texts(self, value):
        global TEXTS
        TEXTS = value

    @property
    def home(self):
        return HOME

    @home.setter
    def home(self, value):
        global HOME
        HOME = value

    @property
    def home_live_date(self):
        return HOME_LIVE_DATE

    @home_live_date.setter
    def home_live_date(self, value):
        global HOME_LIVE_DATE
        HOME_LIVE_DATE = value

    @property
    def listings(self):
        return LISTINGS

    @property
    def near_on(self):
        return NEAR_ON

    @property
    def near_index(self):
        return NEAR_INDEX

    @property
    def near_root(self):
        return NEAR_ROOT

    @property
    def near_index_min(self):
        return NEAR_INDEX_MIN

    @property
    def near_index_slack(self):
        return NEAR_INDEX_SLACK

    @property
    def near_remote_shown(self):
        return NEAR_REMOTE_SHOWN

    @property
    def min_open(self):
        return MIN_OPEN

    @property
    def min_kind(self):
        return MIN_KIND

    @property
    def min_employer(self):
        return MIN_EMPLOYER

    @property
    def index_combo(self):
        return INDEX_COMBO

    @property
    def index_employer(self):
        return INDEX_EMPLOYER

    @property
    def index_slack(self):
        return INDEX_SLACK

    @property
    def compare_as_of(self):
        return COMPARE_AS_OF

    @property
    def slogan(self):
        return SLOGAN

    @property
    def site(self):
        return SITE

    @property
    def site_id(self):
        return SITE_ID

    @property
    def org_id(self):
        return ORG_ID

    @property
    def organization(self):
        return ORGANIZATION

    @property
    def website(self):
        return WEBSITE

    @property
    def css(self):
        return CSS

    @property
    def new_days(self):
        return NEW_DAYS

    @property
    def per_page(self):
        return PER_PAGE

    @property
    def home_states(self):
        return HOME_STATES

    @property
    def field_titles(self):
        return FIELD_TITLES

    @property
    def digest_min_new(self):
        return DIGEST_MIN_NEW

    @property
    def new_feed(self):
        return NEW_FEED

    @property
    def min_pay_roles(self):
        return MIN_PAY_ROLES

    @property
    def min_pay_field(self):
        return MIN_PAY_FIELD

    @property
    def min_pay_employer(self):
        return MIN_PAY_EMPLOYER

    @property
    def pay_top(self):
        return PAY_TOP

    @property
    def pay_per_employer(self):
        return PAY_PER_EMPLOYER

    @property
    def pay_employers(self):
        return PAY_EMPLOYERS

    @property
    def numbers_path(self):
        return NUMBERS_PATH

    @property
    def numbers_top(self):
        return NUMBERS_TOP

    @property
    def first_seen_since(self):
        return FIRST_SEEN_SINCE

    @property
    def canada_since(self):
        return CANADA_SINCE

    @property
    def free_words(self):
        return FREE_WORDS

    @property
    def plan_prices(self):
        return PLAN_PRICES

_LEGACY_STATE = cast(_runtime.BuildState, _LegacyState())


_LEGACY_HOOKS = _runtime.BuildHooks(
        load=lambda *args, **kwargs: load(*args, **kwargs),
        page=lambda *args, **kwargs: page(*args, **kwargs),
        pricing_page=lambda *args, **kwargs: pricing_page(*args, **kwargs),
        fit_title=lambda *args, **kwargs: fit_title(*args, **kwargs),
        fit_description=lambda *args, **kwargs: fit_description(*args, **kwargs),
        near_pages=lambda *args, **kwargs: near_pages(*args, **kwargs),
        near_hub=lambda *args, **kwargs: near_hub(*args, **kwargs),
        new_roles=lambda *args, **kwargs: new_roles(*args, **kwargs),
        listing_body=lambda *args, **kwargs: listing_body(*args, **kwargs),
        listing_rows=lambda *args, **kwargs: listing_rows(*args, **kwargs),
        signup_form=lambda *args, **kwargs: signup_form(*args, **kwargs),
        llms_files=lambda *args, **kwargs: llms_files(*args, **kwargs),
        home_browse=lambda *args, **kwargs: home_browse(*args, **kwargs),
        digest_page=lambda *args, **kwargs: digest_page(*args, **kwargs),
        pay_page=lambda *args, **kwargs: pay_page(*args, **kwargs),
        numbers_page=lambda *args, **kwargs: numbers_page(*args, **kwargs),
        beacon_from=lambda *args, **kwargs: beacon_from(*args, **kwargs),
        digest_form_action=lambda *args, **kwargs: digest_form_action(*args, **kwargs),
        earning_paths=lambda *args, **kwargs: earning_paths(*args, **kwargs),
        placeholder_pay=lambda *args, **kwargs: placeholder_pay(*args, **kwargs),
    )


def _legacy_call(call, *args, **kwargs):
    return _runtime.invoke(_LEGACY_STATE, _LEGACY_HOOKS, call, *args, **kwargs)


earning_paths = _runtime.earning_paths
def combo_indexed(n: int, path: str, live, earning: frozenset[str] = frozenset()) -> bool:
    """Whether a field-in-a-place page listing n roles is indexed (INDEX_COMBO, INDEX_SLACK)."""
    return _legacy_call(_runtime.combo_indexed, n, path, live, earning)


def employer_indexed(n: int, path: str, live, earning: frozenset[str] = frozenset()) -> bool:
    """Whether an employer page listing n roles is indexed (INDEX_EMPLOYER, INDEX_SLACK)."""
    return _legacy_call(_runtime.employer_indexed, n, path, live, earning)


duplicates = _runtime.duplicates
us_metro = _runtime.us_metro
def field_title(tag: str) -> str:
    return _legacy_call(_runtime.field_title, tag)


def field_short(tag: str) -> str:
    return _legacy_call(_runtime.field_short, tag)


slugify = _runtime.slugify
def field_slug(tag: str) -> str:
    return _legacy_call(_runtime.field_slug, tag)


state_slug = _runtime.state_slug
def load(site_dir: str) -> dict:
    return _source.load(
        site_dir,
        ca_metros=CA_METRO_PAGES,
        metro=us_metro,
        baseline=baseline_day,
        valid_row=well_formed,
        valid_url=safe_url,
        diagnostic=console,
    )


def canada_first_scan(x: dict) -> bool:
    """A role only in Canada that the first Canadian scan found (see CANADA_SINCE)."""
    return _legacy_call(_runtime.canada_first_scan, x)


def baseline_day(listings: list[dict]) -> str | None:
    """The day before which "first seen" means only "already open when we started keeping dates"."""
    return _legacy_call(_runtime.baseline_day, listings)


placeholder_pay = _runtime.placeholder_pay
def real_salary(x: dict) -> str | None:
    """The listing's salary text, unless it is a placeholder (placeholder_pay)."""
    return _legacy_call(_runtime.real_salary, x)


def is_paid(x: dict) -> bool:
    return _legacy_call(_runtime.is_paid, x)


def pay_text(x: dict) -> str:
    """What a listing row says about pay: the real salary, else "Paid" when the posting says so."""
    return _legacy_call(_runtime.pay_text, x)


def fresh(x: dict, now: datetime, baseline: str | None = None) -> bool:
    """Found in the last NEW_DAYS, and not an old posting a scan has only just reached, nor one that
    was already open on the day first_seen began (baseline_day).

    Counted in calendar days (today is the data's UTC date, a stamp's day the day it names), the
    rule export_static.mark_new gives is_new, so the dashboard's "New" filter and /internships/new/
    agree. A rolling 7 x 24 hours made them differ by the roles
    found seven days ago later in the day than the run (1,834 here against 1,832 there). One
    difference is left: a listing with no first_seen is not new here and is there, but every
    exported row has one."""
    return _legacy_call(_runtime.fresh, x, now, baseline)


def near_home_first(items: list[dict]) -> list[dict]:
    return _legacy_call(_runtime.near_home_first, items)


def summary(
    items: list[dict], what: str, where: str, tail: str = TAIL, about: frozenset = frozenset()
) -> str:
    """The page's opening paragraph, every clause computed from its own listings. tail is "" where
    "from internships to co-ops and research" would contradict the page (the co-op page)."""
    return _legacy_call(_runtime.summary, items, what, where, tail, about)


fit_title = _runtime.fit_title
fit_description = _runtime.fit_description
count_floor = _runtime.count_floor
def fit_head(subjects: list[str], tails: list[str] = ()) -> Head:
    """A <title> of at most TITLE_MAX characters. `subjects` are the search phrase, fullest first
    ("Under Armour Internships Summer 2027", then "Under Armour Internships"); `tails` what may follow
    it, fullest first (": 10+ Open Roles", ": 10+ Open"). The first that fits, trying each subject with
    every tail and the brand, then every tail without the brand, then the brand alone, then the subject
    alone: the brand goes first, the tail next, the subject's own extra words last. When even the last
    subject is too long, it is cut at a word (fit_title), never mid-word."""
    return _legacy_call(_runtime.fit_head, subjects, tails)


pack = _runtime.pack
pay_words = _runtime.pay_words
def employer_title(name: str, n: int, term: str | None) -> Head:
    """ "Under Armour Internships Summer 2027: 10+ Open | InternScout". The term is the one most of the
    employer's roles share (main_term), so it is whatever that is, Spring 2027 or Fall 2026 as well."""
    return _legacy_call(_runtime.employer_title, name, n, term)


employer_description = _runtime.employer_description
own_posting = _runtime.own_posting
hiring_words = _runtime.hiring_words
def listing_title(subjects: list[str], n: int, tail: str = "Open") -> Head:
    """A field, place or field-in-a-place title: "Software Engineering Internships: 2,000+ Open"."""
    return _legacy_call(_runtime.listing_title, subjects, n, tail)


listing_description = _runtime.listing_description
kind_description = _runtime.kind_description
employer_key = _runtime.employer_key
dedupe_roles = _runtime.dedupe_roles
unique_roles = _runtime.unique_roles
def new_roles(d: dict, now: datetime) -> list[dict]:
    """This week's new roles, as every growth output counts them: found this week by fresh (the
    rule /internships/new/ uses), then one row per role within each employer (unique_roles). The
    digest's subject, the brand posts' counts, the dashboard metrics and the sign-up forms' numbers
    all use this one number. stats.json's "new" (export_static's is_new) counts every listing a scan
    first saw in the last week, before either step, so it runs a little higher; it is the dashboard's
    own badge count."""
    return _legacy_call(_runtime.new_roles, d, now)


student_share = _runtime.student_share
def kinds(listings: list[dict]) -> list[dict]:
    """The other ways students search, beside field, state, major and employer, each a volume Semrush
    measured on 2026-09-24 (US, monthly): a start term ("summer 2027 internships" 590, "summer
    internships" 5,400), "paid internships" 3,600, "co op jobs" 720, "research internships for
    undergraduates" 390 and "reu programs" 1,300, "freshman internships" and "sophomore internships"
    390 each. Every page is picked by the listings' own fields, so it lists only what its title says:
    a term page is the roles whose posting names that term, and a class-year page is the roles whose
    posting says it takes that year (most say nothing, and those stay off it)."""
    return _legacy_call(_runtime.kinds, listings)


upcoming_summers = _runtime.upcoming_summers
tracker_path = _runtime.tracker_path
def opened_on(x: dict, year: int, baseline: str | None) -> tuple | None:
    """(day, exact) a role for the summer of `year` first appeared: the earlier of its posting date and
    the day a scan first found it. A posting date before the year ahead of the summer is a requisition
    an employer keeps reopening (57 Summer 2027 roles on 2026-10-07 carried dates from 2016 to 2025),
    not the day this summer opened, so it is left out. A first_seen on or before `baseline` (or a
    Canadian role from the first Canadian scan, canada_first_scan) only says the role was open by then:
    exact is False, and the page says "by"."""
    return _legacy_call(_runtime.opened_on, x, year, baseline)


def opened_rows(items: list[dict], year: int, baseline: str | None) -> list[tuple]:
    """One row per employer with roles in `items`: (day, exact, name, page or None, roles), newest-opened
    first. One employer's spellings are one row (employer_key), named as its employer page is."""
    return _legacy_call(_runtime.opened_rows, items, year, baseline)


def tracker_page(
    term: str, rows: list[tuple], roles: int, now: datetime, updated: str, term_path: str
) -> tuple[str, str, str, str]:
    """(title, description, h1, body) for one summer's tracker."""
    return _legacy_call(_runtime.tracker_page, term, rows, roles, now, updated, term_path)


def _render_tracker_page(model: _listing.TrackerPage) -> tuple[str, str, str, str]:
    return _legacy_call(_runtime._render_tracker_page, model)


def shown(items: list[dict], state: str | None = None) -> list[dict]:
    """The PER_PAGE listings a page actually shows, in its order: what a reader, and a search engine,
    sees of it. Two pages that show the same ones are the same page to both (see same_list)."""
    return _legacy_call(_runtime.shown, items, state)


def shown_ids(items: list[dict]) -> frozenset:
    return _legacy_call(_runtime.shown_ids, items)


same_list = _runtime.same_list
def listing_rows(
    items: list[dict],
    now: datetime,
    state: str | None = None,
    here: str | None = None,
    src: str = "seo-field",
    details: dict | None = None,
) -> str:
    """src: where the page sits (seo-employer, seo-state, ...), carried into the install page's ?from=
    by each row's "Auto-Apply this" link, so its store link's utm_source says which pages install."""
    return _legacy_call(_runtime.listing_rows, items, now, state, here, src, details)


def row_meta(x: dict, state: str | None = None) -> str:
    """A row's grey line, HTML: place, term, stage and pay. The same for a listing row and a paid
    listing's box (placement_box), so the two can never describe one role differently."""
    return _legacy_call(_runtime.row_meta, x, state)


autofills = _runtime.autofills
go_aa = _runtime.go_aa
def autoapply_card(items: list[dict], src: str, state: str | None = None) -> str:
    """What the free extension would do for the roles this page lists, counted from them (2026-10-04):
    "12 of these 40 applications are on Workday, Greenhouse or another site ...". Nothing when none of
    them is on a site it fills. Two buttons, one shown: on a computer straight to the store (count.js
    counts it as install_click), on a phone or tablet, which can't add extensions, to the install page,
    which says to send the link to a laptop. The same media query as install.html's, so no script."""
    return _legacy_call(_runtime.autoapply_card, items, src, state)


def company_link(name: str, here: str | None = None) -> str:
    """The company's name, linked to its employer page when it has one (here: this page's path)."""
    return _legacy_call(_runtime.company_link, name, here)


in_place = _runtime.in_place
def combo_label(t: str, k: str) -> str:
    """A field-in-a-place page as a link names it: "Software Engineering in Boston"."""
    return _legacy_call(_runtime.combo_label, t, k)


beacon_from = _runtime.beacon_from
def signup_form(
    pitch: str,
    field: str | None = None,
    heading: str = _digest.SIGNUP_HEADING,
    what: bool = True,
    placement: str = "landing",
) -> str:
    """The weekly email's sign-up form, or "" while DIGEST_FORM is empty. Built like the dashboard's
    (js/app.js Digest): a plain form that posts straight from the browser to Buttondown, in a new tab
    (Buttondown may ask for a CAPTCHA or a fixed typo on its own page), so the address never reaches
    InternScout's servers. js/count.js counts a submit as "digest_signup", with nothing about who.
    `field`: the page's field tag, offered as one unticked box that sends it as a `tag`, the dashboard
    form's own field name and value (the tag key, not its label). Nothing is ticked for the student.
    `pitch`: the page's own sentence (with its number) ahead of what the email is. `heading`: /digest/
    has its own, since its h1 already says what the email is, and `what` False leaves out the sentence
    saying what the email holds, which /digest/ lists under the form instead."""
    return _legacy_call(_runtime.signup_form, pitch, field, heading, what, placement)


def _select_signup_form(
    pitch: str,
    field: str | None,
    heading: str,
    what: bool,
    placement: str,
) -> _digest.Signup | None:
    return _legacy_call(_runtime._select_signup_form, pitch, field, heading, what, placement)


_render_signup_form = _runtime._render_signup_form
widget_follow = _runtime.widget_follow
def footer_browse() -> str:
    """The footer's links to the employer index and the soonest summer's tracker (2026-10-07): every
    page then links both, so a crawler reaches every employer page in two steps from any page."""
    return _legacy_call(_runtime.footer_browse)


def page(
    path: str,
    title: str,
    description: str,
    h1: str,
    crumbs: list[tuple[str, str]],
    body: str,
    updated: str,
    index: bool = True,
    feed: bool = False,
    ld: tuple | list = (),
    thin: bool = False,
) -> str:
    """ld: more JSON-LD objects for the head (added 2026-10-02: the Organization, WebSite and
    FAQPage blocks of the hub and /about/), each in its own block after the breadcrumb trail.
    thin (2026-10-13, INDEX_COMBO): a real page kept out of search. It keeps its canonical link to
    itself and says "noindex, follow", so a crawler still follows its links to the indexed pages."""
    return _legacy_call(_runtime.page, path, title, description, h1, crumbs, body, updated, index, feed, ld, thin)


_dash_state = _runtime._dash_state
dash_link = _runtime.dash_link
chart_counts = _runtime.chart_counts
chart_figure = _runtime.chart_figure
def listing_body(
    items: list[dict],
    what: str,
    where: str,
    now: datetime,
    related: str,
    state: str | None = None,
    dash: str = "/",
    fits: list[str] | None = None,
    here: str | None = None,
    tail: str = TAIL,
    about: frozenset = frozenset(),
    extra: str = "",
    src: str = "seo-field",
    faq: str = "",
    signup: str = "",
    details: dict | None = None,
) -> str:
    return _legacy_call(_runtime.listing_body, items, what, where, now, related, state, dash, fits, here, tail, about, extra, src, faq, signup, details)


long_day = _runtime.long_day
def hourly_rate(x: dict) -> tuple[float, float] | None:
    """One posting's listed hourly rate as (low, high), or None when it gives no clear one. A bare
    amount counts as hourly only under $200 (student pay quoted without a unit is an hourly rate); a
    yearly salary, monthly or weekly pay or a stipend is left out rather than turned into a made-up
    hourly figure, and so is pay text that only looks hourly (_THOUSANDS, _CUT_OFF, _POINT_THOUSANDS)."""
    return _legacy_call(_runtime.hourly_rate, x)


def hourly_range(items: list[dict]) -> tuple[float, float, int] | None:
    """Lowest and highest hourly rate the postings list, and how many list one (see hourly_rate)."""
    return _legacy_call(_runtime.hourly_range, items)


dated_terms = _runtime.dated_terms
main_term = _runtime.main_term
place_name = _runtime.place_name
city_name = _runtime.city_name
places = _runtime.places
counted = _runtime.counted
def employer_facts(name: str, items: list[dict], fields_main: list[str]) -> tuple[str, str]:
    """The "at a glance" list and the questions section for one employer's page, as HTML."""
    return _legacy_call(_runtime.employer_facts, name, items, fields_main)


employer_offer = _runtime.employer_offer
def employer_breakdown(name: str, items: list[dict], fields_main: list[str]) -> str:
    """2026-10-23: facts for each actual hiring field, beyond the employer-wide totals.

    was: each employer had only the same aggregate fact labels and FAQ prompts. Count intersections
    from its own deduplicated open roles; quote example pay rather than blend currencies or periods.
    Revert: remove this function and its call when constructing employer related content.
    """
    return _legacy_call(_runtime.employer_breakdown, name, items, fields_main)


def faq_topic(field: str | None, state: str | None, what: str = "internships") -> str:
    """The page's subject as a phrase: "software engineering internships in Massachusetts",
    "internships in Canada", "remote software engineering interns" (what="interns")."""
    return _legacy_call(_runtime.faq_topic, field, state, what)


_fit_names = _runtime._fit_names
def listing_faq(
    items: list[dict], field: str | None, state: str | None, updated: str
) -> list[tuple[str, str]]:
    """(question, answer) for a field page (state None), a state, province, metro or Canada page
    (field None) or a field in one of them. Plain text; the HTML escaping is faq_section's."""
    return _legacy_call(_runtime.listing_faq, items, field, state, updated)


plan_allowance = _runtime.plan_allowance
def _offer(name: str, price: str) -> dict:
    """One schema.org Offer for a plan: price per month in USD, from PLAN_PRICES ("$4" -> "4")."""
    return _legacy_call(_runtime._offer, name, price)


def site_facts(listings: list[dict]) -> dict:
    """What the whole export says about InternScout's coverage: the numbers /about/, /compare/ and
    llms.txt state, so they all agree with each other and with the listing pages."""
    return _legacy_call(_runtime.site_facts, listings)


rate_words = _runtime.rate_words
def pay_report(listings: list[dict], fields: dict[str, list]) -> dict:
    """The highest listed hourly pay among the open roles: the top roles, the median and top rate by
    field, and the employers that list the most. Only hourly_rate's clear hourly figures count; a
    yearly salary or stipend is left out, never converted. The same role on two of one employer's
    boards counts once (as dedupe_roles, but across every employer at once). Roles only in Canada are
    left out: their pay is in Canadian dollars, and a ranking in two currencies ranks neither."""
    return _legacy_call(_runtime.pay_report, listings, fields)


def pay_rows(top_roles: list[tuple], now: datetime) -> str:
    return _legacy_call(_runtime.pay_rows, top_roles, now)


def pay_page(
    rep: dict, f: dict, now: datetime, fields: dict[str, list], paid_page: bool
) -> tuple[str, str, str]:
    """(title, description, body) of /internships/highest-paying/."""
    return _legacy_call(_runtime.pay_page, rep, f, now, fields, paid_page)


def _render_pay_page(model: _pay.Page) -> tuple[str, str, str]:
    return _legacy_call(_runtime._render_pay_page, model)


def about_answers(
    f: dict, majors: int, new: int, rep: dict | None, updated: str = "", numbers: bool = False
) -> list[tuple[str, str, str]]:
    """(question, answer, extra HTML) for /about/. The answer is plain text, the same words in the page
    and in its FAQPage block; the extra (a link) is the page's only. `numbers`: whether this build made
    /internships/by-the-numbers/, which the size answer then links (2026-10-05)."""
    return _legacy_call(_runtime.about_answers, f, majors, new, rep, updated, numbers)


def about_page(f: dict, qa: list[tuple[str, str, str]], updated: str) -> tuple[str, str, str, list]:
    """(title, description, body, JSON-LD) of /about/."""
    return _legacy_call(_runtime.about_page, f, qa, updated)


def numbers_page(
    f: dict,
    listings: list[dict],
    fields: dict,
    states: dict,
    rep: dict | None,
    new: int,
    kind_made: list,
    now: datetime,
    updated: str,
) -> tuple[list, str, str, list]:
    """(title forms, description, body, JSON-LD) of /internships/by-the-numbers/."""
    return _legacy_call(_runtime.numbers_page, f, listings, fields, states, rep, new, kind_made, now, updated)


def _render_numbers_page(model: _numbers.Page) -> tuple[list, str, str, list]:
    return _legacy_call(_runtime._render_numbers_page, model)


def compare_page(f: dict) -> tuple[str, str, str]:
    """(title, description, body) of /compare/."""
    return _legacy_call(_runtime.compare_page, f)


tier_card = _runtime.tier_card
def pricing_page() -> tuple[str, str, str, list]:
    """(title, description, body, JSON-LD) of /pricing/."""
    return _legacy_call(_runtime.pricing_page)


def digest_examples(new: list[dict]) -> str:
    """Three real new roles from this export, favoring different fields and employers.

    A sample is not a promise that a listing stays open or appears in next Monday's email.
    Filtering here also keeps this safe when called outside build() with untrusted rows.
    """
    return _legacy_call(_runtime.digest_examples, new)


def _select_digest_examples(new: list[dict]) -> _digest.Examples:
    return _legacy_call(_runtime._select_digest_examples, new)


_render_digest_examples = _runtime._render_digest_examples
def digest_page(new: list[dict], by_field: Counter, new_page: bool) -> tuple[str, str, str]:
    """(title, description, body) of /digest/, the weekly email's page (2026-10-06). `new` is this
    week's new roles as the email counts them (new_roles) and `by_field` the same per field; new_page
    says whether /internships/new/ was made. With no form address yet (DIGEST_FORM empty) the page has
    no form and says sign-ups aren't open, and build() keeps it out of search and the sitemap."""
    return _legacy_call(_runtime.digest_page, new, by_field, new_page)


_render_digest_page = _runtime._render_digest_page
def _render_kind_page(model: _listing.KindPage) -> dict:
    return _legacy_call(_runtime._render_kind_page, model)


def _render_new_page(model: _digest.NewPage) -> dict:
    return _legacy_call(_runtime._render_new_page, model)


def llms_files(
    f: dict,
    made: dict[str, tuple[str, int]],
    rep: dict | None,
    majors: int,
    employers: int,
    new: int,
    updated: str,
) -> dict[str, str]:
    """The two llmstxt.org files: llms.txt, an H1, a one-paragraph summary and lists of links to the
    pages that matter; llms-full.txt, the longer description an assistant can quote from. made is
    every page this build wrote (path -> (heading, open roles)), so neither links a page that isn't
    there. Dated from the data, like everything else a build writes."""
    return _legacy_call(_runtime.llms_files, f, made, rep, majors, employers, new, updated)


def near_path(m: dict, slug: str) -> str:
    return _legacy_call(_runtime.near_path, m, slug)


def near_indexed(
    local: list[dict], path: str, live, earning: frozenset, rivals: list[frozenset]
) -> bool:
    """Whether a near page is asked into search (NEAR_INDEX_MIN). A page people already find in search
    (earning) stays in whatever its count. None is while NEAR_INDEX is off."""
    return _legacy_call(_runtime.near_indexed, local, path, live, earning, rivals)


near_local = _runtime.near_local
near_town = _runtime.near_town
near_view = _runtime.near_view
def near_how(m: dict, f: dict) -> str:
    """What the page counts, in plain words: the metro as drawn, and the tags that make up the field."""
    return _legacy_call(_runtime.near_how, m, f)


def near_title(f: dict, m: dict, local: list[dict]) -> Head:
    """ "Business Internships near Denver: 75+ Open | InternScout". The count floor (or, under 10 roles, the
    start term most of them share) is the page's own; the field's short name when the full one won't fit."""
    return _legacy_call(_runtime.near_title, f, m, local)


near_description = _runtime.near_description
def near_body(
    f: dict,
    m: dict,
    local: list[tuple[dict, list[dict]]],
    remote: list[dict],
    now: datetime,
    path: str,
    indexed: bool,
    related: str,
) -> str:
    return _legacy_call(_runtime.near_body, f, m, local, remote, now, path, indexed, related)


def _select_near_body(
    f: dict,
    m: dict,
    local: list[_near.LocalRow],
    remote: list[dict],
    now: datetime,
    path: str,
    indexed: bool,
) -> _near.NearBody:
    return _legacy_call(_runtime._select_near_body, f, m, local, remote, now, path, indexed)


def _render_near_body(model: _near.NearBody) -> str:
    return _legacy_call(_runtime._render_near_body, model)


def _near_footer() -> str:
    return _legacy_call(_runtime._near_footer)


def near_pages(
    listings: list[dict],
    now: datetime,
    updated: str,
    live,
    earning: frozenset,
    rivals: list[frozenset],
) -> tuple[list[dict], dict]:
    """The 500 pages as add() arguments, and (path, field, local roles) per (CBSA, field slug) for the hub."""
    return _legacy_call(_runtime.near_pages, listings, now, updated, live, earning, rivals)


def _render_near_page(model: _near.NearPage) -> dict:
    return _legacy_call(_runtime._render_near_page, model)


near_hub = _runtime.near_hub
_render_near_hub = _runtime._render_near_hub
def _select_employer_page(
    directory: _employer.Directory,
    name: str,
    items: list[dict],
    path: str,
    spellings: list[str],
    root: tuple[str, str],
    now: datetime,
    live,
    earning: frozenset,
    details: dict[str, tuple[tuple[str, str], ...]] | None,
) -> _employer.Page:
    return _legacy_call(_runtime._select_employer_page, directory, name, items, path, spellings, root, now, live, earning, details)


def _render_employer_page(model: _employer.Page) -> dict:
    return _legacy_call(_runtime._render_employer_page, model)


def _render_field(model: _field.Field) -> dict:
    return _legacy_call(_runtime._render_field, model)


def _render_place(model: _field.Place) -> dict:
    return _legacy_call(_runtime._render_place, model)


def _render_combo(model: _field.Combo) -> dict:
    return _legacy_call(_runtime._render_combo, model)


def _render_major(model: _field.Major) -> dict:
    return _legacy_call(_runtime._render_major, model)


def _emit_field_pages(
    add: _build.AddPage,
    context: _field.Context,
    cohorts: _build.Cohorts,
    majors: _build.Majors,
    by_company: _build.Groups,
    digest_by_field: Counter,
    live: _build.Live,
    earning: frozenset[str],
) -> list[tuple[str, str, int]]:
    return _legacy_call(_runtime._emit_field_pages, add, context, cohorts, majors, by_company, digest_by_field, live, earning)


def _emit_employer_pages(
    add: _build.AddPage,
    site_dir: str,
    context: _field.Context,
    cohorts: _build.Cohorts,
    employers: _build.Employers,
    live: _build.Live,
    earning: frozenset[str],
) -> None:
    return _legacy_call(_runtime._emit_employer_pages, add, site_dir, context, cohorts, employers, live, earning)


def _emit_kind_and_tracker_pages(
    add: _build.AddPage,
    context: _field.Context,
    fields: _build.Groups,
    kind_made: list[_listing.KindSelection],
    term_paths: dict[str, str],
    trackers: list[str],
    by_term: dict,
    baseline: str | None,
) -> None:
    return _legacy_call(_runtime._emit_kind_and_tracker_pages, add, context, fields, kind_made, term_paths, trackers, by_term, baseline)


def _emit_near_and_new_pages(
    add: _build.AddPage,
    pages: list[dict],
    context: _field.Context,
    listings: _build.Listings,
    digest_new: _build.Listings,
    baseline: str | None,
    live: _build.Live,
    earning: frozenset[str],
) -> _build.Listings:
    return _legacy_call(_runtime._emit_near_and_new_pages, add, pages, context, listings, digest_new, baseline, live, earning)


def _emit_report_pages(
    add: _build.AddPage,
    context: _field.Context,
    listings: _build.Listings,
    cohorts: _build.Cohorts,
    kind_made: list[_listing.KindSelection],
    new_count: int,
    enough: _build.Enough,
) -> tuple[dict, str, dict | None, bool]:
    return _legacy_call(_runtime._emit_report_pages, add, context, listings, cohorts, kind_made, new_count, enough)


def _emit_hubs(
    add: _build.AddPage,
    context: _field.Context,
    cohorts: _build.Cohorts,
    by_company: _build.Groups,
    majors_made: list[tuple[str, str, int]],
    kind_made: list[_listing.KindSelection],
    trackers: list[str],
    listing_count: int,
    new_count: int,
    pay_path: str,
    rep: dict | None,
    numbers: bool,
) -> None:
    return _legacy_call(_runtime._emit_hubs, add, context, cohorts, by_company, majors_made, kind_made, trackers, listing_count, new_count, pay_path, rep, numbers)


def _emit_information_pages(
    add: _build.AddPage,
    facts: dict,
    majors_count: int,
    new_count: int,
    rep: dict | None,
    updated: str,
    numbers: bool,
    digest_new: _build.Listings,
    digest_by_field: Counter,
) -> None:
    # What InternScout is, for people and for answer engines (2026-10-02). After the hubs: they link
    # only pages that exist.
    return _legacy_call(_runtime._emit_information_pages, add, facts, majors_count, new_count, rep, updated, numbers, digest_new, digest_by_field)


def _fitted_page_title(title) -> str:
    return _legacy_call(_runtime._fitted_page_title, title)


def _select_build_fields(listings, enough, employers_in, fold_at):
    return _legacy_call(_runtime._select_build_fields, listings, enough, employers_in, fold_at)


def _select_build_trackers(listings, now, enough, employers_in):
    return _legacy_call(_runtime._select_build_trackers, listings, now, enough, employers_in)


def _set_build_tracker(trackers: list[str]) -> None:
    return _legacy_call(_runtime._set_build_tracker, trackers)


def _select_build_combinations(fields, states, enough, live, earning, employers_in, fold_at):
    return _legacy_call(_runtime._select_build_combinations, fields, states, enough, live, earning, employers_in, fold_at)


def _select_build_majors(listings, major_data, cohorts, enough):
    return _legacy_call(_runtime._select_build_majors, listings, major_data, cohorts, enough)


def _register_build_employers(listings, enough):
    return _legacy_call(_runtime._register_build_employers, listings, enough)


def _build_page_writer(pages, listings, live, updated):
    return _legacy_call(_runtime._build_page_writer, pages, listings, live, updated)


def _select_build_kinds(pages, listings, trackers, enough):
    return _legacy_call(_runtime._select_build_kinds, pages, listings, trackers, enough)


def _finish_build(pages, live, by_company, cohorts, trackers, new, majors_made, facts, rep, updated):
    return _legacy_call(_runtime._finish_build, pages, live, by_company, cohorts, trackers, new, majors_made, facts, rep, updated)


def build(
    site_dir: str,
    live: dict[str, str] | set[str] | frozenset[str] = frozenset(),
    held: set[str] | frozenset[str] = frozenset(),
    earning: frozenset[str] | None = None,
) -> list[dict]:
    """live: the pages the site is serving now (live_paths), which get the lower keep_at bar and
    whose lastmod the new one never goes below. held: the noindex pages it is serving now
    (held_paths), live for keep_at though not in the sitemap. earning: the pages people find in
    search (earning_paths, read from SEARCH_PAGES when None), which are never made noindex, but for
    the near pages while NEAR_INDEX is off."""
    return build_result(site_dir, live, held, earning).pages


def build_result(
    site_dir: str,
    live: dict[str, str] | set[str] | frozenset[str] = frozenset(),
    held: set[str] | frozenset[str] = frozenset(),
    earning: frozenset[str] | None = None,
) -> _build.Result:
    """Build pages and return the employer registry from that same build."""
    return _legacy_call(_runtime.build_result, site_dir, live, held, earning)


def top_employers(by_company: dict[str, list], n: int) -> list[tuple[str, str, int]]:
    """(page, name, open roles) of the n employers with the most open roles; ties by name."""
    return _legacy_call(_runtime.top_employers, by_company, n)


def home_browse(
    pages: list[dict],
    by_company: dict[str, list],
    fields: dict,
    states: dict,
    trackers: list[str],
    new: bool,
    majors: int,
) -> str:
    """The dashboard's Browse section: plain links with their counts, each to a page this build made."""
    return _legacy_call(_runtime.home_browse, pages, by_company, fields, states, trackers, new, majors)


def not_found(updated: str) -> str:
    """GitHub Pages serves 404.html for any missing path, including a landing page whose listings
    closed. Without it a visitor from an old search result gets GitHub's own page, with no way back."""
    return _legacy_call(_runtime.not_found, updated)


strip_placements = _runtime.strip_placements


def placement_box(x: dict, pl: dict, state: str | None = None) -> str:
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



def add_paid_boxes(pages: list[dict], kept: list[dict], today: str) -> list[dict]:
    """pages with at most one paid listing's box each (MAX_PER_PAGE), on the listing pages
    (PLACEMENT_KINDS) whose own items include its listing. kept: placements.resolve's. When two or more
    fit one page, a hash of the path and the day picks one, so two builds on the same day are the same
    and price never matters. Only "html" changes; a page with no box is the same dict."""
    max_per_page = _paid.placement_services().MAX_PER_PAGE

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
        box = placement_box(here[pl["listing_id"]], pl, p.get("state"))
        out.append(dict(p, html=p["html"][:at] + box + p["html"][at:]) if box else p)
    return out



def write_placements(site_dir: str, kept: list[dict], today: str) -> None:
    """<site_dir>/data/placements.json: the placements kept today, public fields only."""
    public = _paid.placement_services().public

    folder = os.path.join(site_dir, "data")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, PLACEMENTS_FILE), "w", encoding="utf-8", newline="\n") as f:
        json.dump(
            {"day": today, "placements": public(kept)}, f, ensure_ascii=False, separators=(",", ":")
        )
        f.write("\n")



def today_utc() -> str:
    """Today's UTC day. A placement's dates are UTC days, start inclusive and end exclusive."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")



def write(site_dir: str, pages: list[dict]) -> None:
    # 2026-10-23: date real visible changes, including corrections and closures, after all page
    # decisions. was: only max(first_seen, live lastmod); see page_dates for the one-line revert.
    now = GENERATED or datetime.now(timezone.utc)
    content_dates, home_lastmod = page_dates.refresh(
        site_dir, pages, now, HOME, HOME_START, HOME_END, LISTINGS, home_floor=HOME_LIVE_DATE
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
    now = GENERATED or datetime.now(timezone.utc)  # was: now = datetime.now(timezone.utc)
    with open(os.path.join(site_dir, "404.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(not_found(f"{now:%B} {now.day}, {now.year}"))
    _discovery.write_sitemap(site_dir, pages, home_lastmod, SITE, esc)
    _discovery.write_robots(site_dir, SITE)
    _llms.write(site_dir, TEXTS)
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
    if HOME and os.path.isfile(home):
        with open(home, encoding="utf-8", newline="") as f:
            text = f.read()
        start, end = text.find(HOME_START), text.find(HOME_END)
        if 0 <= start < end:
            text = text[: start + len(HOME_START)] + HOME + text[end:]
            with open(home, "w", encoding="utf-8", newline="") as f:
                f.write(text)



def live_paths(sitemap: str) -> dict[str, str]:
    """path -> lastmod ("" if none) for every page in the sitemap the site was serving before this
    build; empty if there was none."""
    return _discovery.live_paths(sitemap, SITE_PATH)



def held_paths(listing: str) -> frozenset[str]:
    """The noindex pages the site was serving before this build (HELD_FILE); empty if there was none."""
    try:
        with open(listing, encoding="utf-8") as f:
            return frozenset(
                s for s in (line.strip() for line in f) if s.startswith("/internships/")
            )
    except (OSError, UnicodeDecodeError):
        return frozenset()



def main(argv: list[str]) -> None:
    """python -m internscout.seo_pages SITE_DIR [LIVE_SITEMAP [LIVE_NOINDEX_LIST]] [--placements PATH]
    [--placements-report PATH]

    --placements PATH (2026-10-14): the Worker's GET /placements answer, which the pages workflow
    fetches only when the repo variable INTERNSCOUT_PLACEMENTS_URL is set and otherwise writes as
    {"placements":[]}. With it, the build writes <site_dir>/data/placements.json (an empty list when the
    file is missing or malformed), prints a ::warning:: for each placement it drops, and adds the boxes.
    Without it, nothing about placements is written or changed.

    --placements-report PATH (2026-10-14), with --placements: also writes PATH, the build's report for
    placements.record_runs (placements.report: the UTC day, the ids kept and the ids dropped with their
    reasons). The pages workflow writes it outside the site, so it is never published."""
    argv = list(argv)
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
    site_dir = argv[1] if len(argv) > 1 else "docs"
    pages = build(
        site_dir,
        live_paths(argv[2]) if len(argv) > 2 else {},
        held_paths(argv[3]) if len(argv) > 3 else frozenset(),
    )
    # was: pages = build(site_dir, live_paths(argv[2]) if len(argv) > 2 else {})
    built = pages  # as build() made them, before any paid box, for the feeds
    today = today_utc()
    if placements_path is not None:
        placements = _paid.placement_services()

        kept, dropped = placements.resolve(
            placements.read(placements_path), {str(x["id"]): x for x in LISTINGS}, today
        )
        # GitHub Actions annotations must remain raw even in JSON log mode.
        for line in placements.warnings(kept, dropped):
            print(line)
        write_placements(site_dir, kept, today)
        if report_path:
            # Only a record for refunds: a report that cannot be written never stops the build.
            try:
                with open(report_path, "w", encoding="utf-8", newline="\n") as f:
                    json.dump(placements.report(kept, dropped, today), f, separators=(",", ":"))
                    f.write("\n")
            except OSError:
                print("::warning::placements report not written")
        pages = add_paid_boxes(pages, kept, today)
        console(f"[seo] placements: {len(kept)} kept, {len(dropped)} dropped")
    write(site_dir, pages)
    # The role index the employer buy page searches and the Worker checks orders against (2026-10-19,
    # role_index). Here and not in build(), which writes nothing: growth/report.py calls build() on docs/.
    shards = role_index.write(site_dir, LISTINGS, GENERATED or datetime.now(timezone.utc), today)
    console(f"[seo] role index: {sum(shards.values())} roles in {len(shards)} shards")
    # The date is passed, not left to feeds to read from seo_pages.GENERATED: run as
    # `python -m internscout.seo_pages` this module is __main__, and the internscout.seo_pages that
    # feeds imports is a second copy whose build() never ran, so its GENERATED is None.
    feeds.write_all(site_dir, built, GENERATED)  # was: feeds.write_all(site_dir, pages)
    # The embedded widget needs real per-field coverage, not the dashboard's 60-row preview.
    widget_data.write(site_dir, LISTINGS, GENERATED, today_utc())
    message = f"[seo] wrote {len(pages)} pages, sitemap.xml and robots.txt"
    if os.environ.get("INTERNSCOUT_LOG_FORMAT") != "json":
        message += f" into {site_dir}"
    console(message)



if __name__ == "__main__":
    main(sys.argv)
