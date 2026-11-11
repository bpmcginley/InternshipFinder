"""Dated opening counts describe the selected export, not a fresh link check."""

import json
import re
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

import pytest

from internscout import page_dates, seo_pages
from test_seo_pages import _row, _site


def build(site):
    return {p["path"]: p for p in seo_pages.build(site, earning=frozenset())}


def stamp(site, value):
    path = Path(site) / "data/listings/index.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if value == "missing":
        data.pop("generated_at")
    else:
        data["generated_at"] = value
    path.write_text(json.dumps(data), encoding="utf-8")


def lead(page):
    return unescape(re.search(r'<p class="lede">(.*?)</p>', page["html"]).group(1))


def fixture(tmp_path):
    rows = [_row(i, company_name="Example Labs") for i in range(52)]
    # Two exported IDs can describe the same title/location: only employers fold them.
    rows.append(dict(rows[0], id="duplicate-title"))
    return _site(tmp_path, {"MA": rows, "NY": [rows[0]]})


def test_counts_use_selected_cohorts_not_visible_rows_and_preserve_later_sentences(tmp_path):
    site = fixture(tmp_path)
    dated = build(site)
    stamp(site, None)
    undated = build(site)
    counts = {"/internships/mechanical-engineering/": 53, "/internships/at/example-labs/": 52}
    for path, page in dated.items():
        if path in counts:
            assert page["items"] == undated[path]["items"]
            text = lead(page)
            assert text == "As of September 23, 2026, InternScout lists " + lead(undated[path])
            assert text.count(f"{counts[path]} open student roles") == 1
            assert (
                f"Showing the 40 newest, Northeast and remote first, of {counts[path]}"
                in page["html"]
            )
        else:
            assert (
                not re.match(
                    r"As of September 23, 2026, InternScout lists [\d,]+ open student roles? ",
                    lead(page),
                )
                if '<p class="lede">' in page["html"]
                else True
            )


@pytest.mark.parametrize(
    "value", ["missing", None, "", "not a date", "2026-02-30T12:00:00Z", 20261111, {}, []]
)
def test_invalid_export_never_dates_opening_from_build_clock(tmp_path, value):
    site = fixture(tmp_path)
    stamp(site, value)
    pages = build(site)
    for path in ("/internships/mechanical-engineering/", "/internships/at/example-labs/"):
        assert not lead(pages[path]).startswith("As of")
        assert "open student roles" in lead(pages[path])


@pytest.mark.parametrize(
    "value",
    ["2026-09-23T10:00:00Z", "2026-09-23T23:00:00-07:00", "2026-09-23T10:00:00", "2026-09-23"],
)
def test_valid_export_calendar_date_follows_existing_timestamp_parser(tmp_path, value):
    site = fixture(tmp_path)
    stamp(site, value)
    assert lead(build(site)["/internships/at/example-labs/"]).startswith(
        "As of September 23, 2026,"
    )


@pytest.mark.parametrize("count", [0, 1, 41])
def test_optional_body_date_keeps_zero_singular_and_full_counts(count):
    rows = [dict(_row(i), keys={"MA"}) for i in range(count)]
    when = datetime(2026, 11, 11, tzinfo=timezone.utc)
    plain = seo_pages.listing_body(rows, "at Example Labs", "", when, "")
    dated = seo_pages.listing_body(rows, "at Example Labs", "", when, "", export_stamp=when)
    assert dated == plain.replace(
        '<p class="lede">', '<p class="lede">As of November 11, 2026, InternScout lists ', 1
    )
    assert f"{count} open student role{'' if count == 1 else 's'} at Example Labs." in dated


def test_date_only_rollover_keeps_lastmod_but_changed_count_advances_it(tmp_path, monkeypatch):
    site = fixture(tmp_path)
    monkeypatch.setattr(page_dates, "observed_day", lambda: "2026-09-23")
    before = build(site)
    seo_pages.write(site, list(before.values()))
    monkeypatch.setattr(page_dates, "observed_day", lambda: "2026-09-24")
    stamp(site, "2026-09-24T10:00:00Z")
    after = build(site)
    seo_pages.write(site, list(after.values()))
    for path in ("/internships/mechanical-engineering/", "/internships/at/example-labs/"):
        assert before[path]["lastmod"] == after[path]["lastmod"]
        assert "September 24, 2026" in lead(after[path])
    file = Path(site) / "data/listings/MA.json"
    rows = json.loads(file.read_text(encoding="utf-8"))
    rows.append(_row(999, company_name="Example Labs"))
    file.write_text(json.dumps(rows), encoding="utf-8")
    changed = build(site)
    seo_pages.write(site, list(changed.values()))
    assert changed["/internships/at/example-labs/"]["lastmod"] == "2026-09-24"


def test_fingerprint_masks_only_exact_lede_export_date_not_count_or_citations():
    path = "/internships/at/example-labs/"
    first, second = datetime(2026, 11, 10), datetime(2026, 11, 11)
    sentence = "As of November 10, 2026, InternScout lists 52 open student roles at Example Labs."
    html = (
        '<body><p class="lede">' + sentence + '</p><p>Source updated November 10, 2026.</p></body>'
    )
    later = html.replace(sentence, sentence.replace("November 10", "November 11"))
    digest = page_dates.fingerprint(path, html, first)
    assert digest == page_dates.fingerprint(path, later, second)
    for changed in (
        later.replace("52 open", "51 open"),
        later.replace("Example Labs", "Other Labs"),
        later.replace("Source updated November 10", "Source updated November 11"),
    ):
        assert digest != page_dates.fingerprint(path, changed, second)
    citation = html.replace('class="lede"', 'class="source"')
    assert page_dates.fingerprint(path, citation, first) != page_dates.fingerprint(
        path, citation.replace("November 10", "November 11"), second
    )
    assert page_dates.fingerprint("/about/", html, first) != page_dates.fingerprint(
        "/about/", later, second
    )
