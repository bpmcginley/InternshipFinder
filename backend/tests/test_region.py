from internscout.region import evaluate_locations, in_region, state_of
from internscout.discover import ats_of, add_board, discover


def test_state_of():
    assert state_of("Boston, MA") == "MA"
    assert state_of("US-MA-Boston") == "MA"
    assert state_of("Hartford, Connecticut") == "CT"
    assert state_of("Cambridge, MA 02139") == "MA"
    assert state_of("Remote in USA") is None


def test_region_cases():
    assert in_region("Boston, MA")
    assert in_region("Burlington, VT")
    assert in_region("Stamford, CT")
    assert in_region("Jersey City, NJ")
    assert in_region("Philadelphia, PA")        # nationwide now
    assert in_region("Princeton, NJ")          # ~45 mi from Midtown
    assert in_region("Remote - US")
    assert in_region("Remote in USA")
    assert not in_region("Remote - Canada")
    assert in_region("Remote, TX")
    for loc in ("Remote - serbia", "Remote - HU", "Virtual, BR", "Remote - SG", "Remote (India)"):
        assert not in_region(loc), loc
    for loc in ("Remote", "Remote (US)", "United States - Virtual", "Remote - any location", "Remote/Homebased"):
        assert in_region(loc), loc
    assert in_region(["San Francisco, CA", "New York, NY"])
    assert in_region("San Francisco, CA; New York, NY")
    assert in_region("Albany, NY")
    assert not in_region("Cambridge, United Kingdom")
    assert in_region("Portland, OR")
    assert in_region("Portland, ME")
    assert in_region("NYC")
    assert not in_region([])


def test_region_fields():
    g = evaluate_locations(["Boston, MA"])
    assert g["within_radius"] and g["in_city"] and g["state"] == "MA"
    g = evaluate_locations(["Remote in USA"])
    assert g["in_region"] and g["is_remote"] and not g["within_radius"] and g["state"] == "Remote"
    g = evaluate_locations(["Seattle, WA", "Hoboken, NJ"])
    assert g["region_locations"] == ["Seattle, WA", "Hoboken, NJ"] and g["state"] == "NJ"
    assert [r["kind"] for r in g["regions"]] == ["us", "nyc_metro"] and g["within_radius"]


def test_comma_city_lists():
    g = evaluate_locations(["New York, Chicago"])
    assert g["region_locations"] == ["New York", "Chicago"] and g["state"] == "NY"
    assert [r["kind"] for r in g["regions"]] == ["nyc_metro", "us"]
    g = evaluate_locations(["Austin, TX; Boston, MA; New York, NY"])
    assert [(r["kind"], r["state"]) for r in g["regions"]] == [("us", "TX"), ("new_england", "MA"), ("nyc_metro", "NY")]
    assert evaluate_locations(["Brooklyn, New York"])["region_locations"] == ["Brooklyn, New York"]
    assert evaluate_locations(["Boston, MA"])["region_locations"] == ["Boston, MA"]
    assert in_region("Chicago, Seattle")
    g = evaluate_locations(["Cambridge, MA, Arlington, VA, Seattle, WA"])
    assert g["region_locations"] == ["Cambridge, MA", "Arlington, VA", "Seattle, WA"] and g["state"] == "MA"
    assert evaluate_locations(["Boston, MA, United States"])["region_locations"] == ["Boston, MA, United States"]
    g = evaluate_locations(["Remote - US"])
    assert g["regions"] == [{"loc": "Remote - US", "kind": "remote", "state": "Remote"}]


def test_ats_of():
    assert ats_of("https://boards.greenhouse.io/janestreet/jobs/123") == ("greenhouse", "janestreet")
    assert ats_of("https://job-boards.greenhouse.io/point72/jobs/9") == ("greenhouse", "point72")
    assert ats_of("https://jobs.lever.co/palantir/abc-123/apply") == ("lever", "palantir")
    assert ats_of("https://jobs.ashbyhq.com/ramp/1234") == ("ashby", "ramp")
    assert ats_of("https://modernatx.wd1.myworkdayjobs.com/en-US/M_tx/job/Cambridge/Intern_R1") == \
        ("workday", "modernatx|wd1|M_tx")
    # a career site named after what it is ("careers", "search") is not a bad token on Workday:
    # there the tenant is what has to look real, and most sites are named this way
    assert ats_of("https://allegion.wd5.myworkdayjobs.com/careers/job/Intern_R1") == \
        ("workday", "allegion|wd5|careers")
    assert ats_of("https://brunswick.wd1.myworkdayjobs.com/en-US/search/job/Intern_R2") == \
        ("workday", "brunswick|wd1|search")
    # Workday's second domain: the tenant is a path segment, and the domain rides in the token
    assert ats_of("https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/Intern_R3") == \
        ("workday", "wf|wd1.myworkdaysite.com|WellsFargoJobs")
    assert ats_of("https://jobs.smartrecruiters.com/BoschGroup/7440") == ("smartrecruiters", "BoschGroup")
    # the whole subdomain is the iCIMS tenant, prefix and all
    assert ats_of("https://careers-foo.icims.com/jobs/1/intern/job") == ("icims", "careers-foo")
    # ...but a bare "careers" is a _BAD_TOKEN, so it stays recognised-without-a-token
    assert ats_of("https://careers.icims.com/jobs/1/intern/job") == ("icims", None)
    assert ats_of("https://example.com/careers") == ("other", None)


def test_discover_dedupes_case():
    reg = {}
    assert add_board(reg, "ashby", "Ramp", "Ramp")
    n = discover(reg, [{"company_name": "Ramp", "apply_url": "https://jobs.ashbyhq.com/ramp/1"},
                       {"company_name": "HRT", "url": "https://boards.greenhouse.io/wehrtyou/jobs/2"}])
    assert n == 1 and list(reg["ashby"]) == ["Ramp"] and "wehrtyou" in reg["greenhouse"]
