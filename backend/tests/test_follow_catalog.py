"""Offline synthetic catalog/source and unchanged Worker scope interoperability."""

import copy
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from internscout.follow_catalog import build_follow_catalog
from internscout.majors import majors_export


def raw(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def inputs():
    row = {
        "id": "a" * 16,
        "company_name": "The Booz Allen Hamilton Corporation",
        "status": "open",
        "field_tags": ["biology"],
    }
    second = dict(row, id="b" * 16, company_name="booz allen")
    closed = dict(row, id="c" * 16, company_name="Closed Fixture", status="closed")
    shards = {"listings/MA.json": raw([row, second, closed]), "listings/ON.json": raw([row])}
    index = {
        "files": {
            "MA": {"file": "listings/MA.json", "count": 3, "open": 2},
            "ON": {"file": "listings/ON.json", "count": 1, "open": 1},
        }
    }
    options = {
        "retained": {
            "companies": frozenset({"company without roles", "closed fixture"}),
            "fields": frozenset({"legacy_field"}),
            "states": frozenset({"MA"}),
        },
        "complete": True,
        "max_source_bytes": 100_000,
        "max_source_rows": 10,
        "max_keys": 100,
        "max_bytes": 20_000,
    }
    return raw(index), shards, raw(majors_export()), options


def build(change=None, **overrides):
    index, shards, majors, options = inputs()
    if change:
        index, shards, majors = change(index, shards, majors)
    return build_follow_catalog(index, shards, majors, **(options | overrides))


def test_aliases_retained_keys_and_exact_repeat():
    index, shards, majors, options = inputs()
    saved = copy.deepcopy((shards, options))
    result = build_follow_catalog(index, shards, majors, **options)
    assert result == build_follow_catalog(
        index, dict(reversed(list(shards.items()))), majors, **options
    )
    assert (shards, options) == saved
    value = json.loads(result)
    assert value["version"] == 1
    assert value["signup"]["companies"] == ["booz allen"]
    assert value["valid"]["companies"] == ["booz allen", "closed fixture", "company without roles"]
    assert value["aliases"] == [
        ["The Booz Allen Hamilton Corporation", "booz allen"],
        ["booz allen", "booz allen"],
    ]
    assert (
        "legacy_field" in value["valid"]["fields"]
        and "legacy_field" not in value["signup"]["fields"]
    )
    assert len(value["signup"]["fields"]) == 66
    assert not {"remote", "REMOTE", "Canada", "all"} & set(value["signup"]["states"])
    prior = {kind: frozenset(keys) for kind, keys in value["valid"].items()}
    empty = json.loads(
        build_follow_catalog(raw({"files": {}}), {}, majors, **(options | {"retained": prior}))
    )
    assert empty["signup"]["companies"] == [] and empty["aliases"] == []
    assert empty["valid"] == value["valid"]
    assert empty["source_sha256"] != value["source_sha256"]


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "extra",
        "conflict",
        "duplicate",
        "count",
        "open",
        "path",
        "field",
        "name",
        "utf8",
        "duplicate_key",
    ],
)
def test_bad_capture_rejects_all(case):
    def change(index, shards, majors):
        manifest = json.loads(index)
        rows = json.loads(shards["listings/ON.json"])
        if case == "missing":
            del shards["listings/ON.json"]
        elif case == "extra":
            shards["listings/ZZ.json"] = raw([])
        elif case == "conflict":
            rows[0]["field_tags"] = ["engineering"]
        elif case == "duplicate":
            rows += rows
            manifest["files"]["ON"].update(count=2, open=2)
        elif case in ("count", "open"):
            manifest["files"]["ON"][case] = 2
        elif case == "path":
            manifest["files"]["ON"]["file"] = "../other.json"
        elif case == "field":
            rows[0]["field_tags"] = ["unlisted_field"]
        elif case == "name":
            rows[0]["company_name"] = " \n"
        elif case == "utf8":
            return index, shards, b"\xff"
        elif case == "duplicate_key":
            return b'{"files":{},"files":{}}', shards, majors
        if case not in ("missing", "extra"):
            shards["listings/ON.json"] = raw(rows)
        return raw(manifest), shards, majors

    with pytest.raises(ValueError):
        build(change)


def test_explicit_bounds_and_attestation():
    index, shards, majors, options = inputs()
    size = len(index) + len(majors) + sum(map(len, shards.values()))
    result = build(max_source_bytes=size, max_source_rows=4)
    assert build(max_bytes=len(result)) == result
    for overrides in [
        {"max_source_bytes": size - 1},
        {"max_source_rows": 3},
        {"max_bytes": len(result) - 1},
        {"max_keys": 65},
        {"complete": False},
        {"complete": 1},
        {"retained": {}},
        {"retained": options["retained"] | {"states": frozenset({"REMOTE"})}},
    ]:
        with pytest.raises(ValueError):
            build(**overrides)
    for name in ("max_source_bytes", "max_source_rows", "max_bytes", "max_keys"):
        for invalid in (0, -1, True, 1.5, 2**53, None):
            with pytest.raises(ValueError):
                build(**{name: invalid})


def test_duplicate_unused_metadata_still_rejects():
    # Never silently normalize duplicate JSON keys, even in unused index counts.
    index, shards, majors, options = inputs()
    index = index[:-1] + b',"by_field":{"architecture":1,"architecture":1}}'
    with pytest.raises(ValueError):
        build_follow_catalog(index, shards, majors, **options)


def test_unicode_ordinal_and_unchanged_worker_scope_parity():
    # These retained public keys expose UTF-16 versus Unicode-codepoint sort differences.
    index, shards, majors, options = inputs()
    options["retained"]["companies"] |= frozenset({"\ue000", "\U00010000"})
    result = build_follow_catalog(index, shards, majors, **options)
    module = Path(__file__).resolve().parents[2] / "worker/src/follows.js"
    code = """
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {canonicalFollow} = await import(process.argv[1]);
const raw = readFileSync(0, 'utf8'), value = JSON.parse(raw);
assert.equal(JSON.stringify(value), raw);
for (const group of ['signup','valid']) for (const keys of Object.values(value[group]))
  assert.deepEqual(keys, [...new Set(keys)].sort());
const sets = group => Object.fromEntries(Object.entries(value[group]).map(([k,v]) => [k,new Set(v)]));
const signup=sets('signup'), valid=sets('valid');
assert.equal(value.signup.fields.length,66);
assert.equal(canonicalFollow({kind:'company',company:value.aliases[0][1]},signup),
  '{"kind":"company","company":"booz allen"}');
assert.throws(()=>canonicalFollow({kind:'company',company:'company without roles'},signup));
assert.equal(canonicalFollow({kind:'company',company:'company without roles'},valid),
  '{"kind":"company","company":"company without roles"}');
canonicalFollow({kind:'search',fields:value.signup.fields.slice(0,64),states:[]},signup);
assert.throws(()=>canonicalFollow({kind:'search',fields:value.signup.fields.slice(0,65),states:[]},signup));
assert.throws(()=>canonicalFollow({kind:'search',fields:[],states:['REMOTE']},signup));
assert.throws(()=>canonicalFollow({kind:'search',fields:['legacy_field'],states:[]},signup));
canonicalFollow({kind:'search',fields:['legacy_field'],states:[]},valid);
console.log('Exact synthetic format and unchanged Worker scope parity passed');
"""
    completed = subprocess.run(
        [shutil.which("node") or "node", "--input-type=module", "-e", code, module.as_uri()],
        input=result,
        capture_output=True,
        check=True,
    )
    assert b"parity passed" in completed.stdout
