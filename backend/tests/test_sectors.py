from datetime import date

from internscout import companies_seed
from internscout.dedupe import merge_batch, same_job
from internscout.discover import (add_board, label_boards, label_sectors, relabel_sector,
                                  sector_from_name, seed_registry, set_location)
from internscout.coverage import SECTOR_CLUSTER
from internscout.normalize import normalize
from internscout.sources.common import board_item


def test_add_board_sector():
    reg = {}
    assert add_board(reg, "greenhouse", "acme", "Acme", sector="health")
    assert reg["greenhouse"]["acme"]["sector"] == "health"
    assert not add_board(reg, "greenhouse", "ACME", "Acme", sector="media")   # first label stays
    assert reg["greenhouse"]["acme"]["sector"] == "health"
    add_board(reg, "lever", "fund", "Fund", quant=True)
    assert reg["lever"]["fund"]["sector"] == "quant_finance"
    add_board(reg, "lever", "plain", "Plain")
    assert "sector" not in reg["lever"]["plain"]
    add_board(reg, "lever", "plain", "Plain", sector="nonprofit")             # filled when missing
    assert reg["lever"]["plain"]["sector"] == "nonprofit"


def test_seed_registry_new_ats(monkeypatch):
    monkeypatch.setattr(companies_seed, "TALEO", [{"name": "Textron", "ats_token": "textron|textron",
                                                   "is_quant_target": False, "sector": "engineering_manufacturing"}])
    reg = {}
    seed_registry(reg)
    assert reg["taleo"]["textron|textron"]["sector"] == "engineering_manufacturing"


def test_workable_probe_needs_jobs():
    from internscout.probe import _workable

    class Resp:
        status_code = 200
        def __init__(self, d): self.d = d
        def json(self): return self.d

    class Client:
        def __init__(self, d): self.d = d
        def get(self, url, params=None): return Resp(self.d)

    assert not _workable(Client({"name": "Mayo Clinic", "jobs": []}), "mayo-clinic", "Mayo Clinic")
    assert _workable(Client({"name": "Mayo Clinic", "jobs": [{"title": "x"}]}), "mayo-clinic", "Mayo Clinic")


def test_jazzhr_probe_needs_the_employers_name():
    # Every applytojob.com subdomain answers 200 - a slug nobody registered serves JazzHR's own
    # marketing page, naming JazzHR as the organization - so the name and the jobs do all the work.
    from internscout.probe import _jazzhr

    item = '<li class="list-group-item"><a href="https://x.applytojob.com/apply/1">Intern</a></li>'
    org = lambda n: '<script type="application/ld+json">{"@type": "Organization", "name": "%s"}</script>' % n

    class Client:
        def __init__(self, page, code=200): self.page, self.code = page, code
        def get(self, url): return type("R", (), {"status_code": self.code, "text": self.page})()

    real = org("Stellar Science") + item
    assert _jazzhr(Client(real), "stellarscience", "Stellar Science")
    assert not _jazzhr(Client(org("JazzHR")), "acme", "Acme")                   # unregistered slug
    assert not _jazzhr(Client(org("JazzHR") + item), "jazzhr", "JazzHR")        # the placeholder never counts
    assert not _jazzhr(Client(real), "roush", "ROUSH")                          # somebody else's board
    assert not _jazzhr(Client(item), "stellarscience", "Stellar Science")       # jobs, but nothing named
    assert not _jazzhr(Client(org("Stellar Science")), "stellarscience", "Stellar Science")   # named, no jobs
    assert not _jazzhr(Client(real, 404), "stellarscience", "Stellar Science")

def test_greenhouse_host_probe():
    # The employer's own careers page is the only place the board token appears; the job id in the
    # apply URL is what proves the token is the right one rather than some other board on the page.
    from internscout.probe import gh_host_token, gh_hosts

    page = ('<script src="https://boards.greenhouse.io/embed/job_board/js?for=towerresearchcapital">'
            '</script><a href="https://boards.greenhouse.io/embed/job_board?for=someoneelse">x</a>')

    class Client:
        def __init__(self, page, ok=("towerresearchcapital",)):
            self.page, self.ok, self.asked = page, ok, []
        def get(self, url, timeout=None):
            if url.startswith("https://boards-api"):
                tok = url.split("/boards/")[1].split("/")[0]
                self.asked.append(tok)
                return type("R", (), {"status_code": 200 if tok in self.ok else 404})()
            return type("R", (), {"status_code": 200, "text": self.page})()

    c = Client(page)
    assert gh_host_token(c, "https://www.tower-research.com/open-positions/?gh_jid=8024128",
                         "8024128") == "towerresearchcapital"
    assert "js" not in c.asked and "embed" not in c.asked      # the embed URL's own words are not boards
    # A page naming only a board that does not serve this job is no answer at all.
    assert gh_host_token(Client(page, ok=()), "https://x.com/?gh_jid=1", "1") is None
    # A careers page that renders its jobs from somewhere private gives nothing away.
    assert gh_host_token(Client("<html>no board here</html>"), "https://x.com/?gh_jid=1", "1") is None

    reg = {"greenhouse": {"coinbase": {"name": "Coinbase"}}}
    items = [{"apply_url": "https://www.coinbase.com/careers/positions/1?gh_jid=1", "company_name": "Coinbase"},
             {"apply_url": "https://boards.greenhouse.io/alku/jobs/2?gh_jid=2", "company_name": "ALKU"},
             {"apply_url": "https://careers.aqr.com/jobs?gh_jid=7895562", "company_name": "AQR"},
             {"apply_url": "https://careers.aqr.com/jobs?gh_jid=7895563", "company_name": "AQR"},
             {"apply_url": "https://example.com/jobs/4", "company_name": "No Greenhouse Here"}]
    got = gh_hosts(reg, items, {"gh:stale.example.com": "2000-01-01"}, date(2026, 9, 18))
    # Coinbase already has a board, ALKU's token is in its URL, and one host is asked about once.
    assert [g[0] for g in got] == ["careers.aqr.com"]
    assert got[0][1:] == ("https://careers.aqr.com/jobs?gh_jid=7895562", "7895562", "AQR")
    # A host asked about recently is left alone until the cache entry ages out.
    assert gh_hosts(reg, items, {"gh:careers.aqr.com": "2026-09-17"}, date(2026, 9, 18)) == []


def test_sector_reaches_listing():
    co = {"name": "Baystate Health", "ats_token": "x", "sector": "health"}
    raw = board_item(co, source="workday", title="Nursing Intern", locations=["Springfield, MA"],
                     url="https://example.com/1", employment_type="Intern")
    n = normalize(raw)
    assert n and n["sector"] == "health"
    first = dict(n, sector=None, source="github")
    merged = merge_batch([first, n])
    assert list(merged.values())[0]["sector"] == "health"


def test_seed_may_relabel_a_board_it_owns():
    # Centria Autism was seeded as health and is behavioral_health now; add_board alone kept the
    # first label, which is what we want from a prober's guess and not from the seed file.
    reg = {}
    add_board(reg, "greenhouse", "centriaautism", "Centria Autism", sector="health")
    assert not add_board(reg, "greenhouse", "centriaautism", "Centria Autism", sector="behavioral_health")
    assert reg["greenhouse"]["centriaautism"]["sector"] == "health"
    assert relabel_sector(reg, "greenhouse", "CentriaAutism", "behavioral_health")   # case is not the point
    assert reg["greenhouse"]["centriaautism"]["sector"] == "behavioral_health"
    assert not relabel_sector(reg, "greenhouse", "centriaautism", "behavioral_health")  # nothing to do
    assert not relabel_sector(reg, "greenhouse", "never-heard-of-it", "health")


def test_behavioral_health_employer_tags_psychology():
    # Eliot's three real openings in Lexington: a title rule cannot read any of them, and the
    # cluster they belong to had nothing in the baseline states before the sector existed.
    co = {"name": "Eliot Community Human Services", "ats_token": "x", "sector": "behavioral_health"}
    item = lambda title: normalize(board_item(co, source="greenhouse", title=title,
                                              locations=["Lexington, MA"], url="https://example.com/1",
                                              employment_type="Intern"))
    assert item("Bachelor's Level Intern")["field_tags"] == ["psychology"]
    assert item("Specialty Clinical Intern")["field_tags"] == ["health"]   # a title match still wins
    assert SECTOR_CLUSTER["behavioral_health"] == "Social sciences"


def test_sector_fills_untagged_titles():
    co = {"name": "Mass General Brigham", "ats_token": "x", "sector": "health"}
    item = lambda title, c=co: normalize(board_item(c, source="workday", title=title, locations=["Boston, MA"],
                                                    url="https://example.com/1", employment_type="Intern"))
    assert item("Research Intern")["field_tags"] == ["health"]
    assert "health" not in item("Software Engineering Intern")["field_tags"]   # a title match wins
    assert item("Research Intern", dict(co, sector=None))["field_tags"] == ["other"]


def test_a_seed_may_say_where_its_employer_is():
    reg = {}
    add_board(reg, "workday", "emerson|wd5|x", "Emerson College", location="Boston, MA")
    assert reg["workday"]["emerson|wd5|x"]["location"] == "Boston, MA"
    add_board(reg, "workday", "plain|wd1|y", "Plain")
    assert "location" not in reg["workday"]["plain|wd1|y"]
    # A second sighting fills it in but does not overwrite, same as sector; only the seed may move it.
    add_board(reg, "workday", "plain|wd1|y", "Plain", location="Boston, MA")
    assert reg["workday"]["plain|wd1|y"]["location"] == "Boston, MA"
    assert set_location(reg, "workday", "PLAIN|WD1|Y", "Cambridge, MA")   # case is not the point
    assert reg["workday"]["plain|wd1|y"]["location"] == "Cambridge, MA"
    assert not set_location(reg, "workday", "plain|wd1|y", "Cambridge, MA")   # nothing to do
    assert not set_location(reg, "workday", "never-heard-of-it", "Boston, MA")


def test_a_campus_posting_keeps_the_state_its_seed_knows():
    # "L - 2 West 13th Street" is a real New School building and no US location a parser can read,
    # so the posting was dropped for having no region at all - 25 of the 34 postings on the eight
    # college boards seeded here.
    co = {"name": "The New School", "ats_token": "x", "sector": "education_research",
          "location": "New York, NY"}
    raw = board_item(co, source="workday", title="BFA Photo Events Student Assistant",
                     locations=["L - 2 West 13th Street"], url="https://example.com/1",
                     employment_type="Intern")
    assert raw["locations"] == ["L - 2 West 13th Street", "New York, NY"]
    n = normalize(raw)
    assert n and n["geo"]["in_region"] and n["geo"]["state"] == "NY"
    # and the building is still what the card shows.
    assert n["geo"]["location_raw"].startswith("L - 2 West 13th Street")


def test_the_seeds_place_never_overrides_one_the_posting_named():
    co = {"name": "The New School", "ats_token": "x", "location": "New York, NY"}
    for locs in (["Boston, MA"], ["Parsons Paris"], ["Remote"], ["Chicago, Illinois"]):
        raw = board_item(co, source="workday", title="Intern", locations=locs, url="u")
        assert raw["locations"] == locs
    # An employer with no seeded place is untouched either way.
    raw = board_item({"name": "Plain", "ats_token": "x"}, source="workday", title="Intern",
                     locations=["Main Campus"], url="u")
    assert raw["locations"] == ["Main Campus"]


def test_the_college_boards_are_seeded_with_their_campus():
    colleges = {c["ats_token"]: c for c in companies_seed.WORKDAY
                if c["ats_token"].split("|")[0] in
                {"amherst", "babson", "berklee", "emerson", "rit", "unioncollege", "newschool"}}
    assert len(colleges) == 7
    for c in colleges.values():
        assert c["sector"] == "education_research"
        assert c["location"], c["name"]
    # Cornell Cooperative Extension is every county in New York and deliberately has no one place.
    cce = next(c for c in companies_seed.WORKDAY if c["ats_token"] == "cornell|wd1|CCECareerPage")
    assert "location" not in cce


def _posting(title, url, where="Boston, MA", source="workday"):
    co = {"name": "Acme", "ats_token": "x"}
    raw = board_item(co, source=source, title=title, locations=[where], url=url,
                     employment_type="Intern")
    raw["apply_url"] = url
    return normalize(raw)


def test_a_posting_seen_twice_is_one_listing_even_when_only_one_source_read_the_term():
    # The board says "coinbase.com/careers/positions/8168315?gh_jid=8168315" and the embed link
    # Google Jobs hands back says "boards.greenhouse.io/embed/job_app?token=8168315". Same job.
    # One title carries the term and the other does not, so they landed under two dedupe keys.
    termed = _posting("Software Engineer Intern, Summer 2027",
                      "https://www.coinbase.com/careers/positions/8168315?gh_jid=8168315")
    blank = _posting("Software Engineer Intern",
                     "https://boards.greenhouse.io/embed/job_app?token=8168315", source="google_jobs")
    assert termed["dedupe_key"] != blank["dedupe_key"]
    merged = merge_batch([termed, blank])
    assert len(merged) == 1
    kept = list(merged.values())[0]
    assert kept["term"] == "Summer 2027" and len(kept["_sources"]) == 2
    # and the query a source adds to say how it arrived is not what makes it a different job.
    assert same_job("https://careers.qorvo.com/job/Chandler-Analog-AZ-85226/1421977600/",
                    "https://careers.qorvo.com/job/Chandler-Analog-AZ-85226/1421977600/?ats=successfactors")


def test_two_offices_of_one_job_title_stay_two_listings():
    # Ryan Companies posts "Safety Engineer Intern" in Phoenix and in Dallas. Only one title says
    # the term, so the naive fix - trust the title, ignore the URL - would have thrown one away.
    phoenix = _posting("Safety Engineer Intern",
                       "https://ryancompanies.wd5.myworkdayjobs.com/rc/job/Phoenix/Safety_R101",
                       where="Phoenix, AZ")
    dallas = _posting("Safety Engineer Intern - Summer 2027",
                      "https://ryancompanies.wd5.myworkdayjobs.com/rc/job/Dallas/Safety_R102",
                      where="Dallas, TX")
    assert len(merge_batch([phoenix, dallas])) == 2
    assert not same_job(phoenix["apply_url"], dallas["apply_url"])
    # A missing URL never matches anything, so an unreadable link cannot collapse two postings.
    assert not same_job(None, None) and not same_job("", "https://example.com/jobs/1")


def test_a_listing_found_off_board_gets_the_sector_its_board_already_carries():
    # The case: Vox Media's greenhouse board is seeded and labelled media, but this posting came
    # through a GitHub list, which gives a title and a link and no employer metadata at all.
    reg = {}
    add_board(reg, "greenhouse", "voxmedia", "Vox Media", sector="media")
    add_board(reg, "lever", "somefund", "Some Fund", quant=True)
    add_board(reg, "greenhouse", "plain", "Plain Co")           # in the registry, no sector
    listed = {"title": "Editorial Intern", "company_name": "Vox Media",
              "apply_url": "https://boards.greenhouse.io/voxmedia/jobs/4321"}
    walked = {"title": "Editorial Intern", "company_name": "Vox Media", "sector": "nonprofit",
              "apply_url": "https://boards.greenhouse.io/voxmedia/jobs/4321"}
    unknown = {"title": "Intern", "company_name": "Nobody",
               "apply_url": "https://boards.greenhouse.io/nobodyatall/jobs/1"}
    unlabelled = {"title": "Intern", "company_name": "Plain Co",
                  "apply_url": "https://boards.greenhouse.io/plain/jobs/1"}
    quant = {"title": "Intern", "company_name": "Some Fund",
             "apply_url": "https://jobs.lever.co/somefund/abc"}
    assert label_sectors(reg, [listed, walked, unknown, unlabelled, quant]) == 2
    assert listed["sector"] == "media"
    assert quant["sector"] == "quant_finance", "a quant board's sector is implied, not stored"
    # A sector the fetcher already supplied is never overwritten - that one came from the board
    # we actually asked, and this is a fallback for the listings that arrived with nothing.
    assert walked["sector"] == "nonprofit"
    assert "sector" not in unknown and "sector" not in unlabelled
    # A board whose token differs only by case is the same board.
    upper = {"title": "Intern", "apply_url": "https://boards.greenhouse.io/VoxMedia/jobs/9"}
    assert label_sectors(reg, [upper]) == 1 and upper["sector"] == "media"
    # A dead board still says who its employer is; the listing came from somewhere else regardless.
    reg["greenhouse"]["voxmedia"]["fails"] = 99
    revived = {"title": "Intern", "apply_url": "https://boards.greenhouse.io/voxmedia/jobs/7"}
    assert label_sectors(reg, [revived]) == 1

    # And the label is what rescues a title no rule could read: "Intern" alone classifies as other.
    row = normalize(board_item({"name": "Vox Media", "sector": "media"}, source="x", title="Intern",
                               locations=["Boston, MA"],
                               url="https://boards.greenhouse.io/voxmedia/jobs/4321"))
    assert row["field_tags"] == ["media"]


def test_a_university_board_is_labelled_from_the_employers_own_name():
    # Every one of these was sitting unlabelled in the registry.
    for name in ("Ohio State University", "Ivy Tech Community College", "Dallas College",
                 "Stevens Institute of Technology", "Worcester Polytechnic Institute",
                 "University System of New Hampshire", "The University of Edinburgh"):
        assert sector_from_name(name) == "education_research", name
    # A university health system hires nurses: health wins over education in the same name.
    for name in ("St. Luke's University Health Network", "Cooper University Health Care",
                 "Medical University of South Carolina", "University Health Network"):
        assert sector_from_name(name) == "health", name
    # An endowment arm is neither, and a name cannot settle which, so it is left alone.
    assert sector_from_name("University of Virginia Investment Management Company (UVIMCO)") is None
    # Names that say nothing about a sector stay saying nothing. "Universal" is not "university",
    # and "Collegiate" is not "college", which is why both patterns are anchored on word breaks.
    for name in ("Universal Studios", "Stripe", "Collegiate Peaks Bank", "", "Vox Media"):
        assert sector_from_name(name) is None, name


def test_labelling_boards_by_name_never_argues_with_a_sector_we_already_have():
    reg = {}
    add_board(reg, "workday", "osu|wd1|osucareers", "Ohio State University")
    add_board(reg, "icims", "careers-cooperhealth", "Cooper University Health Care")
    add_board(reg, "greenhouse", "voxmedia", "Vox Media")
    # A seeded sector stands, even where the name would have suggested a different one.
    add_board(reg, "workday", "musc|wd1|musc", "Medical University of South Carolina",
              sector="education_research")
    # A quant board is already labelled quant_finance by add_board, so it is already protected.
    add_board(reg, "lever", "somefund", "Some University Endowment Fund", quant=True)
    assert label_boards(reg) == 2
    assert reg["workday"]["osu|wd1|osucareers"]["sector"] == "education_research"
    assert reg["icims"]["careers-cooperhealth"]["sector"] == "health"
    assert "sector" not in reg["greenhouse"]["voxmedia"]
    assert reg["workday"]["musc|wd1|musc"]["sector"] == "education_research"
    assert reg["lever"]["somefund"]["sector"] == "quant_finance"
    # Idempotent: a second pass has nothing left to do.
    assert label_boards(reg) == 0
    # And the label reaches a listing found off-board, which is the point of doing it at all.
    item = {"title": "Intern",
            "apply_url": "https://careers-cooperhealth.icims.com/jobs/1234/intern/job"}
    assert label_sectors(reg, [item]) == 1
    assert item["sector"] == "health"


# The real thing, from blackrock.wd1.myworkdayjobs.com on 2026-09-18: a tenant naming its own
# sites, three of them, one open.
_BLACKROCK = """Sitemap: https://blackrock.wd1.myworkdayjobs.com/BlackRock_Professional/siteMap.xml

User-agent: *
Allow: /BlackRock_Professional/
Disallow: /BlackRock_AIG/
Disallow: /BlackRock_Early_Careers_Program/
Disallow: /refreshFacet/
"""


def test_a_workday_tenant_names_its_own_sites_in_robots():
    # The half of a Workday token that no rule could guess is not guessed: the tenant publishes
    # it. refreshFacet is an API path, not a site, and the two closed boards stay closed.
    from internscout.probe import wd_sites

    assert wd_sites(_BLACKROCK) == ["BlackRock_Professional"]
    assert wd_sites("User-agent: *\nAllow: /Careers/\nAllow: /Faculty/\n") == ["Careers", "Faculty"]
    assert wd_sites("") == []


class _WdTenant:
    """A Workday pod: one tenant exists, with one site that has postings on it."""

    def __init__(self, tenant, robots, jobs_on=()):
        self.tenant, self.robots, self.jobs_on = tenant, robots, set(jobs_on)
        self.tried = []

    def get(self, url, params=None):
        live = url.startswith("https://%s.wd1." % self.tenant)
        body, code = (self.robots, 200) if live else ("", 422)
        return type("R", (), {"status_code": code, "text": body})()

    def post(self, url, headers=None, json=None):
        site = url.split("/")[-2]
        self.tried.append(site)
        posts = [{"title": "Intern"}] if site in self.jobs_on else []
        return type("R", (), {"status_code": 200,
                              "json": lambda s, p=posts: {"jobPostings": p}})()


def test_the_workday_probe_returns_the_whole_token():
    # Every other probe answers True and the slug is the token. Workday's is a triple, and the
    # tenant is the squashed name with the suffixes off - Chamberlain Group is chamberlain.
    from internscout.probe import _workday

    pod = _WdTenant("chamberlain", _BLACKROCK, jobs_on=["BlackRock_Professional"])
    assert _workday(pod, "chamberlain", "Chamberlain Group") == "chamberlain|wd1|BlackRock_Professional"


def test_the_workday_probe_never_asks_a_site_the_tenant_closed():
    # The same robots.txt that tells us the site names tells us which of them to leave alone,
    # and a probe that ignored it would be the one thing reintroducing boards we just dropped.
    from internscout.probe import _workday

    pod = _WdTenant("blackrock", _BLACKROCK, jobs_on=["BlackRock_Early_Careers_Program"])
    assert _workday(pod, "blackrock", "BlackRock") is False
    assert pod.tried == ["BlackRock_Professional"], "only the open site may be asked"


def test_the_workday_probe_wants_the_exact_squashed_name_and_a_board_with_jobs():
    from internscout.probe import _workday

    pod = _WdTenant("chamberlain", _BLACKROCK, jobs_on=["BlackRock_Professional"])
    assert _workday(pod, "chamberlain-group", "Chamberlain Group") is False   # the hyphen slug
    assert pod.tried == [], "a slug that cannot be a tenant costs no requests at all"
    empty = _WdTenant("chamberlain", _BLACKROCK)
    assert _workday(empty, "chamberlain", "Chamberlain Group") is False       # answers, no jobs


def test_a_miss_cached_before_the_probes_last_grew_is_asked_again():
    from datetime import timedelta
    from internscout.probe import PROBES_CHANGED, candidates
    changed = date.fromisoformat(PROBES_CHANGED)
    items = [{"company_name": n, "apply_url": "https://careers.example.com/x"}
             for n in ("Old Miss", "New Miss")]
    cache = {"oldmiss": (changed - timedelta(days=1)).isoformat(),   # asked before the new probe
             "newmiss": changed.isoformat()}                          # asked with it
    assert candidates({}, items, cache, changed + timedelta(days=1)) == ["Old Miss"]
