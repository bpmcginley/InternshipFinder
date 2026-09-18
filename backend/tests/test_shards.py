"""Nationwide labels, demand-gated detail calls, sharded export and the coverage report."""
import json
import os
from internscout.classify import ALL_FIELDS
from internscout.coverage import CLUSTERS, SECTOR_CLUSTER, counts, dormant, per_tag, report
from internscout.export_static import (carry_first_seen, carry_open_boards, merged_stages,
                                       shard_keys, still_student_opportunities, write_shards)
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


def test_a_listing_remembers_when_we_first_saw_it(tmp_path):
    # The database does not outlive a CI run, so first_seen was the moment of the run and is_new
    # was true for all 13,652 listings in the last export. The badge was on every card.
    from datetime import date
    shard_dir = tmp_path / "listings"
    shard_dir.mkdir()
    (shard_dir / "MA.json").write_text(json.dumps([
        {"id": "aaaa", "apply_url": "https://x/1", "first_seen": "2026-09-01T00:00:00+00:00"},
        {"id": "bbbb", "apply_url": "https://x/2", "first_seen": "2026-09-17T00:00:00+00:00"},
        {"id": "9999", "apply_url": "https://x/3", "first_seen": "2026-09-02T00:00:00+00:00"},
    ]), encoding="utf-8")
    (shard_dir / "index.json").write_text('{"files": {}}', encoding="utf-8")

    today = date(2026, 9, 18)
    listings = [
        {"id": "aaaa", "apply_url": "https://x/1", "first_seen": "2026-09-18", "is_new": True},
        {"id": "bbbb", "apply_url": "https://x/2", "first_seen": "2026-09-18", "is_new": True},
        # Same posting, but the employer edited the title, so the id moved: the URL still finds it.
        {"id": "cccc", "apply_url": "https://x/3", "first_seen": "2026-09-18", "is_new": True},
        # Genuinely first seen today.
        {"id": "dddd", "apply_url": "https://x/4", "first_seen": "2026-09-18", "is_new": True},
    ]
    assert carry_first_seen(listings, str(tmp_path), today=today) == 3
    assert listings[0]["first_seen"].startswith("2026-09-01")
    assert listings[2]["first_seen"].startswith("2026-09-02")   # matched on the URL, not the id
    assert listings[3]["first_seen"] == "2026-09-18"            # nothing to carry
    # New means first seen inside the window, so the badge stops meaning "every listing".
    assert [x["is_new"] for x in listings] == [False, True, False, True]


def test_a_first_export_has_nothing_to_carry_and_does_not_mind(tmp_path):
    listings = [{"id": "aaaa", "apply_url": "https://x/1", "first_seen": "2026-09-18"}]
    assert carry_first_seen(listings, str(tmp_path)) == 0
    assert listings[0]["is_new"] is True
    # An unreadable shard is skipped rather than failing the run.
    (tmp_path / "listings").mkdir()
    (tmp_path / "listings" / "MA.json").write_text("{not json", encoding="utf-8")
    assert carry_first_seen(listings, str(tmp_path)) == 0


def _prev(**over):
    row = {"id": "x", "apply_url": "https://x/0", "ats": "workday", "company_name": "Stryker",
           "status": "open", "first_seen": "2026-09-16T00:00:00+00:00",
           "last_seen": "2026-09-18T00:00:00+00:00", "regions": [], "state": "MA",
           "title": "Summer Intern", "stage": ["internship"]}
    row.update(over)
    return row


def _write_prev(tmp_path, rows):
    shard_dir = tmp_path / "listings"
    shard_dir.mkdir(exist_ok=True)
    (shard_dir / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    (shard_dir / "index.json").write_text('{"files": {}}', encoding="utf-8")


def test_a_board_that_did_not_answer_does_not_delete_its_jobs(tmp_path):
    # An export is only what the run managed to fetch. Between two exports on 2026-09-18, 2,341
    # open listings vanished and 71 arrived, almost all of it Workday boards that timed out.
    from datetime import date
    prev = [_prev(id=str(i), apply_url="https://x/%d" % i) for i in range(10)]
    _write_prev(tmp_path, prev)
    # The board answered with one of its ten. That is a failed fetch, not nine closures.
    listings = [dict(prev[0])]
    held = carry_open_boards(listings, str(tmp_path), today=date(2026, 9, 18))
    assert held == 9
    assert len(listings) == 10
    assert all(x["carried"] for x in listings[1:])
    assert "carried" not in listings[0]   # this one was really fetched


def test_a_board_that_merely_closed_a_job_is_left_alone(tmp_path):
    from datetime import date
    prev = [_prev(id=str(i), apply_url="https://x/%d" % i) for i in range(10)]
    _write_prev(tmp_path, prev)
    listings = [dict(r) for r in prev[:6]]   # six of ten: an employer closing jobs, not a failure
    assert carry_open_boards(listings, str(tmp_path), today=date(2026, 9, 18)) == 0
    assert len(listings) == 6


def test_rows_todays_rules_drop_are_not_carried_back(tmp_path):
    # A board whose staff jobs stopped counting as student ones is not a board that failed to
    # answer: its dropped rows are not counted, and none of them come back.
    from datetime import date
    prev = [_prev(id=str(i), apply_url="https://x/%d" % i, title="Research Scientist II",
                  stage=["research"]) for i in range(8)]
    prev += [_prev(id="i%d" % i, apply_url="https://x/i%d" % i, title="PhD Research Intern",
                   stage=["research"]) for i in range(2)]
    _write_prev(tmp_path, prev)
    listings = [dict(r) for r in prev[8:]]
    assert carry_open_boards(listings, str(tmp_path), today=date(2026, 9, 18)) == 0
    # and a genuine collapse carries only the rows that would still be admitted, restaged
    listings = []
    prev = [_prev(id=str(i), apply_url="https://x/%d" % i, title="Research Scientist II",
                  stage=["research"]) for i in range(3)]
    prev += [_prev(id="i%d" % i, apply_url="https://x/i%d" % i, title="PhD Research Intern",
                   stage=["internship"]) for i in range(4)]
    _write_prev(tmp_path, prev)
    assert carry_open_boards(listings, str(tmp_path), today=date(2026, 9, 18)) == 4
    assert all(x["title"] == "PhD Research Intern" for x in listings)
    assert all(x["stage"] == ["internship", "research"] for x in listings)


def test_a_tiny_board_is_left_alone_because_churn_looks_the_same(tmp_path):
    from datetime import date
    prev = [_prev(id=str(i), apply_url="https://x/%d" % i) for i in range(2)]
    _write_prev(tmp_path, prev)
    listings = []
    assert carry_open_boards(listings, str(tmp_path), today=date(2026, 9, 18)) == 0


def test_a_board_that_stays_quiet_empties_out(tmp_path):
    # The hold is not open-ended: a carried listing keeps the last_seen of the run that fetched it.
    from datetime import date
    prev = [_prev(id=str(i), apply_url="https://x/%d" % i,
                  last_seen="2026-09-14T00:00:00+00:00") for i in range(10)]
    _write_prev(tmp_path, prev)
    listings = []
    assert carry_open_boards(listings, str(tmp_path), today=date(2026, 9, 18)) == 0


def test_a_listing_no_rule_can_place_lands_in_no_state_file(tmp_path):
    # Not hypothetical: _regions re-reads a carried listing's stored location under today's
    # rules, so a listing that classified when it was first seen can stop classifying later.
    # It cannot go in US.json - it never named the US - so it is withheld, and the only thing
    # that stops it being lost silently is that export counts it.
    lost = {"id": "x", "regions": [], "state": None, "status": "open",
            "field_tags": ["health"], "stage": ["internship"], "sector": None}

    assert shard_keys(lost) == set()
    index = write_shards([lost, _listing("y", ["Boston, MA"])], str(tmp_path), "now")
    assert list(index["files"]) == ["MA"]
    kept = json.load(open(os.path.join(str(tmp_path), "listings", "MA.json"), encoding="utf-8"))
    assert [x["id"] for x in kept] == ["y"]


def test_a_stored_research_stage_alone_is_asked_again():
    # Stored while the bare word still admitted a posting; today's rules find no student job in it.
    assert merged_stages(["research"], "VP, Research") == []
    assert merged_stages(["research"], "REU Site: Computational Biology") == ["research"]
    # a feed that said intern still keeps the research reading of the title
    assert merged_stages(["internship", "research"], "Researcher, Interpretability") == ["internship", "research"]


def test_a_never_student_title_loses_the_stage_its_feed_gave_it():
    # The feed called these internships; the title says only active-duty members or staff may apply.
    assert merged_stages(["internship"], "Boeing SkillBridge - Military Internship") == []
    assert merged_stages(["internship"], "Postdoctoral Research Fellow") == []
    assert merged_stages(["internship"], "Regional Discovery Program Coach") == []
    # a feed-only stage on a title that says nothing either way is still kept
    assert merged_stages(["internship"], "Growth") == ["internship"]
