"""The RSS feed beside each landing page: valid XML whatever a job board sends, newest first, and
linking straight to the employer's posting."""

import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import pytest

from internscout import feeds


def _row(i, **over):
    row = {
        "id": f"id{i}",
        "company_name": f"Company {i}",
        "title": f"Intern {i}",
        "term": "Summer 2027",
        "salary": None,
        "first_seen": f"2026-09-20T10:{i:02d}:00",
        "regions": [{"loc": f"Town {i}, MA", "kind": "x", "state": "MA"}],
        "apply_url": f"https://jobs.example.com/{i}",
        "insights": None,
    }
    row.update(over)
    return row


NOW = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)


def test_feed_is_valid_xml_even_with_hostile_titles():
    rows = [_row(1, title="<b>Intern</b> & \x0bco\x00"), _row(2, company_name='"Quotes" Inc')]
    xml = feeds.rss(
        "/internships/massachusetts/", "Internships in Massachusetts", rows, NOW, state="MA"
    )
    channel = ET.fromstring(xml).find("channel")
    assert channel.findtext("title") == "Internships in Massachusetts | InternScout"
    titles = [i.findtext("title") for i in channel.findall("item")]
    assert titles == ['"Quotes" Inc: Intern 2', "Company 1: <b>Intern</b> & co"]


def test_newest_first_capped_and_linked_to_the_employer():
    rows = [_row(i) for i in range(feeds.ITEMS + 5)]
    items = (
        ET.fromstring(feeds.rss("/internships/x/", "X internships", rows, NOW))
        .find("channel")
        .findall("item")
    )
    assert len(items) == feeds.ITEMS
    assert items[0].findtext("link") == f"https://jobs.example.com/{feeds.ITEMS + 4}"
    assert items[0].findtext("guid") == f"internscout-id{feeds.ITEMS + 4}"
    assert "https://internscout.org/internships/x/" in items[0].findtext("description")


def test_a_feed_is_written_beside_each_listing_page_and_not_the_hubs(tmp_path):
    (tmp_path / "internships" / "x").mkdir(parents=True)
    pages = [
        {"path": "/internships/x/", "h1": "X internships", "items": [_row(1)], "state": None},
        {"path": "/internships/", "h1": "Browse internships", "items": None},
    ]
    assert feeds.write_all(str(tmp_path), pages) == 1
    assert (tmp_path / "internships" / "x" / "feed.xml").exists()
    assert not (tmp_path / "internships" / "feed.xml").exists()


def test_a_feed_is_dated_by_its_data_not_the_clock(tmp_path, monkeypatch):
    # lastBuildDate came from the clock, so every deploy rewrote every feed even when nothing changed.
    from internscout import seo_pages

    monkeypatch.setattr(seo_pages, "SITE", "https://legacy.example.test")
    monkeypatch.setattr(seo_pages, "GENERATED", datetime(2026, 9, 23, 10, tzinfo=timezone.utc))
    (tmp_path / "internships" / "x").mkdir(parents=True)
    feeds.write_all(
        str(tmp_path), [{"path": "/internships/x/", "h1": "X", "items": [_row(1)], "state": None}]
    )
    xml = (tmp_path / "internships" / "x" / "feed.xml").read_text(encoding="utf-8")
    assert "<lastBuildDate>Wed, 23 Sep 2026 10:00:00 +0000</lastBuildDate>" in xml
    assert "<link>https://legacy.example.test/internships/x/</link>" in xml


@pytest.mark.parametrize("scenario", ["clock", "configured", "prior-rss"])
def test_standalone_defaults_work_with_the_legacy_facade_blocked(tmp_path, scenario):
    script = """
import json
from datetime import datetime, timezone
from importlib.abc import MetaPathFinder
from pathlib import Path
import sys

class BlockLegacy(MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "internscout.seo_pages":
            raise AssertionError("standalone feed imported the legacy facade")

sys.meta_path.insert(0, BlockLegacy())
from internscout import feeds
from internscout.site import runtime

class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 9, 23, 11, tzinfo=tz)

feeds.datetime = Clock
scenario = sys.argv[3]
configured = datetime(2026, 9, 23, 9, tzinfo=timezone.utc)
if scenario != "clock":
    runtime.GENERATED = configured
if scenario == "prior-rss":
    feeds.rss("/internships/x/", "X", [], configured)
    runtime.GENERATED = configured.replace(hour=10)
root = Path(sys.argv[1])
page = root / "internships/x"
page.mkdir(parents=True)
pages = [{"path": "/internships/x/", "h1": "X", "items": [json.loads(sys.argv[2])]}]
assert feeds.write_all(str(root), pages) == 1
xml = (page / "feed.xml").read_text(encoding="utf-8")
assert "<link>https://internscout.org/internships/x/</link>" in xml
hour = 11 if scenario == "clock" else 9
assert f"<lastBuildDate>Wed, 23 Sep 2026 {hour:02}:00:00 +0000</lastBuildDate>" in xml
assert feeds.write_all(str(root), pages, now=configured.replace(hour=12)) == 1
assert "<lastBuildDate>Wed, 23 Sep 2026 12:00:00 +0000</lastBuildDate>" in (
    page / "feed.xml"
).read_text(encoding="utf-8")
assert "internscout.seo_pages" not in sys.modules
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path), json.dumps(_row(1)), scenario],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
