"""2026-10-28: a small static content cohort must add supported facts, not eligibility guesses."""
import json
import re
from datetime import date, datetime, timedelta, timezone

import pytest

from internscout import insights, page_dates, seo_pages, seo_role_details as details


def row(text, **over):
    return dict({"id": "example", "insights": insights.extract(text), "insights_text_version": 2,
                 "keys": {"MA"}}, **over)


def test_literal_mentions_preserve_alternatives_and_dont_promote_preferred_to_required():
    text = ("Graduating between December 2027 and August 2028. Junior or senior students welcome.\n"
            "Python preferred; SQL is a plus.\nThe full job contains other conditions.")
    facts = details.source_facts(row(text), text)
    assert facts == (("Graduation years mentioned", "2027, 2028"),
                     ("Class years mentioned", "junior, senior"), ("Skills mentioned", "Python, SQL"))
    assert "required" not in str(facts) and "eligible" not in str(facts)


@pytest.mark.parametrize("text", [
    "Python is not required.", "No experience with Java required.",
    "Not graduating in 2027. Junior students are not eligible.",
    "Candidates without Python experience are welcome.",
    "Equal opportunity for junior students with Python.",
])
def test_negative_and_unrelated_clauses_do_not_become_posting_facts(text):
    assert details.source_facts(row(text), text) == ()


def test_inferred_class_years_and_graduate_role_start_year_are_not_literal_mentions():
    text = "Completed freshman year. Graduate research internship for Summer 2027."
    r = row(text)
    assert set(r["insights"]["class_standing"]) == {"sophomore", "junior", "senior"}
    r["insights"]["grad_years"] = [2027]
    assert details.source_facts(r, text) == ()


def test_old_or_changed_source_omits_stale_facts_and_accepts_only_canonical_skill_names():
    old = row("Graduating in 2027. Python and SQL.")
    assert details.source_facts(old, "Graduating in 2028. Java preferred.") == ()
    assert details.source_facts(dict(old, insights_text_version=1), "Python and SQL.") == ()
    assert details.source_facts(dict(old, insights_text_version=True), "Python and SQL.") == ()
    old["insights"]["skills"].append({"name": '<script>alert("x")</script>', "level": "required"})
    assert "script" not in str(details.source_facts(old, "Python and SQL."))


@pytest.mark.parametrize("text", ["We help students excel at communication.",
    "You should excel at collaborating with partners.", "React quickly to customer requests.",
    "We value swift delivery.", "Spark your creativity.", "Use .NET and Jira."])
def test_ambiguous_words_and_broad_aliases_are_not_named_as_unmentioned_skills(text):
    assert details.source_facts(row(text), text) == ()


def test_unambiguous_product_names_can_be_named_and_sql_is_not_read_from_nosql():
    text = "Microsoft Excel, React.js, SwiftUI, Apache Spark and NoSQL."
    assert details.source_facts(row(text), text) == (("Skills mentioned", "Excel, NoSQL, React, Spark"),)


def test_skills_are_bounded_sorted_and_source_text_is_not_copied():
    text = "Python, Java, SQL, React, AWS, Docker, Linux. Private employer prose stays on the source page."
    result = details.source_facts(row(text), text)
    assert result == (("Skills mentioned", "AWS, Docker, Java, Linux"),)
    assert "Private employer" not in str(result)
    assert details.source_facts(row(text), text * details.MAX_DESCRIPTION) == ()


def test_sidecars_only_read_once_for_needed_roles_and_fail_closed(tmp_path, monkeypatch):
    root = tmp_path / "data/listings"
    root.mkdir(parents=True)
    text = "Graduating in 2027. Python preferred."
    rows = [row(text), row(text, id="second"), row(text, id="missing", keys={"../outside"})]
    (root / "MA.desc.json").write_text(json.dumps({"example": text, "second": text}), encoding="utf-8")
    # A duplicate multi-state description is unnecessary once the first copy supplied the source.
    (root / "NY.desc.json").write_text(json.dumps({"example": text * 20}), encoding="utf-8")
    rows[0]["keys"].add("NY")
    seen = []
    real_open = open
    def counted(path, *args, **kwargs):
        seen.append(str(path))
        return real_open(path, *args, **kwargs)
    monkeypatch.setattr("builtins.open", counted)
    found = details.load(str(tmp_path), rows)
    assert set(found) == {"example", "second"}
    sidecars = [path for path in seen if path.endswith(".desc.json")]
    assert len(sidecars) == 1 and sidecars[0].endswith("MA.desc.json")
    (root / "MA.desc.json").write_text("{bad json", encoding="utf-8")
    assert details.load(str(tmp_path), [rows[1]]) == {}
    monkeypatch.setattr(details, "MAX_SIDECAR_BYTES", 2)
    assert details.load(str(tmp_path), rows) == {}
    assert details.load(str(tmp_path), []) == {}


def fixture_site(tmp_path):
    data = tmp_path / "data/listings"
    data.mkdir(parents=True)
    text = "Graduating in 2027. Junior or senior students. Python preferred."
    rows = []
    for name, prefix in (("Under Armour", "target"), ("Sonos", "control")):
        for i in range(10):
            r = row(text, id=f"{prefix}-{i}", company_name=name, title=f"Mechanical Intern {i}",
                    field_tags=["mechanical"], stage=["internship"], term="Summer 2027", salary=None,
                    first_seen="2026-09-01T00:00:00", posted_at="2026-09-01T00:00:00", status="open",
                    regions=[{"loc": "Boston, MA", "kind": "x", "state": "MA"}],
                    apply_url=f"https://jobs.example.com/{prefix}-{i}", is_remote=False)
            r.pop("keys")
            rows.append(r)
    (data / "index.json").write_text(json.dumps({"generated_at": "2026-09-23T10:00:00Z",
        "files": {"MA": {"file": "listings/MA.json"}}}), encoding="utf-8")
    (data / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    (data / "MA.desc.json").write_text(json.dumps({r["id"]: text for r in rows}), encoding="utf-8")
    (tmp_path / "data/majors.json").write_text('{"majors":[]}', encoding="utf-8")
    return rows


def test_only_allowlisted_employer_html_changes_not_page_membership_schema_or_controls(tmp_path, monkeypatch):
    fixture_site(tmp_path)
    expected = {p["path"]: p for p in seo_pages.build(str(tmp_path))}
    monkeypatch.setattr(details, "COHORT_PATHS", frozenset())
    original = {p["path"]: p for p in seo_pages.build(str(tmp_path))}
    assert expected.keys() == original.keys()
    changed = [path for path in expected if expected[path]["html"] != original[path]["html"]]
    assert changed == ["/internships/at/under-armour/"]
    for path, p in expected.items():
        assert p["index"] == original[path]["index"]
        assert re.findall(r'<script type="application/ld\+json">(.*?)</script>', p["html"], re.S) == \
            re.findall(r'<script type="application/ld\+json">(.*?)</script>', original[path]["html"], re.S)
    html = expected[changed[0]]["html"]
    assert html.count('class="meta posting-details"') == 10
    assert "Brief posting details are shown for 10 of 10 roles" in html
    assert "not a complete eligibility check" in html
    assert 'href="https://jobs.example.com/target-0"' in html
    assert "Private employer prose" not in html


def test_optional_details_are_escaped_without_changing_application_links():
    text = "Python preferred."
    r = dict(row(text), title="Intern", company_name="Example", field_tags=[], stage=[],
             regions=[], apply_url="https://jobs.example.com/role", first_seen="2026-09-01")
    html = seo_pages.listing_rows([r], datetime(2026, 9, 23, tzinfo=timezone.utc),
                                details={"example": (("Example <label>", 'value <script>&"'),)})
    assert "Example &lt;label&gt;: value &lt;script&gt;&amp;&quot;" in html
    assert '<script>' not in html and 'href="https://jobs.example.com/role"' in html


def test_visible_source_fact_change_updates_only_cohort_content_date(tmp_path, monkeypatch):
    rows = fixture_site(tmp_path)
    monkeypatch.setattr(page_dates, "observed_day", lambda: "2026-09-24")
    def build():
        pages = seo_pages.build(str(tmp_path), seo_pages.live_paths(str(tmp_path / "sitemap.xml")))
        seo_pages.write(str(tmp_path), pages)
        return {p["path"]: p for p in pages}
    before = build()
    same = build()
    assert before["/internships/at/under-armour/"]["lastmod"] == same["/internships/at/under-armour/"]["lastmod"]
    updated = "Graduating in 2028. Junior or senior students. Python preferred."
    rows[0]["insights"] = insights.extract(updated)
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    descriptions = json.loads((tmp_path / "data/listings/MA.desc.json").read_text())
    descriptions[rows[0]["id"]] = updated
    (tmp_path / "data/listings/MA.desc.json").write_text(json.dumps(descriptions), encoding="utf-8")
    after = build()
    assert after["/internships/at/under-armour/"]["lastmod"] == "2026-09-24"
    assert after["/internships/at/sonos/"]["lastmod"] == before["/internships/at/sonos/"]["lastmod"]
    assert after["/internships/mechanical-engineering/"]["lastmod"] == before["/internships/mechanical-engineering/"]["lastmod"]


def test_cohort_version_tracks_export_contract():
    from internscout.export_static import INSIGHTS_TEXT_VERSION
    assert details.INSIGHTS_VERSION == INSIGHTS_TEXT_VERSION


def test_full_source_export_is_bounded_separate_from_slim_rows_and_description_cap(tmp_path):
    from internscout.export_static import _listing_dict, write_shards, DESC_CHARS
    from internscout.models import Listing
    text = "Employer background. " * 120 + "\nGraduating in 2027 or 2028. Python preferred."
    r = Listing(company_name="Under Armour", title="Intern", dedupe_key="ua|intern||",
                description=text, status="open", apply_url="https://jobs.example.com/intern",
                location_raw="Boston, MA", source_links=[])
    exported = _listing_dict(r)
    assert len(exported["description"]) == DESC_CHARS
    assert "Graduating" not in exported["description"]
    assert exported["posting_details"]["source_chars"] == len(text)
    assert details.recorded_facts(exported, exported["posting_details"]) == (
        ("Graduation years mentioned", "2027, 2028"), ("Skills mentioned", "Python"))
    write_shards([exported], str(tmp_path), "2026-10-28T12:00:00Z")
    slim = json.loads((tmp_path / "listings/MA.json").read_text())[0]
    assert "posting_details" not in slim and "description" not in slim
    assert (tmp_path / details.FILE).stat().st_size < 1000
    exported.pop("posting_details")
    write_shards([exported], str(tmp_path), "2026-10-28T13:00:00Z")
    assert json.loads((tmp_path / details.FILE).read_text())["records"] == {}
    r.company_name = "Sonos"
    assert "posting_details" not in _listing_dict(r)
    r.company_name, r.status = "Under Armour", "closed"
    assert "posting_details" not in _listing_dict(r)


def test_changed_url_insights_version_or_malformed_fact_invalidates_full_source_record():
    text = "Graduating in 2027. Python preferred."
    r = row(text, company_name="Under Armour", status="open", apply_url="https://jobs.example.com/role")
    packet = details.record(r, text)
    assert details.recorded_facts(r, packet)
    assert not details.recorded_facts(dict(r, apply_url="https://jobs.example.com/new"), packet)
    assert not details.recorded_facts(dict(r, insights={"grad_years": [2028]}), packet)
    assert not details.recorded_facts(dict(r, insights_text_version=1), packet)
    assert not details.recorded_facts(r, dict(packet, facts=[["Skills mentioned", "<script>"]]))
    assert not details.recorded_facts(r, dict(packet, source_sha256="not-a-hash"))
    assert details.record(r, "Not graduating in 2027. Python not required.") is None


def test_carried_record_keeps_original_provenance_but_new_source_or_expiry_removes_it(tmp_path, monkeypatch):
    from internscout.export_static import write_shards
    rows = fixture_site(tmp_path)
    r = rows[0]
    text = "Graduating in 2027. Junior or senior students. Python preferred."
    r["posting_details"] = details.record(r, text)
    write_shards([r], str(tmp_path), "now")
    original = json.loads((tmp_path / details.FILE).read_text())["records"][r["id"]]
    r.pop("posting_details")
    r["carried"] = True
    write_shards([r], str(tmp_path), "later")
    assert json.loads((tmp_path / details.FILE).read_text())["records"][r["id"]] == original
    # Keeping an open carried role does not extend the original source check's lifetime.
    monkeypatch.setattr(details, "checked_day", lambda: (date.fromisoformat(original["checked_on"]) + timedelta(days=8)).isoformat())
    write_shards([r], str(tmp_path), "expired")
    assert json.loads((tmp_path / details.FILE).read_text())["records"] == {}
    monkeypatch.undo()
    r["posting_details"] = original
    write_shards([r], str(tmp_path), "reset")
    r.pop("posting_details")
    r.pop("carried")
    write_shards([r], str(tmp_path), "new-source-without-details")
    assert json.loads((tmp_path / details.FILE).read_text())["records"] == {}


def test_export_bound_selects_the_same_visible_forty_per_employer_not_global_id_order(tmp_path):
    from internscout.export_static import write_shards
    base = fixture_site(tmp_path)[0]
    text = "Graduating in 2027. Junior or senior students. Python preferred."
    rows = []
    for name in ("Under Armour", "Medtronic", "Lyft", "Bose"):
        for i in range(45):
            r = dict(base, id=f"{name}-{i}", company_name=name, title=f"Mechanical Intern {i}", apply_url=f"https://jobs.example.com/{name}/{i}",
                     first_seen=f"2026-09-{1 + i % 28:02d}T00:00:00", regions=base["regions"])
            r["posting_details"] = details.record(r, text)
            rows.append(r)
    write_shards(rows, str(tmp_path), "now")
    packets = json.loads((tmp_path / details.FILE).read_text())["records"]
    assert len(packets) == 160
    for name in ("Under Armour", "Medtronic", "Lyft", "Bose"):
        expected = {r["id"] for r in seo_pages.shown([dict(r, keys={"MA"}) for r in rows if r["company_name"] == name])}
        assert {id_ for id_ in packets if id_.startswith(name + "-")} == expected
