"""The product footer link does not change email safety or recipient controls."""

import copy
import importlib.util
import json
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("digest_footer", ROOT / "growth/digest.py")
digest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(digest)
FIXTURE = ROOT / "notes/product/screenshots/P-1.7c/digest-fixture.json"
LABEL = "Internships for every major on GitHub"
URL = "https://github.com/bpmcginley/internships-every-major"


class Links(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.links = []
        self.current = None
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.current = [dict(attrs).get("href"), ""]

    def handle_data(self, data):
        if self.current is not None:
            self.current[1] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            self.links.append(tuple(self.current))
            self.current = None


@pytest.mark.parametrize("fields", [None, ["mechanical"], ["absent-field"]])
def test_footer_link_is_once_in_both_parts_without_changing_the_digest(fields):
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    original = copy.deepcopy(data)
    page = digest.render_html(data, fields=fields)
    text = digest.render_text(data, fields=fields)
    assert Links(page).links.count((URL, LABEL)) == 1
    assert text.splitlines().count(f"{LABEL}: {URL}") == 1
    assert page.index(digest.SLOGAN) < page.index(LABEL) < page.index(digest.UNSUBSCRIBE)
    assert text.index(digest.SLOGAN) < text.index(LABEL) < text.index(digest.WHY)
    assert data == original


def test_unsubscribe_reason_and_missing_address_remain_intact():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    page, text = digest.render_html(data), digest.render_text(data)
    assert Links(page).links.count(("{{ unsubscribe_url }}", "Unsubscribe")) == 1
    assert text.count("Unsubscribe: {{ unsubscribe_url }}") == 1
    assert page.count(digest.esc(digest.WHY)) == text.count(digest.WHY) == 1
    assert page.count(digest.NO_ADDRESS) == text.count(digest.NO_ADDRESS) == 1
    assert text.endswith(digest.NO_ADDRESS + "\n")


def test_existing_html_escaping_link_validation_and_address_handling_remain():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    role = data["sections"][0]["roles"][0]
    role.update(
        company="Fixture <script>bad()</script>",
        title="Role <b>name</b>",
        url="javascript:alert(1)",
    )
    address = "[SYNTHETIC PREVIEW ONLY]\nFixture <address> & line"
    page = digest.render_html(data, postal_address=address)
    text = digest.render_text(data, postal_address=address)
    assert "<script>" not in page and "&lt;script&gt;" in page
    assert "Role &lt;b&gt;name&lt;/b&gt;" in page
    assert "javascript:" not in page and "javascript:" not in text
    assert "Fixture &lt;address&gt; &amp; line" in page
    assert text.endswith(address + "\n")
    assert digest.NO_ADDRESS not in page and digest.NO_ADDRESS not in text
    assert (URL, LABEL) in Links(page).links
