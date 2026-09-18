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
