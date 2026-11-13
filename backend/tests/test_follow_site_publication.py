"""Offline private publication, failure isolation and retained reference closure."""

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import shutil

import pytest

from internscout import core_graph
from internscout.site import follow_site_publication as adapter, publish
from test_follow_employer_selection import captured
from test_paired_annotation_stage import sample
from test_follow_company_stage import repin
from test_employer_publication import tree

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def fixture(captured):
    root, _, stage = captured
    site = root / "input"
    site.mkdir()
    shutil.move(str(root / "data"), site / "data")
    first = json.loads(stage.files['first.json'])
    for row in first:
        row.pop('follow_company_key', None)
        row.pop('employer_key', None)
    raw = json.dumps(first).encode()
    (site / 'data/first.json').write_bytes(raw)
    selected = {
        p.relative_to(site / 'data').as_posix(): p.read_bytes()
        for p in (site / 'data').rglob('*.json')
        if p.name != 'first.json'
    }
    options = repin(selected, raw, sample()[2])
    shutil.copytree(ROOT / 'docs/js/app', site / 'js/app')
    shutil.copyfile(ROOT / 'docs/js/follow-company.mjs', site / 'js/follow-company.mjs')
    (site / 'index.html').write_text('<!doctype html><title>Fixture</title>')
    graph = core_graph.plan(site, None, None, core_graph.APP)
    standalone = (site / 'js/follow-company.mjs').read_bytes()
    inputs = adapter.FollowSiteInput(
        options,
        dict(
            enabled=True,
            graph_plan=graph,
            app_sha256=graph[0].split('/')[3],
            standalone=standalone,
            standalone_sha256=hashlib.sha256(standalone).hexdigest(),
            max_rows=100,
            max_source_bytes=200000,
            max_models=50,
            max_model_rows=200,
            max_asset_files=100,
            max_asset_bytes=2000000,
        ),
        'data/follow-catalog.json',
        (),
        5000,
        20000000,
    )
    return site, inputs


def run(fixture, output):
    site, inputs = fixture
    return adapter.publish_follow_site(site, output, enabled=True, inputs=inputs)


def test_default_no_inspection():
    for enabled in (False, None, 1, 'true'):
        assert (
            adapter.publish_follow_site(object(), object(), enabled=enabled, inputs=object())
            is None
        )


def test_real_publication_parity_and_source_rollback(fixture, tmp_path):
    site, inputs = fixture
    before = tree(site)
    baseline = tmp_path / 'baseline'
    shutil.copytree(site, baseline)
    publish.main(['publish', str(baseline)])
    output = tmp_path / 'output'
    result = run(fixture, output)
    assert tree(site) == before
    catalog = json.loads((output / inputs.catalog_path).read_bytes())
    assert catalog['source_sha256'] == inputs.stage_options['source_sha256']
    assert (output / result.script_url[1:]).read_bytes() == result.assets[result.script_url[1:]]
    for path in ('data/listings/MA.json', 'data/listings/ON.json', 'data/first.json'):
        rows = json.loads((output / path).read_bytes())
        assert [
            {k: v for k, v in row.items() if k not in ('follow_company_key', 'employer_key')}
            for row in rows
        ] == json.loads(before[path])
    page = output / 'internships/at/booz-allen/index.html'
    text = page.read_text(encoding='utf-8')
    assert result.script_url in text and 'src="/js/follow-company.mjs"' not in text
    assert 'data-follow-company-key="booz allen"' in text
    # A fresh ordinary artifact remains a rollback target; enabled publication never edits it.
    assert 'data-follow-company-key' not in (
        baseline / 'internships/at/booz-allen/index.html'
    ).read_text(encoding='utf-8')
    saved = tree(output)
    with pytest.raises(ValueError):
        run(fixture, output)
    assert tree(output) == saved


@pytest.mark.parametrize(
    'broken',
    [
        'source-pin',
        'preview-pin',
        'model-limit',
        'asset-limit',
        'site-limit',
        'graph',
        'retained-missing',
    ],
)
def test_rejection_leaves_no_artifact_or_input_change(fixture, tmp_path, broken, monkeypatch):
    site, inputs = fixture
    stage = dict(inputs.stage_options)
    plan = dict(inputs.plan_options)
    if broken == 'source-pin':
        stage['source_sha256'] = '0' * 64
    elif broken == 'preview-pin':
        stage['first_sha256'] = '0' * 64
    elif broken == 'model-limit':
        plan['max_model_rows'] = 1
    elif broken == 'asset-limit':
        plan['max_asset_bytes'] = 1
    elif broken == 'graph':
        plan['app_sha256'] = '0' * 64
    elif broken == 'retained-missing':
        p = site / 'js/follow-company-modules' / ('0' * 64 + '.mjs')
        p.parent.mkdir()
        p.write_bytes(b'unknown')
    inputs = replace(
        inputs,
        stage_options=stage,
        plan_options=plan,
        max_site_bytes=1 if broken == 'site-limit' else inputs.max_site_bytes,
    )
    before = tree(site)
    output = tmp_path / 'rejected'
    with pytest.raises(ValueError):
        run((site, inputs), output)
    assert not output.exists() and tree(site) == before
    assert not list(tmp_path.glob('.internscout-follow-*'))


def test_late_generation_failure_removes_private_staging(fixture, tmp_path, monkeypatch):
    site, _ = fixture
    before = tree(site)
    monkeypatch.setattr(
        publish, '_write_site', lambda *a, **k: (_ for _ in ()).throw(OSError('synthetic'))
    )
    with pytest.raises(OSError):
        run(fixture, tmp_path / 'failed')
    assert tree(site) == before and not (tmp_path / 'failed').exists()
    assert not list(tmp_path.glob('.internscout-follow-*'))


def test_retained_wrapper_exact_graph_closure_across_two_releases(fixture, tmp_path):
    site, inputs = fixture
    first = run(fixture, tmp_path / 'first')
    # Fresh raw source, carrying only explicit prior immutable references.
    for path, body in first.assets.items():
        target = site / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    (site / 'js/app/entry.mjs').write_bytes(
        (site / 'js/app/entry.mjs').read_bytes() + b'\n// Synthetic next release\n'
    )
    graph = core_graph.plan(site, site / 'js/app-modules', None, core_graph.APP)
    graph = (
        graph[0],
        {k: v for k, v in first.assets.items() if k.startswith('js/app-modules/')} | graph[1],
    )
    old = dict(
        source=inputs.plan_options['standalone'],
        source_sha256=inputs.plan_options['standalone_sha256'],
        app_sha256=first.app_sha256,
        path=first.script_url[1:],
        body=first.assets[first.script_url[1:]],
    )
    newer = replace(
        inputs,
        plan_options=inputs.plan_options
        | {'graph_plan': graph, 'app_sha256': graph[0].split('/')[3]},
        retained_wrappers=(old,),
    )
    incomplete = dict(graph[1])
    del incomplete[f"js/app-modules/{first.app_sha256}/follow.mjs"]
    with pytest.raises(ValueError):
        run(
            (
                site,
                replace(
                    newer, plan_options=newer.plan_options | {"graph_plan": (graph[0], incomplete)}
                ),
            ),
            tmp_path / "missing-reference",
        )
    second = run((site, newer), tmp_path / 'second')
    assert second.script_url != first.script_url
    for path, body in first.assets.items():
        assert (tmp_path / 'second' / path).read_bytes() == body
    assert (tmp_path / 'first' / first.script_url[1:]).read_bytes() == old['body']
    # Neither missing acknowledgement of a retained wrapper nor its changed bytes is accepted.
    with pytest.raises(ValueError):
        run((site, replace(newer, retained_wrappers=())), tmp_path / 'missing')
    (site / old['path']).write_bytes(old['body'] + b'changed')
    with pytest.raises(ValueError):
        run((site, newer), tmp_path / 'changed')


def test_atomic_absent_target_never_replaces_existing_empty_directory(tmp_path):
    staged = tmp_path / 'staged'
    staged.mkdir()
    (staged / 'proof').write_text('original')
    target = tmp_path / 'target'
    target.mkdir()
    with pytest.raises(OSError):
        adapter._absent_rename(staged, target)
    assert list(target.iterdir()) == [] and (staged / 'proof').read_text() == 'original'


def test_private_entry_rejects_report_sidecar_before_any_work(tmp_path):
    report = tmp_path / 'report.json'
    report.write_bytes(b'sentinel')
    with pytest.raises(ValueError, match='sidecars'):
        publish.main(
            ['publish', str(tmp_path / 'missing'), '--placements-report', str(report)],
            _follow=object(),
        )
    assert report.read_bytes() == b'sentinel'


@pytest.mark.parametrize("flag", ["--employer-postings", "--employer-posting-capture"])
def test_private_context_rejects_duplicate_stage_before_write(tmp_path, monkeypatch, flag):
    from internscout.site import employer_publication

    monkeypatch.setattr(employer_publication, "prepare", lambda *_: pytest.fail("wrote stage"))
    with pytest.raises(ValueError, match="own paired stage"):
        publish.main(
            ["publish", str(tmp_path), "--employer-postings"]
            + ([flag] if flag != "--employer-postings" else []),
            _follow=object(),
        )


def test_complete_model_rejection_precedes_artifact_write(fixture, tmp_path, monkeypatch):
    from internscout.site import catalog

    original = catalog.emit_employer_pages
    writes = []
    monkeypatch.setattr(adapter._Prepared, "write", lambda *_: writes.append(True))

    def emit(*args, **kwargs):
        original_batch = kwargs["employer_batch"]

        def late_bad_model(models):
            return original_batch(models + [object()])

        kwargs["employer_batch"] = late_bad_model
        return original(*args, **kwargs)

    monkeypatch.setattr(catalog, "emit_employer_pages", emit)
    before = tree(fixture[0])
    with pytest.raises(ValueError):
        run(fixture, tmp_path / "invalid-model")
    assert writes == [] and tree(fixture[0]) == before
    assert not (tmp_path / "invalid-model").exists()


@pytest.mark.parametrize(
    "relative",
    [
        "data/FOLLOW-CATALOG.JSON",
        "js/FOLLOW-COMPANY-MODULES/unknown.mjs",
    ],
)
def test_case_alias_owned_namespace_is_rejected(fixture, tmp_path, relative):
    site, _ = fixture
    sentinel = site / relative
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    sentinel.write_bytes(b"sentinel")
    before = tree(site)
    with pytest.raises(ValueError):
        run(fixture, tmp_path / "case-alias")
    assert tree(site) == before and sentinel.read_bytes() == b"sentinel"
    assert not (tmp_path / "case-alias").exists()


def test_directory_entries_are_bounded_before_copy(fixture, tmp_path, monkeypatch):
    site, inputs = fixture
    limit = sum(1 for _ in site.rglob("*")) + 10
    for i in range(15):
        (site / f"empty-{i}").mkdir()
    monkeypatch.setattr(adapter.shutil, "copytree", lambda *_: pytest.fail("copied unbounded tree"))
    with pytest.raises(ValueError):
        run((site, replace(inputs, max_site_files=limit)), tmp_path / "too-many-directories")
    assert not (tmp_path / "too-many-directories").exists()


@pytest.mark.parametrize("name", ["--placements", "--placements-report"])
def test_option_looking_reference_is_only_an_absolute_read(fixture, tmp_path, monkeypatch, name):
    monkeypatch.chdir(tmp_path)
    reference = tmp_path / name
    reference.write_text("<urlset/>")
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("unchanged")
    site, inputs = fixture
    original = publish.main
    seen = []

    def invoke(argv, **kwargs):
        seen.append(argv[2:])
        assert argv[2:] == [str(reference.resolve()), str(sentinel.resolve())]
        return original(argv, **kwargs)

    monkeypatch.setattr(publish, "main", invoke)
    output = tmp_path / "safe-reference"
    adapter.publish_follow_site(
        site, output, enabled=True, inputs=inputs, live_sitemap=name, live_noindex=sentinel
    )
    assert seen and sentinel.read_text() == "unchanged"
    assert not (output / "data/placements.json").exists()


def test_case_alias_of_otherwise_valid_existing_graph_rejected(fixture, tmp_path):
    site, inputs = fixture
    for name, body in inputs.plan_options["graph_plan"][1].items():
        target = site / name.replace("js/app-modules/", "js/APP-MODULES/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    before = tree(site)
    with pytest.raises(ValueError):
        run(fixture, tmp_path / "graph-alias")
    assert tree(site) == before and not (tmp_path / "graph-alias").exists()
