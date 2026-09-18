from datetime import date

from internscout import companies_seed
from internscout.dedupe import merge_batch
from internscout.discover import add_board, relabel_sector, seed_registry, set_location
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
