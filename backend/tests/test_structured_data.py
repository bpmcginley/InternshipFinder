"""2026-10-23: validate the schemas readers actually receive across page types.

was: selected fixtures checked a few top-level objects, leaving nested JobPosting and
invisible FAQ regressions uncovered. Revert: remove this file and its schema guards.
These are offline schema contracts, not a claim of Google rich-result eligibility.
"""
from html import unescape
from html.parser import HTMLParser
from datetime import date
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

import pytest

from internscout import seo_pages


class _Visible(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.hidden = 0
        self.text = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag in {"head", "script", "style", "template"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"head", "script", "style", "template"}:
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, text):
        if not self.hidden:
            self.text.append(text)


def _plain(text):
    return " ".join(text.split())


def _blocks(html):
    pattern = r'<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>'
    return [json.loads(text) for text in re.findall(pattern, html, re.S | re.I)]


def _nodes(value):
    """Include graph entries and nested types, rather than checking just top-level blocks."""
    if isinstance(value, dict):
        yield value
        for nested in value.values():
            yield from _nodes(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _nodes(nested)


def _assert_collection_schema(html, path):
    blocks = _blocks(html)
    assert blocks, path
    visible = _plain(" ".join(_Visible(html).text))
    nodes = list(_nodes(blocks))
    for block in blocks:
        assert block.get("@context") in {"https://schema.org", "https://schema.org/"}, path
    for node in nodes:
        types = node.get("@type", [])
        types = [types] if isinstance(types, str) else types
        # A results page is never a single posting, including inside an ItemList or graph.
        assert "JobPosting" not in types, path
        for key in ("name", "description", "text"):
            if key in node:
                assert isinstance(node[key], str) and node[key], (path, key)
        if "url" in node:
            assert urlsplit(node["url"]).scheme == "https", path
        if "dateModified" in node:
            assert date.fromisoformat(node["dateModified"]), path
        if "Product" in types:
            assert node["brand"] == {"@id": seo_pages.ORG_ID}, path
            assert node["url"] == seo_pages.SITE + "/pricing/", path
            if "offers" in node:
                assert isinstance(node["offers"], list) and node["offers"], path
                assert all(offer.get("@type") == "Offer" for offer in node["offers"]), path
        if "Offer" in types:
            assert re.fullmatch(r"\d+(?:\.\d+)?", node["price"]), path
            assert node["priceCurrency"] == "USD", path
            assert node["availability"] == "https://schema.org/InStock", path
        if "UnitPriceSpecification" in types:
            assert re.fullmatch(r"\d+(?:\.\d+)?", node["price"]), path
            assert node["priceCurrency"] == "USD", path
            assert isinstance(node["billingIncrement"], (int, float)), path
            assert node["billingIncrement"] > 0 and node["unitCode"] == "MON", path
        if "BreadcrumbList" in types:
            trail = node["itemListElement"]
            assert len(trail) >= 2, path
            assert [item["position"] for item in trail] == list(range(1, len(trail) + 1)), path
            for item in trail:
                assert item["@type"] == "ListItem", path
                assert item["name"] and _plain(item["name"]) in visible, path
                assert urlsplit(item["item"]).scheme == "https", path
                assert urlsplit(item["item"]).netloc == "internscout.org", path
            assert trail[-1]["item"] == seo_pages.SITE + path, path
        if "FAQPage" in types:
            assert node["mainEntity"], path
            for question in node["mainEntity"]:
                assert question["@type"] == "Question", path
                assert question["name"] and _plain(question["name"]) in visible, path
                answer = question["acceptedAnswer"]
                assert answer["@type"] == "Answer", path
                assert answer["text"] and _plain(answer["text"]) in visible, path
        if "CollectionPage" in types:
            assert node["url"] == seo_pages.SITE + path, path
            assert node["@id"] == node["url"], path
            assert node["isPartOf"] == {"@id": seo_pages.SITE_ID}, path
            assert node["name"] and _plain(node["name"]) in visible, path
            title = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S).group(1)
            parser = _Visible(title)
            assert node["name"] == _plain(" ".join(parser.text)), path


@pytest.fixture
def collection_pages(tmp_path):
    data = tmp_path / "data"
    listings = data / "listings"
    listings.mkdir(parents=True)
    rows = [{
        "id": f"role-{i}", "company_name": ["Apex Robotics", "Boreal Systems", "Cobalt Labs"][i // 10],
        "title": f"Mechanical internship {i}", "field_tags": ["mechanical"],
        "stage": ["internship"], "term": "Summer 2027", "salary": "$25/hr",
        "posted_at": "2026-10-20T00:00:00", "first_seen": "2026-10-20T00:00:00",
        "regions": [{"loc": "Boston, MA" if i < 24 else "New York, NY", "kind": "x",
                     "state": "MA" if i < 24 else "NY"}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False,
    } for i in range(30)]
    (listings / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    (listings / "index.json").write_text(json.dumps({
        "generated_at": "2026-10-21T12:00:00+00:00", "files": {"MA": {"file": "listings/MA.json"}},
    }), encoding="utf-8")
    (data / "majors.json").write_text('{"majors": []}', encoding="utf-8")
    return {p["path"]: p for p in seo_pages.build(str(tmp_path))}


def test_all_generated_page_schemas_and_required_page_types(collection_pages):
    required = {
        "/internships/", "/internships/for/", "/internships/at/",
        "/internships/mechanical-engineering/", "/internships/massachusetts/",
        "/internships/mechanical-engineering/massachusetts/", "/internships/at/apex-robotics/",
        "/about/", "/compare/", "/pricing/", "/internships/by-the-numbers/",
    }
    assert required <= collection_pages.keys()
    for path, page in collection_pages.items():
        _assert_collection_schema(page["html"], path)
        for node in _nodes(_blocks(page["html"])):
            if node.get("@type") == "CollectionPage":
                assert node["description"] == unescape(
                    re.search(r'<meta name="description" content="(.*?)"', page["html"]).group(1)
                )


def test_homepage_describes_product_without_invisible_tier_details(collection_pages):
    root = Path(__file__).resolve().parents[2]
    home = (root / "docs" / "index.html").read_text(encoding="utf-8")
    _assert_collection_schema(home, "/")
    home_nodes = list(_nodes(_blocks(home)))
    product = next(node for node in home_nodes if node.get("@type") == "Product")
    assert "offers" not in product
    assert not any(node.get("@type") == "Offer" for node in home_nodes)
    pricing = collection_pages["/pricing/"]["html"]
    product = next(node for node in _nodes(_blocks(pricing)) if node.get("@type") == "Product")
    assert [offer["name"] for offer in product["offers"]] == ["Free", "Supporter", "Pro"]
    visible = _plain(" ".join(_Visible(pricing).text))
    for offer in product["offers"]:
        assert offer["name"] in visible
        assert offer["priceCurrency"] == "USD"
        if offer["price"] != "0":
            assert "$" + offer["price"] + " a month" in visible


def test_nested_job_posting_is_rejected():
    bad = seo_pages.ld_script({"@context": "https://schema.org", "@graph": [
        {"@type": "ItemList", "itemListElement": [{"@type": "JobPosting", "title": "Hidden job"}]},
    ]})
    with pytest.raises(AssertionError):
        _assert_collection_schema(bad, "/internships/")


def test_invisible_faq_answer_is_rejected():
    bad = seo_pages.ld_script(seo_pages.faq_ld([("A visible question?", "An invisible answer.")]))
    with pytest.raises(AssertionError):
        _assert_collection_schema(bad + "<h2>A visible question?</h2>", "/internships/")
