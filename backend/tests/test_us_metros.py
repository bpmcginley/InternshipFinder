"""The top-50 search rotation survives missed runs and stays within search quotas."""
import httpx

from internscout.us_metros import TOP_US_METROS, metro_searches
from internscout.sources import google_jobs as gj


def test_population_catalog_and_rotation_cover_all_fifty():
    assert len(TOP_US_METROS) == len({m['cbsa'] for m in TOP_US_METROS}) == 50
    assert [m['rank'] for m in TOP_US_METROS] == list(range(1, 51))
    assert [m['population'] for m in TOP_US_METROS] == sorted((m['population'] for m in TOP_US_METROS), reverse=True)
    assert TOP_US_METROS[0]['city'] == 'New York'
    assert TOP_US_METROS[-1]['city'] == 'Hartford'
    for batch in (1, 2, 7):
        planned = [p for cursor in range(0, 50, batch) for p in metro_searches(cursor, min(batch, 50 - cursor))]
        assert len({p[2] for p in planned}) == 50
    assert metro_searches(50, 1)[0][0] != metro_searches(0, 1)[0][0]


def _mock(monkeypatch, handler, monthly=250):
    real = httpx.Client
    def route(req):
        if req.url.path == '/account.json':
            return httpx.Response(200, json={'searches_per_month': monthly, 'total_searches_left': 100})
        return handler(req)
    monkeypatch.setattr(gj, 'client', lambda: real(transport=httpx.MockTransport(route)))
    monkeypatch.setenv('SERPAPI_KEY', 'test')
    monkeypatch.delenv('SERPAPI_US_METRO_SEARCHES', raising=False)


def test_top50_reserved_budget_and_persistent_success(monkeypatch):
    searches = []
    def handler(req):
        searches.append(req.url.params['location'])
        return httpx.Response(200, json={'jobs_results': []})
    _mock(monkeypatch, handler)
    gj.fetch_google_jobs(['museum internship'], ['Boston, Massachusetts'],
                         fixed=[('student', 'Toronto, Ontario, Canada')], nationwide=True)
    assert searches[:2] == [m['location'] for m in TOP_US_METROS[:2]]
    assert len(searches) <= 8
    assert gj.search_state()['metro_cursor'] == 2
    assert len(gj.search_state()['metro_last_success']) == 2
    gj.mark_searched('2000-01-01')
    assert gj.search_state()['metro_cursor'] == 2
    searches.clear()
    gj.fetch_google_jobs(['internship'], [], nationwide=True)
    assert searches == [m['location'] for m in TOP_US_METROS[2:4]]


def test_failed_or_malformed_metro_is_not_skipped(monkeypatch):
    searches = []
    def handler(req):
        searches.append(req.url.params['location'])
        return httpx.Response(200, json={'error': 'invalid location'})
    _mock(monkeypatch, handler)
    gj.fetch_google_jobs(['internship'], [], nationwide=True)
    assert searches == [TOP_US_METROS[0]['location']]
    assert gj.search_state().get('metro_cursor', 0) == 0


def test_a_single_search_budget_still_reaches_a_top50_metro(monkeypatch):
    searches = []
    def handler(req):
        searches.append(req.url.params['location'])
        return httpx.Response(200, json={'jobs_results': []})
    _mock(monkeypatch, handler, monthly=31)
    gj.fetch_google_jobs(['internship'], ['Boston, Massachusetts'],
                         fixed=[('student', 'Toronto, Ontario, Canada')], nationwide=True)
    assert searches == [TOP_US_METROS[0]['location']]


def test_exhausted_quota_does_not_advance_the_metro_cursor(monkeypatch):
    _mock(monkeypatch, lambda req: httpx.Response(429, json={'error': 'quota'}))
    gj.fetch_google_jobs(['internship'], [], nationwide=True)
    assert gj.search_state().get('metro_cursor', 0) == 0
