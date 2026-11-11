"""Recruiter copy changes only the existing employer entry, not its paid-listing terms."""

import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, urlsplit

import pytest

from internscout.site import runtime as sp

PAID_PARAGRAPH = (
    '<p>Promote an eligible open role in a clearly labeled paid listing. '
    'One role costs $29 for 30 days. Payment never changes organic search rankings.</p>'
)


@pytest.mark.parametrize(
    "company,key",
    [
        ("Bose", "bose"),
        ('North & South <Research> "Hiring"', "north & south research hiring"),
        ("The Boeing Company", "boeing"),
    ],
)
def test_exact_linked_heading_preserves_public_key_one_marker_and_paid_disclosure(company, key):
    html = sp.employer_offer(company)
    root = ET.fromstring(html)
    heading = root.find("h2")
    assert len(heading) == 1 and heading[0].tag == "a" and len(heading[0]) == 0
    assert (
        heading[0].text == f"Work at {company}? See how students find your roles, and feature them."
    )
    destination = urlsplit(heading[0].get("href"))
    assert destination.path == "/employers/buy/" and not destination.fragment
    assert parse_qs(destination.query) == {"company": [key]}
    assert html.count('data-employer-entry="employer"') == 1
    assert heading[0].get("data-employer-entry") == "employer"
    assert html.count(PAID_PARAGRAPH) == 1
    assert [(a.get("href"), a.text) for a in root.findall("p/a")] == [
        ("/employers/", "See how paid listings work"),
        ("/employers/#free-help", "Board additions and corrections are free"),
    ]
    assert root.findall(".//form") == [] and root.findall(".//script") == []
