"""Canadian opportunities survive country filters without moving US namesakes."""
import pytest

from internscout.region import evaluate_locations
from internscout.sources.oracle import parse_oracle
from internscout.sources.successfactors import KEYWORDS, _location, parse_successfactors
from internscout.sources.taleo import _place, parse_taleo

CO = {"name": "Acme", "ats_token": "acme", "is_quant_target": False}


@pytest.mark.parametrize("raw, expected", [
    ("Toronto, ON, CA", ["Toronto, ON, Canada"]),
    ("London, Ontario, Canada, N6A 1A1", ["London, Ontario, Canada"]),
    ("Vancouver, BC, CAN, V6B 1A1", ["Vancouver, BC, Canada"]),
    ("Dorval, Québ, CA", ["Dorval, QC, Canada"]),
    ("CA", ["Canada"]),
    ("Remote, CA", ["Remote, Canada"]),
    ("Ontario, CA, US, 91761", ["Ontario, CA"]),
    ("San Francisco, CA, USA, 94105", ["San Francisco, CA"]),
    ("Paris, FR, 75001", []),
])
def test_successfactors_explicit_countries(raw, expected):
    assert _location(raw, "", "Engineering Intern") == expected


def test_successfactors_locale_suffix_and_french_search():
    assert "stagiaire" in KEYWORDS
    # These locale-suffixed numeric job IDs are used by Teck and Bombardier.
    page = ('<a class="jobTitle-link" href="/job/Trail-Supply-Chain-Co-op-Brit/54654-en_US/">'
            'Supply Chain Co-op</a><span class="jobLocation">Trail, BC, CA</span>'
            '<a class="jobTitle-link" href="/job/Dorval-Stagiaire-Queb/15657-fr_CA/">'
            'Stagiaire, Gestion</a><span class="jobLocation">Dorval, Québ, CA</span>')
    items = parse_successfactors(page, CO)
    assert [it["locations"] for it in items] == [["Trail, BC, Canada"], ["Dorval, QC, Canada"]]
    assert items[0]["url"].endswith("/54654-en_US/")


def test_oracle_keeps_canadian_primary_and_secondary_locations():
    items, total = parse_oracle({"items": [{"TotalJobsCount": 2, "requisitionList": [
        {"Id": "1", "Title": "Engineering Intern", "PrimaryLocation": "London, Ontario",
         "PrimaryLocationCountry": "CA", "secondaryLocations": [
             {"Name": "Boston, United States", "CountryCode": "US"},
             {"Name": "Victoria, BC, Canada", "CountryCode": "CA"},
             {"Name": "London, United Kingdom", "CountryCode": "GB"}]},
        {"Id": "2", "Title": "Engineering Intern", "PrimaryLocation": "Paris, France",
         "PrimaryLocationCountry": "FR"},
    ]}]}, CO, "acme.example", "CX_1")
    assert total == 2 and len(items) == 1
    assert items[0]["locations"] == ["London, Ontario, Canada", "Boston", "Victoria, BC, Canada"]
    assert evaluate_locations(items[0]["locations"])["in_canada"]


@pytest.mark.parametrize("raw, expected", [
    ("CA-Ontario-Toronto", "Toronto, Ontario, Canada"),
    ("Canada-British Columbia-Victoria", "Victoria, British Columbia, Canada"),
    ("CA-Quebec-Saint-Laurent", "Saint-Laurent, Quebec, Canada"),
    ("CA-Ontario", "Ontario, Canada"),
    ("CA", "Canada"),
    ("US-California-Ontario", "Ontario, California"),
    ("GB-England-London", None),
])
def test_taleo_country_prefix(raw, expected):
    assert _place(raw) == expected


def test_taleo_canadian_only_posting_is_retained():
    items, _ = parse_taleo({"requisitionList": [
        {"contestNo": "1", "linkedColumn": 0, "locationsColumns": [1],
         "column": ["Engineering Intern", '["CA-Ontario-Toronto","GB-England-London"]']}
    ]}, CO, "acme", "ext")
    assert items[0]["locations"] == ["Toronto, Ontario, Canada"]
    assert evaluate_locations(items[0]["locations"])["in_canada"]
