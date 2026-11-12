"""Actual Pages Bash mode transport; publisher remains a local command double."""

import pytest

from tests.test_pages_employer_mode import PREFIX, build_step, nul_values
from tests.test_pages_employer_mode import run_build as run_build


@pytest.mark.parametrize("selected", [False, True])
@pytest.mark.parametrize("advisor", [None, "", "off", "enabled"])
@pytest.mark.parametrize(
    ("employer", "flags"),
    [
        (None, []),
        ("annotations", ["--employer-postings"]),
        ("capture", ["--employer-postings", "--employer-posting-capture"]),
    ],
)
def test_exact_combined_modes_keep_one_publisher_and_selected_export(
    run_build, selected, advisor, employer, flags
):
    root, result = run_build(employer, selected=selected, advisor=advisor)
    assert result.returncode == 0, result.stdout + result.stderr
    extra = ["--advisor-signup"] if advisor == "enabled" else []
    assert nul_values(root / "publisher.args") == PREFIX + flags + extra
    assert (root / "calls").read_text() == "publisher\naudit\n"
    assert nul_values(root / "publisher.env") == [(root / "_site/data").as_posix(), "..:."]
    assert (root / "_site/data/index.json").read_text() == (
        "selected index" if selected else "primary index"
    )


@pytest.mark.parametrize(
    "advisor",
    [
        "on",
        "true",
        "1",
        "Enabled",
        "OFF",
        " enabled",
        "enabled ",
        "enabled\n",
        "$(touch injected)",
        "off;touch injected",
    ],
)
def test_invalid_advisor_rejects_before_staging_and_never_evaluates_value(run_build, advisor):
    root, result = run_build("capture", advisor=advisor)
    assert result.returncode != 0
    assert result.stdout == "::error::Invalid advisor signup mode.\n"
    assert result.stderr == ""
    assert not (root / "_site").exists()
    assert not (root / "calls").exists()
    assert not (root / "injected").exists()


@pytest.mark.parametrize("failure", ["publisher", "audit"])
def test_enabled_failure_does_not_fall_back_or_prepare_publication(run_build, failure):
    root, result = run_build("annotations", advisor="enabled", failure=failure)
    assert result.returncode == (70 if failure == "publisher" else 71)
    assert not (root / "sitemaps").exists()
    assert (root / "calls").read_text() == (
        "publisher\n" if failure == "publisher" else "publisher\naudit\n"
    )


def test_returning_to_off_uses_fresh_staging_without_previous_artifacts(run_build):
    enabled, result = run_build(advisor="enabled")
    assert result.returncode == 0
    stale = enabled / "_site/internships/for/old-majors/weekly/index.html"
    stale.parent.mkdir(parents=True)
    stale.write_text("prior generated form fixture", encoding="utf-8")
    off, result = run_build(advisor="off")
    assert result.returncode == 0
    assert off != enabled
    assert nul_values(off / "publisher.args") == PREFIX
    assert not (off / "_site/internships/for/old-majors/weekly/index.html").exists()
    assert (off / "_site/index.html").read_text() == "unchanged dashboard"
    assert stale.read_text() == "prior generated form fixture"  # No destructive reuse.


def test_advisor_value_is_only_step_environment_data():
    step, script = build_step()
    assert "ADVISOR_SIGNUP_MODE: ${{ vars.INTERNSCOUT_ADVISOR_SIGNUP_MODE }}" in step
    assert "${{" not in script
    assert script.index('case "${ADVISOR_SIGNUP_MODE:-}"') < script.index("cp -r docs _site")
    assert script.count("python -m scripts.make_og_image") == 1
    assert '"${employer_args[@]}" "${advisor_args[@]}"' in script
