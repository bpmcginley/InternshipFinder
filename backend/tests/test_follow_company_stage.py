"""Offline same-export catalog/row integration, without publisher or network actions."""

import hashlib
import json
from dataclasses import FrozenInstanceError

import pytest

from internscout.follow_catalog import build_follow_catalog
from internscout.site.follow_company_stage import stage_follow_companies
from test_follow_catalog import inputs, raw


def fixture():
    index, shards, majors, bounds = inputs()
    index = json.loads(index)
    first = raw([json.loads(shards["listings/MA.json"])[0]])
    index["first"] = {"file": "first.json", "rows": 1}
    selected = {"listings/index.json": raw(index), "majors.json": majors, **shards}
    catalog = build_follow_catalog(raw(index), shards, majors, **bounds)
    args = dict(
        enabled=True,
        source_sha256=json.loads(catalog)["source_sha256"],
        catalog_sha256=hashlib.sha256(catalog).hexdigest(),
        first_sha256=hashlib.sha256(first).hexdigest(),
        prior_bytes=catalog,
        prior_sha256=hashlib.sha256(catalog).hexdigest(),
        max_first_bytes=10000,
        max_first_rows=10,
        max_output_bytes=100000,
        **{k: v for k, v in bounds.items() if k.startswith("max_")},
    )
    return selected, first, args


def test_disabled_zero_inspection_and_original_publication_bytes():
    class Forbidden:
        def __iter__(self):
            pytest.fail("disabled input accessed")

    assert stage_follow_companies() is None
    for enabled in (False, None, 1, "true"):
        assert stage_follow_companies(Forbidden(), Forbidden(), enabled=enabled) is None
    selected, first, args = fixture()
    originals = selected | {"first.json": first}
    result = stage_follow_companies(selected, first, **(args | {"enabled": False}))
    staged = originals if result is None else originals | dict(result.files)
    assert staged == originals
    assert all(staged[path] is data for path, data in originals.items())


def test_real_staged_path_aliases_full_facts_default_rollback_and_immutable_receipt():
    selected, first, args = fixture()
    originals = dict(selected)
    result = stage_follow_companies(selected, first, **args)
    assert set(result.files) == {"listings/MA.json", "listings/ON.json", "first.json"}
    assert result.catalog.catalog_sha256 == args["catalog_sha256"]
    assert result.catalog.source_sha256 == args["source_sha256"]
    assert result.first_sha256 == args["first_sha256"]
    for path, data in result.files.items():
        before = json.loads(first if path == "first.json" else selected[path])
        after = json.loads(data)
        for a, b in zip(before, after, strict=True):
            if a["status"] == "open":
                assert b.pop("follow_company_key") == "booz allen"
            else:
                assert "follow_company_key" not in b
            assert b == a
    assert selected == originals
    assert stage_follow_companies(selected, first, **args) == result
    assert stage_follow_companies(selected, first, **(args | {"enabled": False})) is None
    with pytest.raises(TypeError):
        result.files["first.json"] = b"changed"
    with pytest.raises(FrozenInstanceError):
        result.first_sha256 = "changed"


@pytest.mark.parametrize(
    "mutation", ["id", "name", "closed", "extra", "type", "duplicate", "shape", "existing"]
)
def test_pinned_but_stale_or_malformed_preview_rejects(mutation):
    selected, first, args = fixture()
    rows = json.loads(first)
    if mutation == "id":
        rows[0]["id"] = "d" * 16
    elif mutation == "name":
        rows[0]["company_name"] = "booz allen"
    elif mutation == "closed":
        rows[0]["status"] = "closed"
    elif mutation == "extra":
        rows[0]["unverified"] = True
    elif mutation == "type":
        rows[0]["id"] = []
    elif mutation == "duplicate":
        rows *= 2
    elif mutation == "shape":
        rows = {}
    else:
        rows[0]["follow_company_key"] = "booz allen"
    changed = raw(rows)
    args["first_sha256"] = hashlib.sha256(changed).hexdigest()
    with pytest.raises(ValueError):
        stage_follow_companies(selected, changed, **args)


@pytest.mark.parametrize(
    "change",
    [
        {"first_sha256": "0" * 64},
        {"catalog_sha256": "0" * 64},
        {"source_sha256": "0" * 64},
        {"first_sha256": None},
        {"prior_sha256": "0" * 64},
        {"max_first_bytes": 1},
        {"max_first_rows": 0},
        {"max_output_bytes": 1},
        {"max_output_bytes": True},
        {"max_source_bytes": 1},
    ],
)
def test_pins_and_explicit_bounds_fail_closed(change):
    selected, first, args = fixture()
    with pytest.raises(ValueError):
        stage_follow_companies(selected, first, **(args | change))


@pytest.mark.parametrize("mutation", ["missing", "conflict", "unknown", "annotated", "mutable"])
def test_source_cannot_silently_reuse_stale_catalog(mutation):
    selected, first, args = fixture()
    if mutation == "missing":
        del selected["listings/ON.json"]
    elif mutation == "mutable":
        first = bytearray(first)
    else:
        rows = json.loads(selected["listings/MA.json"])
        if mutation == "annotated":
            rows[0]["follow_company_key"] = "booz allen"
        else:
            rows[0 if mutation == "conflict" else 1]["company_name"] = "Unknown Company"
        selected["listings/MA.json"] = raw(rows)
    with pytest.raises(ValueError):
        stage_follow_companies(selected, first, **args)


def repin(selected, first, args):
    prior = json.loads(args["prior_bytes"])
    shards = {p: b for p, b in selected.items() if p not in ("listings/index.json", "majors.json")}
    value = build_follow_catalog(
        selected["listings/index.json"],
        shards,
        selected["majors.json"],
        complete=True,
        retained={k: frozenset(v) for k, v in prior["valid"].items()},
        **{k: args[k] for k in ("max_source_bytes", "max_source_rows", "max_keys", "max_bytes")},
    )
    return args | {
        "source_sha256": json.loads(value)["source_sha256"],
        "catalog_sha256": hashlib.sha256(value).hexdigest(),
        "first_sha256": hashlib.sha256(first).hexdigest(),
    }


@pytest.mark.parametrize(
    "mutation", ["duplicate", "boolean_fact", "already_annotated", "preview_path"]
)
def test_independently_repinned_inputs_still_need_exact_organic_preview(mutation):
    selected, first, args = fixture()
    preview = json.loads(first)
    index = json.loads(selected["listings/index.json"])
    if mutation == "duplicate":
        preview *= 2
        index["first"]["rows"] = 2
    elif mutation == "preview_path":
        index["first"]["file"] = "other.json"
    else:
        for path in ("listings/MA.json", "listings/ON.json"):
            rows = json.loads(selected[path])
            rows[0]["fact" if mutation == "boolean_fact" else "follow_company_key"] = (
                1 if mutation == "boolean_fact" else "booz allen"
            )
            selected[path] = raw(rows)
        preview[0]["fact" if mutation == "boolean_fact" else "follow_company_key"] = (
            True if mutation == "boolean_fact" else "booz allen"
        )
    selected["listings/index.json"] = raw(index)
    first = raw(preview)
    with pytest.raises(ValueError):
        stage_follow_companies(selected, first, **repin(selected, first, args))


def test_exact_output_bound_and_empty_preview():
    selected, first, args = fixture()
    result = stage_follow_companies(selected, first, **args)
    bound = sum(len(raw) for raw in result.files.values())
    assert stage_follow_companies(selected, first, **(args | {"max_output_bytes": bound})) == result
    with pytest.raises(ValueError):
        stage_follow_companies(selected, first, **(args | {"max_output_bytes": bound - 1}))
    index = json.loads(selected["listings/index.json"])
    index["first"]["rows"] = 0
    selected["listings/index.json"] = raw(index)
    result = stage_follow_companies(selected, b"[]", **repin(selected, b"[]", args))
    assert result.files["first.json"] == b"[]"


def test_oversized_selected_rejects_before_catalog_preparation(monkeypatch):
    import internscout.site.follow_company_stage as stage

    _, first, args = fixture()
    oversized = dict.fromkeys(range(26**2 + 5), b"")
    calls = []

    def forbidden(*_args, **_kwargs):
        calls.append(True)
        pytest.fail("oversized selected reached snapshot/preparation")

    monkeypatch.setattr(stage, "prepare_follow_catalog", forbidden)
    with pytest.raises(ValueError):
        stage.stage_follow_companies(oversized, first, **args)
    assert not calls
    assert stage.stage_follow_companies(oversized, first) is None
