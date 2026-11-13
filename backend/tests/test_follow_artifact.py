from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from pathlib import Path
import shutil
import socket

import pytest

from internscout import asset_versions, core_graph
from internscout.follow_catalog import build_follow_catalog
from internscout.follow_snapshot import build_follow_snapshot
from internscout.follow_snapshot_archive import INDEX, plan_follow_snapshot_archive
from internscout.site import follow_artifact as module
from internscout.site.follow_site_publication import FollowSiteInput, publish_follow_site
from scripts.check_site_contents import audit, read_allowlist, DEFAULT_ALLOWLIST
from scripts.follow_archive_stage import stage_follow_archive
from test_follow_archive_from_publication import accepted, BOUNDS, NOW, CATALOG, plan
from test_follow_writer_provenance import (
    BASELINE,
    database,
    observe_seed,
    seed,
    raw,
    pipeline,
    export_static,
)
from test_ingest_data_writer import writer

ROOT = Path(__file__).resolve().parents[2]


def sha(body):
    return hashlib.sha256(body).hexdigest()


@pytest.fixture
def staged_writer(tmp_path, database):
    repo = tmp_path / 'data-repo'
    state = tmp_path / 'writer-state'
    state.mkdir()
    writer.git(tmp_path, 'init', str(repo))
    writer.git(repo, 'config', 'core.autocrlf', 'true')
    directory = repo / 'docs/data'
    capture = observe_seed(seed(directory, []))
    rows = [
        raw(name, f'{name[-2:]}-{i}')
        | {'title': f'Software Engineering Intern {i}', 'locations': [location]}
        for name, location in [('Fixture MA', 'Boston, MA'), ('Fixture NY', 'Albany, NY')]
        for i in range(10)
    ]
    pipeline.run(rows, verbose=False, follow_capture=capture)
    export_static.export(str(directory), follow_capture=capture)
    assert capture.result is not None
    return repo, state, capture.result


@pytest.fixture
def candidate(accepted, tmp_path, monkeypatch):
    # File-only Git acceptance is upstream. The assembler itself never runs Git.
    monkeypatch.setattr(socket.socket, 'connect', lambda *_: pytest.fail('network'))
    builder, receipt, repo = accepted
    bounds = replace(
        BOUNDS,
        snapshot=replace(BOUNDS.snapshot, max_roles=40, max_bytes=80000),
        max_archive_bytes=200000,
    )
    older = build_follow_snapshot(
        [],
        generated_at=NOW - timedelta(days=1),
        covers_after=NOW - timedelta(days=1, hours=1),
        complete=True,
        catalog=CATALOG,
        bounds=bounds.snapshot,
    )
    prior = plan_follow_snapshot_archive(
        {}, older, now=NOW - timedelta(days=1), bounds=bounds
    ).files
    archive_plan = plan(builder, receipt, prior, bounds=bounds, max_source_bytes=500000)
    private = tmp_path / 'private'
    private.mkdir()
    archive = stage_follow_archive(prior, archive_plan, parent=private, now=NOW, bounds=bounds)
    entries = []
    for line in (
        writer.git(repo, 'ls-tree', '-r', f'{receipt.commit}:docs/data')
        .stdout.decode()
        .splitlines()
    ):
        metadata, name = line.split('\t')
        mode, kind, identity = metadata.split()
        assert kind == 'blob'
        body = writer.git(repo, 'cat-file', 'blob', identity).stdout
        entries.append(module.ExportFile(name, mode, identity, body))
    files = {item.path: item.body for item in entries}
    source = tmp_path / 'source'
    shutil.copytree(ROOT / 'docs', source, ignore=shutil.ignore_patterns('data'))
    (source / 'CNAME').unlink(missing_ok=True)
    for name, body in files.items():
        path = source / 'data' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    limits = dict(max_source_bytes=500000, max_source_rows=100, max_keys=10000, max_bytes=1000000)
    catalog = build_follow_catalog(
        receipt.staged.index_bytes,
        dict(receipt.staged.shards),
        files['majors.json'],
        complete=True,
        retained={key: frozenset() for key in ('companies', 'fields', 'states')},
        **limits,
    )
    stage = dict(
        enabled=True,
        genesis=True,
        source_sha256=json.loads(catalog)['source_sha256'],
        catalog_sha256=sha(catalog),
        first_sha256=sha(files['first.json']),
        max_first_bytes=500000,
        max_first_rows=100,
        max_output_bytes=1000000,
        max_combined_bytes=1000000,
        **limits,
    )
    graph = core_graph.plan(source, None, None, core_graph.APP)
    standalone = (source / 'js/follow-company.mjs').read_bytes()
    site = FollowSiteInput(
        stage,
        dict(
            enabled=True,
            graph_plan=graph,
            app_sha256=graph[0].split('/')[3],
            standalone=standalone,
            standalone_sha256=sha(standalone),
            max_rows=100,
            max_source_bytes=1000000,
            max_models=100,
            max_model_rows=1000,
            max_asset_files=1000,
            max_asset_bytes=10000000,
        ),
        'data/follow-catalog.json',
        (),
        20000,
        100000000,
    )
    inputs = module.FollowArtifactInput(
        site, receipt, tuple(entries), archive, prior, NOW, BASELINE, bounds, CATALOG, 100, 500000
    )
    return source, inputs, tmp_path / 'assembled'


def run(candidate, **options):
    source, inputs, output = candidate
    return module.assemble_follow_artifact(
        source, output, enabled=True, inputs=inputs, clock=lambda: NOW, **options
    )


def inventory(root):
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob('*')
        if path.is_file()
    }


def test_disabled_does_not_inspect_any_input():
    class Poison:
        def __fspath__(self):
            pytest.fail('disabled read')

    for enabled in (False, None, 1, 'true'):
        assert (
            module.assemble_follow_artifact(
                Poison(), Poison(), enabled=enabled, inputs=Poison(), clock=Poison()
            )
            is None
        )


def test_actual_receipt_tree_and_raw_archive_match_stamped_site(candidate):
    source, inputs, output = candidate
    baseline = inventory(source)
    archive_before = inventory(inputs.archive.directory)
    expected = output.parent / 'expected-site'
    site_plan = publish_follow_site(source, expected, enabled=True, inputs=inputs.site)
    asset_versions.version_assets(expected)
    expected_files = inventory(expected)
    result = run(candidate)
    actual = inventory(output)
    assert result.directory == output and result.public_tree == inputs.publication.public_tree
    assert result.archive_index_sha256 == inputs.archive.index_sha256
    assert result.files == len(actual) and result.references > 0
    assert actual == expected_files | archive_before
    assert len(site_plan.models) == 2
    assert all(actual[name] == body for name, body in inputs.prior.items() if name != INDEX)
    assert inventory(source) == baseline
    assert inventory(inputs.archive.directory) == archive_before
    _, problems = audit(output, read_allowlist(DEFAULT_ALLOWLIST))
    assert set(problems) == {'unexpected file: ' + name for name in archive_before} | {
        'unexpected file: data/follow-catalog.json',
        'unexpected file: ' + site_plan.script_url[1:],
    }
    # A committed private result is never overwritten, even by an identical retry.
    with pytest.raises(ValueError):
        run(candidate)
    assert inventory(output) == actual


def test_full_git_tree_binds_preview_metadata_modes_and_complete_shards(candidate):
    _, inputs, _ = candidate
    records = inputs.export_files
    for name in ('first.json', 'majors.json', 'listings/index.json', 'listings/MA.json'):
        selected = next(item for item in records if item.path == name)
        changed = selected.body + b' '
        digest = hashlib.sha1(b'blob ' + str(len(changed)).encode() + b'\0' + changed).hexdigest()
        for replacement in (
            replace(selected, body=changed),
            replace(selected, body=changed, oid=digest),
            replace(selected, mode='100755'),
        ):
            altered = tuple(replacement if item.path == name else item for item in records)
            with pytest.raises(ValueError):
                module._export(replace(inputs, export_files=altered))
        with pytest.raises(ValueError):
            module._export(
                replace(inputs, export_files=tuple(item for item in records if item.path != name))
            )
    assert module._export(inputs) == {item.path: item.body for item in records}
    for altered in (
        replace(inputs, max_export_files=1),
        replace(inputs, max_export_bytes=1),
        replace(inputs, export_files=records + records[:1]),
        replace(inputs, publication=replace(inputs.publication, public_tree='0' * 40)),
    ):
        with pytest.raises(ValueError):
            module._export(altered)


def test_invalid_proof_is_rejected_before_private_stage(candidate, monkeypatch):
    source, inputs, output = candidate
    monkeypatch.setattr(
        module.site, 'publish_follow_site', lambda *_a, **_k: pytest.fail('staged invalid input')
    )
    changed = replace(inputs, publication=replace(inputs.publication, commit='invalid'))
    with pytest.raises(ValueError):
        run((source, changed, output))
    for field, value in [
        ('prior', {}),
        ('effective_lower', BASELINE - timedelta(seconds=1)),
        ('archive_at', NOW + timedelta(hours=1)),
    ]:
        with pytest.raises(ValueError):
            run((source, replace(inputs, **{field: value}), output))
    assert not output.exists()


def test_raw_source_changes_and_case_aliases_fail_without_output(candidate):
    source, inputs, output = candidate
    path = source / 'data/first.json'
    original = path.read_bytes()
    path.write_bytes(original + b' ')
    with pytest.raises(ValueError):
        run(candidate)
    path.write_bytes(original)
    alternate = path.with_name('FIRST.JSON')
    path.rename(alternate)
    with pytest.raises(ValueError):
        run(candidate)
    alternate.rename(path)
    (source / 'data/unproven.json').write_bytes(b'{}')
    with pytest.raises(ValueError):
        run(candidate)
    assert not output.exists()


def test_archive_receipt_tamper_unknown_paths_and_bounds_fail(candidate):
    source, inputs, output = candidate
    archive = inputs.archive
    first = archive.files[0]
    path = archive.directory / first.path
    original = path.read_bytes()
    path.write_bytes(original + b' ')
    with pytest.raises(ValueError):
        run(candidate)
    path.write_bytes(original)
    unknown = archive.directory / 'data/follows/extra.json'
    unknown.write_bytes(b'{}')
    with pytest.raises(ValueError):
        run(candidate)
    unknown.unlink()
    for replacement in (
        replace(archive, index_sha256='0' * 64),
        replace(archive, base_index_sha256=None),
        replace(archive, files=archive.files + archive.files[:1]),
    ):
        with pytest.raises(ValueError):
            run((source, replace(inputs, archive=replacement), output))
    assert not output.exists()


@pytest.mark.parametrize('terminal', [NOW - timedelta(milliseconds=1), NOW + timedelta(hours=1)])
def test_late_clock_failure_preserves_source_archive_and_absent_output(candidate, terminal):
    source, inputs, output = candidate
    baseline, archive = inventory(source), inventory(inputs.archive.directory)
    moments = iter((NOW, terminal))
    with pytest.raises(ValueError):
        module.assemble_follow_artifact(
            source, output, enabled=True, inputs=inputs, clock=lambda: next(moments)
        )
    assert not output.exists()
    assert inventory(source) == baseline and inventory(inputs.archive.directory) == archive
    assert not list(output.parent.glob('.fa-*'))


def test_late_private_validation_failure_and_concurrent_target_preserved(candidate, monkeypatch):
    source, inputs, output = candidate
    audit = module.audit
    monkeypatch.setattr(module, 'audit', lambda *_: ([], ['synthetic failure']))
    with pytest.raises(ValueError):
        run(candidate)
    assert not output.exists()
    monkeypatch.setattr(module, 'audit', audit)
    original = module.site._absent_rename

    def raced(staged, target):
        if target == output:
            target.mkdir()
            (target / 'sentinel').write_bytes(b'keep')
        return original(staged, target)

    monkeypatch.setattr(module.site, '_absent_rename', raced)
    with pytest.raises(OSError):
        run(candidate)
    assert inventory(output) == {'sentinel': b'keep'}
    assert not list(output.parent.glob('.fa-*'))


def test_retained_wrapper_and_graph_closure_survive_outer_assembly(candidate):
    source, inputs, output = candidate
    first = publish_follow_site(
        source, output.parent / 'first-site', enabled=True, inputs=inputs.site
    )
    for name, body in first.assets.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    entry = source / 'js/app/entry.mjs'
    entry.write_bytes(entry.read_bytes() + b'\n// Synthetic next graph\n')
    current = core_graph.plan(source, source / 'js/app-modules', None, core_graph.APP)
    graph = (
        current[0],
        {name: body for name, body in first.assets.items() if name.startswith('js/app-modules/')}
        | current[1],
    )
    old = dict(
        source=inputs.site.plan_options['standalone'],
        source_sha256=inputs.site.plan_options['standalone_sha256'],
        app_sha256=first.app_sha256,
        path=first.script_url[1:],
        body=first.assets[first.script_url[1:]],
    )
    updated = replace(
        inputs,
        site=replace(
            inputs.site,
            plan_options=inputs.site.plan_options
            | {'graph_plan': graph, 'app_sha256': graph[0].split('/')[3]},
            retained_wrappers=(old,),
        ),
    )
    before = inventory(source)
    run((source, updated, output))
    assert all((output / name).read_bytes() == body for name, body in first.assets.items())
    assert inventory(source) == before
    missing = dict(graph[1])
    del missing[f'js/app-modules/{first.app_sha256}/follow.mjs']
    broken = replace(
        updated,
        site=replace(
            updated.site,
            plan_options=updated.site.plan_options | {'graph_plan': (graph[0], missing)},
        ),
    )
    with pytest.raises(ValueError):
        run((source, broken, output.parent / 'missing-closure'))
    assert not (output.parent / 'missing-closure').exists()


def test_actual_source_namespace_and_entry_limits_precede_render(candidate, monkeypatch):
    source, inputs, output = candidate
    monkeypatch.setattr(
        module.site, 'publish_follow_site', lambda *_a, **_k: pytest.fail('rendered invalid source')
    )
    for update in (
        replace(inputs, max_export_files=1),
        replace(inputs, max_export_bytes=1),
        replace(inputs, site=replace(inputs.site, max_site_files=1)),
    ):
        with pytest.raises(ValueError):
            run((source, update, output))
    for index in range(inputs.max_export_files + 1):
        (source / 'data' / f'empty{index}').mkdir()
    with pytest.raises(ValueError):
        run(candidate)
    assert not output.exists()


def test_existing_archive_namespace_cannot_be_injected_as_raw_data(candidate):
    source, inputs, output = candidate
    raw = inputs.export_files
    injected = source / 'data/follows/index.json'
    injected.parent.mkdir()
    injected.write_bytes(b'{}')
    with pytest.raises(ValueError):
        run(candidate)
    assert not output.exists()
    assert inputs.export_files == raw and injected.read_bytes() == b'{}'


def test_final_archive_bytes_and_link_validation_are_not_optional(candidate, monkeypatch):
    source, inputs, output = candidate
    stamp = module.asset_versions.version_assets

    def corrupt(root):
        stamp(root)
        path = root / INDEX
        path.write_bytes(path.read_bytes() + b' ')

    monkeypatch.setattr(module.asset_versions, 'version_assets', corrupt)
    with pytest.raises(ValueError):
        run(candidate)
    assert not output.exists()
    monkeypatch.setattr(module.asset_versions, 'version_assets', stamp)
    monkeypatch.setattr(
        module.site_links, 'audit', lambda *_: {'problems': ['synthetic missing link']}
    )
    with pytest.raises(ValueError):
        run(candidate)
    assert not output.exists()
