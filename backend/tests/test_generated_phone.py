"""Phone table labels supplement, rather than replace, semantic row/column headers."""

import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from html import escape

from internscout import seo_pages as sp
from internscout.site.render import layout


def test_table_preserves_headers_values_and_safe_visible_labels():
    html = layout.table(
        ["Employer", "Opened &amp; found", "Roles"],
        [
            ["SyntheticInternationalLaboratory", "By Sep 17, 2026", "30"],
            ["Second employer", "Sep 18, 2026", "4"],
        ],
        label='Employers "<listed>"',
    )
    root = ET.fromstring(html)
    assert root.attrib == {
        "class": "tablewrap",
        "tabindex": "0",
        "role": "region",
        "aria-label": 'Employers "<listed>"',
    }
    table = root.find("table")
    assert table.get("role") == "table"
    assert [h.get("scope") for h in table.findall("./thead/tr/th")] == ["col"] * 3
    assert [h.get("role") for h in table.findall("./thead/tr/th")] == ["columnheader"] * 3
    for row in table.findall("./tbody/tr"):
        assert row.get("role") == "row"
        assert row[0].tag == "th" and row[0].get("scope") == "row"
        assert row[0].get("role") == "rowheader"
        assert [c.find("span[@class='cell-label']").text for c in row[1:]] == [
            "Opened & found",
            "Roles",
        ]
        assert all(
            c.find("span[@class='cell-label']").get("aria-hidden") == "true" for c in row[1:]
        )
        assert all(c.get("role") == "cell" for c in row[1:])
    assert table.find("./tbody/tr/td/span[@class='cell-value']").text == "By Sep 17, 2026"


def test_tracker_uses_shared_headers_and_escapes_employer_data():
    _, _, _, html = sp.tracker_page(
        "Summer 2027",
        [(date(2026, 9, 17), False, 'Synthetic<Lab> & "Research"', None, 30)],
        30,
        datetime(2026, 11, 10, tzinfo=timezone.utc),
        "November 10, 2026",
        "/internships/summer-2027/",
    )
    table = ET.fromstring(re.search(r'<table class="data tracker".*?</table>', html, re.S)[0])
    assert table.find("./tbody/tr/th").text == 'Synthetic<Lab> & "Research"'
    assert table.find("./tbody/tr/th").get("scope") == "row"
    assert [h.text for h in table.findall("./thead/tr/th")] == [
        "Employer",
        "Opened",
        "Summer 2027 roles",
    ]
    assert "By Sep 17, 2026" in html and "Synthetic<Lab>" not in html


def test_ragged_rows_keep_every_value_and_numeric_first_columns_remain_cells():
    table = ET.fromstring(layout.table(["Known"], [["12", "Unheaded value"]], num_from=0)).find(
        "table"
    )
    row = table.find("./tbody/tr")
    assert [cell.tag for cell in row] == ["td", "td"]
    assert all(cell.get("class") == "num" and cell.get("role") == "cell" for cell in row)
    assert [cell.find("span[@class='cell-value']").text for cell in row] == ["12", "Unheaded value"]
    assert row[1].find("span[@class='cell-label']").text is None


def test_escaped_hostile_column_labels_stay_text_in_headers_and_phone_labels():
    label = escape('<img src=x onerror="alert(1)"> & details')
    table = ET.fromstring(layout.table(["Name", label], [["Example", "Value"]])).find("table")
    assert table.find("./thead/tr/th[2]").text == '<img src=x onerror="alert(1)"> & details'
    assert (
        table.find("./tbody/tr/td/span[@class='cell-label']").text
        == '<img src=x onerror="alert(1)"> & details'
    )
    assert table.findall(".//img") == []


def test_mobile_footer_keeps_secondary_destinations_and_conditional_email(monkeypatch):
    monkeypatch.setattr(sp, "DIGEST_FORM", "enabled")
    html = sp.page("/internships/arts/", "Arts", "Arts", "Arts", [], "", "November 10, 2026")
    nav = re.search(r'<nav aria-label="Primary">.*?</nav>', html, re.S)[0]
    footer = re.search(r"<footer>.*?</footer>", html, re.S)[0]
    for url in ["/pricing/", "/compare/", "/about/", "/employers/", "/digest/"]:
        assert f'href="{url}"' in nav and f'href="{url}"' in footer
    assert 'data-digest-placement="footer"' in footer
    assert [a for a in re.findall(r"<a[^>]*>", nav) if "nav-extra" not in a] == [
        '<a href="/">',
        '<a href="/internships/">',
        '<a href="/install.html">',
    ]
    monkeypatch.setattr(sp, "DIGEST_FORM", "")
    disabled = sp.page("/internships/arts/", "Arts", "Arts", "Arts", [], "", "November 10, 2026")
    assert 'data-digest-placement="footer"' not in disabled
