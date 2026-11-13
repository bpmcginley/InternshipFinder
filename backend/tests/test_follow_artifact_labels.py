"""Labels share the existing private artifact's validation and atomic promotion."""

from dataclasses import replace
from datetime import timedelta
import json

import pytest

from test_follow_artifact import (
    accepted,
    candidate,
    database,
    inventory,
    module,
    NOW,
    rebuild_archive,
    run,
    sha,
    staged_writer,
    build_follow_catalog,
    FollowSnapshotCatalog,
)


def label_options(**changes):
    return module.FollowArtifactLabels(max_label_bytes=2_000_000, **changes)


def expected(inputs):
    raw_export = {item.path: item.body for item in inputs.export_files}
    catalog, selected, options = module._catalog(inputs, raw_export, module._archive(inputs))
    return module.produce_follow_labels(
        selected,
        catalog,
        enabled=True,
        catalog_sha256=sha(catalog),
        stage_options=options,
        max_label_bytes=2_000_000,
    )


def test_disabled_does_not_inspect_labels():
    assert module.assemble_follow_artifact(labels=object()) is None


def test_paired_artifact_adds_only_exact_labels_and_receipt(candidate):
    source, inputs, output = candidate
    before = inventory(source)
    plain = run(candidate)
    assert type(plain) is module.PrivateFollowArtifact
    assert list(plain.__dataclass_fields__) == [
        'directory',
        'public_tree',
        'archive_index_sha256',
        'files',
        'references',
    ]
    paired_output = output.with_name('paired')
    receipt = run((source, inputs, paired_output), labels=label_options())
    labels = expected(inputs)
    assert inventory(paired_output) == inventory(output) | {module.LABEL_PATH: labels.payload}
    assert receipt.labels_sha256 == labels.labels_sha256
    assert receipt.files == plain.files + 1
    assert receipt.archive_index_sha256 == plain.archive_index_sha256
    assert receipt.public_tree == plain.public_tree
    assert inventory(source) == before


@pytest.mark.parametrize('name', ['follow-labels.json', 'FOLLOW-LABELS.JSON'])
def test_existing_label_alias_rejected_before_staging(candidate, monkeypatch, name):
    source, _, output = candidate
    (source / 'data' / name).write_bytes(b'pre-existing')
    monkeypatch.setattr(module.site, 'publish_follow_site', lambda *a, **k: pytest.fail('staged'))
    with pytest.raises(ValueError):
        run(candidate, labels=label_options())
    assert not output.exists()
    assert (source / 'data' / name).read_bytes() == b'pre-existing'


def test_catalog_cannot_alias_label_path(candidate, monkeypatch):
    source, inputs, output = candidate
    changed = replace(inputs, site=replace(inputs.site, catalog_path='data/FOLLOW-LABELS.JSON'))
    monkeypatch.setattr(module.site, 'publish_follow_site', lambda *a, **k: pytest.fail('staged'))
    with pytest.raises(ValueError):
        run((source, changed, output), labels=label_options())
    assert not output.exists()


def predecessor(candidate):
    source, inputs, output = candidate
    files = {item.path: item.body for item in inputs.export_files}
    retained = dict(
        companies=frozenset({'retired synthetic'}), fields=frozenset(), states=frozenset()
    )
    options = inputs.site.stage_options
    catalog = build_follow_catalog(
        inputs.publication.staged.index_bytes,
        dict(inputs.publication.staged.shards),
        files['majors.json'],
        retained=retained,
        complete=True,
        **{k: options[k] for k in ('max_source_bytes', 'max_source_rows', 'max_keys', 'max_bytes')},
    )
    valid = FollowSnapshotCatalog(
        **{k: frozenset(v) for k, v in json.loads(catalog)['valid'].items()}
    )
    labels = json.loads(expected(inputs).payload)
    labels['catalog_sha256'] = sha(catalog)
    labels['companies'].append(['retired synthetic', 'Retired Synthetic'])
    labels['companies'].sort()
    prior = json.dumps(labels, ensure_ascii=False, separators=(',', ':')).encode()
    changed = replace(
        inputs,
        site=replace(
            inputs.site,
            stage_options=options
            | dict(
                genesis=False,
                prior_bytes=catalog,
                prior_sha256=sha(catalog),
                catalog_sha256=sha(catalog),
            ),
        ),
        catalog=valid,
    )
    changed = rebuild_archive(changed, valid)
    return (source, changed, output), prior


def test_pinned_predecessor_preserves_retained_only_label(candidate):
    changed, prior = predecessor(candidate)
    receipt = run(
        changed, labels=label_options(prior_label_bytes=prior, prior_label_sha256=sha(prior))
    )
    raw = (receipt.directory / module.LABEL_PATH).read_bytes()
    assert receipt.labels_sha256 == sha(raw)
    assert ['retired synthetic', 'Retired Synthetic'] in json.loads(raw)['companies']
    catalog = json.loads((receipt.directory / changed[1].site.catalog_path).read_bytes())
    assert 'retired synthetic' not in catalog['signup']['companies']


@pytest.mark.parametrize('failure', ['missing', 'digest', 'catalog', 'retained', 'cap'])
def test_bad_predecessor_is_not_promoted(candidate, monkeypatch, failure):
    changed, prior = predecessor(candidate)
    value = json.loads(prior)
    if failure == 'catalog':
        value['catalog_sha256'] = '0' * 64
    if failure == 'retained':
        value['companies'] = [pair for pair in value['companies'] if pair[0] != 'retired synthetic']
    prior = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    options = label_options(prior_label_bytes=prior, prior_label_sha256=sha(prior))
    if failure == 'missing':
        options = label_options()
    if failure == 'digest':
        options = replace(options, prior_label_sha256='0' * 64)
    if failure == 'cap':
        options = replace(options, max_label_bytes=1)
    monkeypatch.setattr(module.site, 'publish_follow_site', lambda *a, **k: pytest.fail('staged'))
    with pytest.raises(ValueError):
        run(changed, labels=options)
    assert not changed[2].exists()


@pytest.mark.parametrize('failure', ['readback', 'audit', 'cutoff'])
def test_late_failure_leaves_no_promoted_artifact(candidate, monkeypatch, failure):
    source, inputs, output = candidate
    before = inventory(source)
    original = module.asset_versions.version_assets

    def version(root):
        original(root)
        if failure == 'readback':
            (root / module.LABEL_PATH).write_bytes(b'changed')

    monkeypatch.setattr(module.asset_versions, 'version_assets', version)
    if failure == 'audit':
        monkeypatch.setattr(module, 'audit', lambda *a: ([], ['label rejected']))
    clock = iter([NOW, NOW + timedelta(days=8)]) if failure == 'cutoff' else iter([NOW, NOW])
    with pytest.raises(ValueError):
        module.assemble_follow_artifact(
            source,
            output,
            enabled=True,
            inputs=inputs,
            labels=label_options(),
            clock=lambda: next(clock),
        )
    assert not output.exists()
    assert inventory(source) == before
    assert not list(output.parent.glob('.fa-*'))
