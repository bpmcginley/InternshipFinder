"""growth/social.py: brand posts written from the data, short enough for every account."""
import importlib.util
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
_spec = importlib.util.spec_from_file_location("social", os.path.join(ROOT, "growth", "social.py"))
social = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(social)

NOW = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)


def _x(i, company, first_seen="2026-09-21T00:00:00", posted_at=None):
    return {"id": str(i), "company_name": company, "first_seen": first_seen, "posted_at": posted_at}


def test_post_fits_bluesky_and_ends_with_the_landing_page():
    items = [_x(i, "A Very Long Employer Name Incorporated %d" % i) for i in range(40)]
    text, url = social.compose("ml", items)
    assert len(text) <= social.LIMIT
    assert text.endswith(url) and url == "https://internscout.org/internships/machine-learning-ai/"
    assert text.startswith("40 new machine learning and AI internships")


def test_old_postings_a_scan_just_reached_are_not_new():
    assert social.fresh(_x(1, "A"), NOW)
    assert not social.fresh(_x(2, "A", posted_at="2024-09-01T00:00:00"), NOW)
    assert not social.fresh(_x(3, "A", first_seen="2026-09-01T00:00:00"), NOW)
