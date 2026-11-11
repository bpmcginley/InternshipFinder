"""Shared test setup."""

import sys

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "without_seo_facade: run in isolation without loading the legacy SEO module"
    )


@pytest.fixture(autouse=True)
def _not_a_push_run(monkeypatch):
    """Run every test as if no CI event started it.

    The Tests workflow runs on a push, so GITHUB_EVENT_NAME is "push" there, and google_jobs skips
    its paid searches on a push-triggered run. The three budget tests in test_google_jobs.py passed
    on a laptop and failed in CI for that reason alone. A test that wants the push behaviour sets
    the variable itself.
    """
    monkeypatch.delenv("GITHUB_EVENT_NAME", raising=False)


@pytest.fixture(autouse=True)
def _no_real_state_files(monkeypatch, tmp_path):
    """Keep tests off the committed state files: the dropped-board list and the day Google Jobs last
    searched. Both are read and written by code the tests call, and a test that dropped a board
    would otherwise leave it kept out for every test after it."""
    from internscout import discover
    from internscout.sources import google_jobs

    monkeypatch.setattr(discover, "DROPPED_PATH", str(tmp_path / "dropped_boards.json"))
    monkeypatch.setattr(discover, "_DROPPED", {})
    monkeypatch.setattr(google_jobs, "DAY_PATH", str(tmp_path / "google_jobs_day.json"))


@pytest.fixture(autouse=True)
def _near_pages_only_where_tested(request, monkeypatch):
    """Keep legacy site builds small outside the near-city page tests.

    The 500 near-city pages increased the original suite from 20 seconds to three minutes.
    """
    if request.module.__name__.endswith("test_near_pages"):
        yield
        return
    legacy_name = "internscout.seo_pages"
    if (
        request.node.get_closest_marker("without_seo_facade") is not None
        and sys.modules.get(legacy_name) is None
    ):
        yield
        if sys.modules.get(legacy_name) is not None:
            pytest.fail(
                "A test marked without_seo_facade imported internscout.seo_pages", pytrace=False
            )
        return
    from internscout import seo_pages

    monkeypatch.setattr(seo_pages, "NEAR_ON", False)
    yield


@pytest.fixture(autouse=True)
def _default_workday_keywords(monkeypatch):
    """Run every test with Workday's default search words, whatever the shell has set.

    WORKDAY_EXTRA_KEYWORDS turns on extra searches for every Workday board. A test that wants
    them sets the variable itself.
    """
    monkeypatch.delenv("WORKDAY_EXTRA_KEYWORDS", raising=False)
