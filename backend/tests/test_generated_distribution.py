"""Generated sharing links preserve existing destinations and carry canonical field tags."""

import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, urlsplit

import pytest

from internscout import seo_pages as sp


@pytest.mark.parametrize("digest", ["", "enabled"])
def test_footer_has_exact_distribution_links_without_losing_existing_routes(monkeypatch, digest):
    monkeypatch.setattr(sp, "DIGEST_FORM", digest)
    html = sp.page("/internships/arts/", "Arts", "Arts", "Arts", [], "", "November 10, 2026")
    footer = re.search(r"<footer>.*?</footer>", html, re.S)[0]
    nav = ET.fromstring(re.search(r'<nav class="distribution-links".*?</nav>', footer, re.S)[0])
    assert nav.get("aria-label") == "More ways to use InternScout"
    assert [(a.get("href"), a.get("data-distribution"), a.text) for a in nav] == [
        (
            "https://github.com/bpmcginley/internships-every-major",
            "list",
            "Internships for every major on GitHub",
        ),
        ("/widget/builder.html", "widget", "Put live internships on your club or department site"),
    ]
    for route in ["/about/", "/pricing/", "/compare/", "/employers/", "/privacy", "/terms"]:
        assert footer.count(f'href="{route}"') == 1
    assert ('data-digest-placement="footer"' in footer) == bool(digest)
    assert 'aria-label="Primary"' in html


@pytest.mark.parametrize("tag", ["mechanical", "swe", 'field&"<x>/ #'])
def test_widget_link_roundtrips_canonical_tag_without_injected_markup(tag):
    root = ET.fromstring(sp.widget_follow(tag))
    assert len(root) == 1 and root[0].tag == "a" and len(root[0]) == 0
    assert set(root[0].attrib) == {"href", "data-distribution"}
    url = urlsplit(root[0].get("href"))
    assert url.path == "/widget/builder.html" and not url.fragment
    assert parse_qs(url.query) == {"field": [tag]}
    assert root[0].get("data-distribution") == "widget"


def test_only_field_landing_pages_get_a_preselected_widget_link(tmp_path):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    rows = [
        {
            "id": f"fixture-{i}",
            "company_name": "Synthetic employer",
            "title": f"Intern {i}",
            "field_tags": ["mechanical"],
            "status": "open",
            "stage": ["internship"],
            "regions": [{"state": "MA", "loc": "Amherst, MA"}],
            "apply_url": f"https://jobs.example.com/{i}",
        }
        for i in range(15)
    ]
    (data / "listings.json").write_text(json.dumps(rows), encoding="utf-8")
    (data / "index.json").write_text(
        json.dumps(
            {
                "generated_at": "2026-11-10T12:00:00Z",
                "files": {"MA": {"file": "listings/listings.json"}},
            }
        ),
        encoding="utf-8",
    )
    (data.parent / "majors.json").write_text('{"majors": []}', encoding="utf-8")
    pages = {page["path"]: page["html"] for page in sp.build(str(tmp_path))}
    selected = 'href="/widget/builder.html?field=mechanical"'
    assert pages["/internships/mechanical-engineering/"].count(selected) == 1
    assert all(
        selected not in html
        for path, html in pages.items()
        if path != "/internships/mechanical-engineering/"
    )
    assert all('data-distribution="list"' in html for html in pages.values())
