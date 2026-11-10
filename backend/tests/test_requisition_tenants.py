"""Observed October 24 duplicates: tenant identity wins over display-name spelling."""
from datetime import date
import pytest
from internscout.dedupe import merge_batch, posting_key, recognized_icims_hosts, requisition_identity
from internscout.export_static import carry_open_boards, carry_search_finds
from internscout.normalize import normalize, listing_id
from internscout.sources.common import board_item

GDMS = "https://careers-gdms.icims.com/jobs/75478/software-engineer-intern-for-crypto-and-cross-domain-solutions/job"
LEIDOS = "https://leidos.wd5.myworkdayjobs.com/External/job/Huntsville-AL/AI-ML-Intern_R-00195168"
TRC = "https://careers.trccompanies.com/jobs/26840"
UUID = "12345678-1234-1234-1234-123456789abc"


def item(company, url, *, source="workday", title="Software Engineer Intern Summer 2027"):
    return normalize(board_item({"name": company}, source=source, title=title,
        locations=["Boston, MA"], url=url, employment_type="Intern"))


@pytest.mark.parametrize("url,source,employer,alias", [
    (GDMS, "icims", "General Dynamics Mission Systems, Inc.", "General Dynamics Mission Systems"),
    (LEIDOS, "workday", "Kudu Dynamics", "Leidos"),
    (TRC, "icims_site", "TRC Companies", "TRC"),
])
def test_exact_tenant_job_folds_alias_to_employer_source_without_alias_dictionary(url, source, employer, alias):
    own = item(employer, url, source=source)
    own["description"] = "Employer details"
    listed = item(alias, url + ("?icims=1" if source == "icims_site" else ""), source="simplify",
                  title="Software Internship Summer 2027")
    for batch in ([own, listed], [listed, own]):
        result = merge_batch(batch)
        assert len(result) == 1
        kept = next(iter(result.values()))
        assert kept["company_name"] == employer
        assert kept["description"] == "Employer details"
        assert {s for s, _ in kept["_sources"]} == {source, "simplify"}


def test_equal_authority_alias_choice_is_deterministic_in_both_arrival_orders():
    rows = [item("General Dynamics Mission Systems, Inc.", GDMS, source="icims"),
            item("General Dynamics Mission Systems", GDMS, source="icims")]
    a = next(iter(merge_batch(rows).values()))
    b = next(iter(merge_batch(list(reversed(rows))).values()))
    assert a["dedupe_key"] == b["dedupe_key"]
    assert a["company_name"] == b["company_name"]


@pytest.mark.parametrize("urls", [
    ("https://careers-a.icims.com/jobs/123/a/job", "https://careers-b.icims.com/jobs/123/a/job"),
    ("https://a.fa.us2.oraclecloud.com/en/sites/CX/job/123", "https://b.fa.us2.oraclecloud.com/en/sites/CX/job/123"),
    ("https://x.wd1.myworkdaysite.com/recruiting/tenant-a/site/job/NY/Intern_R123",
     "https://x.wd1.myworkdaysite.com/recruiting/tenant-b/site/job/NY/Intern_R123"),
    (f"https://jobs.lever.co/a/{UUID}", f"https://jobs.lever.co/b/{UUID}"),
    (f"https://jobs.ashbyhq.com/a/{UUID}", f"https://jobs.ashbyhq.com/b/{UUID}"),
    ("https://jobs.smartrecruiters.com/a/123456789-intern", "https://jobs.smartrecruiters.com/b/123456789-intern"),
    ("https://careers-a.icims.com/jobs/123/a/job", "https://careers-a.icims.com/jobs/456/a/job"),
    ("https://jobs.smartrecruiters.com/123456789Corp/111111111-intern", "https://jobs.smartrecruiters.com/123456789Corp/222222222-intern"),
    (f"https://jobs.lever.co/{UUID}/11111111-1111-1111-1111-111111111111", f"https://jobs.lever.co/{UUID}/22222222-2222-2222-2222-222222222222"),
])
def test_equal_numbers_or_uuids_do_not_cross_distinct_tenants_or_requisitions(urls):
    # Same display company intentionally: the observed tenant path must establish separation.
    rows = [item("Example", url) for url in urls]
    assert len({posting_key(row) for row in rows}) == 2
    assert len(merge_batch(rows)) == 2


@pytest.mark.parametrize("domain,job_a,job_b", [
    ("jobs.lever.co", "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"),
    ("jobs.ashbyhq.com", "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"),
    ("jobs.smartrecruiters.com", "111111111", "222222222"),
])
def test_normal_distinct_requisitions_keep_main_disambiguation_and_public_ids(domain, job_a, job_b):
    rows = [item("Example", f"https://{domain}/ordinary-tenant/{job}") for job in (job_a, job_b)]
    prefix, season, year = rows[0]["dedupe_key"].rsplit("|", 2)
    expected = {f"{prefix} [req:{domain}:{job}]|{season}|{year}" for job in (job_a, job_b)}
    merged = merge_batch(rows)
    assert set(merged) == expected
    assert {listing_id(key) for key in merged} == {listing_id(key) for key in expected}


def test_shared_greenhouse_id_keeps_company_collision_guard_and_generic_boards_stay_separate():
    gh = "https://boards.greenhouse.io/board-a/jobs/123"
    assert len(merge_batch([item("Employer A", gh), item("Employer B", gh.replace("board-a", "board-b"))])) == 2
    # An unscoped custom/embed id does not prove a board tenant across different company labels.
    custom = "https://careers.example.com/open?gh_jid=123"
    assert len(merge_batch([item("Employer A", custom), item("Employer B", custom)])) == 2
    generic = "https://careers.example.com/jobs"
    assert len(merge_batch([item("Example", generic), item("Example", generic, title="Data Intern Summer 2027")])) == 2


def test_explicit_greenhouse_tenant_folds_aliases_but_ambiguous_custom_cannot_bridge_boards():
    a = item("Varda Space Industries", "https://job-boards.greenhouse.io/vardaspace/jobs/8010682003", source="greenhouse")
    b = item("Varda Space", "https://boards.greenhouse.io/vardaspace/jobs/8010682003", source="simplify")
    assert len(merge_batch([a, b])) == 1
    # Exact same company/id is observed on two distinct board tenants: the third row stays unknown.
    a = item("Example", "https://boards.greenhouse.io/board-a/jobs/123", source="greenhouse")
    b = item("Example", "https://boards.greenhouse.io/board-b/jobs/123", source="greenhouse")
    c = item("Example", "https://careers.example.com/open?gh_jid=123", source="simplify")
    assert len(merge_batch([a, b, c])) == 3
    assert len(merge_batch([c, b, a])) == 3
    assert len(merge_batch([a, c])) == 1  # one observed board gives this exact company/id context
    assert requisition_identity("https://boards.greenhouse.io/a/jobs/123?gh_jid=456") is None


def test_custom_icims_requires_exact_marker_or_trusted_adapter_evidence():
    unknown = item("Example", "https://unknown.example.com/jobs/123", source="simplify")
    assert requisition_identity(unknown["apply_url"]) is None
    assert not recognized_icims_hosts([unknown])
    for query in ("?icims=10", "?tracking=icims%3D1", "?token=123", "?icims=true"):
        assert requisition_identity(unknown["apply_url"] + query) is None
    own = item("Example", TRC, source="icims_site")
    hosts = recognized_icims_hosts([own])
    assert hosts == {"careers.trccompanies.com"}
    assert requisition_identity(TRC, icims_hosts=hosts) == requisition_identity(TRC + "?icims=1")
    assert requisition_identity("https://unrelated.example.com/jobs/26840", icims_hosts=hosts) is None
    assert requisition_identity("https://careers.trccompanies.com/careers?icims=1") is None


@pytest.mark.parametrize("carry", [carry_open_boards, carry_search_finds])
@pytest.mark.parametrize("url,ats,scan_sources", [(GDMS, "icims", []), (LEIDOS, "workday", ["workday"]),
                                               (TRC, "other", ["icims_site"])])
def test_fresh_tenant_job_blocks_alias_carry_without_guessing_company_equivalence(carry, url, ats, scan_sources):
    fresh = {"id": "new", "company_name": "Employer", "apply_url": url, "ats": ats,
             "scan_sources": scan_sources, "status": "open"}
    stale = {**fresh, "id": "old", "company_name": "Employer Former Label", "via_search": True,
             "apply_url": url + ("?icims=1" if url == TRC else "?source=community"),
             "title": "Software Intern", "stage": ["internship"], "last_seen": "2026-10-24"}
    assert carry([fresh], "unused", today=date(2026, 10, 24), prev=[stale], observed_urls=[url]) == 0
