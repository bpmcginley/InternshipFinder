"""Nationwide labels, demand-gated detail calls, sharded export and the coverage report."""
import json
import os
from internscout.classify import ALL_FIELDS
from internscout.coverage import CLUSTERS, SECTOR_CLUSTER, counts, dormant, per_tag, report
from internscout.export_static import (merged_stages, shard_keys,
                                       still_student_opportunities, write_shards)
from internscout.region import evaluate_locations, maybe_in_region


def _listing(i, locs, status="open", tags=("health",), sector=None):
    ev = evaluate_locations(locs)
    return {"id": i, "regions": ev["regions"], "state": ev["state"], "status": status,
            "field_tags": list(tags), "stage": ["internship"], "sector": sector}


def test_kinds():
    kinds = lambda locs: [(g["kind"], g["state"]) for g in evaluate_locations(locs)["regions"]]
    assert kinds(["Philadelphia, PA"]) == [("us", "PA")]
    assert kinds(["Remote, TX"]) == [("remote", "TX")]
    assert kinds(["United States"]) == [("us", None)]
    assert kinds(["Chicago"]) == [("us", "IL")]
    g = evaluate_locations(["Austin, TX"])
    assert g["in_region"] and g["on_site"] and not g["within_radius"] and g["state"] == "TX"


def test_detail_calls_follow_demand(monkeypatch):
    monkeypatch.delenv("INTERNSCOUT_WANTED_STATES", raising=False)
    assert maybe_in_region("Boston, MA") and maybe_in_region("Jersey City, NJ")
    assert maybe_in_region("Remote - US") and maybe_in_region("3 Locations")
    assert not maybe_in_region("Austin, TX") and not maybe_in_region("Remote, TX")
    assert not maybe_in_region("London, UK")
    monkeypatch.setenv("INTERNSCOUT_WANTED_STATES", "tx, FL")
    assert maybe_in_region("Austin, TX") and maybe_in_region("Miami, FL")


def test_google_locations_follow_demand(monkeypatch):
    from internscout.config import google_jobs_locations, GOOGLE_JOBS_LOCATIONS
    monkeypatch.delenv("INTERNSCOUT_WANTED_STATES", raising=False)
    assert google_jobs_locations() == GOOGLE_JOBS_LOCATIONS
    monkeypatch.setenv("INTERNSCOUT_WANTED_STATES", "CA,MA")
    assert google_jobs_locations() == GOOGLE_JOBS_LOCATIONS + ["San Francisco, California"]


def test_each_listing_in_exactly_its_files(tmp_path):
    listings = [
        _listing(1, ["Boston, MA", "Austin, TX"]),
        _listing(2, ["Remote - US"]),
        _listing(3, ["Remote, TX"]),
        _listing(4, ["United States"], status="closed"),
        _listing(5, ["New York, NY; Remote"]),
    ]
    assert shard_keys(listings[0]) == {"MA", "TX"}
    assert shard_keys(listings[4]) == {"NY", "remote"}
    stale = tmp_path / "listings"
    stale.mkdir()
    (stale / "WY.json").write_text("[]")
    index = write_shards(listings, str(tmp_path), "now")
    assert set(index["files"]) == {"MA", "TX", "remote", "US", "NY"}
    assert not (stale / "WY.json").exists()
    for x in listings:
        homes = {k for k in index["files"]
                 if x["id"] in [y["id"] for y in json.loads((stale / f"{k}.json").read_text(encoding="utf-8"))]}
        assert homes == shard_keys(x), x["id"]
    assert index["files"]["TX"]["count"] == 2 and index["files"]["US"]["open"] == 0
    assert index["files"]["MA"]["by_field"] == {"health": 1}


def test_coverage():
    known = set(ALL_FIELDS)
    for name, tags in CLUSTERS.items():
        assert set(tags) <= known, (name, set(tags) - known)
    rows = [_listing(1, ["Boston, MA"]), _listing(2, ["Austin, TX"]), _listing(3, ["Remote"])]
    c = counts(rows)
    assert c["Health"] == 2
    # the same three listings, counted nationally: the Texas one stops being excluded
    assert counts(rows, baseline_only=False)["Health"] == 3

    # a listing carrying two tags of one cluster counts once for the cluster and once per tag,
    # which is the point of the breakdown: it says which of the two has nothing behind it
    both = _listing(4, ["Boston, MA"], tags=("health", "nursing"))
    assert counts(rows + [both])["Health"] == 3
    assert per_tag(rows + [both])["nursing"] == 1 and per_tag(rows + [both])["health"] == 3

    # a closed listing is not coverage, whichever way it is counted
    shut = _listing(5, ["Boston, MA"], status="closed")
    assert counts(rows + [shut])["Health"] == 2
    assert per_tag(rows + [shut], baseline_only=False)["health"] == 3

    text = report(rows, minimum=15, env=_ALL_KEYS)
    # rarest first, so the tag with nothing behind it leads and the one carrying the cluster trails
    assert "- Health: nursing 0," in text and text.rstrip().endswith("health 2")
    assert "**thin**" in text
    # nothing is thin below a bar of zero, and then there is no breakdown to print
    assert "Every cluster has at least" in report(rows, minimum=0, env=_ALL_KEYS)
def test_coverage_counts_the_employers_sector():
    # Every sector the classifier can fall back on has to land in some cluster, or listings from those
    # employers would be counted by nobody.
    assert set(SECTOR_CLUSTER.values()) <= set(CLUSTERS)
    assert SECTOR_CLUSTER["nonprofit"] == "Nonprofit & social work"
    assert SECTOR_CLUSTER["quant_finance"] == "Business"
    assert "engineering_manufacturing" not in SECTOR_CLUSTER   # absent from SECTOR_FIELDS on purpose

    # The case this exists for: a real ACLU posting is tagged by what the role is, not who it is for,
    # so on tags alone a nonprofit's whole board can count towards the nonprofit cluster zero times.
    aclu = _listing(1, ["Boston, MA"], tags=("law",), sector="nonprofit")
    c = counts([aclu])
    assert c["Nonprofit & social work"] == 1
    assert c["Government & law"] == 1, "the tag still counts too - it is a legal internship"
    assert per_tag([aclu])["nonprofit"] == 0, "and it is still not given a tag it never had"

    # A listing that matched the cluster both ways is one listing, not two.
    assert counts([_listing(2, ["Boston, MA"], tags=("nonprofit",), sector="nonprofit")])[
        "Nonprofit & social work"] == 1
    # An employer with no sector label, which is most of them, is unaffected.
    assert counts([_listing(3, ["Boston, MA"], tags=("swe",))])["Nonprofit & social work"] == 0

    # The breakdown has to account for the difference, and count only what no tag already covered.
    text = report([aclu, _listing(4, ["Boston, MA"], tags=("nonprofit",), sector="nonprofit")], minimum=15)
    assert "- Nonprofit & social work: social_work 0, nonprofit 1, plus 1 from employers in that sector" in text


def test_a_row_that_would_no_longer_be_admitted_is_not_published():
    # normalize() has refused new-grad postings for a while, but 46 of them were already in the
    # store from before it did, and an export publishes what is stored. stage_of() answers [] for
    # every one of them, which is the same answer that would have kept them out.
    from internscout.classify import stage_of
    stale = ["Software Engineer, New Grad", "2027 Early Career Software Engineer",
             "Trader Trainee (September 2027)", "Campus Police Officer",
             "Adjunct Faculty-Off-Campus Advisor", "Data Science Trainee"]
    keep = ["Software Engineer Intern", "Research Assistant - Summer 2027",
            "Manufacturing Co-op (Spring 2027)"]
    rows = [{"id": i, "title": t, "stage": stage_of(t)} for i, t in enumerate(stale + keep)]
    assert [x["title"] for x in still_student_opportunities(rows)] == keep


def test_a_stored_stage_is_added_to_and_not_trusted_alone():
    # "PhD Research Intern" was stored as an internship and nothing else, because the research rule
    # did not know the bare word yet. 25 listings in one export were research jobs a student
    # filtering for research could not find.
    assert merged_stages(["internship"], "PhD Research Intern") == ["internship", "research"]
    assert merged_stages([], "Research and Technology Co-Op") == ["co_op", "research"]
    # The stored list is the only record of what the feed said the employment type was: the whole
    # title of one Palantir posting is "Growth", and of another "Cohort 0".
    assert merged_stages(["internship"], "Growth") == ["internship"]
    assert merged_stages(["internship", "part_time"], "Data Analyst") == ["internship", "part_time"]
    # and the order is STAGES order, whichever side a stage came from.
    assert merged_stages(["research"], "Summer Intern") == ["internship", "research"]


_ALL_KEYS = {"USAJOBS_API_KEY": "k", "USAJOBS_EMAIL": "a@b.c", "SERPAPI_KEY": "k"}


def test_the_report_says_when_a_source_is_switched_off_rather_than_unseeded():
    # "Social sciences 8" reads as an instruction to go and seed more employers. It was not: the
    # two sources aimed at that cluster were built and had no key, so they contributed nothing and
    # no amount of seeding would have moved the number.
    assert dormant(_ALL_KEYS) == []
    off = dormant({"SERPAPI_KEY": "k"})
    assert len(off) == 1 and off[0].startswith("USAJOBS (USAJOBS_API_KEY and USAJOBS_EMAIL unset)")
    # Half a key is no key: USAJOBS sends the email as its User-Agent and 403s without it.
    assert len(dormant({**_ALL_KEYS, "USAJOBS_EMAIL": "  "})) == 1
    assert len(dormant({})) == 2

    rows = [_listing(1, ["Boston, MA"])]
    text = report(rows, minimum=15, env={})
    assert "Sources built but switched off" in text
    assert "USAJOBS (USAJOBS_API_KEY and USAJOBS_EMAIL unset)" in text and "SERPAPI_KEY" in text
    # It sits above the tag breakdown, because it decides whether that list is worth working from.
    assert text.index("switched off") < text.index("Tags inside them")
    assert "switched off" not in report(rows, minimum=15, env=_ALL_KEYS)

    # A healthy table says so too, rather than implying every source ran.
    assert "Switched off even so: USAJOBS" in report(rows, minimum=0, env={})
