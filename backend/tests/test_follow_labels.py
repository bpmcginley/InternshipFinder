"""Synthetic same-export/predecessor labels, with existing Worker consumer parity."""

import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from internscout.follow_catalog import build_follow_catalog
from internscout.majors import majors_export

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.follow_labels import produce_follow_labels, _label


def raw(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def row(identity, name='Fixture Labs', status='open'):
    return dict(id=identity * 16, company_name=name, status=status, field_tags=['swe'])


def fixture(rows=None, previous=None, fields=None):
    rows = [row('a')] if rows is None else rows
    # A repeated state occurrence must not alter the employer spelling vote.
    shards = {'listings/MA.json': raw(rows), 'listings/NY.json': raw(rows[:1])}
    index = {
        'files': {
            name[9:-5]: dict(
                file=name,
                count=len(json.loads(body)),
                open=sum(r['status'] == 'open' for r in json.loads(body)),
            )
            for name, body in shards.items()
        }
    }
    majors = majors_export()
    if fields is not None:
        majors['fields'] = fields
    selected = {'listings/index.json': raw(index), 'majors.json': raw(majors), **shards}
    retained = (
        {kind: frozenset() for kind in ('companies', 'fields', 'states')}
        if previous is None
        else {kind: frozenset(keys) for kind, keys in json.loads(previous[1])['valid'].items()}
    )
    bounds = dict(max_source_bytes=100000, max_source_rows=30, max_keys=100, max_bytes=20000)
    catalog = build_follow_catalog(
        selected['listings/index.json'],
        shards,
        selected['majors.json'],
        retained=retained,
        complete=True,
        **bounds,
    )
    options = dict(
        enabled=True,
        source_sha256=json.loads(catalog)['source_sha256'],
        prior_bytes=None if previous is None else previous[1],
        prior_sha256=None if previous is None else sha(previous[1]),
        genesis=previous is None,
        **bounds,
    )
    kwargs = dict(
        enabled=True,
        catalog_sha256=sha(catalog),
        stage_options=options,
        prior_label_bytes=None if previous is None else previous[2].payload,
        prior_label_sha256=None if previous is None else previous[2].labels_sha256,
        max_label_bytes=20000,
    )
    return selected, catalog, kwargs


def call(value):
    selected, catalog, kwargs = value
    return produce_follow_labels(selected, catalog, **kwargs)


def test_disabled_never_inspects_inputs():
    for enabled in (False, None, 1, 'true'):
        assert (
            produce_follow_labels(object(), object(), enabled=enabled, stage_options=object())
            is None
        )


def test_complete_same_export_labels_and_deterministic_spelling():
    value = fixture(
        [
            row('a', 'The Fixture Corporation'),
            row('b', 'Fixture'),
            row('c', 'Closed Fixture', 'closed'),
        ]
    )
    original = copy.deepcopy(value)
    result = call(value)
    labels = json.loads(result.payload)
    catalog = json.loads(value[1])
    assert list(labels) == [
        'version',
        'source_sha256',
        'catalog_sha256',
        'companies',
        'fields',
        'states',
    ]
    for kind in ('companies', 'fields', 'states'):
        assert set(dict(labels[kind])) == set(catalog['valid'][kind])
    assert labels['companies'] == [['fixture', 'Fixture']]
    assert dict(labels['fields'])['swe'] == 'Software'
    assert dict(labels['states'])['NY'] == 'New York'
    assert dict(labels['states'])['ON'] == 'Ontario'
    assert result.labels_sha256 == sha(result.payload)
    assert result.payload == call(value).payload and value == original
    assert (
        produce_follow_labels(dict(reversed(list(value[0].items()))), value[1], **value[2]).payload
        == result.payload
    )
    tied = call(fixture([row('a', 'fixture'), row('b', 'Fixture')]))
    assert json.loads(tied.payload)['companies'] == [['fixture', 'Fixture']]


def test_retained_only_labels_require_complete_pinned_lineage():
    first = fixture()
    labels = call(first)
    next_release = fixture([], previous=(first[0], first[1], labels))
    result = call(next_release)
    assert json.loads(result.payload)['companies'] == json.loads(labels.payload)['companies']
    assert json.loads(next_release[1])['signup']['companies'] == []
    for patch in (
        {'prior_label_bytes': None},
        {'prior_label_sha256': '0' * 64},
        {'prior_label_bytes': labels.payload + b' '},
    ):
        with pytest.raises(ValueError):
            produce_follow_labels(next_release[0], next_release[1], **(next_release[2] | patch))
    for patch in (
        {'prior_label_bytes': labels.payload},
        {'prior_label_sha256': labels.labels_sha256},
    ):
        with pytest.raises(ValueError):
            produce_follow_labels(first[0], first[1], **(first[2] | patch))


@pytest.mark.parametrize('kind', ['companies', 'fields', 'states'])
def test_missing_duplicate_extra_or_crossed_prior_labels_fail(kind):
    first = fixture()
    previous = call(first)
    current = fixture([], previous=(first[0], first[1], previous))
    for mutate in (
        'missing',
        'duplicate',
        'extra',
        'source',
        'catalog',
        'version',
        'control',
        'length',
    ):
        body = json.loads(previous.payload)
        if mutate == 'missing':
            body[kind] = body[kind][1:]
        elif mutate == 'duplicate':
            body[kind] = body[kind] + body[kind][:1]
        elif mutate == 'extra':
            body[kind].append(['unqualified', 'Unqualified'])
        elif mutate == 'source':
            body['source_sha256'] = '0' * 64
        elif mutate == 'catalog':
            body['catalog_sha256'] = '0' * 64
        elif mutate == 'version':
            body['version'] = True
        elif mutate == 'control':
            body[kind][0][1] = 'Wrong\nlabel'
        else:
            body[kind][0][1] = 'x' * 201
        changed = raw(body)
        with pytest.raises(ValueError):
            produce_follow_labels(
                current[0],
                current[1],
                **(current[2] | dict(prior_label_bytes=changed, prior_label_sha256=sha(changed))),
            )


def test_unknown_current_field_does_not_get_guessed_label():
    value = fixture([], fields=['unqualified_field'])
    with pytest.raises(ValueError):
        call(value)


def test_current_labels_and_byte_bounds_match_worker_utf16_limit():
    valid = fixture([row('a', 'The ' + 'x' * 184 + ' Corporation')])
    assert len(dict(json.loads(call(valid).payload)['companies'])['x' * 184]) == 200
    assert _label('\U00010400' * 100) == '\U00010400' * 100
    with pytest.raises(ValueError):
        _label('\U00010400' * 101)
    with pytest.raises(ValueError):
        call(fixture([row('a', 'The ' + 'x' * 185 + ' Corporation')]))
    value = fixture()
    result = call(value)
    assert (
        produce_follow_labels(
            value[0], value[1], **(value[2] | {'max_label_bytes': len(result.payload)})
        ).payload
        == result.payload
    )
    for bound in (0, True, len(result.payload) - 1, 2000001):
        with pytest.raises(ValueError):
            produce_follow_labels(value[0], value[1], **(value[2] | {'max_label_bytes': bound}))


def test_catalog_source_prior_and_canonical_pins_cannot_be_crossed():
    value = fixture()
    for patch in (
        {'catalog_sha256': '0' * 64},
        {'stage_options': value[2]['stage_options'] | {'source_sha256': '0' * 64}},
        {'stage_options': value[2]['stage_options'] | {'max_bytes': 1000001}},
        {'stage_options': value[2]['stage_options'] | {'max_keys': 10001}},
    ):
        with pytest.raises(ValueError):
            produce_follow_labels(value[0], value[1], **(value[2] | patch))
    for catalog in (value[1] + b' ', raw(dict(reversed(list(json.loads(value[1]).items()))))):
        with pytest.raises(ValueError):
            produce_follow_labels(
                value[0], catalog, **(value[2] | {'catalog_sha256': sha(catalog)})
            )
    for changed in (
        {key: body for key, body in value[0].items() if key != 'listings/NY.json'},
        value[0] | {'listings/MA.json': raw([row('a', 'Changed')])},
    ):
        with pytest.raises(ValueError):
            produce_follow_labels(changed, value[1], **value[2])


def test_exact_compact_bytes_and_all_labels_work_with_existing_worker_ports():
    if not shutil.which('node'):
        pytest.skip('Node consumer qualification requires Node')
    value = fixture([row('a', 'Fixture É Labs')])
    result = call(value)
    probe = r'''
import fs from 'node:fs';
import {parseFollowCatalog} from './worker/src/follow-catalog.js';
import {canonicalFollow} from './worker/src/follows.js';
import {renderFollowMail} from './worker/src/follow-mail.js';
const f=JSON.parse(fs.readFileSync(0,'utf8')), enc=new TextEncoder();
const bytes=Buffer.from(f.labels,'base64'), labels=JSON.parse(bytes.toString('utf8'));
if(!bytes.equals(Buffer.from(JSON.stringify(labels)))) throw Error('noncanonical bytes');
const catalog=await parseFollowCatalog(Buffer.from(f.catalog,'base64'), {catalogSha256:f.catalogSha,sourceSha256:f.sourceSha,maxBytes:20000,maxKeys:100,previousValid:{companies:new Set(),fields:new Set(),states:new Set()}});
const maps=Object.fromEntries(['companies','fields','states'].map(k=>{if(labels[k].length!==catalog.valid[k].size||labels[k].some(([key])=>!catalog.valid[k].has(key)))throw Error('coverage');return[k,new Map(labels[k])]}));
const token=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}.${'a'.repeat(64)}`;
const company=maps.companies.keys().next().value;
canonicalFollow({kind:'company',company},maps);
const facts={from:'Fixture <sender@example.test>',postalAddress:'1 Fixture Lane',summary:maps.companies.get(company),origins:['https://internscout.org','https://api.example.test'],links:{confirmation:`https://internscout.org/follows/action.html#purpose=confirm&token=${token(1)}`,deleteRequest:`https://internscout.org/follows/action.html#purpose=delete-request&token=fd_${token(2)}`,unsubscribe:`https://api.example.test/follows/unsubscribe?token=${token(3)}`}};
renderFollowMail('confirm',{...facts,to:'student@example.test'});
console.log(JSON.stringify({company:facts.summary,fields:maps.fields.size,states:maps.states.size}));
'''
    import base64

    payload = dict(
        labels=base64.b64encode(result.payload).decode(),
        catalog=base64.b64encode(value[1]).decode(),
        catalogSha=result.catalog_sha256,
        sourceSha=result.source_sha256,
    )
    completed = subprocess.run(
        ['node', '--input-type=module', '-e', probe],
        input=json.dumps(payload),
        text=True,
        encoding='utf-8',
        capture_output=True,
        cwd=ROOT,
        check=False,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr
    receipt = json.loads(completed.stdout)
    assert (
        receipt['company'] == 'Fixture É Labs'
        and receipt['fields'] == 66
        and receipt['states'] > 50
    )


def test_original_selected_input_is_captured_once(monkeypatch):
    from scripts import follow_labels as module

    value = fixture([row('a', 'Fixture'), row('b', 'The Fixture Corporation')])
    expected = call(value)
    actual = module.prepare_follow_catalog

    def changed(selected, **options):
        result = actual(selected, **options)
        value[0]['listings/MA.json'] = raw([row('a', 'The Fixture Corporation')])
        return result

    monkeypatch.setattr(module, 'prepare_follow_catalog', changed)
    assert call(value).payload == expected.payload
