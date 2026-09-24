"""growth/metrics.py: where each visit is counted as coming from."""
import importlib.util
import json
import os

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location("metrics", os.path.join(ROOT, "growth", "metrics.py"))
metrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(metrics)


def test_referrers_sort_into_search_social_and_direct():
    assert metrics.source("www.google.com") == "search"
    assert metrics.source("duckduckgo.com") == "search"
    assert metrics.source("chatgpt.com") == "search"
    assert metrics.source("bsky.app") == "social"
    assert metrics.source("old.reddit.com") == "social"
    assert metrics.source("l.instagram.com") == "social"
    assert metrics.source("") == "direct" and metrics.source(None) == "direct"
    assert metrics.source("internscout.org") == "direct"
    assert metrics.source("umass.edu") == "other"
    assert metrics.source("notgoogle.co") == "other"


def test_listings_come_from_the_exported_stats(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "stats.json").write_text(json.dumps({"open": 12823, "new": 1422, "generated_at": "x"}))
    assert metrics.listings(str(tmp_path)) == {"open": 12823, "new_7d": 1422, "generated_at": "x"}


def test_store_listing_numbers_read_from_the_page_and_absent_until_shown():
    page = ('<a href="/category/extensions/productivity">Tools</a>1,234 users</div>'
            '<span aria-label="4.5 out of 5 stars" title="4.5 out of 5 stars"></span>')
    unrated = '<span aria-label="0 out of 5 stars"></span>'
    assert metrics.store_stats(page) == {"users": 1234, "rating": 4.5}
    assert metrics.store_stats("<div>Add to Chrome</div>" + unrated) == {"users": None, "rating": None}
    # A page that isn't a listing (a consent page, new markup) is a problem to report, not "no users".
    with pytest.raises(ValueError):
        metrics.store_stats("<html>Before you continue to Google</html>")
