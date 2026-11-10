"""Audit must surface defects instead of hiding them through its own deduplication."""
import json

import pytest

from internscout.listing_audit import audit, read_corpus


def role(id, url, **extra):
    return {"id": id, "apply_url": url, "status": "open", "field_tags": ["swe"], **extra}


def test_shard_repetition_is_removed_but_changed_url_for_same_id_is_kept(tmp_path):
    shards = tmp_path / "listings"
    shards.mkdir()
    first = role("a", "https://employer.example/jobs/1")
    changed = role("a", "https://employer.example/jobs/2")
    for name, content in {"MA.json": [first], "NY.json": [first, changed],
                          "MA.desc.json": {"a": "Student required"}, "index.json": {"files": {}}}.items():
        (shards / name).write_text(json.dumps(content), encoding="utf-8")
    rows, descriptions = read_corpus(tmp_path)
    result = audit(rows, descriptions, fields=["swe"])
    assert result["open_record_variants"] == 2
    assert result["unique_open_ids"] == 1
    assert result["excess_id_variants"] == 1
    assert result["samples"][0]["description_available"] is True


def test_same_url_different_ids_and_conflicting_years_are_candidates_not_auto_deleted():
    rows = [role("a", "https://jobs.example/123?source=x", years=["phd"]),
            role("b", "https://jobs.example/123?source=y", years=[]),
            role("closed", "https://jobs.example/closed", status="closed")]
    result = audit(rows, {}, fields=["swe"])
    assert result["unique_open_ids"] == 2
    assert result["canonical_groups_with_multiple_ids"] == 1
    assert result["canonical_groups_with_years_conflict"] == 1
    assert len(result["samples"]) == 2
    assert all(r["live_status"] == "not_checked" for r in result["samples"])


def test_sample_is_stable_across_input_order_and_never_repeats_multi_field_ids():
    rows = [role(str(i), f"https://jobs.example/{i}", field_tags=["swe", "civil"]) for i in range(12)]
    a = audit(rows, {}, fields=["swe", "civil"], per_field=4)
    b = audit(rows[::-1], {}, fields=["swe", "civil"], per_field=4)
    assert a["samples"] == b["samples"]
    assert len({r["id"] for r in a["samples"]}) == 8


@pytest.mark.parametrize("n", [0, 21])
def test_sampling_is_bounded(n):
    with pytest.raises(ValueError):
        audit([], {}, per_field=n)
