"""Offline bounded capture, explicit continuity and exact Worker parser interoperability."""

from dataclasses import FrozenInstanceError
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from internscout.follow_catalog import build_follow_catalog
from internscout.site.follow_publication import prepare_follow_catalog
from test_follow_catalog import inputs, raw


def setup_export(tmp_path):
    index, shards, majors, options = inputs()
    root = tmp_path / "selected"
    (root / "listings").mkdir(parents=True)
    for name, data in {"listings/index.json": index, "majors.json": majors, **shards}.items():
        (root / name).write_bytes(data)
    original = build_follow_catalog(index, shards, majors, **options)
    prior = tmp_path / "prior.json"
    prior.write_bytes(original)
    args = {
        "enabled": True,
        "source_sha256": json.loads(original)["source_sha256"],
        "prior_path": prior,
        "prior_sha256": hashlib.sha256(original).hexdigest(),
        **{key: value for key, value in options.items() if key.startswith("max_")},
    }
    return root, args, original


def test_disabled_never_touches_paths():
    class Forbidden:
        def __fspath__(self):
            pytest.fail("disabled path accessed")

    for enabled in (False, None, 1, "true"):
        assert prepare_follow_catalog(Forbidden(), enabled=enabled, prior_path=Forbidden()) is None
    assert prepare_follow_catalog() is None


def test_exact_receipt_continuity_repeat_and_no_writes(tmp_path):
    root, args, original = setup_export(tmp_path)
    before = {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    result = prepare_follow_catalog(root, **args)
    assert result.payload == original
    assert result.catalog_sha256 == args["prior_sha256"] == result.prior_sha256
    assert result.source_sha256 == args["source_sha256"]
    assert prepare_follow_catalog(root, **args) == result
    with pytest.raises(FrozenInstanceError):
        result.payload = b"changed"
    assert before == {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}


def test_explicit_genesis_and_empty_current_retains_prior(tmp_path):
    root, args, original = setup_export(tmp_path)
    genesis = args | {"genesis": True, "prior_path": None, "prior_sha256": None}
    result = prepare_follow_catalog(root, **genesis)
    assert result.prior_sha256 is None
    assert "company without roles" not in json.loads(result.payload)["valid"]["companies"]
    index, shards, majors, options = inputs()
    index = raw({"files": {}})
    (root / "listings/index.json").write_bytes(index)
    value = json.loads(original)
    expected = build_follow_catalog(
        index,
        {},
        majors,
        **(options | {"retained": {k: frozenset(v) for k, v in value["valid"].items()}}),
    )
    result = prepare_follow_catalog(
        root, **(args | {"source_sha256": json.loads(expected)["source_sha256"]})
    )
    assert result.payload == expected
    assert json.loads(result.payload)["signup"]["companies"] == []
    assert json.loads(result.payload)["valid"] == value["valid"]


@pytest.mark.parametrize(
    "change",
    [
        {"source_sha256": "0" * 64},
        {"source_sha256": None},
        {"source_sha256": "A" * 64},
        {"prior_sha256": "0" * 64},
        {"prior_path": None},
        {"prior_sha256": None},
        {"genesis": True},
        {"genesis": 1},
        {"max_bytes": 0},
        {"max_keys": True},
    ],
)
def test_missing_ambiguous_or_mismatched_authority(tmp_path, change):
    root, args, _ = setup_export(tmp_path)
    with pytest.raises(ValueError):
        prepare_follow_catalog(root, **(args | change))


@pytest.mark.parametrize(
    "mutation", ["order", "duplicate", "newline", "shape", "version", "subset", "alias", "keys"]
)
def test_pinned_but_malformed_prior_rejects(tmp_path, mutation):
    root, args, original = setup_export(tmp_path)
    value = json.loads(original)
    if mutation == "order":
        value = dict(reversed(list(value.items())))
    elif mutation == "shape":
        value["unknown"] = []
    elif mutation == "version":
        value["version"] = True
    elif mutation == "subset":
        value["valid"]["companies"] = []
    elif mutation == "alias":
        value["aliases"] = []
    elif mutation == "keys":
        value["valid"]["fields"] += ["biology"]
    malformed = raw(value)
    if mutation == "duplicate":
        malformed = malformed[:-1] + b',"version":1}'
    if mutation == "newline":
        malformed += b"\n"
    args["prior_path"].write_bytes(malformed)
    args["prior_sha256"] = hashlib.sha256(malformed).hexdigest()
    with pytest.raises(ValueError):
        prepare_follow_catalog(root, **args)


@pytest.mark.parametrize(
    "mutation",
    [
        "missing",
        "path",
        "conflict",
        "duplicate",
        "utf8",
        "source_bound",
        "prior_bound",
        "directory",
    ],
)
def test_invalid_selected_inputs_and_bounded_reads(tmp_path, mutation):
    root, args, _ = setup_export(tmp_path)
    if mutation == "missing":
        (root / "listings/ON.json").unlink()
    elif mutation == "directory":
        (root / "listings/ON.json").unlink()
        (root / "listings/ON.json").mkdir()
    elif mutation == "path":
        (root / "listings/index.json").write_bytes(raw({"files": {"../escape": {}}}))
    elif mutation == "conflict":
        rows = json.loads((root / "listings/ON.json").read_bytes())
        rows[0]["company_name"] = "different public name"
        (root / "listings/ON.json").write_bytes(raw(rows))
    elif mutation == "duplicate":
        (root / "listings/index.json").write_bytes(b'{"files":{},"files":{}}')
    elif mutation == "utf8":
        (root / "majors.json").write_bytes(b'\xff')
    elif mutation == "source_bound":
        args["max_source_bytes"] = 1
    else:
        args["max_bytes"] = 1
    with pytest.raises((ValueError, OSError)):
        prepare_follow_catalog(root, **args)


def test_filesystem_link_rejected(tmp_path):
    root, args, _ = setup_export(tmp_path)
    link = tmp_path / "linked"
    try:
        link.symlink_to(root, target_is_directory=True)
    except OSError:
        pytest.skip("Creating filesystem symlinks requires platform permission")
    with pytest.raises(ValueError):
        prepare_follow_catalog(link, **args)


def test_exact_main_worker_parser_interoperability(tmp_path):
    root, args, original = setup_export(tmp_path)
    result = prepare_follow_catalog(root, **args)
    module = Path(__file__).resolve().parents[2] / "worker/src/follow-catalog.js"
    code = """
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {parseFollowCatalog} = await import(process.argv[1]);
const input=JSON.parse(readFileSync(0,'utf8'));
const previousValid=Object.fromEntries(Object.entries(input.prior.valid).map(([k,v])=>[k,new Set(v)]));
const options={maxBytes:20000,maxKeys:100,sourceSha256:input.source,
 catalogSha256:input.digest,previousValid};
const parsed=await parseFollowCatalog(Buffer.from(input.payload),options);
assert.equal(parsed.signup.fields.size,66);
assert.equal(parsed.aliases.get('The Booz Allen Hamilton Corporation'),'booz allen');
assert(parsed.valid.companies.has('company without roles'));
assert(!parsed.signup.companies.has('company without roles'));
await assert.rejects(()=>parseFollowCatalog(Buffer.from(input.payload),{...options,catalogSha256:'0'.repeat(64)}));
console.log('Strict Worker interoperability passed');
"""
    completed = subprocess.run(
        [shutil.which("node") or "node", "--input-type=module", "-e", code, module.as_uri()],
        input=raw(
            {
                "prior": json.loads(original),
                "payload": list(result.payload),
                "source": result.source_sha256,
                "digest": result.catalog_sha256,
            }
        ),
        capture_output=True,
        check=True,
    )
    assert b"interoperability passed" in completed.stdout
