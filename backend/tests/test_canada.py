"""Canadian internships: kept since 2026-09-30, filed by province, never under a US state."""
import pytest

from internscout import seo_pages
from internscout.export_static import shard_keys
from internscout.geo import canada_of
from internscout.region import classify_location, evaluate_locations, maybe_in_region
from internscout.sources.lever import parse_lever
from internscout.sources.workable import parse_workable
from tests.test_seo_pages import _row, _site


@pytest.mark.parametrize("loc, prov, metro", [
    ("Toronto, ON", "ON", "Toronto"),
    ("Toronto, Ontario, Canada", "ON", "Toronto"),
    ("Toronto, CA", "ON", "Toronto"),                 # the country code, not California
    ("Toronto", "ON", "Toronto"),
    ("Hybrid - Toronto", "ON", "Toronto"),
    ("Toronto ON M5V 2T6", "ON", "Toronto"),
    ("Mississauga, ON", "ON", "Toronto"),
    ("Montréal, QC", "QC", "Montreal"),
    ("Saint-Laurent, QC", "QC", "Montreal"),
    ("Vancouver, BC", "BC", "Vancouver"),
    ("Burnaby BC", "BC", "Vancouver"),
    ("Calgary, AB, CA", "AB", "Calgary"),
    ("Kanata, ON", "ON", "Ottawa"),
    ("Waterloo, ON", "ON", "Waterloo Region"),
    ("Cambridge, Ontario", "ON", "Waterloo Region"),
    ("CA-QC-MIRABEL-M01 ~ 12800 Rue Henri-Fabre", "QC", None),
    ("Barrie, ON, CA", "ON", None),
    ("Halifax, NS", "NS", "Halifax"),
])
def test_a_canadian_location_is_filed_by_province_and_metro(loc, prov, metro):
    h = classify_location(loc)
    assert (h["kind"], h["state"], h.get("metro")) == ("canada", prov, metro), loc


@pytest.mark.parametrize("loc, state", [
    ("Vancouver, WA", "WA"), ("Ontario, CA", "CA"), ("New Brunswick, NJ", "NJ"), ("London, KY", "KY"),
    ("Burlington, VT", "VT"), ("Cambridge, MA", "MA"), ("Waterloo, IA", "IA"), ("Richmond, VA", "VA"),
    ("Victoria, TX", "TX"), ("Ottawa, IL", "IL"), ("Irvine, CA - ON SITE", "CA"), ("Hamilton, NJ", "NJ"),
])
def test_a_us_namesake_stays_in_its_state(loc, state):
    assert canada_of(loc) is None, loc
    assert classify_location(loc)["state"] == state, loc


def test_a_bare_town_with_a_bigger_us_namesake_is_not_guessed():
    for loc in ("London", "Waterloo", "Ottawa", "Richmond", "Victoria"):
        assert canada_of(loc) is None, loc


def test_canada_with_no_province_goes_in_its_own_file():
    for loc in ("Canada", "Remote - Canada", "Remote, Canada"):
        regions = evaluate_locations([loc])["regions"]
        assert [(g["kind"], g["state"]) for g in regions] == [("canada", None)], loc
        assert shard_keys({"regions": regions}) == {"Canada"}, loc
    ev = evaluate_locations(["Toronto, ON", "Boston, MA"])
    assert shard_keys(ev) == {"ON", "MA"}
    assert ev["state"] == "MA"              # the US location still leads a listing that has one


def test_the_big_metros_provinces_get_detail_calls():
    assert maybe_in_region("Toronto, ON") and maybe_in_region("Montreal, QC") and maybe_in_region("Calgary, AB")
    assert not maybe_in_region("Halifax, NS") and not maybe_in_region("Remote - Canada")


def test_remote_canada_on_lever_is_not_remote_in_california():
    # Lever's country is the ISO code, and "Remote - CA" read as remote in California.
    items = parse_lever([{"text": "Software Intern", "categories": {"location": "", "commitment": "Intern"},
                          "workplaceType": "remote", "country": "CA", "hostedUrl": "https://jobs.lever.co/x/1"}],
                        {"name": "Acme", "ats_token": "acme"})
    assert "Remote - Canada" in items[0]["locations"]
    assert shard_keys(evaluate_locations(items[0]["locations"])) == {"Canada"}


def test_workable_keeps_its_canadian_offices():
    items = parse_workable({"jobs": [{"title": "Data Intern", "employment_type": "Internship",
                                      "locations": [{"countryCode": "CA", "country": "Canada", "city": "Toronto", "region": "Ontario"},
                                                    {"countryCode": "GB", "country": "United Kingdom", "city": "London"}],
                                      "url": "https://apply.workable.com/acme/j/1"}]},
                           {"name": "Acme", "ats_token": "acme"})
    assert items[0]["locations"] == ["Toronto, Ontario, Canada"]


def _ca_row(i, loc, prov, metro=None, **over):
    region = {"loc": loc, "kind": "canada", "state": prov}
    if metro:
        region["metro"] = metro
    return _row(i, state=prov, regions=[region], **over)


def test_canada_metro_and_province_pages(tmp_path):
    toronto = [_ca_row(i, "Toronto, ON", "ON", "Toronto") for i in range(15)]
    montreal = [_ca_row(100 + i, "Montreal, QC", "QC", "Montreal") for i in range(3)]
    anywhere = [_ca_row(200 + i, "Remote - Canada", None) for i in range(2)]
    site = _site(tmp_path, {"ON": toronto, "QC": montreal, "Canada": anywhere, "MA": [_row(300 + i) for i in range(6)]})
    pages = {p["path"]: p for p in seo_pages.build(site)}
    paths = set(pages)
    assert {"/internships/ontario/", "/internships/toronto/", "/internships/canada/"} <= paths
    assert "/internships/mechanical-engineering/toronto/" in paths          # a field in a metro
    assert "/internships/quebec/" not in paths and "/internships/montreal/" not in paths   # 3 < MIN_OPEN
    canada = pages["/internships/canada/"]["html"]
    assert "20 open" in canada
    # The dashboard has province files only: a metro opens its province, Canada all of them.
    assert 'href="/?state=ON"' in pages["/internships/toronto/"]["html"]
    assert "state=ON,QC,BC" in canada
    hub = pages["/internships/"]["html"]
    assert "<h2>Canada</h2>" in hub and hub.index("<h2>By state</h2>") < hub.index("<h2>Canada</h2>")


def test_the_canada_views_do_not_count_as_extra_places():
    # A Toronto role is in ON, Toronto and Canada, but it is filed in one place.
    assert {"ON", "Toronto", "Canada"} & seo_pages.PLACES == {"ON"}


def test_an_in_person_canadian_role_ranks_like_an_in_person_us_one():
    assert evaluate_locations(["Toronto, ON"])["on_site"]
    assert not evaluate_locations(["Remote - Canada"])["on_site"]


def test_uhn_keeps_its_student_roles_in_toronto():
    from internscout.sources.uhn import parse_uhn
    payload = {"data": [
        {"id": "744000151069349", "name": "Student, Admin Support (Research)", "site": "Princess Margaret Cancer Centre",
         "department": "Research", "employment": "Temporary Full Time"},
        {"id": "744000152669697", "name": "Occupational Therapist - Brain Program ", "site": "Toronto Rehab",
         "department": "Neuro Rehab Program", "employment": "Permanent Full Time"},
        {"name": "Summer Student", "employment": "Temporary Full Time"},           # no id: no link to give
    ]}
    items = parse_uhn(payload)
    assert [i["title"] for i in items] == ["Student, Admin Support (Research)"]
    assert items[0]["locations"] == ["Toronto, ON"]
    assert items[0]["url"] == "https://forms.uhn.ca/UHNCareers/Home/Posting/744000151069349"
    assert classify_location(items[0]["locations"][0])["metro"] == "Toronto"
