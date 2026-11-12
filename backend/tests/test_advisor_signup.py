"""Opt-in rendering only. Form submission is exercised with a local browser fixture."""

from dataclasses import replace

import pytest

from internscout.site.advisor import Edition
from internscout.site.digest import SIGNUP_HEADING, Signup
from internscout.site.render.advisor import render
from internscout.site.render.digest import render_signup_form


ACTION = "https://buttondown.com/api/emails/embed-subscribe/advisor-fixture"
SIGNUP = Signup(
    action=ACTION,
    archive="",
    pitch="",
    field="swe",
    field_name="Software engineering",
    heading=SIGNUP_HEADING,
    what=False,
    placement="landing",
)
EDITION = Edition(
    "Computer Science",
    "/internships/for/computer-science-majors/weekly/",
    [],
    None,
    "undated",
    "/internships/for/",
)


def page(**kwargs):
    return render(EDITION, listing_rows=lambda *_: "", **kwargs)


def test_advisor_signup_requires_explicit_model_and_keeps_default_digest():
    assert page() == page(advisor_signup=None)
    assert "<form" not in page()["body"]
    legacy = render_signup_form(SIGNUP)
    assert 'data-digest-placement="landing"' in legacy
    assert 'value="swe"' in legacy
    assert 'value="advisor"' not in legacy
    assert "Your address and the field you tick go to Buttondown" in legacy


def test_advisor_form_uses_approved_copy_and_preserves_shared_submission():
    default = page()
    enabled = page(advisor_signup=SIGNUP)
    assert {key: value for key, value in enabled.items() if key != "body"} == {
        key: value for key, value in default.items() if key != "body"
    }
    assert enabled["body"].startswith(default["body"])
    form = enabled["body"][len(default["body"]) :]
    assert f'action="{ACTION}" method="post" target="_blank" rel="noopener"' in form
    assert 'type="checkbox" name="tag" value="swe"' in form
    assert 'type="checkbox" name="tag" value="advisor"' in form
    assert 'aria-describedby="digest-advisor-help"' in form
    assert 'id="digest-advisor-help"' in form
    assert "Subscribe as an advisor" in form
    assert "Add an advisor label to my subscription. Everyone gets the same Monday email." in form
    assert (
        "Buttondown receives your email address and the labels you choose when you submit this form."
        in form
    )
    assert "You'll get a confirmation email first" in form
    assert '<a href="/privacy#digest">Details</a>' in form
    assert 'type="email" name="email" required' in form
    assert 'name="embed" value="1"' in form
    assert "data-digest-placement" not in form


def test_advisor_form_without_field_does_not_infer_one():
    form = render_signup_form(replace(SIGNUP, field=None), advisor=True)
    assert form.count('name="tag"') == 1
    assert 'value="advisor"' in form


@pytest.mark.parametrize(
    "action",
    [
        "",
        "http://buttondown.com/api/emails/embed-subscribe/advisor-fixture",
        "https://buttondown.com.example.test/api/emails/embed-subscribe/advisor-fixture",
        ACTION + "?other=1",
        ACTION + "\n",
    ],
)
def test_invalid_explicit_provider_action_leaves_the_page_static(action):
    assert page(advisor_signup=replace(SIGNUP, action=action)) == page()
