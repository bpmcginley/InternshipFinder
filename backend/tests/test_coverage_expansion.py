"""Coverage losses and reporting for US/Canadian student opportunities."""
import pytest

from internscout.classify import stage_of
from internscout.coverage import geographic_report
from internscout.normalize import normalize, parse_term_from_text, parse_term_pair


@pytest.mark.parametrize("word,season", [("Hiver", "Winter"), ("Printemps", "Spring"),
                                         ("Été", "Summer"), ("Automne", "Fall")])
def test_french_internships_keep_their_actual_term(word, season):
    title = f"Stagiaire, Génie mécanique ({word} 2027)"
    assert stage_of(title) == ["internship"]
    assert parse_term_from_text(title) == (season, 2027)
    assert parse_term_pair(f"2027 {word}") == (season, 2027)
    row = normalize({"company_name": "Example", "title": title,
                     "locations": ["Dorval, QC, Canada"], "source": "successfactors",
                     "url": "https://example.com/job/1"})
    assert row is not None
    assert (row["season"], row["year"]) == (season, 2027)
    assert row["geo"]["in_canada"]


def test_french_stage_employment_type_and_english_stage_staff():
    assert stage_of("Analyste", "Stage") == ["internship"]
    assert stage_of("Stage Manager") == []
    assert stage_of("Senior Stage Technician") == []
    assert stage_of("Gestionnaire de programme") == []


def test_geography_counts_each_listing_once_per_place_and_exposes_zeroes():
    rows = [{"status": "open", "regions": [
        {"kind": "us", "state": "CA"}, {"kind": "us", "state": "CA"},
        {"kind": "canada", "state": "ON"}, {"kind": "canada", "state": None}]},
        {"status": "closed", "regions": [{"kind": "canada", "state": "ON"}]},
        {"status": "open", "state": "ME"},
        {"status": "open", "regions": [{"kind": "remote", "state": "Remote"}]}]
    report = geographic_report(rows)
    assert "| US | California (CA) | 1 |" in report
    assert "| Canada | Ontario (ON) | 1 |" in report
    assert "| Canada | Nunavut (NU) | 0 | **thin** |" in report
    assert "| US | Maine (ME) | 1 |" in report
    assert "Canada (unassigned province): 1" in report
    assert "US remote (unassigned state): 1" in report
