"""The dashboard's first-screen file (P2): docs/data/first.json, written by the export."""
import json
import os
import re
from internscout.export_static import FIRST_SCREEN_KEYS, first_screen, write_shards

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
# The same fixture tests/site/first_screen.test.mjs sorts with the dashboard's own IS.sortRows, so the
# two languages are held to one expected order.
with open(os.path.join(ROOT, "tests", "site", "fixtures", "first_screen.json"), encoding="utf-8") as f:
    FIX = json.load(f)


def test_order_matches_the_dashboards_newest_first():
    got = first_screen(FIX["rows"], n=FIX["n"])
    assert [x["id"] for x in got] == FIX["expected"]
    assert [x["id"] for x in first_screen(FIX["rows"], n=99)] == FIX["expected_all"]


def test_rows_are_the_slim_rows_the_state_files_carry():
    row = first_screen(FIX["rows"], n=1)[0]
    assert "description" not in row and "region_locations" not in row
    assert row["score_parts"] == {"source": 1}


def test_written_beside_listings_and_named_in_the_index(tmp_path):
    index = write_shards(FIX["rows"], str(tmp_path), "now")
    assert index["first"] == {"file": "first.json", "keys": FIRST_SCREEN_KEYS, "sort": "new", "rows": 7}
    rows = json.loads((tmp_path / "first.json").read_text(encoding="utf-8"))
    assert [x["id"] for x in rows] == FIX["expected_all"]
    on_disk = json.loads((tmp_path / "listings" / "index.json").read_text(encoding="utf-8"))
    assert on_disk["first"]["file"] == "first.json"
    # Each row is byte for byte the row its state file holds, so the dashboard's first copy is the right one.
    ma = json.loads((tmp_path / "listings" / "MA.json").read_text(encoding="utf-8"))
    assert next(x for x in rows if x["id"] == "a") == next(x for x in ma if x["id"] == "a")
    # Not in listings/, where every *.json but index.json is read as a state file.
    assert not (tmp_path / "listings" / "first.json").exists()


def test_first_screen_keys_are_the_dashboards_first_files():
    # docs/js/core.js FIRST_KEYS = CONFIG.baselineStates + "remote"
    html = open(os.path.join(ROOT, "docs", "index.html"), encoding="utf-8").read()
    states = json.loads(re.search(r"baselineStates: (\[[^\]]*\])", html).group(1))
    assert sorted(FIRST_SCREEN_KEYS) == sorted(states + ["remote"])
