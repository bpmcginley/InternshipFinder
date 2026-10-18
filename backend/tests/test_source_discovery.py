"""Offline discovery tests: coverage worklist, source provenance and registry boundaries."""
from datetime import date
import importlib.util
import json
from pathlib import Path

import httpx
import pytest

from internscout.source_discovery import (DiscoveryClient, RequestBudgetExceeded, _blocked,
    admit_verified, board_candidates, discovery_plan, scan_target, starter_targets,
    validate_targets, verify_boards)
from internscout.sources.common import RobotsDisallowed


def target(**kwargs):
    return {"name": "Example University", "country": "CA", "jurisdiction": "MB",
            "sector": "education_research", "official_url": "https://university.example/careers",
            **kwargs}


def client(routes, max_requests=200):
    calls = []
    def handle(request):
        url = str(request.url)
        calls.append(url)
        if url in routes:
            status, body, headers = routes[url]
            return httpx.Response(status, text=body, headers=headers)
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        raise AssertionError(f"unexpected request: {url}")
    raw = httpx.Client(transport=httpx.MockTransport(handle))
    return DiscoveryClient(raw, max_requests=max_requests), calls


def test_worklist_includes_all_jurisdictions_and_every_sector():
    rows = discovery_plan()
    assert len(rows) == 65 * 5  # 50 states + DC + PR + 13 Canadian jurisdictions
    assert len({(r["country"], r["jurisdiction"]) for r in rows}) == 65
    assert len(discovery_plan({"MB", "CA"})) == 10
    assert any("stagiaire" in q for r in discovery_plan({"QC"}) for q in r["queries"])
    assert all(r["status"] == "needs_research" for r in rows)


def test_official_starters_are_targets_without_guessed_ats_tokens():
    targets = validate_targets(starter_targets())
    assert len(targets) == 16
    assert {"MB", "SK", "NS", "NB", "NL", "NT", "NU", "YT"} <= {t["jurisdiction"] for t in targets}
    assert all(t["extraction"] == "unverified" and "ats_token" not in t for t in targets)


@pytest.mark.parametrize("bad", [target(country="US", jurisdiction="MB"),
    target(official_url="http://university.example/careers"),
    target(official_url="https://user:secret@university.example/"), target(sector="anything"), {}])
def test_invalid_target_fails_before_network(bad):
    with pytest.raises(ValueError):
        validate_targets([bad])


def test_extract_real_links_embeds_and_deduplicate_boards_without_guessing():
    body = '''<a href="https://job-boards.greenhouse.io/real/jobs/123">Job</a>
    <iframe src="https://boards.greenhouse.io/real"></iframe>
    <a href="https://university.example/?next=https://jobs.lever.co/fake">Bad</a>
    <a href="https://jobs.lever.co.evil.example/nope">Bad</a>
    <a href="https://tenant.wd3.myworkdayjobs.com/en-US/External">Career</a>
    <script src="https://jobs.ashbyhq.com/research/embed"></script>'''
    rows = board_candidates(body, "https://university.example/careers")
    assert [(r["ats"], r["token"]) for r in rows] == [
        ("greenhouse", "real"), ("workday", "tenant|wd3|External"), ("ashby", "research")]
    assert all(r["extraction"] == "unverified" for r in rows)


def test_scan_follows_only_first_level_career_links_and_page_limit():
    c, calls = client({
        "https://university.example/careers": (200, '''<a href="/student/jobs">Student</a>
            <a href="/careers/another">Another</a><a href="/privacy">Privacy</a>
            <a href="https://other.example/privacy">External unrelated</a>''', {"content-type": "text/html"}),
        "https://university.example/student/jobs": (200, '''<a href="https://jobs.lever.co/actual">Apply</a>
            <a href="/careers/deeper">More</a>''', {"content-type": "text/html"})})
    result = scan_target(c, target(), max_pages=2)
    assert result["access"] == "public"
    assert result["extraction"] == "ats_links_found"
    assert [b["token"] for b in result["boards"]] == ["actual"]
    assert calls == ["https://university.example/robots.txt", "https://university.example/careers",
                     "https://university.example/student/jobs"]


def test_scan_follows_officially_linked_external_career_portal():
    c, calls = client({
        "https://university.example/careers": (200,
            '<a href="https://careers.university.example/">Jobs</a>', {"content-type": "text/html"}),
        "https://careers.university.example/": (200,
            '<a href="https://tenant.wd3.myworkdayjobs.com/External">Open roles</a>',
            {"content-type": "text/html"})})
    result = scan_target(c, target(), max_pages=2)
    assert result["boards"][0]["token"] == "tenant|wd3|External"
    assert result["boards"][0]["discovered_from"] == "https://careers.university.example/"
    assert len(calls) == 4


def test_branded_successfactors_requires_real_platform_script():
    url = "https://jobs.province.example/home"
    assert board_candidates("SuccessFactors student requisition guide", url) == []
    rows = board_candidates('<script src="/platform/js/j2w/min/j2w.core.min.js"></script>', url)
    assert rows[0]["ats"] == "successfactors"
    assert rows[0]["token"] == "jobs.province.example"
    assert board_candidates('<script src="https://other.example/platform/js/j2w/core.js"></script>', url) == []


def test_robots_block_redirect_destination_before_request():
    c, calls = client({
        "https://university.example/careers": (302, "", {"location": "https://blocked.example/jobs"}),
        "https://blocked.example/robots.txt": (200, "User-agent: *\nDisallow: /jobs", {})})
    result = scan_target(c, target())
    assert result["pages"][0]["status"] == "robots_blocked_or_unavailable"
    assert "https://blocked.example/jobs" not in calls
    assert not result["boards"]


def test_robots_patterns_allow_override_and_failure_is_not_permission():
    assert _blocked([("disallow", "/jobs/*?apply$")], "/jobs/123?apply")
    assert not _blocked([("disallow", "/"), ("allow", "/careers")], "/careers")
    c, calls = client({"https://university.example/robots.txt": (503, "", {})})
    with pytest.raises(RobotsDisallowed):
        c.get("https://university.example/careers")
    assert len(calls) == 1


def test_request_budget_includes_robots_and_adapter_traffic():
    c, calls = client({}, max_requests=1)
    with pytest.raises(RequestBudgetExceeded):
        c.get("https://university.example/careers")
    assert len(calls) == 1 and c.remaining == 0


def verified_result():
    return {**target(employer_identity_reviewed=True), "boards": [{"ats": "lever", "token": "actual",
        "board_url": "https://jobs.lever.co/actual", "access": "public", "extraction": "verified",
        "parsed_opportunities": 2, "verified_on": date.today().isoformat()}]}


def test_only_fresh_verified_identity_reviewed_boards_admitted_and_duplicate_safe():
    registry = {}
    assert len(admit_verified(registry, [verified_result()])) == 1
    assert registry["lever"]["actual"]["sector"] == "education_research"
    assert admit_verified(registry, [verified_result()]) == []
    for field, value in [("extraction", "unverified"), ("access", "robots_blocked_or_unavailable"),
                         ("parsed_opportunities", 0), ("verified_on", "2000-01-01")]:
        result = verified_result()
        result["boards"][0][field] = value
        assert admit_verified({}, [result]) == []
    result = verified_result()
    result.pop("employer_identity_reviewed")
    assert admit_verified({}, [result]) == []
    result = verified_result()
    result["boards"].append({**result["boards"][0], "token": "different"})
    assert admit_verified({}, [result]) == []  # directory identity cannot label every employer


def test_board_verification_records_empty_and_failures_without_calling_them_dead():
    c, _ = client({})
    result = verified_result()
    verify_boards(c, result, {"lever": lambda *_: [{"title": "Summer Student", "url": "https://jobs.lever.co/actual/123"}]})
    assert result["boards"][0]["extraction"] == "verified"
    assert result["boards"][0]["parsed_opportunities"] == 1
    verify_boards(c, result, {"lever": lambda *_: []})
    assert result["boards"][0]["extraction"] == "no_opportunities_parsed"
    def blocked(*args):
        raise RobotsDisallowed("actual")
    verify_boards(c, result, {"lever": blocked})
    assert result["boards"][0]["access"] == "robots_blocked_or_unavailable"


def cli_module():
    path = Path(__file__).resolve().parents[1] / "scripts" / "discover_sources.py"
    spec = importlib.util.spec_from_file_location("discover_sources_cli", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_defaults_are_offline_and_registry_stays_untouched(tmp_path, monkeypatch):
    from internscout import discover
    registry = tmp_path / "registry.json"
    registry.write_text('{"keep": {}}')
    monkeypatch.setattr(discover, "REGISTRY_PATH", str(registry))
    def no_network(*args, **kwargs):
        raise AssertionError("default command must stay offline")
    monkeypatch.setattr(httpx.Client, "request", no_network)
    output = tmp_path / "report.json"
    assert cli_module().main(["--jurisdictions", "MB,SD", "--output", str(output)]) == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["requests"] == 0 and report["mode"] == "offline_plan"
    assert len(report["plan"]) == 10
    assert registry.read_text() == '{"keep": {}}'


@pytest.mark.parametrize("args", [["--apply"], ["--verify"], ["--max-requests", "0"],
                                    ["--jurisdictions", "ZZ"]])
def test_cli_rejects_invalid_modes_and_limits(args):
    with pytest.raises(SystemExit) as error:
        cli_module().main(args)
    assert error.value.code == 2
