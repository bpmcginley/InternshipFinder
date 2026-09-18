from internscout.region import (board_state, evaluate_locations, in_region, place_bare_cities,
                                state_of)
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


def test_board_state_needs_agreement():
    # Eliot's board: forty-six postings say Massachusetts and nothing says anything else.
    assert board_state(["Danvers, MA", "Lynn, MA", "Boston, MA", "Lexington"]) == "MA"
    assert board_state(["Boston, MA", "Boston, MA"]) is None           # too little to go on
    assert board_state(["Boston, MA", "Austin, TX", "Denver, CO"]) is None  # hires in three states
    assert board_state(["Lexington", "Danvers", "Saugus"]) is None     # says nothing at all
    assert board_state(["Remote", "Remote - US", "Remote"]) is None


def test_place_bare_cities_reads_towns_in_the_board_state():
    items = [{"locations": ["Lexington"]}, {"locations": ["Danvers", "Boston, MA"]},
             {"locations": ["Remote - US"]}, {"locations": ["London"]}, {"locations": []}]
    assert place_bare_cities(items, "MA") == 2
    assert items[0]["locations"] == ["Lexington, MA"]
    assert items[1]["locations"] == ["Danvers, MA", "Boston, MA"]   # one already said where it was
    assert items[2]["locations"] == ["Remote - US"]                # remote is not a town
    assert items[3]["locations"] == ["London"]                     # and neither is another country
    assert place_bare_cities(items, None) == 0                     # no state, no change


def test_a_bare_town_the_board_places_is_a_listing_we_keep():
    # "Lexington" alone is not to be trusted: geo._AMBIGUOUS lists it, and Kentucky's is the big one.
    assert in_region(["Lexington"]) is False
    items = [{"locations": ["Lexington"]}]
    place_bare_cities(items, "MA")
    geo = evaluate_locations(items[0]["locations"])
    assert geo["in_region"] and geo["state"] == "MA" and geo["within_radius"]


def test_ats_of():
    assert ats_of("https://boards.greenhouse.io/janestreet/jobs/123") == ("greenhouse", "janestreet")
    assert ats_of("https://job-boards.greenhouse.io/point72/jobs/9") == ("greenhouse", "point72")
    assert ats_of("https://jobs.lever.co/palantir/abc-123/apply") == ("lever", "palantir")
    # a EU-hosted board is a different API host, so the region is kept in the token
    assert ats_of("https://jobs.eu.lever.co/cirrus/645ceaf8/apply") == ("lever", "cirrus|eu")
    # ...but Greenhouse serves its EU boards from the same API, so the token is unchanged
    assert ats_of("https://job-boards.eu.greenhouse.io/veeamsoftware/jobs/4952609101") == \
        ("greenhouse", "veeamsoftware")
    # Rippling puts a locale in front of the board slug on some links
    assert ats_of("https://ats.rippling.com/en-GB/neosigma/jobs/a2ee1d26") == ("rippling", "neosigma")
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


def test_state_of_reads_a_code_the_board_did_not_set_apart():
    # The strict passes want the code to be a comma-or-dash piece on its own, so every board that
    # writes something else beside it used to come back stateless and land in the "US" shard.
    assert state_of("Cambridge, MA USA") == "MA"                 # country after the code
    assert state_of("Chicago IL USA") == "IL"                    # no comma at all
    assert state_of("San Mateo, CA United States") == "CA"
    assert state_of("White Plains, NY United States of America") == "NY"
    assert state_of("US WV Friendly") == "WV"                    # code before the town
    assert state_of("USA-IL Oak Brook") == "IL"
    assert state_of("US.GA.Atlanta.2018 Powers Ferry Rd") == "GA"  # dots, which are not split on
    assert state_of("(USA) OH HAMILTON 02441 WM SUPERCENTER") == "OH"
    assert state_of("(USA) AR ROGERS 05837 NEIGHBORHOOD MARKET") == "AR"
    assert state_of("US FL JAX 347") == "FL"                     # an airport code after the state
    # It reads a code, not a word: the pass is capital-only and needs the two letters to stand alone.
    assert state_of("United States") is None
    assert state_of("US Headquarters") is None
    assert state_of("Remote - anywhere in the US or nearby") is None
    assert state_of("Walmart") is None
    # letters glued into a word are not a code; a UPS site code that closes the string is read on
    # purpose by its own pass (test_a_ups_site_code_names_its_state), so this is one that does not
    assert state_of("US - GACOR OFFICES") is None
    # and the earlier passes still answer first, so a real "City, ST" is unchanged.
    assert state_of("Boston, MA") == "MA"
    assert state_of("Hartford, Connecticut") == "CT"


def test_a_location_the_new_pass_reads_is_sharded_by_its_state():
    ev = evaluate_locations(["(USA) NY WATKINS GLEN 03221 WM SUPERCENTER"])
    assert ev["state"] == "NY"
    assert [g["state"] for g in ev["regions"]] == ["NY"]


def test_a_city_next_to_its_country_is_still_just_a_city():
    # The major-city map was only consulted when the string had no comma at all, so a board that
    # wrote the country after the city ("Chicago, United States") lost the state the map knew.
    assert evaluate_locations(["Chicago, United States"])["state"] == "IL"
    assert evaluate_locations(["Los Angeles, USA"])["state"] == "CA"
    assert evaluate_locations(["Chicago"])["state"] == "IL"
    # but a real second place is still a second place, and an unknown city still has no state.
    assert evaluate_locations(["Chicago, Illinois"])["state"] == "IL"
    assert evaluate_locations(["United States"])["state"] is None


def test_remote_is_only_said_where_a_location_says_it():
    # A US location we cannot pin to a state is somewhere in the US, not remote.
    assert evaluate_locations(["United States"])["state"] is None
    assert evaluate_locations(["US Headquarters"])["state"] is None
    assert evaluate_locations(["Remote - US"])["state"] == "Remote"
    assert evaluate_locations(["Boston, MA"])["state"] == "MA"


def test_filler_beside_a_remote_location_does_not_move_it_abroad():
    # "Remote - US: All locations" is how a Greenhouse board writes it, and "all" was not on the
    # list of words allowed to stand beside remote, so the posting had no US location at all and
    # was dropped before anything else saw it. Dropbox's only 2027 SWE internship, for one.
    for loc in ("Remote - US: All locations", "Remote USA - All Locations", "Remote - US (All Locations)",
                "Fully Remote", "Fully Remote (US)", "Remote Worker - US",
                "US Remote - Various", "Remote - Multiple Locations", "Remote - Continental US",
                "Remote - US Mainland", "Remote - Lower 48", "Remote Position - USA"):
        assert evaluate_locations([loc])["state"] == "Remote", loc
    # "Home Office - US" and "Telework - US" say no remote word at all, so they stay what they are:
    # somewhere in the US with no state, which is also what a UPS "home office" posting really is.
    for loc in ("Home Office - US", "Telework - US"):
        assert evaluate_locations([loc])["in_region"] and evaluate_locations([loc])["state"] is None
    # and the check still keeps out the thing it is for.
    for loc in ("Remote - Serbia", "Remote - HU", "Virtual, BR", "Remote - EMEA", "Remote - India"):
        assert evaluate_locations([loc])["in_region"] is False, loc


def test_a_us_town_named_after_a_foreign_city_is_in_its_state():
    # Each of these was thrown out of the country by the foreign-city word alone.
    for loc, st in (("Dublin, OH", "OH"), ("Ontario, CA", "CA"), ("Warsaw, IN 46580", "IN"),
                    ("New London, CT", "CT"), ("Paris, Texas, USA", "TX"), ("Vancouver, WA", "WA"),
                    ("New Berlin, WI 53151", "WI")):
        r = evaluate_locations([loc])
        assert r["in_region"] and r["state"] == st, (loc, r["state"])
    assert evaluate_locations(["Vienna, VA; United States"])["state"] == "VA"


def test_the_foreign_city_is_still_foreign():
    # "IN" is India's code as well as Indiana's; only the namesake towns are let through.
    for loc in ("Bangalore, IN", "Hyderabad, IN", "Dublin, Ireland", "London, UK", "Toronto, ON",
                "Vancouver, BC", "Paris, France", "London", "Remote - Canada"):
        assert not evaluate_locations([loc])["in_region"], loc


def test_a_ups_site_code_names_its_state():
    assert evaluate_locations(["US - UPS CORPORATE OFFICES (GACOR)"])["state"] == "GA"
    assert evaluate_locations(["US - JEFFERSON HUB (ILJEF)"])["state"] == "IL"
    # the shape has to be exact: a parenthesised word elsewhere is not a site code
    assert evaluate_locations(["United States (HYBRID)"])["state"] is None
    assert evaluate_locations(["US - ZZ TOP HUB (ZZTOP)"])["state"] is None


def test_puerto_rico_is_its_own_state():
    for loc in ("Gurabo, Puerto Rico, United States of America", "San Juan, PR", "Juncos, PR 00777",
                "US Home Office Puerto Rico"):
        r = evaluate_locations([loc])
        assert r["in_region"] and r["state"] == "PR", (loc, r["state"])
    # but a bare "PR" among other capitals is not read as the island
    assert state_of("US - PR DEPT") is None
