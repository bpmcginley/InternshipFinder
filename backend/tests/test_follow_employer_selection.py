"""Same-export model bridge, using the real loader, paired stage and employer renderer."""

from copy import deepcopy
from dataclasses import replace
import json
import re

import pytest

from internscout.site import employer, runtime, source
from internscout.site import follow_employer_selection as adapter
from internscout.site.follow_employer_selection import prepare_follow_employer_selection as prepare
from internscout.site.paired_annotation_stage import stage_paired_annotations
from test_employer_follow import model
from test_follow_company_stage import repin, raw
from test_paired_annotation_stage import sample
from tests.seo_fixture_data import _row


@pytest.fixture
def captured(tmp_path):
    selected, _, options = sample()
    names = ('The Booz Allen Hamilton Corporation', 'booz allen')
    rows = [
        _row(
            i,
            id=f'{i:016x}',
            company_name=names[i % 2],
            tags=('biology',),
            regions=[{'loc': 'Boston, MA', 'kind': 'us', 'state': 'MA'}],
        )
        for i in range(8)
    ]
    rows.append(dict(rows[0], id='f' * 16, status='closed'))
    selected['listings/MA.json'] = raw(rows)
    selected['listings/ON.json'] = raw([rows[0]])
    index = json.loads(selected['listings/index.json'])
    for key, meta in index['files'].items():
        members = json.loads(selected[f'listings/{key}.json'])
        meta['count'] = len(members)
        meta['open'] = sum(r['status'] == 'open' for r in members)
    selected['listings/index.json'] = raw(index)
    first = raw([rows[0]])
    options = repin(selected, first, options)
    stage = stage_paired_annotations(selected, first, **options)
    for path, data in selected.items():
        target = tmp_path / 'data' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    loaded = source.load(str(tmp_path))
    return tmp_path, loaded, stage


def selection(captured, **changes):
    _, loaded, stage = captured
    return prepare(
        loaded['listings'],
        stage,
        **({'enabled': True, 'max_rows': 100, 'max_bytes': 200000} | changes),
    )


def page(captured):
    rows = captured[1]['listings']
    return replace(
        model('booz allen'),
        items=rows[:],
        spellings=list(dict.fromkeys(r['company_name'] for r in rows)),
    )


def test_default_no_inspection_and_receipts_unchanged(captured):
    for enabled in (False, None, 1, 'true'):
        assert prepare(object(), object(), enabled=enabled) is None
    ctx = selection(captured)
    assert ctx.stage is captured[2]
    invalid = object()
    for enabled in (False, None, 1, 'true'):
        assert ctx.select(invalid, enabled=enabled) is invalid
    value = page(captured)
    assert ctx.select(value) is value


def test_same_original_aliases_derived_metro_copies_and_mutation(captured):
    original = page(captured)
    saved = deepcopy(original)
    ctx = selection(captured)
    result = ctx.select(original, enabled=True)
    assert result.follow_company.key == 'booz allen'
    assert result.follow_company.label == original.name
    assert original == saved
    assert all(a is not b for a, b in zip(result.items, original.items, strict=True))
    assert result.spellings is not original.spellings
    assert result.items[0]['regions'] is not original.items[0]['regions']
    assert result.items[0]['regions'][0]['metro'] == source.us_metro(
        original.items[0]['regions'][0]
    )
    for old, new in zip(original.items, result.items, strict=True):
        assert {k: v for k, v in new.items() if k != 'follow_company_key'} == old
    result.items[0]['follow_company_key'] = 'changed'
    with pytest.raises(ValueError):
        employer.validated_company_follow(result)
    assert original == saved


@pytest.mark.parametrize(
    'change', ['copy', 'paid', 'closed', 'id', 'name', 'title', 'keys', 'nested']
)
def test_changed_copied_paid_and_stale_rows_reject(captured, change):
    ctx = selection(captured)
    value = page(captured)
    row = value.items[0]
    if change == 'copy':
        value.items[0] = dict(row)
    elif change == 'paid':
        row['placement_id'] = 'synthetic-placement'
    elif change == 'closed':
        row['status'] = 'closed'
    elif change == 'keys':
        row['keys'].add('unsupported')
    elif change == 'nested':
        row['regions'][0]['loc'] = 'Different city'
    else:
        row[{'id': 'id', 'name': 'company_name', 'title': 'title'}[change]] = 'changed'
    with pytest.raises(ValueError):
        ctx.select(value, enabled=True)


@pytest.mark.parametrize('change', ['replace', 'remove', 'append', 'reverse'])
def test_original_render_input_membership_is_still_current(captured, change):
    ctx = selection(captured)
    value = page(captured)
    rows = captured[1]['listings']
    if change == 'replace':
        rows[0] = dict(rows[0])
    elif change == 'remove':
        rows.pop()
    elif change == 'append':
        rows.append(dict(rows[0]))
    else:
        rows.reverse()
    with pytest.raises(ValueError):
        ctx.select(value, enabled=True)


@pytest.mark.parametrize('change', ['facts', 'metro', 'unknown', 'duplicate', 'preannotated'])
def test_different_or_ambiguous_loaded_export_rejects_before_selection(captured, change):
    row = captured[1]['listings'][0]
    if change == 'facts':
        row['title'] = 'Other release with same ID and company'
    elif change == 'metro':
        row['regions'][0]['metro'] = 'Unverified derived value'
    elif change == 'unknown':
        row['id'] = 'e' * 16
    elif change == 'duplicate':
        captured[1]['listings'].append(row)
    else:
        row['employer_key'] = 'unrelated-counter-key'
    with pytest.raises(ValueError):
        selection(captured)


@pytest.mark.parametrize(
    'changes', [{'max_rows': True}, {'max_rows': 1}, {'max_bytes': 1}, {'max_bytes': None}]
)
def test_explicit_bounds_fail_closed(captured, changes):
    with pytest.raises(ValueError):
        selection(captured, **changes)


def test_candidate_cost_and_nested_copy_are_bounded(captured, monkeypatch):
    ctx = selection(captured)
    value = replace(page(captured), items=captured[1]['listings'][:1])

    class IndexedOnly(list):
        reads = 0

        def __iter__(self):
            pytest.fail('selection scanned unrelated organic rows')

        def __getitem__(self, index):
            self.reads += 1
            return super().__getitem__(index)

    indexed = IndexedOnly(ctx._source)
    instrumented = replace(ctx, _source=indexed)
    assert instrumented.select(value, enabled=True).follow_company.key == 'booz allen'
    assert indexed.reads == 1
    # Oversized caller mutation must be rejected before deepcopy, not copied then compared.
    value.items[0]['regions'].extend([{}] * 10000)
    monkeypatch.setattr(adapter, 'deepcopy', lambda _: pytest.fail('oversized candidate copied'))
    with pytest.raises(ValueError):
        ctx.select(value, enabled=True)


def test_missing_rows_conflicting_alias_empty_and_duplicate_models(captured):
    ctx = selection(captured)
    value = page(captured)
    for invalid in (
        replace(value, items=[]),
        replace(value, items=[value.items[0]] * 2),
        replace(value, spellings=['Unapproved alias']),
        replace(value, name='Other company'),
    ):
        with pytest.raises(ValueError):
            ctx.select(invalid, enabled=True)
    changed = replace(captured[2].follow, files={})
    with pytest.raises(ValueError):
        prepare(
            captured[1]['listings'],
            replace(captured[2], follow=changed),
            enabled=True,
            max_rows=100,
            max_bytes=200000,
        )


def test_real_build_only_adds_existing_employer_control(captured, monkeypatch):
    root, loaded, _ = captured
    ctx = selection(captured)
    choose = runtime._select_employer_page
    enabled = False
    selected_models = []

    def select(*args, **kwargs):
        value = choose(*args, **kwargs)
        selected_models.append(value)
        return ctx.select(value, enabled=enabled)

    monkeypatch.setattr(runtime, '_select_employer_page', select)

    def build():
        return runtime.invoke(
            runtime.BuildState(),
            runtime.BuildHooks(load=lambda _: loaded),
            runtime.build,
            str(root),
        )

    baseline = {p['path']: p for p in build()}
    enabled = True
    result = {p['path']: p for p in build()}
    changed = [p for p in baseline if baseline[p]['html'] != result[p]['html']]
    assert changed == ['/internships/at/booz-allen/']
    marker = re.compile(
        r'<section data-follow-company-key="[^"]+" data-follow-company-label="[^"]+"></section><script type="module" src="/js/follow-company.mjs"></script>'
    )
    path = changed[0]
    assert len(marker.findall(result[path]['html'])) == 1
    assert marker.sub('', result[path]['html']) == baseline[path]['html']
    assert all(result[p]['html'] == baseline[p]['html'] for p in baseline if p != path)
    assert all('follow_company_key' not in row for row in loaded['listings'])
    assert all(value.follow_company is None for value in selected_models)


@pytest.mark.parametrize(
    'value',
    [
        '',
        '"\\\b\f\n\r\t\x00\x1f',
        'é🙂',
        [[], {}, '', None, True, False],
        {'number': 10**80, 'negative': -100, 'float': 1e-8, 'keys': {'a', 'b'}},
    ],
)
def test_budget_matches_compact_utf8_json_exactly(value):
    expected = json.dumps(
        value,
        ensure_ascii=False,
        separators=(',', ':'),
        allow_nan=False,
        default=lambda value: sorted(value),
    ).encode('utf-8')
    assert adapter._budget(value, len(expected)) == 0
    with pytest.raises(ValueError):
        adapter._budget(value, len(expected) - 1)


@pytest.mark.parametrize(
    'value',
    [
        [[''] * 500 for _ in range(100)],
        ['\x00' * 100] * 10,
        [10**100] * 20,
    ],
)
def test_oversized_nested_scalars_reject_before_encoding_or_copy(value, monkeypatch):
    monkeypatch.setattr(adapter.json, 'dumps', lambda *a, **k: pytest.fail('encoded too early'))
    monkeypatch.setattr(adapter, 'deepcopy', lambda _: pytest.fail('copied too early'))
    with pytest.raises(ValueError):
        adapter._facts({'nested': value}, limit=1000)


def test_duplicate_and_unbounded_spellings_reject_before_copy(captured, monkeypatch):
    ctx = selection(captured)
    value = page(captured)
    monkeypatch.setattr(adapter, 'deepcopy', lambda _: pytest.fail('copied invalid model'))

    def unbounded():
        pytest.fail('iterated unbounded spellings')
        yield 'booz allen'

    for invalid in (
        replace(value, items=[value.items[0]] * 8),
        replace(value, spellings=unbounded()),
        replace(value, spellings=['booz allen'] * (len(ctx._aliases) + 1)),
        replace(value, spellings=['x' * 100000]),
    ):
        with pytest.raises(ValueError):
            ctx.select(invalid, enabled=True)


def test_full_upstream_shard_cardinality_plus_first_is_accepted(captured):
    from string import ascii_uppercase

    stage = captured[2]
    files = {f'listings/{a}{b}.json': b'[]' for a in ascii_uppercase for b in ascii_uppercase}
    files.update({'listings/Canada.json': b'[]', 'listings/remote.json': b'[]'})
    files.update(stage.follow.files)
    assert len(files) == 26**2 + 3
    updated = replace(stage, follow=replace(stage.follow, files=files))
    ctx = prepare(captured[1]['listings'], updated, enabled=True, max_rows=100, max_bytes=200000)
    assert ctx.select(page(captured), enabled=True).follow_company.key == 'booz allen'
    files['unexpected.json'] = b'[]'
    with pytest.raises(ValueError):
        prepare(captured[1]['listings'], updated, enabled=True, max_rows=100, max_bytes=200000)


@pytest.mark.parametrize('change', ['mutated', 'other_loader'])
def test_loader_membership_must_match_captured_shards(captured, change):
    root, loaded, _ = captured
    if change == 'mutated':
        loaded['listings'][0]['keys'].discard('MA')
        loaded['listings'][0]['keys'].add('CA')
    else:
        index_path = root / 'data/listings/index.json'
        index = json.loads(index_path.read_bytes())
        index['files']['CA'] = index['files'].pop('MA')
        index['files']['CA']['file'] = 'listings/CA.json'
        (root / 'data/listings/CA.json').write_bytes((root / 'data/listings/MA.json').read_bytes())
        index_path.write_bytes(raw(index))
        other = source.load(str(root))
        assert {k: v for k, v in other['listings'][0].items() if k != 'keys'} == {
            k: v for k, v in loaded['listings'][0].items() if k != 'keys'
        }
        loaded['listings'][0] = other['listings'][0]
    with pytest.raises(ValueError):
        selection(captured)


def test_first_preview_cannot_supply_missing_shard_membership(captured):
    stage = captured[2]
    updated = replace(
        stage, follow=replace(stage.follow, files={'first.json': stage.follow.files['first.json']})
    )
    with pytest.raises(ValueError):
        prepare(captured[1]['listings'][:1], updated, enabled=True, max_rows=100, max_bytes=200000)


@pytest.mark.parametrize('name', ['Acme Café', 'Acme ' + 'é' * 110])
def test_canada_metro_membership_and_inherited_multibyte_label_bound(captured, name):
    root = captured[0]
    _, _, options = sample()
    selected = {
        path: (root / 'data' / path).read_bytes()
        for path in ('listings/index.json', 'majors.json', 'listings/MA.json', 'listings/ON.json')
    }
    metro = next(iter(source.CA_METRO_PAGES))
    for path in ('listings/MA.json', 'listings/ON.json'):
        rows = json.loads(selected[path])
        for row in rows:
            row['company_name'] = name
            row['regions'] = [
                {'loc': 'Toronto, ON', 'state': 'ON', 'kind': 'canada', 'metro': metro}
            ]
        selected[path] = raw(rows)
    first = raw([json.loads(selected['listings/MA.json'])[0]])
    stage = stage_paired_annotations(selected, first, **repin(selected, first, options))
    assert name in dict(json.loads(stage.follow.catalog.payload)['aliases'])
    for path, data in selected.items():
        (root / 'data' / path).write_bytes(data)
    loaded = source.load(str(root))
    current = (root, loaded, stage)
    ctx = selection(current)
    assert loaded['listings'][0]['keys'] == {'MA', 'ON', 'Canada', metro}
    value = replace(page(current), name=name, spellings=[name])
    if len(name.encode('utf-8')) > 200:
        # Existing #575 renderer is stricter than the catalog's UTF-16 display bound.
        with pytest.raises(ValueError):
            ctx.select(value, enabled=True)
    else:
        assert ctx.select(value, enabled=True).follow_company.key == source.employer_key(name)
