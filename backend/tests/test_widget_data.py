"""The embed's bounded feed must represent every field in the full open corpus."""
import json
import random
from datetime import datetime, timezone

import pytest

from internscout import widget_data as widget

NOW = datetime(2026, 10, 19, 18, tzinfo=timezone.utc)


def row(i, fields=None, **over):
    x = {"id": str(i), "status": "open", "title": f"Intern {i}", "company_name": "Example",
         "apply_url": f"https://careers.example/{i}", "field_tags": fields or ["swe"],
         "posted_at": f"2026-10-{19 - i // 50:02d}T00:00:00Z", "first_seen": "2026-10-01",
         "regions": [{"loc": "Boston, MA"}], "description": "not copied into the widget"}
    x.update(over)
    return x


def test_a_field_missing_from_the_sixty_row_dashboard_preview_is_not_empty():
    preview = [row(i) for i in range(60)]
    civil = row(100, ["civil"], posted_at="2026-10-01T00:00:00Z")
    data = widget.build(preview + [civil], NOW)
    assert not any("civil" in x["field_tags"] for x in preview)
    assert data["total"] == 61 and data["counts"]["civil"] == 1
    assert [x["id"] for x in data["rows"] if "civil" in x["field_tags"]] == ["100"]
    assert len(data["rows"]) == 13  # twelve software roles plus the older civil role
    assert "description" not in json.dumps(data)


def test_every_field_and_or_query_keeps_its_actual_newest_twelve_without_duplicates():
    rows = [row(i, ["civil"] if i % 2 else ["chemical"]) for i in range(55)]
    rows += [row(90, ["civil", "chemical"]), row(110, ["nursing"])]
    rows += [dict(rows[0])]  # a role in more than one state file
    data = widget.build(rows, NOW)
    assert data["total"] == 57
    assert len({x["id"] for x in data["rows"]}) == len(data["rows"])
    complete = sorted({x["id"]: x for x in rows}.values(), key=widget._rank, reverse=True)
    for wanted in [{"civil"}, {"chemical"}, {"nursing"}, {"civil", "chemical"}]:
        expected = [x["id"] for x in complete if wanted.intersection(x["field_tags"])][:12]
        actual = [x["id"] for x in data["rows"] if wanted.intersection(x["field_tags"])][:12]
        assert actual == expected
    assert [x["id"] for x in data["rows"][:12]] == [x["id"] for x in complete[:12]]


def test_closed_expired_or_unsafe_rows_are_not_offered_and_only_display_fields_are_exported():
    rows = [row(1, status="closed"), row(2, insights={"deadline": "2026-10-18"}),
            row(3, apply_url="javascript:alert(1)"), row(4, apply_url="https://secret@example.com/a"),
            row(5, insights={"deadline": "2026-10-19"}, profile="PRIVATE-SENTINEL", is_remote=True)]
    data = widget.build(rows, NOW)
    assert data["total"] == 1 and data["rows"][0]["id"] == "5"
    assert data["rows"][0]["location"] == "Remote"
    assert "PRIVATE-SENTINEL" not in json.dumps(data)


def test_output_is_deterministic_and_bounded_before_a_file_is_written(tmp_path, monkeypatch):
    rows = [row(i, ["civil" if i % 2 else "chemical"]) for i in range(40)]
    one = widget.build(rows, NOW)
    random.Random(10).shuffle(rows)
    assert widget.build(rows, NOW) == one
    size = widget.write(str(tmp_path), rows, NOW)
    assert size == (tmp_path / "data/widget.json").stat().st_size
    assert json.loads((tmp_path / "data/widget.json").read_text()) == one
    with pytest.raises(ValueError, match="field count"):
        widget.build([row(i, [f"field_{i}"]) for i in range(129)], NOW)
    monkeypatch.setattr(widget, "MAX_BYTES", 1)
    with pytest.raises(ValueError, match="download limit"):
        widget.write(str(tmp_path / "overflow"), rows, NOW)
    assert not (tmp_path / "overflow/data/widget.json").exists()


def test_pages_build_writes_the_feed_from_its_complete_listing_set(tmp_path, monkeypatch):
    from internscout import seo_pages, feeds

    monkeypatch.setattr(seo_pages, "build", lambda *args: {})
    monkeypatch.setattr(seo_pages, "write", lambda *args: None)
    monkeypatch.setattr(feeds, "write_all", lambda *args: None)
    monkeypatch.setattr(seo_pages, "LISTINGS", [row(1, ["civil"])])
    monkeypatch.setattr(seo_pages, "GENERATED", NOW)
    monkeypatch.setattr(seo_pages, "today_utc", lambda: "2026-10-19")
    seo_pages.main(["seo_pages", str(tmp_path)])
    feed = json.loads((tmp_path / "data/widget.json").read_text())
    assert feed["counts"] == {"civil": 1}
