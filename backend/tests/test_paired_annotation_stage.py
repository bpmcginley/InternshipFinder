"""Real pure-stage composition and adversarial receipt/fact checks, offline only."""

from dataclasses import FrozenInstanceError, replace
import json
from types import MappingProxyType

import pytest

from internscout.site import paired_annotation_stage as paired
from test_follow_company_stage import fixture, repin, raw


def sample():
    selected, first, options = fixture()
    for path in ("listings/MA.json", "listings/ON.json"):
        rows = json.loads(selected[path])
        for row in rows:
            row["apply_url"] = "https://jobs.example.test/" + row["id"]
            row["nested"] = {"flag": True, "number": 1}
        # One open row without a direct link receives Follow only.
        if path.endswith("MA.json"):
            rows[1]["apply_url"] = None
        selected[path] = raw(rows)
    first = raw([json.loads(selected["listings/MA.json"])[0]])
    return selected, first, repin(selected, first, options) | {"max_combined_bytes": 200000}


def test_default_never_inspects_and_preserves_original_bytes(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("disabled stage inspected input")

    monkeypatch.setattr(paired, "stage_follow_companies", forbidden)
    monkeypatch.setattr(paired, "stage_employer_postings", forbidden)
    for enabled in (False, None, 1, "true"):
        assert paired.stage_paired_annotations(object(), object(), enabled=enabled) is None
    selected, first, options = sample()
    originals = selected | {"first.json": first}
    result = paired.stage_paired_annotations(selected, first, **(options | {"enabled": False}))
    output = originals if result is None else originals | dict(result.files)
    assert all(output[path] is value for path, value in originals.items())


def test_both_receipts_same_original_facts_order_closed_and_repeat(monkeypatch):
    selected, first, options = sample()
    saved = dict(selected)
    calls = []
    follow_fn, employer_fn = paired.stage_follow_companies, paired.stage_employer_postings

    def follow(original, preview, **kwargs):
        assert original == selected and preview is first
        result = follow_fn(original, preview, **kwargs)
        calls.append(result)
        return result

    def employer(index, shards, preview):
        assert index is selected["listings/index.json"] and preview is first
        assert all(value is selected[path] for path, value in shards.items())
        result = employer_fn(index, shards, preview)
        calls.append(result)
        return result

    monkeypatch.setattr(paired, "stage_follow_companies", follow)
    monkeypatch.setattr(paired, "stage_employer_postings", employer)
    result = paired.stage_paired_annotations(selected, first, **options)
    assert result.follow is calls[0] and result.employer is calls[1]
    assert result.files[paired.CATALOG_PATH] is result.employer.files[paired.CATALOG_PATH]
    for path in result.follow.files:
        original = json.loads(first if path == "first.json" else selected[path])
        merged = json.loads(result.files[path])
        assert len(original) == len(merged)
        for before, after in zip(original, merged, strict=True):
            assert list(after)[: len(before)] == list(before)
            assert after.pop("employer_key", None) == result.employer.posting_keys.get(before["id"])
            assert after.pop("follow_company_key", None) == (
                "booz allen" if before["status"] == "open" else None
            )
            assert paired._facts(after) == paired._facts(before)
    assert selected == saved
    assert paired.stage_paired_annotations(selected, first, **options) == result
    with pytest.raises(TypeError):
        result.files["first.json"] = b"[]"
    with pytest.raises(FrozenInstanceError):
        result.follow = None
    size = sum(map(len, result.files.values()))
    assert (
        paired.stage_paired_annotations(selected, first, **(options | {"max_combined_bytes": size}))
        == result
    )
    with pytest.raises(ValueError):
        paired.stage_paired_annotations(
            selected, first, **(options | {"max_combined_bytes": size - 1})
        )


@pytest.mark.parametrize("pin", ["source_sha256", "catalog_sha256", "first_sha256", "prior_sha256"])
def test_independent_pin_rejection(pin):
    selected, first, options = sample()
    with pytest.raises(ValueError):
        paired.stage_paired_annotations(selected, first, **(options | {pin: "0" * 64}))


def test_employer_validation_remains_independent():
    selected, first, options = sample()
    rows = json.loads(selected["listings/MA.json"])
    rows[1]["apply_url"] = 42  # Follow identity permits this fact; employer rejects it.
    selected["listings/MA.json"] = raw(rows)
    options = repin(selected, first, options)
    paired.stage_follow_companies(
        selected, first, **{k: v for k, v in options.items() if k != "max_combined_bytes"}
    )
    with pytest.raises(ValueError):
        paired.stage_paired_annotations(selected, first, **options)


@pytest.mark.parametrize("stage", ["follow", "employer"])
@pytest.mark.parametrize(
    "damage",
    [
        "missing",
        "extra",
        "reorder",
        "truncate",
        "fact",
        "typed",
        "cross_field",
        "key",
        "missing_key",
        "wrong_key",
    ],
)
def test_partial_or_changed_stage_output_never_escapes(monkeypatch, stage, damage):
    selected, first, options = sample()
    name = "stage_follow_companies" if stage == "follow" else "stage_employer_postings"
    real = getattr(paired, name)

    def broken(*args, **kwargs):
        result = real(*args, **kwargs)
        files = dict(result.files)
        path = "listings/MA.json"
        if damage == "missing":
            del files[path]
        elif damage == "extra":
            files["unexpected.json"] = b"[]"
        else:
            rows = json.loads(files[path])
            if damage == "reorder":
                rows.reverse()
            elif damage == "truncate":
                rows.pop()
            elif damage == "fact":
                rows[0]["company_name"] = "Changed"
            elif damage == "typed":
                rows[0]["nested"]["flag"] = 1
            else:
                key = "follow_company_key" if stage == "follow" else "employer_key"
                if damage == "cross_field":
                    key = "employer_key" if stage == "follow" else "follow_company_key"
                if damage == "missing_key":
                    rows[0].pop(key)
                else:
                    rows[0][key] = "unknown" if damage in ("cross_field", "wrong_key") else None
            files[path] = raw(rows)
        return replace(result, files=MappingProxyType(files))

    monkeypatch.setattr(paired, name, broken)
    with pytest.raises(ValueError):
        paired.stage_paired_annotations(selected, first, **options)


def test_bound_before_copy_or_dependency_and_annotated_cross_feed(monkeypatch):
    selected, first, options = sample()
    result = paired.stage_paired_annotations(selected, first, **options)
    annotated = selected | {p: b for p, b in result.files.items() if p in selected}
    with pytest.raises(ValueError, match="source pin mismatch"):
        paired.stage_paired_annotations(annotated, first, **options)

    def forbidden(*args, **kwargs):
        pytest.fail("invalid snapshot reached dependency")

    monkeypatch.setattr(paired, "stage_follow_companies", forbidden)
    for invalid in (dict.fromkeys(range(26**2 + 5), b""), MappingProxyType(selected)):
        with pytest.raises(ValueError):
            paired.stage_paired_annotations(invalid, first, **options)
    for bound in (None, False, 0, -1):
        with pytest.raises(ValueError):
            paired.stage_paired_annotations(
                selected, first, **(options | {"max_combined_bytes": bound})
            )
