"""2026-10-23: prevent real missing destinations and Pages directory redirects."""
import json
import shutil
from pathlib import Path

from internscout import feeds, seo_pages, site_links


def put(root, path, text=""):
    dest = root / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")


def test_clean_urls_fragments_queries_and_non_web_links(tmp_path):
    put(tmp_path, "index.html", '<a href="https://internscout.org">Home</a>'
        '<a href="/privacy#digest">Privacy</a><a href="/privacy.html">Privacy</a>'
        '<a href="/topics/?term=summer#roles">Topics</a><a href="mailto:a@example.com">Mail</a>'
        '<a href="https://example.com/missing">Elsewhere</a>')
    put(tmp_path, "privacy.html")
    put(tmp_path, "topics/index.html", '<a href="../privacy">Privacy</a>')
    report = site_links.audit(tmp_path)
    assert report["internal_references"] == 5
    assert report["problems"] == []


def test_missing_links_resources_canonicals_and_sitemap_are_reported(tmp_path):
    put(tmp_path, "index.html", '<a href="/gone/">Gone</a><img src="/missing.png">'
        '<link rel="canonical" href="https://internscout.org/wrong/">')
    put(tmp_path, "sitemap.xml", '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        '<url><loc>https://internscout.org/absent/</loc></url></urlset>')
    report = site_links.audit(tmp_path)
    assert report["missing_references"] == 4
    assert {p["kind"] for p in report["problems"]} == {"a", "img", "canonical", "sitemap"}


def test_directory_redirects_and_case_errors_are_not_silently_accepted(tmp_path):
    put(tmp_path, "index.html", '<a href="/topics">Redirect</a><a href="/Topics/">Wrong case</a>')
    put(tmp_path, "topics/index.html")
    report = site_links.audit(tmp_path)
    assert report["redirect_references"] == 1
    assert report["missing_references"] == 1
    assert site_links.main([str(tmp_path)]) is True


def test_generated_fixture_and_static_pages_have_direct_existing_destinations(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    shutil.copytree(repo / "docs", tmp_path, dirs_exist_ok=True, ignore=shutil.ignore_patterns("data"))
    listings = [{"id": f"id{i}", "company_name": "Fixture Employer", "title": f"Engineering Intern {i}",
        "field_tags": ["mechanical"], "stage": ["internship"], "term": "Summer 2027", "salary": None,
        "first_seen": "2026-09-22T00:00:00", "posted_at": "2026-09-22T00:00:00",
        "regions": [{"loc": "Boston, MA", "state": "MA", "kind": "x"}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False}
        for i in range(25)]
    put(tmp_path, "data/listings/index.json", json.dumps({"generated_at": "2026-09-23T00:00:00Z",
        "files": {"MA": {"file": "listings/MA.json"}}}))
    put(tmp_path, "data/listings/MA.json", json.dumps(listings))
    put(tmp_path, "data/majors.json", '{"majors":[]}')
    pages = seo_pages.build(str(tmp_path))
    seo_pages.write(str(tmp_path), pages)
    feeds.write_all(str(tmp_path), pages, seo_pages.GENERATED)
    report = site_links.audit(tmp_path)
    assert report["problems"] == []
    assert report["internal_references"] > 100
