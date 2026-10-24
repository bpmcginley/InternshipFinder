"""2026-10-23 audit regressions: verified identity, fractional duration, domain and pay."""
from datetime import date
import pytest
from internscout.dedupe import merge_batch, requisition_identity
from internscout.normalize import extract_duration, extract_salary, normalize
from internscout.classify import classify
from internscout.pay import placeholder_pay
from internscout.sources.common import board_item
from internscout.export_static import carry_open_boards, carry_search_finds, _listing_dict, discard_placeholder_paid_claims
from internscout.models import Listing

ORACLE = "https://example.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/2506799"


def posting(title, url=ORACLE, source="oracle"):
    raw = board_item({"name": "Example", "ats_token": "x"}, source=source, title=title,
                     locations=["Boston, MA"], url=url, employment_type="Intern")
    return normalize(raw)


def test_conflicting_terms_same_requisition_keep_employer_facts_and_sources():
    employer = posting("Spring 2027 - Application Intern")
    curated = posting("Applications Intern Summer 2027", source="simplify")
    for rows in ([employer, curated], [curated, employer]):
        merged = merge_batch(rows)
        assert len(merged) == 1
        kept = next(iter(merged.values()))
        assert kept["term"] == "Spring 2027"
        assert kept["title"] == employer["title"]
        assert {s for s, _ in kept["_sources"]} == {"oracle", "simplify"}


def test_distinct_requisitions_and_shared_generic_boards_remain_separate():
    a = posting("Software Intern Summer 2027")
    b = posting("Software Intern Summer 2027", ORACLE.replace("2506799", "2506642"))
    assert len(merge_batch([a, b])) == 2
    board = "https://example.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs"
    assert requisition_identity(board) is None
    assert requisition_identity("https://example.com/careers?token=123") is None
    assert len(merge_batch([posting("Software Intern", board), posting("Data Intern", board)])) == 2


def test_employer_authority_precedes_key_merge_and_latest_board_metadata_wins():
    from datetime import datetime, timezone
    employer = posting("Software Intern Summer 2027")
    curated = {**employer, "source": "simplify", "description": "Community guess"}
    employer["description"] = "Employer description"
    assert next(iter(merge_batch([curated, employer]).values()))["description"] == "Employer description"
    old = posting("Software Intern Fall 2026")
    fresh = posting("Application Intern Spring 2027")
    old["posted_at"] = datetime(2026, 9, 1, tzinfo=timezone.utc)
    fresh["posted_at"] = datetime(2026, 10, 1, tzinfo=timezone.utc)
    merged = merge_batch([old, fresh])
    assert len(merged) == 1
    assert next(iter(merged.values()))["term"] == "Spring 2027"


def test_fresh_locale_requisition_does_not_restore_stale_carried_title_or_term():
    fresh = {"id": "fresh", "apply_url": ORACLE, "company_name": "Example", "ats": "oracle", "status": "open"}
    stale = {**fresh, "id": "old", "apply_url": ORACLE.replace("/en/", "/fr/"),
             "title": "Summer Software Intern", "stage": ["internship"], "via_search": True,
             "last_seen": "2026-10-23", "first_seen": "2026-10-22", "term": "Summer 2027"}
    for fn in (carry_open_boards, carry_search_finds):
        assert fn([fresh], "unused", today=date(2026, 10, 23), prev=[stale]) == 0


def test_greenhouse_host_embed_and_custom_aliases_reconcile_without_other_employer_loss():
    aliases = ["https://boards.greenhouse.io/acme/jobs/123", "https://job-boards.greenhouse.io/acme/jobs/123",
               "https://careers.acme.com/open?gh_jid=123", "https://boards.greenhouse.io/embed/job_app?token=123"]
    assert {requisition_identity(url) for url in aliases} == {"gh:123"}
    fresh = {"id": "fresh", "apply_url": aliases[0], "company_name": "Acme", "status": "open"}
    stale = {**fresh, "id": "stale", "apply_url": aliases[1], "via_search": True, "stage": ["internship"],
             "title": "Software Intern", "last_seen": "2026-10-23"}
    assert carry_search_finds([fresh], "unused", today=date(2026, 10, 23), prev=[stale]) == 0
    other = {**stale, "company_name": "Other Employer", "apply_url": aliases[1].replace("/acme/", "/other/")}
    assert carry_search_finds([fresh], "unused", today=date(2026, 10, 23), prev=[other]) == 1


@pytest.mark.parametrize("text,want", [("10.5-week opportunity", "10.5 weeks"),
    ("12.5 weeks", "12.5 weeks"), ("10-12-week internship", "10-12 weeks"),
    ("10.5 to 12.5 weeks", "10.5-12.5 weeks"), ("12 weeks", "12 weeks"),
    ("110.5 weeks", None), ("12-10 weeks", None), ("0 weeks", None)])
def test_fractional_duration_and_ranges(text, want):
    assert extract_duration(text) == want


def test_field_domains_without_removing_real_mixed_disciplines():
    assert classify("Intern - Materials Test Engineer - Summer 2027") == ["materials"]
    assert "finance" not in classify("Crypto/Cross Domain Engineering Intern")
    assert "finance" not in classify("Cryptography Software Engineering Intern")
    assert "finance" in classify("Crypto Inventory Operations Intern")
    assert {"materials", "swe"} <= set(classify("Materials Test and Software Engineer Intern"))
    assert {"security", "finance"} <= set(classify("Cryptography and Finance Intern"))
    assert "swe" in classify("Software Test Engineer Intern")


@pytest.mark.parametrize("salary", ["$0.02 /Yr", "$20.00/Yr", "$0 /hr", "$0-$999.99 Hour", "-$20/hr", "$-20/hr"])
def test_invalid_pay_does_not_display_or_establish_paid_claim(salary):
    assert placeholder_pay(salary)
    assert extract_salary("Salary range: " + salary) is None
    row = Listing(company_name="Example", title="Intern", dedupe_key="example|intern||",
                  salary=salary, description="Salary range: " + salary, status="open", source_links=[])
    exported = _listing_dict(row)
    assert exported["salary"] is None
    assert (exported["insights"] or {}).get("pay") != "paid"
    assert row.salary == salary  # operator provenance is retained, never rewritten as invented pay


@pytest.mark.parametrize("salary", ["$5/hour", "$0.01 - $18 Per Hour", "$120k/year", "$20 unknown units", "$1000/Yr"])
def test_unknown_and_real_pay_are_not_guessed_or_discarded(salary):
    assert not placeholder_pay(salary)


@pytest.mark.parametrize("salary", ["$20.00/Yr", "-$20/hr", "$-20/hr"])
def test_description_only_bad_amount_cannot_reintroduce_paid_after_normalization(salary):
    row = Listing(company_name="Example", title="Intern", dedupe_key="example|intern||",
                  salary=None, description="Salary range: " + salary, status="open", source_links=[])
    assert (_listing_dict(row)["insights"] or {}).get("pay") != "paid"
    row.description = "This is a paid internship. Salary range: $20.00/Yr"
    assert _listing_dict(row)["insights"]["pay"] == "paid"  # independent employer wording survives


def test_carried_pay_cleanup_preserves_raw_provenance_dates_and_independent_claims():
    for salary in ("$20/Yr", "$0.02/Yr", "-$20/hr"):
        row = {"carried": True, "salary": salary, "insights": {"pay": "paid", "no_sponsorship": True},
               "last_seen": "2026-10-22", "description": "Salary range: " + salary}
        discard_placeholder_paid_claims([row])
        assert row["insights"] == {"no_sponsorship": True}
        assert row["salary"] == salary and row["last_seen"] == "2026-10-22"
        independent = {**row, "insights": {"pay": "paid"}, "description": "This is a paid internship."}
        discard_placeholder_paid_claims([independent])
        assert independent["insights"]["pay"] == "paid"
