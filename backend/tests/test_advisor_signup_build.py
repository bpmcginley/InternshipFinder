"""Explicit advisor build option, using synthetic exports and no provider calls."""

import json
from pathlib import Path

import pytest

from internscout.site import publish, runtime
from internscout.site.digest import SIGNUP_HEADING
from tests.seo_fixture_data import _row, _site

pytestmark = pytest.mark.without_seo_facade
ACTION = "https://buttondown.com/api/emails/embed-subscribe/advisor-fixture"
MAJORS = [{"name": "Computer Science", "tags": ["swe"]}, {"name": "Undeclared", "tags": []}]


def fixture(root, action=ACTION):
    site = Path(_site(root, {"MA": [_row(i) for i in range(30)]}, MAJORS))
    (site / "privacy.html").write_bytes(
        (Path(__file__).resolve().parents[2] / "docs" / "privacy.html").read_bytes()
    )
    (site / "index.html").write_text(
        f'<!-- browse:start --><!-- browse:end -->\ndigest: {{formAction: "{action}"}},\n',
        encoding="utf-8",
    )
    return site


def files(site):
    return {p.relative_to(site).as_posix(): p.read_bytes() for p in site.rglob("*") if p.is_file()}


def build(site, enabled=False):
    state = runtime.BuildState(near_on=False, advisor_signup_enabled=enabled)
    pages = runtime.invoke(
        state, runtime.BuildHooks(), runtime.build, str(site), earning=frozenset()
    )
    return {p["path"]: p for p in pages}


def test_only_weekly_advisor_pages_receive_exact_approved_form(tmp_path):
    site = fixture(tmp_path)
    off = build(site)
    on = build(site, True)
    assert on.keys() == off.keys()
    changed = {path for path in off if off[path]["html"] != on[path]["html"]}
    assert changed == {
        "/internships/for/computer-science-majors/weekly/",
        "/internships/for/undeclared-majors/weekly/",
    }
    for path in changed:
        html = on[path]["html"]
        assert html.count("Subscribe as an advisor") == 1
        assert (
            "Add an advisor label to my subscription. Everyone gets the same Monday email." in html
        )
        assert (
            "Buttondown receives your email address and the labels you choose when you submit this form."
            in html
        )
        assert f'action="{ACTION}" method="post" target="_blank" rel="noopener"' in html
        assert (
            'type="checkbox" name="tag" value="advisor" aria-describedby="digest-advisor-help"/>'
            in html
        )
        assert html.count('name="tag"') == 1  # No field or major inferred from the page.
        assert 'data-digest-placement=' not in html.split('<form', 1)[1].split('</form>', 1)[0]
        assert "You'll get a confirmation email first" in html
        assert '<a href="/privacy#digest">Details</a>' in html
        assert 'name="embed" value="1"' in html
        assert SIGNUP_HEADING in html
        assert on[path]["items"] == off[path]["items"]
        assert on[path]["index"] == off[path]["index"]
        assert on[path]["thin"] == off[path]["thin"]
    assert build(site) == off  # Enabled invocation cannot leak to the next build.


def test_actual_publisher_option_changes_only_weekly_html_and_its_content_dates(tmp_path):
    before, after = fixture(tmp_path / "off"), fixture(tmp_path / "on")
    publish.main(["publish", str(before)])
    publish.main(["publish", str(after), "--advisor-signup"])
    off, on = files(before), files(after)
    assert off.keys() == on.keys()
    changed = {p for p in off if off[p] != on[p]}
    weekly = {
        "internships/for/computer-science-majors/weekly/index.html",
        "internships/for/undeclared-majors/weekly/index.html",
    }
    assert changed == weekly | {"data/page-content-dates.json", "privacy.html"}
    old_dates, new_dates = (
        json.loads(off["data/page-content-dates.json"]),
        json.loads(on["data/page-content-dates.json"]),
    )
    # The exact metadata schema is retained, including every non-weekly record.
    assert old_dates.keys() == new_dates.keys()
    assert {k: v for k, v in old_dates.items() if k != "pages"} == {
        k: v for k, v in new_dates.items() if k != "pages"
    }
    for path in old_dates["pages"]:
        if not path.endswith("/weekly/"):
            assert old_dates["pages"][path] == new_dates["pages"][path], path


@pytest.mark.parametrize(
    "option",
    ["--advisor-signup=true", "--advisor-signup=false", "--advisor-signup=", "--advisor-signups"],
)
def test_unrecognized_advisor_options_fail_before_output(tmp_path, option):
    site = fixture(tmp_path)
    before = files(site)
    with pytest.raises(ValueError, match="one exact"):
        publish.main(["publish", str(site), option])
    assert files(site) == before


def test_duplicate_option_fails_before_output(tmp_path):
    site = fixture(tmp_path)
    before = files(site)
    with pytest.raises(ValueError, match="one exact"):
        publish.main(["publish", str(site), "--advisor-signup", "--advisor-signup"])
    assert files(site) == before


@pytest.mark.parametrize(
    "action",
    [
        "",
        "https://example.test/signup",
        ACTION + "?other=1",
        "http://buttondown.com/api/emails/embed-subscribe/advisor-fixture",
    ],
)
def test_enabled_invalid_or_missing_existing_action_fails_before_output(tmp_path, action):
    site = fixture(tmp_path, action)
    before = files(site)
    with pytest.raises(ValueError, match="existing valid Buttondown"):
        publish.main(["publish", str(site), "--advisor-signup"])
    assert files(site) == before
    assert all("Subscribe as an advisor" not in p["html"] for p in build(site).values())


@pytest.mark.parametrize("enabled", ["true", "false", 1, None])
def test_truthy_or_ambiguous_programmatic_values_are_not_activation(tmp_path, enabled):
    with pytest.raises(ValueError, match="explicit boolean"):
        build(fixture(tmp_path), enabled)


def test_environment_does_not_enable_advisor_signup(tmp_path, monkeypatch):
    site = fixture(tmp_path)
    monkeypatch.setenv("INTERNSCOUT_ADVISOR_SIGNUP", "true")
    assert all("Subscribe as an advisor" not in p["html"] for p in build(site).values())


def test_default_rebuild_removes_current_forms_and_fresh_destination_has_no_retained_signup(
    tmp_path,
):
    reused = fixture(tmp_path / "reused")
    publish.main(["publish", str(reused), "--advisor-signup"])
    publish.main(["publish", str(reused)])
    assert not any(
        b'digest-advisor-help' in body
        for name, body in files(reused).items()
        if name.endswith('.html')
    )
    # Rollback publication uses a fresh artifact, not a previously generated directory.
    fresh = fixture(tmp_path / "fresh")
    (fresh / "data" / "majors.json").write_text(
        '{"majors": [{"name": "New Major", "tags": []}]}', encoding="utf-8"
    )
    publish.main(["publish", str(fresh)])
    output = files(fresh)
    assert not any(
        b'digest-advisor-help' in body for name, body in output.items() if name.endswith('.html')
    )
    assert 'internships/for/computer-science-majors/weekly/index.html' not in output
    assert 'internships/for/new-major-majors/weekly/index.html' in output
