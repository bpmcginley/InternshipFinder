"""Offline end-to-end test: no network. Validates filtering, dedupe, geo, scoring."""
import os, tempfile
os.environ.setdefault("INTERNSCOUT_DB", os.path.join(tempfile.gettempdir(), "internscout_test.db"))
if os.path.exists(os.environ["INTERNSCOUT_DB"]):
    os.remove(os.environ["INTERNSCOUT_DB"])

from internscout.sources.github_lists import parse_fixture
from internscout.pipeline import run
from internscout.classify import classify, is_internship
from internscout.region import evaluate_locations
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


def test_a_season_with_no_year_does_not_print_the_word_none():
    # "Year-round Intern - UX Design and Research" names a season and no year, and the term came out
    # as "Year-round None". 649 listings in one export did. A season on its own is the honest answer.
    def term(title, **raw):
        return (normalize(dict({"company_name": "Acme", "title": title, "locations": ["Boston, MA"],
                                "source": "test", "employment_type": "Intern",
                                "url": "https://example.com/1"}, **raw)) or {}).get("term")
    assert term("Summer Intern - Mechanical Design") == "Summer"
    assert term("Year-round Intern - UX Design and Research") == "Year-round"
    assert term("Software Engineer Intern, Summer 2027") == "Summer 2027"
    assert term("Software Engineer Intern") is None
    # and a source that says the season is "null" has said nothing at all.
    assert term("Data Intern", season="null") is None
    assert term("Data Intern", season="null", year=2027) is None


def test_geo():
    g = evaluate_locations(["Boston, MA"])
    assert g["within_radius"] and g["in_city"]
    g2 = evaluate_locations(["Remote in USA"])
    assert g2["is_remote"] and not g2["within_radius"] and g2["in_region"]
    g3 = evaluate_locations(["San Francisco, CA"])
    assert g3["in_region"] and not g3["within_radius"] and g3["on_site"]   # nationwide, outside the baseline
    g4 = evaluate_locations(["Hoboken, NJ"])
    assert g4["within_radius"] and g4["state"] == "NJ"              # NYC metro


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
        assert "FarCorp" in names            # every US location is kept
        assert "OldCo" not in names          # wrong year
        assert "BioLab" in names             # marketing is a supported discipline now
        assert "FullTimeCo" not in names     # not an internship
        # a named place outranks a remote-only role (neutral score)
        js = next(r for r in rows if r.company_name == "Jane Street")
        acme = next(r for r in rows if r.company_name == "Acme Cloud")
        assert js.relevance_score > acme.relevance_score
        # Jane Street seen from 2 sources -> deduped to 1 with 2 source links
        assert len(js.source_links) == 2  # vanshb03 + speedyapply, deduped
        assert js.state in ("NY", "MA") and set(js.region_locations) >= {"New York, NY", "Boston, MA"}
    print("ALL PIPELINE ASSERTIONS PASSED")


if __name__ == "__main__":
    test_classify(); test_term_parse(); test_geo(); test_dedupe_title(); test_full_pipeline()
    print("OK")


def test_dead_adp_link_is_dropped():
    """ADP's recruitment.html without a cid opens a cookie banner and nothing else, forever."""
    base = dict(company_name="Mathtech", title="Web Application Developer Intern",
                locations=["Falls Church, VA"], source="google_jobs", active=True)
    adp = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html"
    assert normalize({**base, "apply_url": adp + "?jobId=565843"}) is None
    # The same posting with the tenant id our own fetcher writes is fine.
    assert normalize({**base, "apply_url": adp + "?cid=89da4960&ccId=19000101_000001&jobId=565843"})
    # And nothing else on ADP is touched.
    assert normalize({**base, "apply_url": "https://workforcenow.adp.com/jobs/apply/posting.html?client=acme"})


def test_a_run_that_reports_no_date_does_not_erase_the_one_we_have():
    # iCIMS, Rippling and BambooHR only learn a posted date on a per-job detail call, and those
    # calls are capped per board. The upsert wrote every run straight over the top, so a posting
    # that was dated on the run that fetched its detail went back to undated on the next one.
    from internscout.db import SessionLocal
    from internscout.models import Listing
    item = dict(company_name="Datewise", title="Software Engineer Intern - Summer 2027",
                locations=["Boston, MA"], source="workday", active=True,
                url="https://datewise.wd1.myworkdayjobs.com/careers/job/Boston/R9",
                apply_url="https://datewise.wd1.myworkdayjobs.com/careers/job/Boston/R9")
    run([dict(item, posted_at="2026-08-07T00:00:00+00:00")])
    run([dict(item)])
    with SessionLocal() as db:
        row = db.query(Listing).filter(Listing.company_name == "Datewise").one()
        assert row.posted_at is not None
        assert row.posted_at.date().isoformat() == "2026-08-07"


def test_freshness_counts_from_the_day_the_employer_posted_it():
    # 2,800 open listings in one export were first seen more than the whole 21-day window after
    # they were posted, and scored as new on the strength of when we happened to find them.
    from datetime import datetime, timedelta, timezone
    from internscout.score import _freshness
    now = datetime.now(timezone.utc)
    old, yday = now - timedelta(days=180), now - timedelta(days=1)
    assert _freshness(yday, old) == 0.0          # posted in March, found yesterday: not new
    assert _freshness(old, yday) > 0.9           # posted yesterday, held for months: new
    # No posting date means the age is unknown, which is not the same as new, and it can never
    # outscore a posting we know is fresh.
    assert _freshness(now, None) == 0.5
    assert _freshness(now, None) < _freshness(now, yday)
    assert _freshness(None, None) == 0.5
    # Unknown decays from there as we go on holding it, because first_seen is a floor on the age.
    assert _freshness(now - timedelta(days=14), None) < 0.5
    assert _freshness(now - timedelta(days=60), None) == 0.0
    # A naive datetime is read as UTC rather than crashing on the subtraction.
    assert _freshness(None, (now - timedelta(days=1)).replace(tzinfo=None)) > 0.9


def test_a_listing_keeps_its_id_when_the_next_run_rebuilds_the_database():
    # CI commits the exported JSON, not the db file, so every run starts on an empty table and
    # the row id a posting gets is its position in that run's insert order. Between the exports
    # of 2026-09-18 08:25 and 08:33, 8,592 of the 12,997 postings present in both changed id.
    # The student's own Applied marks are keyed on it in localStorage, so they moved too.
    from internscout.db import SessionLocal
    from internscout.models import Listing
    from internscout.export_static import _listing_dict
    from internscout.normalize import listing_id, make_dedupe_key

    item = dict(company_name="Idstable", title="Software Engineer Intern - Summer 2027",
                locations=["Boston, MA"], source="workday", active=True,
                url="https://idstable.wd1.myworkdayjobs.com/careers/job/Boston/R1",
                apply_url="https://idstable.wd1.myworkdayjobs.com/careers/job/Boston/R1")
    run([item])
    with SessionLocal() as db:
        row = db.query(Listing).filter(Listing.company_name == "Idstable").one()
        got = _listing_dict(row)["id"]
        assert got == listing_id(row.dedupe_key)
        # The row id is what it used to export, and what the next run would have changed.
        assert got != row.id and isinstance(got, str)

    # The next run reads the employer, the title and the term off the board again and rebuilds
    # the same key from them, so it recomputes the same id without having stored anything.
    assert got == listing_id(make_dedupe_key("Idstable",
                                             "Software Engineer Intern - Summer 2027",
                                             "Summer", 2027))
    # A different posting is a different id; the same one twice is not.
    assert listing_id("a|b||") != listing_id("a|c||")
    assert len(listing_id("a|b||")) == 16
