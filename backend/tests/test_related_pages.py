"""2026-10-23: recommendation quality must not change page eligibility or factual counts."""
from copy import deepcopy
from internscout.related_pages import SECTIONS, prefer_indexed


def page(path, *, indexed=True, kind=None, ids=(), body="", h1="Field"):
    return {"path": path, "index": indexed, "thin": not indexed, "kind": kind,
            "items": [{"id": i} for i in ids], "h1": h1, "lastmod": "2026-10-01",
            "html": '<main>' + body + '</main>'}


def related(*targets):
    return '<section class="rel"><h2>Related</h2><ul>' + ''.join(
        f'<li><a href="{p}">Local field</a> <span class="n">5</span></li>' for p in targets) + '</ul></section>'


def test_thin_combo_falls_back_to_real_field_with_accurate_all_place_count():
    pages = [page('/internships/engineering/', kind='field', ids=range(30), h1='Engineering & research'),
             page('/internships/engineering/maine/', indexed=False, kind='combo', ids=range(5)),
             page('/internships/maine/', kind='state', ids=range(5),
                  body=related('/internships/engineering/maine/'))]
    before = deepcopy(pages)
    prefer_indexed(pages)
    text = pages[-1]['html']
    assert 'href="/internships/engineering/"' in text
    assert 'Engineering &amp; research (all places)' in text
    assert '<span class="n">30</span>' in text
    primary = ''.join(m[0] for m in SECTIONS.finditer(text))
    assert 'href="/internships/engineering/maine/"' not in primary
    assert '<details class="browse-more">' in text
    assert 'href="/internships/engineering/maine/"' in text
    for old, new in zip(before, pages):
        assert {k: v for k, v in old.items() if k != 'html'} == {k: v for k, v in new.items() if k != 'html'}


def test_recommendations_keep_indexed_targets_and_dedupe_fallbacks():
    field = page('/internships/engineering/', kind='field', ids=range(30))
    thin = [page(f'/internships/engineering/{p}/', indexed=False) for p in ['maine', 'vermont']]
    source = page('/internships/at/acme/', ids=[1], body=related(*(p['path'] for p in thin), field['path']))
    prefer_indexed([field, *thin, source])
    assert source['html'].count('href="/internships/engineering/"') == 1


def test_complete_catalogues_and_noindex_sources_keep_their_browsing_links():
    thin = page('/internships/at/small/', indexed=False)
    catalogue = page('/internships/at/', body=related(thin['path']))
    source = page('/internships/engineering/maine/', indexed=False, body=related(thin['path']))
    before = [p['html'] for p in [catalogue, source]]
    prefer_indexed([thin, catalogue, source])
    assert [p['html'] for p in [catalogue, source]] == before


def test_employer_with_only_ineligible_similar_pages_gets_real_shared_fields():
    field = page('/internships/engineering/', kind='field', ids=[1, 2])
    thin = page('/internships/at/small/', indexed=False)
    source = page('/internships/at/acme/', kind='employer', ids=[1], body=related(thin['path']))
    prefer_indexed([field, thin, source])
    assert '<h2>Related fields</h2>' in source['html']
    assert 'href="/internships/engineering/"' in source['html']
    once = source['html']
    prefer_indexed([field, thin, source])
    assert source['html'] == once


def test_no_fabricated_field_when_no_indexed_field_shares_a_role():
    hub = page('/internships/')
    field = page('/internships/engineering/', kind='field', ids=[100])
    source = page('/internships/at/acme/', kind='employer', ids=[1])
    prefer_indexed([hub, field, source])
    assert 'href="/internships/">Browse internships by field and place' in source['html']
    assert 'href="/internships/engineering/"' not in source['html']


def test_a_field_already_recommended_is_not_repeated_under_places():
    field = page('/internships/engineering/', kind='field', ids=range(30))
    thin = page('/internships/engineering/maine/', indexed=False)
    source = page('/internships/at/acme/', kind='employer', ids=[1],
                  body=related(field['path']) + related(thin['path']))
    prefer_indexed([field, thin, source])
    assert source['html'].count('href="/internships/engineering/"') == 1
    assert 'href="/internships/engineering/maine/"' in source['html']
    once = source['html']
    prefer_indexed([field, thin, source])
    assert source['html'] == once
