"""The offline correction removes proven open duplicates without editing retained facts."""
import json
from pathlib import Path
import pytest
from internscout.export_static import write_shards
from internscout.listing_audit import read_corpus
from internscout.reconcile_requisitions import reconcile

STAMP = "2026-10-24T02:25:37.291740+00:00"
URL = "https://careers-gdms.icims.com/jobs/75478/software-intern/job"


def row(identity, *, company="Example", url=URL, status="open", source=5, **extra):
    return dict(id=identity, company_name=company, title="Software Intern", apply_url=url,
        field_tags=["swe"], stage=["internship"], sector="technology", regions=[{"kind":"us", "state":"MA", "loc":"Boston, MA"}],
        state="MA", ats="icims", description="Employer facts", first_seen="2026-10-01", last_seen=STAMP,
        status=status, score_parts={"source":source}, is_new=False, **extra)


def fixture(tmp_path):
    rows = [row("closed", status="closed", source=100), row("old", company="Example Inc.", source=2.5),
        row("keep", company="Example"), row("different", url=URL.replace("75478", "75479")),
        row("generic-a", url="https://example.com/careers"), row("generic-b", url="https://example.com/careers")]
    # These rows are distinct unrecognized destinations, so title similarity cannot remove them.
    rows[-1]["title"] = "Data Intern"
    write_shards(rows, str(tmp_path), STAMP)
    stats = {"generated_at":STAMP, "total":6, "open":5, "new":0, "held":0,
        "profile":{"unchanged":"profile"}, "score_weights":{"unchanged":1}}
    (tmp_path / "stats.json").write_text(json.dumps(stats), encoding="utf-8")
    return rows


def snapshot(path):
    return {str(file.relative_to(path)): file.read_bytes() for file in path.rglob("*.json")}


def test_dry_run_and_generation_mismatch_do_not_write(tmp_path):
    fixture(tmp_path)
    before = snapshot(tmp_path)
    report = reconcile(tmp_path)
    assert report["removed_ids"] == ["old"]
    assert report["before_total"] == 6 and report["after_total"] == 5
    assert snapshot(tmp_path) == before
    with pytest.raises(ValueError, match="exact existing generated_at"):
        reconcile(tmp_path, write=True, expected_generated_at="wrong")
    assert snapshot(tmp_path) == before


def test_only_proven_open_duplicate_is_removed_and_every_retained_fact_survives(tmp_path):
    fixture(tmp_path)
    before, desc_before = read_corpus(tmp_path)
    stats_before = json.loads((tmp_path / "stats.json").read_text())
    report = reconcile(tmp_path, write=True, expected_generated_at=STAMP)
    after, desc_after = read_corpus(tmp_path)
    assert {row["id"] for row in after} == {"keep", "closed", "different", "generic-a", "generic-b"}
    assert {row["id"]: row for row in after} == {row["id"]: row for row in before if row["id"] != "old"}
    assert desc_after == {key: value for key, value in desc_before.items() if key != "old"}
    assert report["closed_unchanged"] == 1
    stats = json.loads((tmp_path / "stats.json").read_text())
    assert stats["total"] == 5 and stats["open"] == 4
    for key in ("generated_at", "profile", "score_weights"):
        assert stats[key] == stats_before[key]
    index = json.loads((tmp_path / "listings/index.json").read_text())
    assert index["generated_at"] == STAMP
    assert index["files"]["MA"]["count"] == 5 and index["files"]["MA"]["open"] == 4
    assert index["files"]["MA"]["by_field"] == {"swe":4}
    assert all(row["id"] != "old" for row in json.loads((tmp_path / "first.json").read_text()))
    written = snapshot(tmp_path)
    assert reconcile(tmp_path, write=True, expected_generated_at=STAMP)["removed_ids"] == []
    assert snapshot(tmp_path) == written


def test_inconsistent_export_counts_refuse_without_partial_writes(tmp_path):
    fixture(tmp_path)
    stats_path = tmp_path / "stats.json"
    stats = json.loads(stats_path.read_text())
    stats["total"] = 999
    stats_path.write_text(json.dumps(stats), encoding="utf-8")
    before = snapshot(tmp_path)
    with pytest.raises(ValueError, match="totals"):
        reconcile(tmp_path, write=True, expected_generated_at=STAMP)
    assert snapshot(tmp_path) == before
