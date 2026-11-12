from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from internscout.employer_catalog import build_employer_catalog

ALIAS_NAMES = [
    "The Booz Allen Hamilton Corporation",
    "booz allen",
    "Fixture Company LLC",
    "Fixture",
    "株式会社",
    "🧪" * 50,
    '"',
    "\\",
]


def build(names=ALIAS_NAMES, **overrides) -> bytes:
    return build_employer_catalog(names, **({"complete": True, "max_bytes": 8_000} | overrides))


def test_canonical_aliases_deduplicate_without_reordering_source():
    source = list(ALIAS_NAMES)
    raw = build(source)
    assert source == ALIAS_NAMES
    assert raw == build(tuple(reversed(source)))
    assert json.loads(raw) == ['"', "\\", "booz allen", "fixture", "株式会社", "🧪" * 50]
    assert raw == json.dumps(json.loads(raw), ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )


@pytest.mark.parametrize(
    "name",
    ["", "  ", "\ufeff", "x\x00", "x\x7f", "x\ud800", "\ufeff株式会社", "株式会社\ufeff", 3, None],
)
def test_invalid_input_rejects_entire_catalog(name):
    with pytest.raises(ValueError):
        build(["Fixture", name])


@pytest.mark.parametrize("flag", [False, None, 1])
def test_partial_capture_rejects_before_projection(flag):
    with pytest.raises(ValueError, match="complete"):
        build(complete=flag)


@pytest.mark.parametrize("value", [0, -1, 1.5, True, "1024", 2**53, None])
def test_invalid_byte_budgets_reject(value):
    with pytest.raises(ValueError, match="byte bound"):
        build(max_bytes=value)


def test_no_empty_or_unstructured_capture():
    for invalid in ([], (), "Fixture", {"Fixture"}, iter(["Fixture"])):
        with pytest.raises(ValueError):
            build(invalid)


def test_exact_utf8_and_serialized_byte_bounds():
    raw = build()
    assert build(max_bytes=len(raw)) == raw
    with pytest.raises(ValueError, match="byte bound"):
        build(max_bytes=len(raw) - 1)
    for text in ("x" * 200, "漢" * 66, "🧪" * 50):
        assert json.loads(build([text])) == [text]
    for text in ("x" * 201, "漢" * 67, "🧪" * 51):
        with pytest.raises(ValueError, match="Worker grammar"):
            build([text])


def test_exact_count_applies_to_unique_keys():
    names = [f"Fixture {number}" for number in range(10_000)]
    raw = build(names + names, max_bytes=200_000)
    assert len(json.loads(raw)) == 10_000
    with pytest.raises(ValueError, match="key count"):
        build(names + ["Additional Fixture"], max_bytes=200_000)


def test_optional_exact_worker_catalog_parity():
    module_path = os.environ.get("INTERN_SCOUT_EMPLOYER_CATALOG_WORKER")
    if not module_path:
        pytest.skip("Optional parity probe needs a local exact-head employer-posting-counts.js")
    script = """
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {pathToFileURL} from 'node:url';
      const {createRequestSafeEmployerPostingCatalog,isEmployerPostingKey} =
        await import(pathToFileURL(process.argv[1]).href);
      const bytes=readFileSync(0);
      const keys=JSON.parse(bytes);
      assert(keys.every(isEmployerPostingKey));
      assert.equal(isEmployerPostingKey('🧪'.repeat(51)), false);
      assert.equal(isEmployerPostingKey('株式会社\ufeff'), false);
      let loads=0;
      const load=()=>{loads++; return new Response(bytes)};
      const cache=createRequestSafeEmployerPostingCatalog({maxBytes:bytes.length,now:()=>1});
      for(const key of keys) assert.equal(await cache.has(key,load),true);
      assert.equal(await cache.has('missing synthetic employer',load),false);
      assert.equal(loads,1);
      const tooSmall=createRequestSafeEmployerPostingCatalog({maxBytes:bytes.length-1,now:()=>1});
      assert.equal(await tooSmall.has(keys[0],load),false);
      for (const invalid of [[], [keys[0],keys[0]], [keys[0], '🧪'.repeat(51)]]) {
        const strict=createRequestSafeEmployerPostingCatalog({maxBytes:10000,now:()=>1});
        assert.equal(await strict.has(keys[0],()=>new Response(JSON.stringify(invalid))),false);
      }
    """
    subprocess.run(
        ["node", "--input-type=module", "-e", script, str(Path(module_path).resolve(strict=True))],
        input=build(),
        check=True,
        timeout=20,
    )
