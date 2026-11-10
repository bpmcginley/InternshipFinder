"""Exact public output from real export, Pages build, feeds, widget and link audit."""

import json

from golden_build import build, differences, prepare


def test_full_build_matches_golden(tmp_path):
    work = tmp_path / "build"
    prepare(work)
    files = build(work)
    assert not (report := differences(files)), report
    # Keep fixture coverage explicit so a refresh cannot silently discard a page family.
    for path in [
        "internships/software-engineering/index.html",
        "internships/massachusetts/index.html",
        "internships/software-engineering/massachusetts/index.html",
        "internships/at/bose/index.html",
        "internships/highest-paying/index.html",
        "internships/by-the-numbers/index.html",
        "internships/new/index.html",
        "digest/index.html",
        "internships/summer-2027/open/index.html",
        "data/roles/index.json",
        "data/widget.json",
        "data/seo-posting-details.json",
        "data/page-content-dates.json",
        "data/placements.json",
    ]:
        assert path in files, path
    assert (
        len([p for p in files if p.startswith("internships/near/") and p.endswith("index.html")])
        == 501
    )
    assert any(
        p.startswith("internships/for/") and p != "internships/for/index.html" for p in files
    )
    assert any(p.endswith("feed.xml") for p in files)
    assert any(b"<!--paid-->" in data for data in files.values())
    assert json.loads(files["data/seo-posting-details.json"])["records"]
    assert json.loads(files["data/placements.json"])["placements"]
    dates = json.loads(files["data/page-content-dates.json"])["pages"]
    assert dates["/pricing/"]["lastmod"] == "2026-11-01"  # unchanged prior content
    assert dates["/about/"]["lastmod"] == "2026-11-10"  # changed prior content
    report = json.loads((work / "placements-report.json").read_text(encoding="utf-8"))
    assert report == {
        "day": "2026-11-10",
        "kept": ["p-golden-active"],
        "dropped": [{"id": "p-golden-ended", "reason": "dates"}],
    }


def test_one_character_template_change_is_detected(tmp_path):
    work = tmp_path / "mutated"
    prepare(work)
    template = work / "backend" / "internscout" / "seo_pages.py"
    source = template.read_text(encoding="utf-8")
    original = 'SLOGAN = "Built by one student, made for all students."'
    assert source.count(original) == 1
    template.write_text(
        source.replace(original, original.replace('students.', 'students!')),
        encoding="utf-8",
        newline="\n",
    )
    report = differences(build(work))
    assert "changed: internships/" in report
    assert "--- expected/" in report and "+++ actual/" in report
