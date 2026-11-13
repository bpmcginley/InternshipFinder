"""Pure publication preflight over real staged models and the existing App graph planner."""

from dataclasses import FrozenInstanceError, replace
import hashlib
import json
from pathlib import Path
import re
import subprocess

import pytest

from internscout import core_graph
from internscout.site import follow_employer_publication as publication, runtime, source
from internscout.site.paired_annotation_stage import stage_paired_annotations
from test_follow_employer_selection import captured as captured, page
from test_follow_company_stage import raw, repin
from test_paired_annotation_stage import sample


ROOT = Path(__file__).resolve().parents[2]


def graph(files):
    digest = core_graph.fingerprint(files)
    return (
        f'/js/app-modules/{digest}/entry.mjs',
        {f'js/app-modules/{digest}/{name}': body for name, body in files.items()},
    ), digest


@pytest.fixture(scope='module')
def asset_fixture(tmp_path_factory):
    root = tmp_path_factory.mktemp('employer-follow-graph')
    app = root / 'js/app'
    app.mkdir(parents=True)
    for path in (ROOT / 'docs/js/app').glob('*.mjs'):
        (app / path.name).write_bytes(path.read_bytes())
    result = core_graph.plan(root, None, None, core_graph.APP)
    standalone = (ROOT / 'docs/js/follow-company.mjs').read_bytes()
    return result, standalone


@pytest.fixture
def inputs(captured, asset_fixture):
    result, standalone = asset_fixture
    return (
        captured,
        [page(captured)],
        dict(
            enabled=True,
            graph_plan=result,
            app_sha256=result[0].split('/')[3],
            standalone=standalone,
            standalone_sha256=hashlib.sha256(standalone).hexdigest(),
            max_rows=100,
            max_source_bytes=200000,
            max_models=20,
            max_model_rows=100,
            max_asset_files=100,
            max_asset_bytes=2000000,
        ),
    )


def plan(inputs, **options):
    captured, models, kwargs = inputs
    return publication.plan_employer_follow_publication(
        captured[1]['listings'], captured[2], models, **(kwargs | options)
    )


def test_disabled_never_inspects(monkeypatch):
    monkeypatch.setattr(publication, '_assets', lambda *a: pytest.fail('asset access'))
    monkeypatch.setattr(
        publication, 'prepare_follow_employer_selection', lambda *a, **k: pytest.fail('data access')
    )
    for enabled in (False, None, 1, 'true'):
        assert (
            publication.plan_employer_follow_publication(
                object(), object(), object(), enabled=enabled
            )
            is None
        )


def test_real_graph_models_and_exact_two_import_edits_without_writes(inputs, monkeypatch):
    monkeypatch.setattr(Path, 'write_bytes', lambda *a: pytest.fail('planner wrote a file'))
    result = plan(inputs)
    captured, models, kwargs = inputs
    assert result.stage is captured[2]
    assert (
        result.stage.follow is captured[2].follow and result.stage.employer is captured[2].employer
    )
    assert models[0].follow_company is None
    assert result.models[0].follow_company.key == 'booz allen'
    assert all(a is not b for a, b in zip(models[0].items, result.models[0].items, strict=True))
    body = result.assets[result.script_url[1:]]
    assert hashlib.sha256(body).hexdigest() == result.standalone_sha256
    restored = body
    for name in ('follow-form.mjs', 'follow.mjs'):
        target = f'/js/app-modules/{result.app_sha256}/{name}'.encode()
        assert body.count(target) == 1
        restored = restored.replace(target, b'./app/' + name.encode())
    assert restored == kwargs['standalone']
    assert dict(result.assets) == kwargs['graph_plan'][1] | {result.script_url[1:]: body}
    before = runtime._render_employer_page(models[0])['body']
    after = runtime._render_employer_page(result.models[0])['body']
    marker = re.compile(
        r'<section data-follow-company-key="[^"]+" data-follow-company-label="[^"]+"></section><script type="module" src="/js/follow-company.mjs"></script>'
    )
    assert len(marker.findall(after)) == 1 and marker.sub('', after) == before
    with pytest.raises(TypeError):
        result.assets['other'] = b'changed'
    with pytest.raises(FrozenInstanceError):
        result.script_url = '/other'


@pytest.mark.parametrize(
    'change', ['raw', 'query', 'fragment', 'other_pin', 'missing', 'changed', 'extra', 'helper']
)
def test_missing_mixed_or_stale_graph_rejects(inputs, change):
    kwargs = inputs[2]
    entry, assets = kwargs['graph_plan']
    assets = dict(assets)
    if change == 'raw':
        entry = '/js/app/entry.mjs'
    elif change in ('query', 'fragment'):
        entry += '?' if change == 'query' else '#'
    elif change == 'other_pin':
        kwargs['app_sha256'] = '0' * 64
    elif change == 'missing':
        assets.pop(next(path for path in assets if path.endswith('/follow.mjs')))
    elif change == 'changed':
        assets[next(iter(assets))] += b'\n'
    elif change == 'extra':
        assets[f'js/app-modules/{kwargs["app_sha256"]}/unused.mjs'] = b'export const extra = 1;'
    else:
        files = {path.rsplit('/', 1)[1]: body for path, body in assets.items()}
        files['follow-form.mjs'] = files['follow-form.mjs'].replace(
            b'export const FOLLOW_COPY =', b'const FOLLOW_COPY ='
        )
        (entry, assets), kwargs['app_sha256'] = graph(files)
    with pytest.raises(ValueError):
        plan(inputs, graph_plan=(entry, assets))


@pytest.mark.parametrize(
    'change', ['missing', 'duplicate', 'dynamic', 'entry', 'query', 'mixed', 'pin', 'utf8']
)
def test_standalone_source_requires_pinned_exact_import_contract(inputs, change):
    source = inputs[2]['standalone']
    if change == 'missing':
        source = source.replace(b'./app/follow.mjs', b'./missing.mjs')
    elif change == 'duplicate':
        source += b'\n' + publication._IMPORTS[0][0]
    elif change == 'dynamic':
        source += b'\nconst other = import("./app/entry.mjs");'
    elif change == 'entry':
        source = source.replace(b'./app/follow.mjs', b'./app/entry.mjs')
    elif change == 'query':
        source = source.replace(b'./app/follow.mjs', b'./app/follow.mjs?v=old')
    elif change == 'mixed':
        source = source.replace(
            b'./app/follow.mjs', b'/js/app-modules/' + b'0' * 64 + b'/follow.mjs'
        )
    elif change == 'utf8':
        source += b'\xff'
    digest = '0' * 64 if change == 'pin' else hashlib.sha256(source).hexdigest()
    with pytest.raises(ValueError):
        plan(inputs, standalone=source, standalone_sha256=digest)


@pytest.mark.parametrize(
    'bound',
    [
        'max_rows',
        'max_source_bytes',
        'max_models',
        'max_model_rows',
        'max_asset_files',
        'max_asset_bytes',
    ],
)
def test_invalid_explicit_bounds_and_no_partial_model_batch(inputs, bound):
    with pytest.raises(ValueError):
        plan(inputs, **{bound: True})
    with pytest.raises(ValueError):
        plan(inputs, **{bound: 0})
    if bound != 'max_models':
        with pytest.raises(ValueError):
            plan(inputs, **{bound: 1})


@pytest.mark.parametrize(
    'change', ['late_model', 'empty', 'duplicate', 'multibyte', 'membership', 'catalog_pin']
)
def test_entire_batch_rejects_without_mutating_inputs(inputs, change):
    captured, models, _ = inputs
    if change == 'late_model':
        models.append(replace(models[0], path='/internships/at/other/', name='Unknown'))
    elif change == 'empty':
        models.clear()
    elif change == 'duplicate':
        models.append(models[0])
    elif change == 'multibyte':
        models.append(replace(models[0], path='/internships/at/other/', name='Acme ' + 'é' * 110))
    elif change == 'membership':
        captured[1]['listings'][0]['keys'].add('unexpected')
    else:
        altered = replace(captured[2].follow.catalog, catalog_sha256='0' * 64)
        stage = replace(captured[2], follow=replace(captured[2].follow, catalog=altered))
        inputs = ((captured[0], captured[1], stage), models, inputs[2])
    with pytest.raises(ValueError):
        plan(inputs)
    assert all(model.follow_company is None for model in models)
    assert all('follow_company_key' not in row for row in captured[1]['listings'])


def test_native_esm_links_old_and_new_assembled_plans_without_entry_boot(inputs):
    old = plan(inputs)
    files = {path.rsplit('/', 1)[1]: body for path, body in inputs[2]['graph_plan'][1].items()}
    files['entry.mjs'] += b'\n// Synthetic second generation.\n'
    newer, digest = graph(files)
    current = plan(inputs, graph_plan=newer, app_sha256=digest)
    assert old.script_url != current.script_url
    assets = dict(old.assets) | dict(current.assets)
    script = r'''
import vm from 'node:vm';
let text = ''; for await (const chunk of process.stdin) text += chunk;
const {assets, roots} = JSON.parse(text);
for (const root of roots) {
  const context = vm.createContext({TextEncoder, URL});
  const modules = new Map();
  function load(path) {
    if (path.endsWith('/entry.mjs')) throw Error('dashboard entry booted');
    if (!Object.hasOwn(assets,path)) throw Error('missing immutable asset');
    if (!modules.has(path)) modules.set(path,new vm.SourceTextModule(assets[path],{context,identifier:path}));
    return modules.get(path);
  }
  const top=load(root);
  await top.link((specifier, owner)=>load(new URL(specifier,'https://fixture.test'+owner.identifier).pathname));
  await top.evaluate();
  if (typeof top.namespace.mountCompanyFollowPage !== 'function' || modules.size !== 3) throw Error('bad linkage');
}
console.log('two exact generations linked; no dashboard boot or network');
'''
    result = subprocess.run(
        ['node', '--experimental-vm-modules', '--input-type=module', '-e', script],
        input=json.dumps(
            {
                'assets': {'/' + path: body.decode() for path, body in assets.items()},
                'roots': [old.script_url, current.script_url],
            }
        ),
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert 'two exact generations linked' in result.stdout


def test_catalog_valid_multibyte_alias_aborts_whole_plan(inputs):
    captured, _, options = inputs
    root = captured[0]
    _, _, bounds = sample()
    selected = {
        path: (root / 'data' / path).read_bytes()
        for path in ('listings/index.json', 'majors.json', 'listings/MA.json', 'listings/ON.json')
    }
    name = 'Acme ' + 'é' * 110
    for path in ('listings/MA.json', 'listings/ON.json'):
        rows = json.loads(selected[path])
        selected[path] = raw([row | {'company_name': name} for row in rows])
    first = raw([json.loads(selected['listings/MA.json'])[0]])
    stage = stage_paired_annotations(selected, first, **repin(selected, first, bounds))
    assert name in dict(json.loads(stage.follow.catalog.payload)['aliases'])
    for path, body in selected.items():
        (root / 'data' / path).write_bytes(body)
    loaded = source.load(str(root))
    current = (root, loaded, stage)
    model = replace(page(current), name=name, spellings=[name])
    with pytest.raises(ValueError):
        plan((current, [model], options))
    assert model.follow_company is None


def test_retained_generation_cannot_replace_explicit_current_pin(inputs):
    kwargs = inputs[2]
    old_entry, old_assets = kwargs['graph_plan']
    files = {path.rsplit('/', 1)[1]: body for path, body in old_assets.items()}
    files['entry.mjs'] += b'\n// Synthetic newer generation.\n'
    (entry, assets), current = graph(files)
    assets.update(old_assets)
    assert plan(inputs, graph_plan=(entry, assets), app_sha256=current).app_sha256 == current
    with pytest.raises(ValueError):
        plan(inputs, graph_plan=(old_entry, assets), app_sha256=current)


@pytest.mark.parametrize('kind', ['comment', 'template'])
def test_import_decoy_with_honest_source_digest_rejects(inputs, kind):
    one = publication._IMPORTS[0][0]
    wrapped = b'/*\n' + one + b'\n*/' if kind == 'comment' else b'const decoy = `\n' + one + b'\n`;'
    body = inputs[2]['standalone'].replace(one, wrapped, 1)
    with pytest.raises(ValueError):
        plan(inputs, standalone=body, standalone_sha256=hashlib.sha256(body).hexdigest())


@pytest.mark.parametrize('kind', ['comment', 'template', 'after_prefix'])
def test_export_decoy_or_changed_dependency_requires_reviewed_repin(inputs, kind):
    files = {path.rsplit('/', 1)[1]: body for path, body in inputs[2]['graph_plan'][1].items()}
    original = files['follow-form.mjs'].replace(b'\r\n', b'\n')
    if kind == 'comment':
        declaration = b'export const FOLLOW_COPY ='
        body = (
            b'/*\n'
            + declaration
            + b'\n*/\n'
            + original.replace(declaration, b'const FOLLOW_COPY =')
        )
    elif kind == 'template':
        body = b'const decoy = `\nexport function followSelection(\n`;\n' + original.replace(
            b'export function followSelection(', b'function followSelection('
        )
    else:
        body = original + b'\n// Changed after every required declaration.\n'
    files['follow-form.mjs'] = body
    changed, digest = graph(files)
    with pytest.raises(ValueError):
        plan(inputs, graph_plan=changed, app_sha256=digest)


@pytest.mark.parametrize(
    'path',
    [
        '',
        'https://example.test/internships/at/fixture-labs/',
        '/internships/at/fixture-labs',
        '/internships/at/./fixture-labs/',
        '/internships/at/other/../fixture-labs/',
        '/internships/at/altera-corporation/',
        '/internships/at/fixture-labs/?x=1',
        '/internships/at/fixture-labs/#x',
        '/internships/at/' + 'x' * 81 + '/',
    ],
)
def test_noncanonical_or_redirect_model_paths_reject_before_copies(inputs, path, monkeypatch):
    captured, models, kwargs = inputs
    monkeypatch.setattr(
        publication,
        'prepare_follow_employer_selection',
        lambda *a, **k: pytest.fail('copied before path validation'),
    )
    with pytest.raises(ValueError):
        plan((captured, [models[0], replace(models[0], path=path)], kwargs))


def test_aggregate_occurrences_are_bounded_before_any_selection(inputs, monkeypatch):
    captured, models, kwargs = inputs
    many = [replace(models[0], path=f'/internships/at/model-{i}/') for i in range(20)]
    count = sum(len(model.items) for model in many)
    assert count == 160
    selected = plan((captured, many, kwargs), max_model_rows=count)
    assert sum(len(model.items) for model in selected.models) == count
    monkeypatch.setattr(
        publication,
        'prepare_follow_employer_selection',
        lambda *a, **k: pytest.fail('copied before aggregate bound'),
    )
    for bound in (10, count - 1):
        with pytest.raises(ValueError):
            plan((captured, many, kwargs), max_rows=10, max_model_rows=bound)


def test_native_esm_confirms_commented_export_is_unusable(inputs):
    original = next(
        body
        for path, body in inputs[2]['graph_plan'][1].items()
        if path.endswith('/follow-form.mjs')
    )
    declaration = b'export const FOLLOW_COPY ='
    decoy = (
        b'/*\n' + declaration + b'\n*/\n' + original.replace(declaration, b'const FOLLOW_COPY =')
    )
    script = r'''
import vm from 'node:vm';
let source = ''; for await (const chunk of process.stdin) source += chunk;
const dependency = new vm.SourceTextModule(source);
const client = new vm.SourceTextModule('import { FOLLOW_COPY } from "dependency";');
try { await client.link(() => dependency); process.exitCode = 1; }
catch (error) { if (!(error instanceof SyntaxError)) throw error; console.log('missing real export'); }
'''
    result = subprocess.run(
        ['node', '--experimental-vm-modules', '--input-type=module', '-e', script],
        input=decoy.decode(),
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0 and 'missing real export' in result.stdout, result.stderr
