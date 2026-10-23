"""2026-10-23: a sitemap date describes a content change, not a new scan or new unrelated role."""
import copy
import json
from datetime import datetime, timezone

import pytest

from internscout import page_dates, seo_pages


@pytest.fixture(autouse=True)
def _observed_day(monkeypatch):
    monkeypatch.setattr(page_dates, "observed_day", lambda: "2026-09-24")


def _site(tmp_path):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    rows = [{"id": f"role-{i}", "company_name": f"Company {i}", "title": f"Mechanical Intern {i}",
             "field_tags": ["mechanical"], "stage": ["internship"], "term": "Summer 2027", "salary": None,
             "first_seen": "2026-09-01T00:00:00", "posted_at": "2026-09-01T00:00:00", "status": "open",
             "regions": [{"loc": f"Town {i}, MA", "kind": "x", "state": "MA"}],
             "apply_url": f"https://jobs.example.com/{i}", "is_remote": False, "insights": None}
            for i in range(6)]
    (data / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    (data / "index.json").write_text(json.dumps({"generated_at": "2026-09-23T10:00:00+00:00",
                                                "files": {"MA": {"file": "listings/MA.json"}}}), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text('{"majors":[]}', encoding="utf-8")
    (tmp_path / "index.html").write_text('<html><head><title>Search</title></head><body>'
                                          '<!-- browse:start --><!-- browse:end --></body></html>', encoding="utf-8")
    return rows


def _build(site):
    live = seo_pages.live_paths(str(site / "sitemap.xml"))
    pages = seo_pages.build(str(site), live)
    seo_pages.write(str(site), pages)
    return {p["path"]: p for p in pages}


def _export_day(site, day="2026-09-24"):
    path = site / "data/listings/index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    index["generated_at"] = day + "T10:00:00+00:00"
    path.write_text(json.dumps(index), encoding="utf-8")


@pytest.mark.parametrize("change", ["title", "pay", "location", "closure"])
def test_corrections_and_closures_advance_page_date(tmp_path, change):
    rows = _site(tmp_path)
    before = _build(tmp_path)
    if change == "title":
        rows[0]["title"] = "Mechanical Research Intern"
    elif change == "pay":
        rows[0]["salary"] = "$50/hr"
    elif change == "location":
        rows[0]["regions"][0]["loc"] = "Boston, MA"
    else:
        rows[0]["status"] = "closed"
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    _export_day(tmp_path)
    after = _build(tmp_path)
    path = "/internships/massachusetts/"
    assert before[path]["lastmod"] == "2026-09-01"
    assert after[path]["lastmod"] == "2026-09-24"
    assert '"dateModified": "2026-09-24"' in after[path]["html"]


def test_same_inputs_and_export_date_labels_keep_dates(tmp_path):
    _site(tmp_path)
    first = _build(tmp_path)
    same = _build(tmp_path)
    assert {p: x["lastmod"] for p, x in first.items()} == {p: x["lastmod"] for p, x in same.items()}
    _export_day(tmp_path)
    later = _build(tmp_path)
    assert {p: x["lastmod"] for p, x in first.items()} == {p: x["lastmod"] for p, x in later.items()}


def test_numbers_page_export_labels_do_not_redate_unchanged_statistics(tmp_path):
    rows = _site(tmp_path)
    rows += [dict(copy.deepcopy(rows[0]), id=f"extra-{i}", company_name=f"Extra company {i}") for i in range(30)]
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    first = _build(tmp_path)
    _export_day(tmp_path)
    later = _build(tmp_path)
    assert seo_pages.NUMBERS_PATH in first
    assert first[seo_pages.NUMBERS_PATH]["lastmod"] == later[seo_pages.NUMBERS_PATH]["lastmod"]


def test_unrelated_new_listing_does_not_date_pricing(tmp_path):
    rows = _site(tmp_path)
    before = _build(tmp_path)
    extra = dict(copy.deepcopy(rows[0]), id="new", company_name="New company", first_seen="2026-09-24T00:00:00")
    rows.append(extra)
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    _export_day(tmp_path)
    after = _build(tmp_path)
    assert after["/pricing/"]["lastmod"] == before["/pricing/"]["lastmod"]
    # Its shell's Updated label changes; the actual pricing content does not.
    assert page_dates.fingerprint("/pricing/", before["/pricing/"]["html"], datetime(2026, 9, 23)) == \
           page_dates.fingerprint("/pricing/", after["/pricing/"]["html"], datetime(2026, 9, 24))


def test_visible_copy_links_facts_and_posting_dates_are_meaningful():
    stamp = datetime(2026, 9, 24, tzinfo=timezone.utc)
    base = '<html><head><title>Search</title><meta name="description" content="Six roles"></head><body>' \
           '<h1>Six internships</h1><a href="/internships/">Browse</a><p>Posted September 24, 2026.</p></body></html>'
    original = page_dates.fingerprint("/pricing/", base, stamp)
    for html in [base.replace("Six", "Seven"), base.replace('href="/internships/"', 'href="/about/"'),
                 base.replace("Posted September 24", "Posted September 23"), base.replace("Browse", "Explore")]:
        assert page_dates.fingerprint("/pricing/", html, stamp) != original
    assert page_dates.fingerprint("/about/", base, stamp) != original
    assert page_dates.fingerprint("/pricing/", base.replace("</body>", '<style>body{color:red}</style>'
                                  '<script>window.scan=999</script><div hidden>token123</div></body>'), stamp) == original
    opening = base.replace("Posted September 24", "Opens on September 24")
    next_day = datetime(2026, 9, 25, tzinfo=timezone.utc)
    assert page_dates.fingerprint("/pricing/", opening, stamp) != page_dates.fingerprint(
        "/pricing/", opening.replace("Opens on September 24", "Opens on September 25"), next_day)


def test_next_day_copy_correction_uses_observation_day_with_unchanged_export(tmp_path, monkeypatch):
    _site(tmp_path)
    _build(tmp_path)
    original = seo_pages.pricing_page

    def corrected():
        title, desc, body, ld = original()
        return title, desc, body + "<p>Corrected product copy.</p>", ld

    monkeypatch.setattr(seo_pages, "pricing_page", corrected)
    monkeypatch.setattr(page_dates, "observed_day", lambda: "2026-09-25")
    after = _build(tmp_path)
    assert after["/pricing/"]["lastmod"] == "2026-09-25"


def test_manifest_persists_into_a_fresh_build_directory(tmp_path):
    site = tmp_path / "before"
    rows = _site(site)
    _build(site)
    fresh = tmp_path / "fresh"
    _site(fresh)
    (fresh / page_dates.FILE).write_bytes((site / page_dates.FILE).read_bytes())
    _export_day(fresh)
    assert _build(fresh)["/pricing/"]["lastmod"] == "2026-09-01"
    # A title correction survives a fresh checkout too, without first_seen changing.
    rows[0]["title"] = "Changed title"
    (fresh / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    assert _build(fresh)["/internships/massachusetts/"]["lastmod"] == "2026-09-24"


@pytest.mark.parametrize("manifest", ["not json", "[]", '{"version":1,"pages":[]}',
                                      '{"version":999,"pages":{}}',
                                      '{"version":1,"pages":{"/pricing/":{"digest":123,"lastmod":"2026-09-23"}}}'])
def test_invalid_manifest_falls_back_safely(tmp_path, manifest):
    _site(tmp_path)
    (tmp_path / page_dates.FILE).write_text(manifest, encoding="utf-8")
    assert _build(tmp_path)["/pricing/"]["lastmod"] == "2026-09-01"
    saved = json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))
    assert saved["version"] == 1 and "/pricing/" in saved["pages"]


def test_identity_mismatch_future_date_and_path_traversal_cannot_poison_dates(tmp_path):
    _site(tmp_path)
    _build(tmp_path)
    manifest = json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))
    manifest["pages"]["/pricing/"] = dict(manifest["pages"]["/about/"])
    manifest["pages"]["/compare/"]["lastmod"] = "9999-12-31"
    manifest["pages"]["/../outside/"] = dict(manifest["pages"]["/about/"])
    (tmp_path / page_dates.FILE).write_text(json.dumps(manifest), encoding="utf-8")
    _export_day(tmp_path)
    after = _build(tmp_path)
    assert after["/pricing/"]["lastmod"] == "2026-09-24"
    assert after["/compare/"]["lastmod"] != "9999-12-31"
    assert "/../outside/" not in json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))["pages"]


def test_page_date_never_goes_back_and_paid_boxes_do_not_redate(tmp_path):
    rows = _site(tmp_path)
    _build(tmp_path)
    rows[0]["title"] = "Corrected Mechanical Intern"
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    _export_day(tmp_path)
    before = _build(tmp_path)
    _export_day(tmp_path, "2026-09-22")
    after = _build(tmp_path)
    assert after["/internships/massachusetts/"]["lastmod"] == before["/internships/massachusetts/"]["lastmod"] == "2026-09-24"
    stamp = datetime(2026, 9, 24)
    html = '<body><h1>Pricing</h1></body>'
    assert page_dates.fingerprint("/pricing/", html, stamp) == page_dates.fingerprint(
        "/pricing/", html.replace("</body>", '<!--paid--><p>Ad</p><!--/paid--></body>'), stamp)


def test_stale_manifest_cannot_move_a_live_sitemap_date_back(tmp_path):
    _site(tmp_path)
    _build(tmp_path)
    sitemap = tmp_path / "sitemap.xml"
    sitemap.write_text(sitemap.read_text().replace("<lastmod>2026-09-01</lastmod>",
                                                  "<lastmod>2026-09-23</lastmod>"), encoding="utf-8")
    after = _build(tmp_path)
    assert after["/pricing/"]["lastmod"] == "2026-09-23"


def test_home_has_its_own_stable_date(tmp_path):
    _site(tmp_path)
    _build(tmp_path)
    old = json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))["pages"]["/"]["lastmod"]
    (tmp_path / "index.html").write_text('<html><body><h1>A new search experience</h1>'
                                          '<!-- browse:start --><!-- browse:end --></body></html>', encoding="utf-8")
    _export_day(tmp_path)
    _build(tmp_path)
    assert old == "2026-09-01"
    assert '<loc>https://internscout.org/</loc><lastmod>2026-09-24</lastmod>' in (tmp_path / "sitemap.xml").read_text()


def test_dashboard_card_data_changes_count_but_scan_bookkeeping_does_not(tmp_path):
    rows = _site(tmp_path)
    _build(tmp_path)
    old = json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))["pages"]["/"]["lastmod"]
    rows[0]["last_seen"] = "2026-09-24T12:00:00"
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    _export_day(tmp_path)
    _build(tmp_path)
    assert json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))["pages"]["/"]["lastmod"] == old
    rows[0]["salary"] = "$50/hr"
    (tmp_path / "data/listings/MA.json").write_text(json.dumps(rows), encoding="utf-8")
    _build(tmp_path)
    assert json.loads((tmp_path / page_dates.FILE).read_text(encoding="utf-8"))["pages"]["/"]["lastmod"] == "2026-09-24"
