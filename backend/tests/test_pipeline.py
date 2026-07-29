"""Offline end-to-end test: no network. Validates filtering, dedupe, geo, scoring."""
import os, tempfile
os.environ.setdefault("INTERNSCOUT_DB", os.path.join(tempfile.gettempdir(), "internscout_test.db"))
if os.path.exists(os.environ["INTERNSCOUT_DB"]):
    os.remove(os.environ["INTERNSCOUT_DB"])

from internscout.sources.github_lists import parse_fixture
from internscout.pipeline import run
from internscout.classify import classify, is_internship
from internscout.geo import evaluate_locations
from internscout.normalize import normalize, normalize_title, parse_term_from_text

HERE = os.path.dirname(__file__)
FIX = os.path.join(HERE, "fixtures", "sample_github.json")


def test_classify():
    assert "swe" in classify("Software Engineer Intern")
    assert "quant" in classify("Quantitative Trading Intern")
    assert classify("Marketing Intern") == ["marketing"]   # all disciplines now supported
    assert classify("Mechanical Engineering Intern") == ["mechanical"]
    assert classify("Some Unknown Widget Intern") == ["other"]  # never silently dropped
    assert is_internship("SWE Intern")
    assert not is_internship("Senior Software Engineer")


def test_term_parse():
    assert parse_term_from_text("SWE Intern Summer 2027") == ("Summer", 2027)


def test_geo():
    g = evaluate_locations(["Boston, MA"])
    assert g["within_radius"] and g["in_city"]
    g2 = evaluate_locations(["Remote in USA"])
    assert g2["is_remote"] and not g2["within_radius"]
    g3 = evaluate_locations(["San Francisco, CA"])
    assert g3["within_radius"] and g3["metro"] == "San Francisco"   # now a supported metro
    g4 = evaluate_locations(["Boise, ID"])
    assert not g4["within_radius"]                                  # outside all metros


def test_dedupe_title():
    a = normalize_title("Software Engineering Internship - Summer 2027")
    b = normalize_title("SWE Intern (Summer 2027)")
    # both reduce toward 'software engineering' vs 'swe' -> not identical, but stable
    assert "software" in a


def test_full_pipeline():
    raw = parse_fixture(FIX, source="vanshb03")
    # simulate the same Jane St role from a 2nd source for dedupe
    stats = run(raw, verbose=True)
    from internscout.db import SessionLocal
    from internscout.models import Listing
    with SessionLocal() as db:
        rows = db.query(Listing).all()
        names = sorted({r.company_name for r in rows})
        print("KEPT:", names)
        print("STATS:", stats)
        # Kept: Jane Street, HRT, Acme Cloud (remote), BioLab (marketing now supported).
        # Dropped: OldCo(2026 term), FullTimeCo(not an internship).
        assert "Jane Street" in names
        assert "HRT" in names
        assert "Acme Cloud" in names
        assert "FarCorp" in names            # SF is now a supported metro
        assert "OldCo" not in names          # wrong year
        assert "BioLab" in names             # marketing is a supported discipline now
        assert "FullTimeCo" not in names     # not an internship
        # quant + boston should outrank remote swe
        js = next(r for r in rows if r.company_name == "Jane Street")
        acme = next(r for r in rows if r.company_name == "Acme Cloud")
        assert js.relevance_score > acme.relevance_score
        # Jane Street seen from 2 sources -> deduped to 1 with 2 source links
        assert len(js.source_links) == 2  # vanshb03 + speedyapply, deduped
    print("ALL PIPELINE ASSERTIONS PASSED")


if __name__ == "__main__":
    test_classify(); test_term_parse(); test_geo(); test_dedupe_title(); test_full_pipeline()
    print("OK")
