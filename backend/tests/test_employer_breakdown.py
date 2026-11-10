"""2026-10-23: employer detail must be specific, factual, bounded and safe to render."""
from copy import deepcopy
import re

from internscout import seo_pages
from test_seo_pages import _row, _site


def test_field_counts_terms_and_locations_use_only_that_employers_matching_roles(tmp_path):
    rows = [_row(i, company_name="North & South", tags=("mechanical",), term="Summer 2027",
                 regions=[{"loc": "Boston, Massachusetts", "kind": "us", "state": "MA"}]) for i in range(10)]
    rows += [_row(20, company_name="North & South", tags=("swe", "swe"), term="Spring 2027",
                  regions=[{"loc": "Toronto, ON", "kind": "canada", "state": "ON"}], salary="CAD $25-$30/hour")]
    rows += [_row(30, company_name="Other Co", tags=("swe",), term="Winter 2099", salary="$199/hr") for _ in range(5)]
    pages = seo_pages.build(_site(tmp_path, {"all": rows}))
    h = next(p["html"] for p in pages if p["path"] == "/internships/at/north-south/")
    detail = h.split('<section class="employer-breakdown">')[1].split('</section>')[0]
    assert "North &amp; South's current postings" in detail
    mechanical, software = re.findall(r'<li>(.*?)</li>', detail)
    assert 'Mechanical Engineering' in mechanical and '10 open roles.' in mechanical
    assert 'Summer 2027 (10)' in mechanical and 'Boston, MA (10)' in mechanical
    assert 'Software Engineering' in software and '1 open role.' in software
    assert 'Spring 2027 (1)' in software and 'Toronto, ON (1)' in software
    assert 'CAD $25-$30/hour' in software
    assert '$199' not in detail and '2099' not in detail


def test_example_pay_is_quoted_without_currency_or_period_conversion():
    rows = [_row(1, salary="CAD $25-$30/hour", title="A Canadian Intern"),
            _row(2, salary="$85,000 a year", title="B Annual Intern"),
            _row(3, salary="$20/hour", title="C US Intern")]
    before = deepcopy(rows)
    h = seo_pages.employer_breakdown("Mixed Co", rows, ["mechanical"])
    assert 'Listed pay: CAD $25-$30/hour.' in h
    assert '$20 to $85' not in h and '$85,000 an hour' not in h
    assert seo_pages.employer_breakdown("Annual Co", [rows[1]], ["mechanical"]).count('$85,000 a year') == 1
    assert rows == before


def test_missing_start_pay_and_locations_are_not_invented():
    rows = [_row(1, field_tags=["other"], term=None, salary=None, regions=[], is_remote=False)]
    h = seo_pages.employer_breakdown("Quiet Co", rows, [])
    assert '<h3>Open roles</h3>' in h and '1 posting does not name a start term with a year.' in h
    assert 'Start terms:' not in h and 'Locations:' not in h and 'Listed pay:' not in h
    assert 'Summer' not in h and 'Remote' not in h
    assert seo_pages.employer_breakdown("Empty", [], []) == ""


def test_examples_and_names_are_escaped_and_unsafe_destinations_are_excluded():
    rows = [_row(1, title='<img src=x onerror="alert(1)">', salary='$25 <script>oops</script>',
                 apply_url='https://example.com/?a=1&b=2'),
            _row(2, title="Unsafe", salary="$50/hr", apply_url="javascript:alert(1)")]
    h = seo_pages.employer_breakdown('<b>Company</b>', rows, ["mechanical"])
    assert '<b>Company</b>' not in h and '<img src=x' not in h and '<script>oops' not in h
    assert '&lt;img' in h and '&lt;script&gt;' in h
    assert 'javascript:' not in h and 'Unsafe</span>' not in h
    assert '<a ' not in h       # existing listing actions remain the only application links


def test_breakdown_is_stable_bounded_and_keeps_original_eligibility(tmp_path):
    rows = [_row(i, company_name="Small Co", salary="$25/hr") for i in range(5)]
    site = _site(tmp_path, {"all": rows})
    page = next(p for p in seo_pages.build(site, earning=frozenset()) if p['path'] == '/internships/at/small-co/')
    assert not page['index'] and page['thin']
    h = seo_pages.employer_breakdown("Small Co", rows, ["mechanical", "mechanical", "swe"])
    assert h.count('<li>') == 1
    assert h == seo_pages.employer_breakdown("Small Co", list(reversed(rows)), ["mechanical"])
    assert 'Mechanical Intern 0</span>' in h


def test_paid_missing_title_does_not_break_a_valid_employer_page(tmp_path):
    rows = [_row(i, company_name="Example Robotics") for i in range(10)]
    rows[0].update(title=None, salary="$25/hr")
    assert all(seo_pages.well_formed(x) for x in rows)
    page = next(p for p in seo_pages.build(_site(tmp_path, {"all": rows}))
                if p['path'] == '/internships/at/example-robotics/')
    detail = page['html'].split('<section class="employer-breakdown">')[1].split('</section>')[0]
    assert '10 open roles.' in detail and 'Mechanical Intern 1</span>' in detail
    assert 'None</span>' not in detail and 'Listed pay:' not in detail
    for x in rows:
        x['title'] = ' '
    detail = seo_pages.employer_breakdown("Example Robotics", rows, ["mechanical"])
    assert '10 open roles.' in detail and 'Example posting:' not in detail
