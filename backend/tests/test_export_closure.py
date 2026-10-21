"""Offline: the published site follows the same scan evidence the database closes by.

CI rebuilds its database every run, so whether a missing posting stays on the site is decided by
export_static's carry rules. These tests drive run_ingest.main end to end (fake Workday API, a new
SQLite database per run, the previous export on disk) and check that a board read to its end loses
its missing roles while a failed or capped board keeps them carried, as before.
"""
import json
import sys

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from internscout import export_static, pipeline, run_ingest
from internscout.db import Base
from internscout.export_static import carry_open_boards, carry_search_finds, previous_export
from internscout.sources import common

TOKEN = "acme|wd1|Careers"
ROLES = ["Software Engineer Intern", "Data Science Intern", "Mechanical Engineering Intern",
         "Finance Intern"]


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    common._ROBOTS.clear()
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)
    monkeypatch.setattr(sys, "argv", ["run_ingest", "--ats"])
    for name in ("seed_registry", "discover", "probe_boards", "label_boards", "label_sectors",
                 "prune", "refused_count"):
        monkeypatch.setattr(run_ingest, name, lambda *a: 0)
    for name in ("save_registry", "save_cache"):
        monkeypatch.setattr(run_ingest, name, lambda *a: None)
    yield
    common._ROBOTS.clear()


def fake_workday(titles, mode="complete"):
    def handle(request):
        if request.method != "POST":
            return httpx.Response(404)          # no robots.txt, no detail pages
        if mode == "failed":
            return httpx.Response(503)
        body = json.loads(request.content)
        rows = list(titles) if body["searchText"] == "intern" else []
        if mode == "capped" and body["searchText"] == "intern":
            rows += ["Internal Audit Manager"] * 500   # the read stops early, before the total
        off, lim = body["offset"], body["limit"]
        page = [{"title": t, "externalPath": f"/job/Boston/{t.replace(' ', '-')}_R{i}",
                 "locationsText": ("2 Locations" if mode == "detail_failed" or
                                   (mode == "one_detail_failed" and i == 0) else "Boston, MA")}
                for i, t in enumerate(rows[off:off + lim], off)]
        return httpx.Response(200, json={"total": len(rows), "jobPostings": page} if off == 0
                              else {"total": 0, "jobPostings": page})
    return handle


def ingest(monkeypatch, tmp_path, run_no, titles, mode="complete", community=None):
    """One CI run: a new database, the Workday board answering as told, then the export."""
    engine = create_engine(f"sqlite:///{tmp_path / f'run{run_no}.db'}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    for mod in (pipeline, export_static):
        monkeypatch.setattr(mod, "SessionLocal", sessions)
        monkeypatch.setattr(mod, "init_db", lambda: None)
    monkeypatch.setattr(run_ingest, "load_registry",
                        lambda: {"workday": {TOKEN: {"name": "Acme", "fails": 0}}})
    monkeypatch.setattr(run_ingest, "client",
                        lambda: httpx.Client(transport=httpx.MockTransport(fake_workday(titles, mode))))
    out = tmp_path / "site"
    if community is not None:
        monkeypatch.setattr(run_ingest, "fetch_github_lists", lambda **kw: community)
    monkeypatch.setattr(sys, "argv", ["run_ingest", "--lists" if community is not None else "--ats",
                                     "--export", str(out)])
    run_ingest.main()
    engine.dispose()
    published = {x["title"]: x for x in previous_export(str(out)) if x.get("status") == "open"}
    report = json.loads((out / "ingest-report.json").read_text(encoding="utf-8"))
    return published, report


def test_a_role_gone_from_a_fully_scanned_workday_board_leaves_the_site(monkeypatch, tmp_path):
    published, _ = ingest(monkeypatch, tmp_path, 1, ROLES)
    assert set(published) == set(ROLES)
    # Three of four roles closed. Before, that read as a collapsed fetch and all three were carried.
    published, report = ingest(monkeypatch, tmp_path, 2, ROLES[:1])
    assert set(published) == {ROLES[0]}
    assert report["export"]["held"] == 0
    assert report["boards"]["workday"]["complete"] == 1


def test_the_same_board_failing_keeps_its_roles_carried(monkeypatch, tmp_path):
    ingest(monkeypatch, tmp_path, 1, ROLES)
    published, report = ingest(monkeypatch, tmp_path, 2, [], mode="failed")
    assert set(published) == set(ROLES)
    assert all(x.get("carried") for x in published.values())
    assert report["export"]["held"] == 4


def test_a_capped_scan_is_not_evidence_and_keeps_the_carry(monkeypatch, tmp_path):
    ingest(monkeypatch, tmp_path, 1, ROLES)
    published, report = ingest(monkeypatch, tmp_path, 2, ROLES[:1], mode="capped")
    assert set(published) == set(ROLES)
    assert {t for t, x in published.items() if x.get("carried")} == set(ROLES[1:])
    assert "complete" not in report["boards"]["workday"]


def test_a_fully_scanned_empty_board_empties_on_the_site(monkeypatch, tmp_path):
    ingest(monkeypatch, tmp_path, 1, ROLES)
    published, _ = ingest(monkeypatch, tmp_path, 2, [])
    assert published == {}


@pytest.mark.parametrize("mode,held", [("detail_failed", 4), ("one_detail_failed", 1)])
def test_observed_postings_survive_detail_failure_even_without_board_collapse(monkeypatch, tmp_path, mode, held):
    before, _ = ingest(monkeypatch, tmp_path, 1, ROLES)
    assert all(row["scan_sources"] == ["workday"] for row in before.values())
    after, report = ingest(monkeypatch, tmp_path, 2, ROLES, mode=mode)
    assert set(after) == set(ROLES)
    assert report["export"]["held"] == held
    assert report["boards"]["workday"]["complete"] == 1
    for title, row in after.items():
        if row.get("carried"):
            assert row["last_seen"] == before[title]["last_seen"]


def test_observed_metadata_failure_does_not_save_genuinely_absent_roles(monkeypatch, tmp_path, capsys):
    ingest(monkeypatch, tmp_path, 1, ROLES)
    after, report = ingest(monkeypatch, tmp_path, 2, ROLES[:2], mode="detail_failed")
    assert set(after) == set(ROLES[:2])
    assert report["export"]["held"] == 2
    assert "[export] 2 listings from the last export left the site" in capsys.readouterr().out


@pytest.mark.parametrize("count", [1, 4])
def test_community_only_roles_survive_keyword_scan_in_fresh_database(monkeypatch, tmp_path, count):
    raw = [{"company_name": "Acme", "title": f"Summer Analyst {i}",
            "locations": ["Boston, MA"], "source": "vanshb03",
            "url": f"https://acme.wd1.myworkdayjobs.com/Careers/job/Boston/Analyst_R{i}"}
           for i in range(count)]
    before, _ = ingest(monkeypatch, tmp_path, 1, [], community=raw)
    assert len(before) == count
    assert all(row["scan_sources"] == [] for row in before.values())
    after, report = ingest(monkeypatch, tmp_path, 2, [])
    assert set(after) == set(before)
    assert report["export"]["held"] == count


def test_a_full_board_scan_still_closes_community_only_finds():
    from datetime import date
    prev = [_row(1, "https://boards.greenhouse.io/acme/jobs/1", ats="greenhouse", scan_sources=[])]
    rows = []
    assert carry_open_boards(rows, "unused", today=date(2026, 10, 18), prev=prev,
                             completed_boards={("greenhouse", "acme")}) == 0
    assert export_static.closed_by_scan(rows, prev, {("greenhouse", "acme")}) == 1


def test_scope_unknown_in_legacy_export_is_retained_but_not_counted_closed():
    from datetime import date
    row = _row(1, "https://acme.wd1.myworkdayjobs.com/Careers/job/Boston/Intern_R1")
    row.pop("scan_sources")
    rows = []
    evidence = {("workday", TOKEN)}
    assert carry_open_boards(rows, "unused", today=date(2026, 10, 18), prev=[row],
                             completed_boards=evidence) == 1
    assert export_static.closed_by_scan([], [row], evidence) == 0


def test_raw_observations_match_locale_and_tracking_variants():
    from datetime import date
    url = "https://acme.wd1.myworkdayjobs.com/Careers/job/Boston/Intern_R1"
    row = _row(1, url)
    observed = {url.replace("/Careers/", "/en-US/Careers/") + "?source=community"}
    evidence = {("workday", TOKEN)}
    assert carry_open_boards([], "unused", today=date(2026, 10, 18), prev=[row],
                             completed_boards=evidence, observed_urls=observed) == 1
    assert export_static.closed_by_scan([], [row], evidence, observed_urls=observed) == 0


# Unit level: the carry rules with and without evidence.

def _row(i, url, **over):
    row = {"id": str(i), "apply_url": url, "ats": "workday", "company_name": "Acme",
           "status": "open", "first_seen": "2026-10-16T00:00:00+00:00",
           "last_seen": "2026-10-18T00:00:00+00:00", "regions": [], "state": "MA",
           "title": f"Software Engineer Intern {i}", "stage": ["internship"],
           "scan_sources": [] if over.get("via_search") else ["workday"]}
    row.update(over)
    return row


def _workday_prev():
    return [_row(i, f"https://acme.wd1.myworkdayjobs.com/Careers/job/Boston/Intern_R{i}") for i in range(5)]


def test_carry_skips_a_board_with_evidence_and_keeps_others():
    from datetime import date
    prev = _workday_prev() + [_row(10 + i, f"https://other.wd5.myworkdayjobs.com/Jobs/job/X_R{i}",
                                   company_name="Other") for i in range(4)]
    listings = [dict(prev[0])]
    held = carry_open_boards(listings, "unused", today=date(2026, 10, 18), prev=prev,
                             completed_boards={("workday", "ACME|wd1|Careers")})
    assert held == 4   # Other's four, which no complete scan vouched for
    assert {x["company_name"] for x in listings if x.get("carried")} == {"Other"}
    listings = [dict(prev[0])]
    assert carry_open_boards(listings, "unused", today=date(2026, 10, 18), prev=prev) == 8


def test_search_finds_drop_only_on_full_list_evidence():
    from datetime import date
    gh = _row(1, "https://boards.greenhouse.io/acme/jobs/1", ats="greenhouse", via_search=True)
    wd = _row(2, "https://acme.wd1.myworkdayjobs.com/Careers/job/Boston/Analyst_R2", via_search=True)
    evidence = {("greenhouse", "acme"), ("workday", TOKEN)}
    listings = []
    held = carry_search_finds(listings, "unused", today=date(2026, 10, 18), prev=[gh, wd],
                              completed_boards=evidence)
    # Greenhouse lists the whole board, so the search find is gone. A Workday keyword search may
    # never have asked for the title a search engine found, so that one is still carried.
    assert held == 1 and listings[0]["apply_url"] == wd["apply_url"]
