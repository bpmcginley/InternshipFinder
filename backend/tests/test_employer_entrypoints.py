"""2026-10-23: employer sales entry points stay separate from organic role actions."""

from urllib.parse import parse_qs, urlsplit
import re

import pytest

from internscout.site import runtime
from internscout.site.runtime import employer_key, employer_offer
from tests.seo_fixture_data import _row, _site

pytestmark = pytest.mark.without_seo_facade


def test_public_company_key_prefill_is_escaped_and_never_places_an_order():
    name = 'North & South <Research> "Hiring"'
    out = employer_offer(name)
    link = re.search(r'href="([^"]+)" data-employer-entry="employer"', out).group(1)
    assert urlsplit(link).path == '/employers/buy/'
    assert parse_qs(urlsplit(link).query) == {'company': [employer_key(name)]}
    assert '<Research>' not in out and '&lt;Research&gt;' in out
    assert 'Payment never changes organic search rankings.' in out
    assert 'Board additions and corrections are free' in out
    assert '/employers/#free-help' in out


def test_employer_cta_does_not_add_application_links_or_change_indexing(tmp_path):
    rows = [_row(i, company_name='Example Co') for i in range(10)]
    site = _site(tmp_path, {'all': rows})
    state = runtime.BuildState(near_on=False)
    pages = runtime.invoke(state, runtime.BuildHooks(), runtime.build, site, earning=frozenset())
    page = next(p for p in pages if p['path'] == '/internships/at/example-co/')
    h = page['html']
    assert h.count('data-employer-entry="employer"') == 1
    assert h.count('data-employer-entry="nav"') == 1
    assert h.count('data-employer-entry="footer"') == 1
    assert h.count('class="go"') == len(rows)
    assert 'class="prose employer-offer"' in h
    assert 'Work at Example Co? See how students find your roles, and feature them.' in h
