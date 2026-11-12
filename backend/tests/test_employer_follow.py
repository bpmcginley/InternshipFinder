"""Optional employer Follow through the real model/renderer; no publisher activation."""

from dataclasses import replace
from datetime import datetime, timezone
from html.parser import HTMLParser
import pytest
from internscout.site import employer, runtime
from tests.seo_fixture_data import _row, _site
from test_seo_pages import _build_pages


def model(name="Fixture Labs"):
    return employer.Page(
        name,
        "/internships/at/fixture-labs/",
        [
            _row(i, id=f"{i:016x}", company_name=name, follow_company_key="fixture")
            for i in range(5)
        ],
        [],
        employer.Related([], [], []),
        "MA",
        [name],
        ("/internships/", "Internships"),
        datetime(2026, 11, 10, tzinfo=timezone.utc),
        None,
        [],
        None,
        None,
        0,
        True,
        False,
        None,
    )


def selected(value):
    return employer.with_company_follow(
        value,
        aliases={name: "fixture" for name in [value.name, *value.spellings]},
        companies=frozenset({"fixture"}),
    )


def test_real_model_alias_and_stale_identity():
    value = model()
    value.items[0]["company_name"] = "Fixture Incorporated"
    value.spellings.append("Fixture Incorporated")
    enabled = selected(value)
    assert enabled.follow_company.key == "fixture"
    assert employer.validated_company_follow(value) is None
    assert employer.validated_company_follow(enabled).label == "Fixture Labs"
    enabled.items[0]["id"] = "f" * 16
    with pytest.raises(ValueError):
        employer.validated_company_follow(enabled)


@pytest.mark.parametrize(
    "edit",
    [
        {"status": "closed"},
        {"follow_company_key": "other"},
        {"follow_company_key": None},
        {"follow_company_key": "bad\nkey"},
        {"id": "old"},
        {"company_name": "Unknown"},
    ],
)
def test_bad_or_unknown_rows_do_not_render_selection(edit):
    value = model()
    value.items[0].update(edit)
    with pytest.raises(ValueError):
        selected(value)


def test_membership_empty_duplicate_and_conflicting_alias():
    for aliases, companies in [
        ({}, frozenset({"fixture"})),
        ({"Fixture Labs": "other"}, frozenset({"fixture"})),
        ({"Fixture Labs": "fixture"}, frozenset()),
    ]:
        with pytest.raises(ValueError):
            employer.with_company_follow(model(), aliases=aliases, companies=companies)
    value = model()
    value.items.append(value.items[0])
    with pytest.raises(ValueError):
        selected(value)
    with pytest.raises(ValueError):
        selected(replace(model(), items=[]))


def build_pair(tmp_path, monkeypatch, name="Fixture Labs"):
    rows = [
        _row(i, id=f"{i:016x}", company_name=name, follow_company_key="fixture") for i in range(8)
    ]
    site = _site(tmp_path, {"MA": rows})
    before = {p["path"]: p["html"] for p in _build_pages(site)}
    original = runtime._select_employer_page

    def choose(*args, **kwargs):
        return selected(original(*args, **kwargs))

    monkeypatch.setattr(runtime, "_select_employer_page", choose)
    after = {p["path"]: p["html"] for p in _build_pages(site)}
    return before, after


def test_real_page_path_omitted_default_and_escaped_control(tmp_path, monkeypatch):
    name = 'Fixture & "Labs" <Test>'
    before, after = build_pair(tmp_path, monkeypatch, name)
    changed = [path for path in before if before[path] != after[path]]
    assert len(changed) == 1 and changed[0].startswith("/internships/at/")
    old, new = before[changed[0]], after[changed[0]]
    assert "follow-company" not in old and "data-follow-company-key" not in old
    assert '<meta name="robots" content="noindex, follow"/>' in old
    assert '<meta name="robots" content="noindex, follow"/>' in new
    assert new.count('src="/js/follow-company.mjs"') == 1

    class Tags(HTMLParser):
        found = []

        def handle_starttag(self, tag, attrs):
            values = dict(attrs)
            if "data-follow-company-key" in values:
                self.found.append(values)

    parser = Tags()
    parser.feed(new)
    assert parser.found == [
        {"data-follow-company-key": "fixture", "data-follow-company-label": name}
    ]
    assert '<Test>' not in new
    assert (
        new.replace(
            '<section data-follow-company-key="fixture" data-follow-company-label="Fixture &amp; &quot;Labs&quot; &lt;Test&gt;"></section><script type="module" src="/js/follow-company.mjs"></script>',
            '',
        )
        == old
    )


def test_exact_python_catalog_fixture_alias_is_used_without_normalizing():
    import json
    from pathlib import Path

    catalog = json.loads(
        (
            Path(__file__).resolve().parents[2] / "worker/test/fixtures/follow-catalog-python.json"
        ).read_text(encoding="utf-8")
    )
    value = model("The Booz Allen Hamilton Corporation")
    for row in value.items:
        row["follow_company_key"] = "booz allen"
    enabled = employer.with_company_follow(
        value, aliases=dict(catalog["aliases"]), companies=frozenset(catalog["signup"]["companies"])
    )
    assert enabled.follow_company.key == "booz allen"
    assert enabled.follow_company.label == "The Booz Allen Hamilton Corporation"
    # A retained-only key is not currently available for signup.
    for row in value.items:
        row["follow_company_key"] = "company without roles"
    with pytest.raises(ValueError):
        employer.with_company_follow(
            value,
            aliases={value.name: "company without roles"},
            companies=frozenset(catalog["signup"]["companies"]),
        )


@pytest.mark.parametrize("change", ["append", "replace", "remove", "reorder"])
def test_changed_approved_spellings_reject_before_renderer(change):
    value = model()
    value.spellings.append("Fixture Incorporated")
    enabled = selected(value)
    if change == "append":
        enabled.spellings.append("Unapproved Other")
    elif change == "replace":
        enabled.spellings[0] = "Unapproved Other"
    elif change == "remove":
        enabled.spellings.pop()
    else:
        enabled.spellings.reverse()
    with pytest.raises(ValueError, match="Stale employer Follow selection"):
        runtime._render_employer_page(enabled)
