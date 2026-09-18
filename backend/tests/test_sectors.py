from datetime import date

from internscout import companies_seed
from internscout.dedupe import merge_batch
from internscout.discover import add_board, seed_registry
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


def test_sector_fills_untagged_titles():
    co = {"name": "Mass General Brigham", "ats_token": "x", "sector": "health"}
    item = lambda title, c=co: normalize(board_item(c, source="workday", title=title, locations=["Boston, MA"],
                                                    url="https://example.com/1", employment_type="Intern"))
    assert item("Research Intern")["field_tags"] == ["health"]
    assert "health" not in item("Software Engineering Intern")["field_tags"]   # a title match wins
    assert item("Research Intern", dict(co, sector=None))["field_tags"] == ["other"]
